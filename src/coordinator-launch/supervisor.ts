import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Server, Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { isNoEntryError } from '../infra/fs-errors.js';
import { readDiscoveryRecordDisposition, removeBackendInfoIfOwner } from '../infra/backend-discovery.js';
import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { createForeignTargetValidator, inspectValidatedHandoffTarget } from '../infra/handoff-target.js';
import { compareProductVersions } from '../infra/product-version.js';
import { validatedRunningBuildRoot } from '../infra/retained-build-root.js';
import {
  CoordinatorLaunchRecord,
  type LaunchOwner,
  type LaunchProcess,
  type LaunchReservation,
} from '../infra/coordinator-launch.js';
import {
  incarnationMayAuthorizeSignal,
  observeProcessLiveness,
  probeProcessIncarnation,
  type ProcessLiveness,
} from '../infra/node-process.js';
import { SENTINEL_TIMING, validSentinelTiming, type SentinelTiming } from '../infra/sentinel-timing.js';
import { readUpgradeIntent } from '../infra/upgrade-intent.js';
import { handoffCapsuleControllerBuildSetId, type HandoffCapsule } from '../provider-proxy/handoff-capsule.js';
import {
  providerProxySetIdentityFromCapsule,
  providerProxySetKey,
} from '../coordinator/services/provider-proxy-set/identity.js';
import { servedControllerTransferForCapsule } from '../coordinator/succession/provider-host-transfer.js';
import { prepareRetainedControllerHandoff } from '../coordinator/services/startup-retirement.js';
import { JobLocationIndex } from '../jobs/location-index.js';
import { readCustodyLedger } from '../store/custody-ledger.js';
import {
  providerHandoffCapsuleCandidatePaths,
  readProviderHandoffCapsuleCandidate,
  supersededHandoffCapsulePaths,
} from '../provider-proxy/handoff-capsule-discovery.js';
import { createRealRuntime } from '../runtime/real.js';
import { childHasExited, childIsUninterruptible } from './child-state.js';
import { replacementServing, requestInheritedSuccession } from './health.js';
import { relaunchRoots, validatedBuild } from './selection.js';

const STARTUP_BUDGET_MS = 120_000;
const POLL_MS = 200;

type Candidate = Readonly<{ executable: string; buildSetId: string }>;

function closeHandle(handle: unknown): void {
  if (handle instanceof Server) handle.close();
  else if (handle instanceof Socket) handle.destroy();
}

function validatedExecutable(executable: string): StrictBundleManifest | null {
  const bundleDir = dirname(executable);
  const adjacent = readBoundedAdjacentManifest(bundleDir);
  if (!adjacent.ok) return null;
  const manifest = strictBundleManifestSchema.safeParse(adjacent.value);
  return manifest.success &&
    createForeignTargetValidator()(bundleDir, manifest.data).kind === 'validated' &&
    existsSync(executable)
    ? manifest.data
    : null;
}

function targetValidation(executable: string): 'absent' | 'indeterminate' | StrictBundleManifest {
  try {
    if (!statSync(executable).isFile()) return 'indeterminate';
  } catch (error: unknown) {
    if (isNoEntryError(error)) return 'absent';
    return 'indeterminate';
  }
  return validatedExecutable(executable) ?? 'indeterminate';
}

function settleRequests(
  record: CoordinatorLaunchRecord,
  owner: LaunchOwner,
  serving: StrictBundleManifest | null,
  ready = false,
): void {
  let indeterminate: string | null = null;
  for (const request of record.read().requests) {
    if (request.status !== 'recorded' && request.status !== 'accepted') continue;
    if (request.acceptedEpoch !== owner.epoch) record.accept(owner, request.id, Date.now());
    const target = targetValidation(request.executable);
    if (target === 'absent') {
      record.unavailable(owner, request.id, Date.now());
      continue;
    }
    if (target === 'indeterminate' || target.buildSetId !== request.buildSetId) {
      indeterminate ??= request.id;
      continue;
    }
    if (serving !== null && serving.flavor === target.flavor) {
      const order = compareProductVersions(target.version, serving.version);
      if (order < 0) {
        record.unavailable(owner, request.id, Date.now());
        continue;
      }
      if (order === 0) {
        if (request.buildSetId !== serving.buildSetId) {
          record.unavailable(owner, request.id, Date.now());
        } else if (ready) {
          record.complete(owner, request.id, Date.now());
        }
        continue;
      }
    }
  }
  if (indeterminate === null) record.clearTargetHold(owner, Date.now());
  else record.holdTarget(owner, indeterminate, Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function incumbentAt(runDir: string): { pid: number; incarnation: string | null } | null {
  try {
    const value = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8')) as {
      pid?: unknown;
      incarnation?: unknown;
    };
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      ? { pid: value.pid, incarnation: typeof value.incarnation === 'string' ? value.incarnation : null }
      : null;
  } catch {
    return null;
  }
}

function incumbentLiveness(incumbent: { pid: number; incarnation: string | null }): ProcessLiveness {
  if (incumbent.incarnation !== null) {
    const observed = probeProcessIncarnation(incumbent.pid);
    if (observed !== null && observed !== incumbent.incarnation) return 'absent';
  }
  return observeProcessLiveness(incumbent.pid);
}

function removeExitedChildDiscovery(runDir: string, identity: LaunchProcess): void {
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', { baseDir: dirname(dirname(runDir)) });
  try {
    const discovery = readDiscoveryRecordDisposition(runtime);
    if (
      discovery.kind === 'record' &&
      discovery.record.pid === identity.pid &&
      discovery.record.incarnation === identity.incarnation &&
      discovery.record.instanceId !== undefined
    ) {
      const removal = removeBackendInfoIfOwner(discovery.record.instanceId, runtime);
      if (removal.kind === 'refused') process.stderr.write(`Coordinator discovery cleanup failed: ${removal.code}\n`);
    }
  } catch (error: unknown) {
    process.stderr.write(`Coordinator discovery cleanup failed: ${String(error)}\n`);
  }
}

export function controllerBuild(
  runDir: string,
): { kind: 'none' | 'unknown' } | { kind: 'required'; buildSetId: string } {
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', { baseDir: dirname(dirname(runDir)) });
  let paths: readonly string[];
  try {
    paths = providerHandoffCapsuleCandidatePaths(runDir, runtime.storage);
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'none' } : { kind: 'unknown' };
  }
  const readable: { path: string; capsule: HandoffCapsule }[] = [];
  for (const path of paths) {
    let candidate: ReturnType<typeof readProviderHandoffCapsuleCandidate>;
    try {
      candidate = readProviderHandoffCapsuleCandidate(path, runtime.paths.coral.generation.root, {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
    } catch {
      return { kind: 'unknown' };
    }
    if (candidate.kind !== 'readable') return { kind: 'unknown' };
    readable.push(candidate);
  }
  const superseded = supersededHandoffCapsulePaths(readable);
  const buildsBySet = new Map<string, string>();
  for (const { path, capsule } of readable) {
    if (superseded.has(path)) continue;
    if (capsule.version === 1) continue;
    if (capsule.version === 2) {
      if (observeProcessLiveness(capsule.proxyPid) !== 'absent') return { kind: 'unknown' };
      continue;
    }
    const observed = probeProcessIncarnation(capsule.proxyPid);
    if (observed === null) {
      if (observeProcessLiveness(capsule.proxyPid) !== 'absent') return { kind: 'unknown' };
      continue;
    }
    if (observed === capsule.proxyIncarnation && observeProcessLiveness(capsule.proxyPid) !== 'absent') {
      const transfer = servedControllerTransferForCapsule(runtime, capsule);
      if (transfer.kind === 'unknown') return { kind: 'unknown' };
      const buildSetId = transfer.kind === 'served' ? transfer.buildSetId : handoffCapsuleControllerBuildSetId(capsule);
      const setKey = providerProxySetKey(providerProxySetIdentityFromCapsule(capsule));
      const existing = buildsBySet.get(setKey);
      if (existing !== undefined && existing !== buildSetId) return { kind: 'unknown' };
      buildsBySet.set(setKey, buildSetId);
    }
  }
  const builds = new Set(buildsBySet.values());
  try {
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const unresolved = new Set(
      index
        .locations()
        .filter((location) => location.disposition !== 'terminal')
        .map((location) => location.jobId),
    );
    const custody = readCustodyLedger(runtime, runDir);
    if (custody.some((entry) => entry.kind === 'unreadable')) return { kind: 'unknown' };
    const durableCliJob = custody.some(
      (entry) =>
        (entry.kind === 'holding' || entry.kind === 'bound') &&
        entry.intent.owner === 'durable-cli' &&
        unresolved.has(entry.intent.jobId ?? entry.intent.operationId),
    );
    if (durableCliJob) {
      const handoff = prepareRetainedControllerHandoff(runtime, index);
      if (handoff === null) return { kind: 'unknown' };
      builds.add(inspectValidatedHandoffTarget(handoff.target).build.buildSetId);
    }
  } catch {
    return { kind: 'unknown' };
  }
  if (builds.size === 0) return { kind: 'none' };
  return builds.size === 1 ? { kind: 'required', buildSetId: [...builds][0] } : { kind: 'unknown' };
}

function candidates(
  record: CoordinatorLaunchRecord,
  runDir: string,
  original: Candidate,
  originalManifest: StrictBundleManifest,
): Candidate[] {
  const controller = controllerBuild(runDir);
  if (controller.kind === 'unknown') return [];
  const observedIntent = readUpgradeIntent(runDir);
  const committedIntent =
    observedIntent.kind === 'readable' &&
    observedIntent.intent.disposition === 'completed' &&
    observedIntent.intent.completionReceipt?.kind === 'serving' &&
    observedIntent.intent.completionReceipt.successor.build.buildSetId === observedIntent.intent.target.build.buildSetId
      ? observedIntent.intent
      : null;
  const committedRoot =
    committedIntent === null
      ? null
      : validatedRunningBuildRoot(runDir, committedIntent.target.pluginRootLabel, committedIntent.target.build);
  const committed =
    committedRoot === null || committedIntent === null
      ? null
      : {
          executable: join(committedRoot, 'bridge', 'coral-backend.cjs'),
          buildSetId: committedIntent.target.build.buildSetId,
        };
  const requested = record
    .read()
    .requests.filter((request) => request.status === 'recorded' || request.status === 'accepted')
    .flatMap((request) =>
      validatedExecutable(request.executable)?.buildSetId === request.buildSetId
        ? [{ executable: request.executable, buildSetId: request.buildSetId }]
        : [],
    );
  const originalRoot = validatedRunningBuildRoot(runDir, dirname(dirname(original.executable)), originalManifest);
  const recovery = relaunchRoots(runDir, originalManifest).flatMap((root) => {
    const build = validatedBuild(root);
    return build === null
      ? []
      : [{ executable: join(root, 'bridge', 'coral-backend.cjs'), buildSetId: build.buildSetId }];
  });
  const requiredBuild = controller.kind === 'required' ? controller.buildSetId : (committed?.buildSetId ?? null);
  const retainedController =
    requiredBuild === null ? null : validatedBuild(join(dirname(runDir), 'builds', requiredBuild));
  const controllerCandidate =
    retainedController !== null &&
    retainedController.buildSetId === requiredBuild &&
    retainedController.flavor === originalManifest.flavor
      ? [
          {
            executable: join(dirname(runDir), 'builds', requiredBuild, 'bridge', 'coral-backend.cjs'),
            buildSetId: requiredBuild,
          },
        ]
      : [];
  const choices = [
    ...new Map(
      [
        ...requested,
        ...(committed === null ? [] : [committed]),
        ...controllerCandidate,
        ...recovery,
        ...(originalRoot === null
          ? []
          : [{ executable: join(originalRoot, 'bridge', 'coral-backend.cjs'), buildSetId: original.buildSetId }]),
      ].map((candidate) => [candidate.executable, candidate]),
    ).values(),
  ];
  const eligible =
    controller.kind === 'required'
      ? choices.filter((candidate) => candidate.buildSetId === controller.buildSetId)
      : choices;
  return eligible.sort((a, b) => {
    const left = validatedExecutable(a.executable);
    const right = validatedExecutable(b.executable);
    if (left === null || right === null) return 0;
    return compareProductVersions(right.version, left.version);
  });
}

type WatchResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  served: boolean;
  wedged: boolean;
}>;
type RunningChild = Readonly<{
  child: ChildProcess;
  identity: LaunchProcess;
  sentinelId: string;
  executable: string;
  manifest: StrictBundleManifest;
}>;
type OwnerHandle = { current: LaunchOwner; lost: boolean };
type ChildRetirement = { at: number | null };
function retireOwnedChild(
  record: CoordinatorLaunchRecord,
  owner: OwnerHandle,
  reservation: LaunchReservation,
  running: RunningChild,
  retirement: ChildRetirement,
  graceMs: number,
): void {
  const now = Date.now();
  if (!record.commitTermination(owner.current, reservation, running.identity, now, graceMs)) return;
  retirement.at ??= now;
  try {
    if (
      terminationCommitted(record, owner.current, reservation, running.identity) &&
      probeProcessIncarnation(running.identity.pid) === running.identity.incarnation
    )
      running.child.kill('SIGTERM');
  } catch {
    return;
  }
}
type InheritedWatch = {
  firstSeen: number;
  lastHealthy: number;
  uninterruptibleSince: number | null;
  terminationAt: number | null;
};

function terminationCommitted(
  record: CoordinatorLaunchRecord,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  identity: LaunchProcess,
): boolean {
  const state = record.read();
  const slot = [state.launch, state.attempt].find((entry) => entry?.id === reservation.id);
  return (
    state.owner?.epoch === owner.epoch &&
    slot?.terminationAt !== undefined &&
    slot.terminationOwnerEpoch === owner.epoch &&
    slot.child?.pid === identity.pid &&
    slot.child.incarnation === identity.incarnation
  );
}

function signalInheritedChild(
  record: CoordinatorLaunchRecord,
  owner: LaunchOwner,
  slot: LaunchReservation,
  signal: NodeJS.Signals,
): boolean {
  const child = slot.child;
  if (child === undefined || !incarnationMayAuthorizeSignal(process.platform)) return false;
  if (!terminationCommitted(record, owner, slot, child) || probeProcessIncarnation(child.pid) !== child.incarnation)
    return false;
  try {
    process.kill(child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function spawnAdmittedChild(
  record: CoordinatorLaunchRecord,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  executable: string,
  args: readonly string[],
  runDir: string,
  attemptId?: string,
): RunningChild | null {
  const manifest = validatedExecutable(executable);
  if (manifest === null) {
    record.cancelReservation(owner, reservation, Date.now());
    return null;
  }
  const sentinelId = randomUUID();
  const legacy = !existsSync(join(dirname(executable), 'coral-sentinel.cjs'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORAL_LAUNCH_ADMISSION: '1',
    CORAL_LAUNCH_PURPOSE: reservation.purpose,
    CORAL_SENTINEL_ID: sentinelId,
    CORAL_SENTINEL_RUN_DIR: runDir,
    CORAL_STARTUP_ATTEMPT_ID: attemptId ?? process.env.CORAL_STARTUP_ATTEMPT_ID ?? randomUUID(),
  };
  delete env.CORAL_LAUNCH_ID;
  if (attemptId === undefined) delete env.CORAL_SUCCESSION_ATTEMPT_ID;
  else env.CORAL_SUCCESSION_ATTEMPT_ID = attemptId;
  const child = spawn(
    process.execPath,
    legacy ? [process.argv[1], '--launch-legacy', executable, ...args] : [executable, ...args],
    {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  child.on('error', (error) => process.stderr.write(`Coordinator spawn failed: ${String(error)}\n`));
  const pid = child.pid;
  const incarnation = pid === undefined ? null : probeProcessIncarnation(pid);
  if (pid === undefined || incarnation === null) {
    const finish = (): void => {
      clearInterval(retry);
      record.cancelReservation(owner, reservation, Date.now());
    };
    const retry = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (pid === undefined || probeProcessIncarnation(pid) === null) return;
      child.kill('SIGKILL');
    }, 1_000);
    child.once('exit', finish);
    if (pid === undefined) finish();
    return null;
  }
  return { child, identity: { pid, incarnation }, sentinelId, executable, manifest };
}

async function watchChild(
  child: ChildProcess,
  executable: string,
  manifest: StrictBundleManifest,
  reservation: LaunchReservation,
  identity: LaunchProcess,
  sentinelId: string,
  record: CoordinatorLaunchRecord,
  runDir: string,
  owner: OwnerHandle,
  timing: SentinelTiming,
  startupBudgetMs: number,
  retirement: ChildRetirement,
  route: (message: unknown, handle: unknown) => boolean = () => false,
  forwardParentMessages = true,
): Promise<WatchResult> {
  let armed = false;
  let pendingHello = false;
  let lastAnswer = Date.now();
  let lastWake = lastAnswer;
  let outstanding: number | null = null;
  let sequence = 0;
  let escalationAt: number | null = null;
  let killed = false;
  let lastKillAttemptAt = 0;
  let wedged = false;
  let dStateSince: number | null = null;
  let served = false;
  let admitted = false;
  let startupDeadline = Date.now() + startupBudgetMs;
  let lastRenewal = Date.now();
  let disconnectedAt: number | null = null;

  const childExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.on('message', (message: unknown, handle: unknown) => {
    if (owner.lost || record.read().owner?.epoch !== owner.current.epoch) {
      closeHandle(handle);
      return;
    }
    if (typeof message === 'object' && message !== null && 'kind' in message) {
      if (message.kind === 'coral-launch-admitted' && 'pid' in message && message.pid === child.pid) admitted = true;
      if (message.kind === 'coral-sentinel-hello' && 'id' in message && message.id === sentinelId) {
        pendingHello = true;
        lastAnswer = Date.now();
        if (armed) child.send({ kind: 'coral-sentinel-armed', id: sentinelId });
      }
      if (message.kind === 'coral-sentinel-answer' && 'id' in message && message.id === outstanding) {
        outstanding = null;
        lastAnswer = Date.now();
      }
      if (route(message, handle)) return;
      if (String(message.kind).startsWith('coral-')) return;
    } else if (route(message, handle)) return;
    if (process.connected)
      process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () =>
        closeHandle(handle),
      );
    else closeHandle(handle);
  });
  const parentMessage = (message: unknown, handle: unknown): void => {
    if (owner.lost || record.read().owner?.epoch !== owner.current.epoch) {
      closeHandle(handle);
      return;
    }
    if (child.connected)
      child.send(message as Parameters<typeof child.send>[0], handle as SendHandle, () => closeHandle(handle));
    else closeHandle(handle);
  };
  if (forwardParentMessages) process.on('message', parentMessage);
  const escalateChild = (now: number): 'sent' | 'absent' | 'held' | 'refused' => {
    if (owner.lost || !record.commitTermination(owner.current, reservation, identity, now, timing.graceMs))
      return 'refused';
    if (
      terminationCommitted(record, owner.current, reservation, identity) &&
      probeProcessIncarnation(identity.pid) === identity.incarnation
    ) {
      let sent: boolean;
      try {
        sent = child.kill('SIGKILL');
      } catch {
        sent = false;
      }
      if (sent) {
        record.clearSignalRefusal(reservation, identity);
        return 'sent';
      }
    }
    if (observeProcessLiveness(identity.pid) === 'absent') {
      record.settleAbsentChild(owner.current, reservation, now);
      return 'absent';
    }
    return record.holdSignalRefusal(owner.current, reservation, identity, now) ? 'held' : 'refused';
  };
  const interval = setInterval(() => {
    const now = Date.now();
    const gap = now - lastWake;
    lastWake = now;
    if (gap > timing.schedulingGapMs) {
      lastAnswer = now;
      outstanding = null;
      startupDeadline += gap;
    }
    if (record.read().owner?.epoch !== owner.current.epoch) {
      owner.lost = true;
      return;
    }
    if (now - lastRenewal >= 30_000) {
      const renewed = record.renew(owner.current, now);
      if (renewed !== null) owner.current = renewed;
      else {
        const { id, process: holderProcess, buildSetId } = owner.current;
        const reacquired = record.acquire({ id, process: holderProcess, buildSetId }, now);
        if (reacquired === null) owner.lost = true;
        else owner.current = reacquired;
      }
      lastRenewal = now;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (owner.lost || record.read().owner?.epoch !== owner.current.epoch) return;
    escalationAt ??= retirement.at;
    if (escalationAt !== null) {
      if (!killed && now - escalationAt >= timing.graceMs && now - lastKillAttemptAt >= 1_000) {
        lastKillAttemptAt = now;
        if (escalateChild(now) === 'sent') killed = true;
      }
      return;
    }
    disconnectedAt = child.connected ? null : (disconnectedAt ?? now);
    if (dStateSince !== null && child.pid !== undefined && !childIsUninterruptible(child.pid)) {
      dStateSince = null;
      lastAnswer = now;
      outstanding = null;
    }
    if (
      (!served && now >= startupDeadline) ||
      (disconnectedAt !== null && now - disconnectedAt >= timing.lapseMs) ||
      (child.connected &&
        pendingHello &&
        (now - lastAnswer >= timing.lapseMs || (dStateSince !== null && now - dStateSince >= timing.dStateDeferralMs)))
    ) {
      if (child.pid !== undefined && childIsUninterruptible(child.pid) && dStateSince === null) dStateSince = now;
      if (dStateSince !== null && now - dStateSince < timing.dStateDeferralMs) {
        lastAnswer = now;
      } else {
        wedged = true;
        if (!record.commitTermination(owner.current, reservation, identity, now, timing.graceMs)) {
          owner.lost = true;
          return;
        }
        if (
          terminationCommitted(record, owner.current, reservation, identity) &&
          probeProcessIncarnation(identity.pid) === identity.incarnation
        )
          child.kill('SIGTERM');
        escalationAt = now;
      }
      return;
    }
    if (admitted && armed && pendingHello && outstanding === null && child.connected) {
      outstanding = ++sequence;
      child.send({ kind: 'coral-sentinel-challenge', id: outstanding });
    }
  }, timing.challengeMs);
  child.once('spawn', () => {
    child.send({
      kind: 'coral-launch-admit',
      runDir,
      launchId: reservation.id,
      ownerEpoch: reservation.ownerEpoch,
      parent: owner.current.process,
    });
    armed = true;
    if (pendingHello) child.send({ kind: 'coral-sentinel-armed', id: sentinelId });
  });
  const servingPoll = setInterval(() => {
    if (!admitted || child.pid === undefined || served) return;
    const state = record.read();
    if (![state.launch, state.attempt].some((launch) => launch?.id === reservation.id && launch.phase === 'admitted'))
      return;
    void replacementServing(runDir, manifest.flavor, child.pid).then((ready) => {
      if (ready && record.serving(reservation, identity)) {
        served = true;
        for (const request of record.read().requests) {
          if (request.buildSetId === reservation.buildSetId && request.status === 'accepted')
            record.complete(owner.current, request.id, Date.now());
        }
      }
    });
  }, POLL_MS);
  const { exitCode, signal } = await childExit;
  clearInterval(interval);
  clearInterval(servingPoll);
  if (forwardParentMessages) process.off('message', parentMessage);
  removeExitedChildDiscovery(runDir, identity);
  if (!record.exited(reservation, identity)) record.cancelReservation(owner.current, reservation, Date.now());
  return { exitCode, signal, served, wedged };
}

type RepairChild = Readonly<{
  attemptId: string;
  reservation: LaunchReservation;
  running: RunningChild;
  retirement: ChildRetirement;
  watch: Promise<WatchResult>;
}>;

type SuccessionAttemptLaunch = Readonly<{
  reservation: LaunchReservation;
  running: RunningChild;
  retirement: ChildRetirement;
  watch: Promise<WatchResult>;
}>;

async function launchSuccessionAttempt(input: {
  record: CoordinatorLaunchRecord;
  owner: OwnerHandle;
  runDir: string;
  bundleDir: string;
  attemptId: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  beforeReserve?: () => Promise<void>;
  route: (running: RunningChild, message: unknown, handle: unknown) => boolean;
  forwardParentMessages: boolean;
  onExit: (attempt: SuccessionAttemptLaunch, result: WatchResult) => void;
}): Promise<SuccessionAttemptLaunch> {
  if (input.owner.lost) throw new Error('Launch ownership was lost');
  const executable = join(input.bundleDir, 'coral-backend.cjs');
  const manifest = validatedExecutable(executable);
  if (manifest === null) throw new Error('Succession target is unavailable');
  await input.beforeReserve?.();
  if (input.owner.lost) throw new Error('Launch ownership was lost');
  const active = input.record.read().attempt;
  if (active !== null && active.phase !== 'exited') throw new Error('Succession attempt is already active');
  const reservation = input.record.reserve(input.owner.current, manifest.buildSetId, 'succession', Date.now());
  if (reservation === null) throw new Error('Succession reservation was refused');
  const running = spawnAdmittedChild(
    input.record,
    input.owner.current,
    reservation,
    executable,
    [],
    input.runDir,
    input.attemptId,
  );
  if (running === null) throw new Error('Succession child did not spawn');
  const retirement: ChildRetirement = { at: null };
  const watch = watchChild(
    running.child,
    running.executable,
    running.manifest,
    reservation,
    running.identity,
    running.sentinelId,
    input.record,
    input.runDir,
    input.owner,
    input.timing,
    input.startupBudgetMs,
    retirement,
    (message, handle) => input.route(running, message, handle),
    input.forwardParentMessages,
  );
  const attempt = { reservation, running, retirement, watch };
  void watch.then((result) => input.onExit(attempt, result));
  return attempt;
}

function createRepairBridge(
  record: CoordinatorLaunchRecord,
  owner: OwnerHandle,
  runDir: string,
  timing: SentinelTiming,
  startupBudgetMs: number,
): Readonly<{ child: (launchId: string | undefined) => RepairChild | null; close: () => void }> {
  const children = new Map<string, RepairChild>();
  let starting = false;
  const servingChild = (): RepairChild | null => {
    const launchId = record.read().launch?.id;
    return launchId === undefined ? null : (children.get(launchId) ?? null);
  };
  const reply = (message: unknown, handle?: unknown): void => {
    const recipient = servingChild()?.running.child;
    if (recipient?.connected)
      recipient.send(message as Parameters<ChildProcess['send']>[0], handle as SendHandle, () => closeHandle(handle));
    else if (process.connected)
      process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () =>
        closeHandle(handle),
      );
    else closeHandle(handle);
  };
  const onMessage = (message: unknown, handle: unknown): void => {
    if (owner.lost || record.read().owner?.epoch !== owner.current.epoch) {
      closeHandle(handle);
      return;
    }
    if (typeof message !== 'object' || message === null || !('kind' in message)) return;
    if (
      message.kind === 'coral-supervisor-start-attempt' &&
      'attemptId' in message &&
      typeof message.attemptId === 'string' &&
      'bundleDir' in message &&
      typeof message.bundleDir === 'string'
    ) {
      const attemptId = message.attemptId;
      if (starting) {
        reply({ kind: 'coral-supervisor-attempt-error', attemptId, reason: 'Succession attempt is already active' });
        return;
      }
      starting = true;
      void launchSuccessionAttempt({
        record,
        owner,
        runDir,
        bundleDir: message.bundleDir,
        attemptId,
        timing,
        startupBudgetMs,
        forwardParentMessages: false,
        route: (running, childMessage, childHandle) => {
          if (servingChild()?.running.child === running.child) onMessage(childMessage, childHandle);
          else reply({ kind: 'coral-supervisor-attempt-message', attemptId, message: childMessage }, childHandle);
          return true;
        },
        onExit: (attempt, result) => {
          reply({ kind: 'coral-supervisor-attempt-exit', attemptId, exitCode: result.exitCode, signal: result.signal });
          children.delete(attempt.reservation.id);
        },
      })
        .then((attempt) => {
          children.set(attempt.reservation.id, { ...attempt, attemptId });
          reply({ kind: 'coral-supervisor-attempt-spawned', attemptId, pid: attempt.running.identity.pid });
        })
        .catch((error: unknown) => {
          reply({ kind: 'coral-supervisor-attempt-error', attemptId, reason: String(error) });
        })
        .finally(() => {
          starting = false;
        });
      return;
    }
    const attemptId = record.read().attempt?.id;
    const attempt = attemptId === undefined ? null : (children.get(attemptId) ?? null);
    if (attempt === null || !('attemptId' in message) || message.attemptId !== attempt.attemptId) return;
    if (message.kind === 'coral-supervisor-retire-attempt') {
      retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
      return;
    }
    if (message.kind !== 'coral-supervisor-relay') return;
    const payload = 'message' in message ? message.message : null;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'kind' in payload &&
      payload.kind === 'coral-sentinel-retire-child'
    )
      retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
    else if (attempt.running.child.connected)
      attempt.running.child.send(payload as Parameters<ChildProcess['send']>[0], handle as SendHandle, () =>
        closeHandle(handle),
      );
    else closeHandle(handle);
  };
  process.on('message', onMessage);
  return {
    child: (launchId) => (launchId === undefined ? null : (children.get(launchId) ?? null)),
    close: () => process.off('message', onMessage),
  };
}

type OwnershipAcquisition =
  | Readonly<{ kind: 'finished'; exitCode: 0 | 1 }>
  | Readonly<{
      kind: 'owned';
      owner: OwnerHandle;
      holderIdentity: Omit<LaunchOwner, 'epoch' | 'renewal' | 'leaseUntil' | 'mode'>;
      incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>;
      replacement: boolean;
      recoveryChallenge: string | undefined;
    }>;

async function acquireLaunchOwnership(
  record: CoordinatorLaunchRecord,
  executable: string,
  manifest: StrictBundleManifest,
): Promise<OwnershipAcquisition> {
  const request = record.request(executable, manifest.buildSetId);
  const incarnation = probeProcessIncarnation(process.pid);
  if (incarnation === null) return { kind: 'finished', exitCode: 1 };
  const holderIdentity = {
    id: randomUUID(),
    process: { pid: process.pid, incarnation },
    buildSetId: manifest.buildSetId,
  };
  const recoverySourcePid = Number(process.env.CORAL_RECOVERY_SOURCE_PID);
  const recoveryChallenge = process.env.CORAL_RECOVERY_CHALLENGE;
  const recoverySourceIncarnation = process.env.CORAL_RECOVERY_SOURCE_INCARNATION;
  const replacement =
    Number.isSafeInteger(recoverySourcePid) &&
    recoverySourcePid > 0 &&
    recoveryChallenge !== undefined &&
    recoverySourceIncarnation !== undefined;
  let offered: LaunchOwner | null = null;
  const onRecoveryOffer = (message: unknown): void => {
    if (
      !replacement ||
      process.ppid !== recoverySourcePid ||
      probeProcessIncarnation(recoverySourcePid) !== recoverySourceIncarnation ||
      typeof message !== 'object' ||
      message === null ||
      !('kind' in message) ||
      message.kind !== 'coral-recovery-offer' ||
      !('id' in message) ||
      typeof message.id !== 'string' ||
      !('challenge' in message) ||
      message.challenge !== recoveryChallenge
    )
      return;
    offered = record.acceptRecoveryTransfer(holderIdentity, message.id, recoveryChallenge, Date.now());
  };
  if (replacement) {
    process.on('message', onRecoveryOffer);
    process.send?.({ kind: 'coral-recovery-ready', challenge: recoveryChallenge });
  }
  try {
    const recoveryWaitStartedAt = Date.now();
    let holder = replacement ? null : record.acquire(holderIdentity, Date.now());
    while (holder === null) {
      if (offered !== null) {
        holder = offered;
        break;
      }
      if (replacement && (!process.connected || process.ppid !== recoverySourcePid))
        return { kind: 'finished', exitCode: 1 };
      const state = record.read();
      const pending = state.requests.find((entry) => entry.id === request.id);
      if (pending?.status === 'completed' || pending?.status === 'unavailable')
        return { kind: 'finished', exitCode: 0 };
      await sleep(POLL_MS);
      if (!replacement || Date.now() - recoveryWaitStartedAt >= 1_000)
        holder = record.acquire(holderIdentity, Date.now());
    }
    return {
      kind: 'owned',
      owner: { current: holder, lost: false },
      holderIdentity,
      incarnation,
      replacement,
      recoveryChallenge,
    };
  } finally {
    if (replacement) process.off('message', onRecoveryOffer);
  }
}

async function reconcileInheritedChildren(input: {
  record: CoordinatorLaunchRecord;
  owner: OwnerHandle;
  runDir: string;
  originalManifest: StrictBundleManifest;
  timing: SentinelTiming;
  startupBudgetMs: number;
  inheritedWatch: Map<string, InheritedWatch>;
  lastInheritedRequest: Map<string, number>;
  repairBridge: ReturnType<typeof createRepairBridge> | null;
  replacement: boolean;
  recoveryChallenge: string | undefined;
  incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>;
}): Promise<Readonly<{ inherited: LaunchReservation[]; repairBridge: ReturnType<typeof createRepairBridge> | null }>> {
  const {
    record,
    owner,
    runDir,
    originalManifest,
    timing,
    startupBudgetMs,
    inheritedWatch,
    lastInheritedRequest,
    replacement,
    recoveryChallenge,
    incarnation,
  } = input;
  let repairBridge = input.repairBridge;
  const inherited = [record.read().launch, record.read().attempt].filter(
    (slot): slot is LaunchReservation =>
      slot !== null &&
      (slot.phase === 'admitted' || slot.phase === 'serving') &&
      (slot.parent?.pid !== process.pid || slot.parent.incarnation !== incarnation),
  );
  const currentInheritedChild = (snapshot: LaunchReservation, child: LaunchProcess): LaunchReservation | null => {
    const state = record.read();
    const current = [state.launch, state.attempt].find((entry) => entry?.id === snapshot.id);
    return !owner.lost &&
      state.owner?.epoch === owner.current.epoch &&
      current !== undefined &&
      current !== null &&
      (current.phase === 'admitted' || current.phase === 'serving') &&
      current.child?.pid === child.pid &&
      current.child.incarnation === child.incarnation
      ? current
      : null;
  };
  if (inherited.length > 0) {
    for (const snapshot of inherited) {
      let slot = snapshot;
      const child = slot.child;
      if (child === undefined) continue;
      if (incumbentLiveness(child) === 'absent' || childHasExited(child.pid)) {
        if (record.settleAbsentChild(owner.current, slot, Date.now()))
          record.clearInheritedChildHold(owner.current, slot, Date.now());
        inheritedWatch.delete(slot.id);
        continue;
      }
      let now = Date.now();
      const watch = inheritedWatch.get(slot.id) ?? {
        firstSeen: now,
        lastHealthy: slot.observedHealthyAt ?? slot.admittedAt ?? now,
        uninterruptibleSince: null,
        terminationAt: slot.terminationAt ?? null,
      };
      inheritedWatch.set(slot.id, watch);
      const healthy =
        probeProcessIncarnation(child.pid) === child.incarnation &&
        (await replacementServing(runDir, originalManifest.flavor, child.pid));
      const current = currentInheritedChild(snapshot, child);
      if (current === null) {
        inheritedWatch.delete(snapshot.id);
        continue;
      }
      slot = current;
      watch.terminationAt = slot.terminationAt ?? watch.terminationAt;
      now = Date.now();
      if (healthy && watch.terminationAt === null) {
        watch.lastHealthy = now;
        record.observeInheritedHealth(owner.current, slot, now);
        record.clearInheritedChildHold(owner.current, slot, now);
        if (slot.phase === 'admitted') record.serving(slot, child);
        if (slot.buildSetId === originalManifest.buildSetId)
          settleRequests(record, owner.current, originalManifest, true);
        if (
          process.connected &&
          process.ppid === child.pid &&
          probeProcessIncarnation(child.pid) === child.incarnation
        ) {
          if (repairBridge === null) {
            repairBridge = createRepairBridge(record, owner, runDir, timing, startupBudgetMs);
            if (replacement) process.send?.({ kind: 'coral-repair-bridge-ready', challenge: recoveryChallenge });
          }
        }
        const incumbentManifest =
          slot.buildSetId === originalManifest.buildSetId
            ? originalManifest
            : record
                .read()
                .requests.filter((request) => request.buildSetId === slot.buildSetId)
                .map((request) => validatedExecutable(request.executable))
                .find((manifest) => manifest !== null);
        if (incumbentManifest !== undefined && incumbentManifest !== null) {
          for (const request of record.read().requests) {
            if (record.read().attempt !== null && record.read().attempt?.phase !== 'exited') break;
            if (
              (request.status !== 'recorded' && request.status !== 'accepted') ||
              request.buildSetId === slot.buildSetId
            )
              continue;
            const target = validatedExecutable(request.executable);
            if (target === null || compareProductVersions(target.version, incumbentManifest.version) <= 0) continue;
            if (now - (lastInheritedRequest.get(request.id) ?? 0) < 10_000) continue;
            lastInheritedRequest.set(request.id, now);
            await requestInheritedSuccession(runDir, incumbentManifest.flavor, child.pid, request.id, {
              build: target,
              pluginRootLabel: dirname(dirname(request.executable)),
            });
            break;
          }
        }
      }
      const live = currentInheritedChild(snapshot, child);
      if (live === null) {
        inheritedWatch.delete(snapshot.id);
        continue;
      }
      slot = live;
      watch.terminationAt = slot.terminationAt ?? watch.terminationAt;
      now = Date.now();
      const overdue =
        (slot.phase === 'admitted' && now >= (slot.admittedAt ?? watch.firstSeen) + startupBudgetMs) ||
        (slot.phase === 'serving' && now - watch.lastHealthy >= timing.lapseMs);
      if (!overdue && watch.terminationAt === null) continue;
      if (watch.terminationAt !== null) {
        if (
          now >= (slot.killAt ?? watch.terminationAt + timing.graceMs) &&
          record.commitTermination(owner.current, slot, child, now, timing.graceMs) &&
          !signalInheritedChild(record, owner.current, slot, 'SIGKILL')
        ) {
          if (!record.holdInheritedChild(owner.current, slot, now)) inheritedWatch.delete(slot.id);
        }
        continue;
      }
      if (childIsUninterruptible(child.pid)) {
        watch.uninterruptibleSince ??= now;
        if (now - watch.uninterruptibleSince < timing.dStateDeferralMs) continue;
      } else {
        watch.uninterruptibleSince = null;
      }
      if (record.commitTermination(owner.current, slot, child, now, timing.graceMs)) {
        watch.terminationAt = now;
        if (!signalInheritedChild(record, owner.current, slot, 'SIGTERM')) {
          if (!record.holdInheritedChild(owner.current, slot, now)) inheritedWatch.delete(slot.id);
        }
      } else if (!record.holdInheritedChild(owner.current, slot, now)) inheritedWatch.delete(slot.id);
    }
  }
  return { inherited, repairBridge };
}

async function superviseActiveChild(input: {
  record: CoordinatorLaunchRecord;
  owner: OwnerHandle;
  initial: RunningChild;
  reservation: LaunchReservation;
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  onChild?: (child: ChildProcess) => void;
}): Promise<boolean> {
  const { record, owner, initial, reservation, runDir, timing, startupBudgetMs, onChild } = input;
  onChild?.(initial.child);
  let current = initial;
  type PendingAttempt = Readonly<{
    attemptId?: string;
    reservation: LaunchReservation;
    running: RunningChild;
    retirement: ChildRetirement;
    watch: Promise<WatchResult>;
  }>;
  const pending: { value: PendingAttempt | null } = { value: null };
  const lastDispatch = new Map<string, number>();
  let startingAttempt: Promise<void> | null = null;
  const startAttempt = async (incumbentChild: ChildProcess, attemptId: string, bundleDir: string): Promise<void> => {
    try {
      const attempt = await launchSuccessionAttempt({
        record,
        owner,
        runDir,
        bundleDir,
        attemptId,
        timing,
        startupBudgetMs,
        forwardParentMessages: true,
        beforeReserve: async () => {
          const contender = pending.value;
          if (contender !== null && contender.attemptId === undefined) {
            retireOwnedChild(
              record,
              owner,
              contender.reservation,
              contender.running,
              contender.retirement,
              timing.graceMs,
            );
            await contender.watch;
            if (pending.value === contender) pending.value = null;
          }
          if (pending.value !== null) throw new Error('Succession attempt is already active');
        },
        route: (running, message, handle) => route(running.child, message, handle),
        onExit: (attempt, result) => {
          if (incumbentChild.connected)
            incumbentChild.send({
              kind: 'coral-supervisor-attempt-exit',
              attemptId,
              exitCode: result.exitCode,
              signal: result.signal,
            });
          if (pending.value?.attemptId === attemptId && current.child === incumbentChild) pending.value = null;
        },
      });
      pending.value = { ...attempt, attemptId };
      incumbentChild.send({ kind: 'coral-supervisor-attempt-spawned', attemptId, pid: attempt.running.identity.pid });
    } catch (error: unknown) {
      if (incumbentChild.connected)
        incumbentChild.send({ kind: 'coral-supervisor-attempt-error', attemptId, reason: String(error) });
    }
  };
  const route = (source: ChildProcess, message: unknown, handle: unknown): boolean => {
    if (owner.lost || record.read().owner?.epoch !== owner.current.epoch) {
      closeHandle(handle);
      return true;
    }
    if (typeof message !== 'object' || message === null || !('kind' in message)) return false;
    const attempt = pending.value;
    if (source === current.child) {
      if (
        message.kind === 'coral-supervisor-start-attempt' &&
        'attemptId' in message &&
        typeof message.attemptId === 'string' &&
        'bundleDir' in message &&
        typeof message.bundleDir === 'string'
      ) {
        startingAttempt = startAttempt(source, message.attemptId, message.bundleDir);
        return true;
      }
      if (
        message.kind === 'coral-supervisor-relay' &&
        'attemptId' in message &&
        attempt !== null &&
        attempt.attemptId === message.attemptId
      ) {
        const target = attempt.running.child;
        const payload = 'message' in message ? message.message : null;
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'kind' in payload &&
          payload.kind === 'coral-sentinel-retire-child'
        )
          retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
        else if (target.connected)
          target.send(payload as Parameters<typeof target.send>[0], handle as SendHandle, () => closeHandle(handle));
        else closeHandle(handle);
        return true;
      }
      if (
        message.kind === 'coral-supervisor-retire-attempt' &&
        'attemptId' in message &&
        attempt !== null &&
        attempt.attemptId === message.attemptId
      ) {
        retireOwnedChild(record, owner, attempt.reservation, attempt.running, attempt.retirement, timing.graceMs);
        return true;
      }
    } else if (attempt !== null && source === attempt.running.child) {
      if (attempt.attemptId === undefined) {
        closeHandle(handle);
        return true;
      }
      if (current.child.connected)
        current.child.send(
          {
            kind: 'coral-supervisor-attempt-message',
            attemptId: attempt.attemptId,
            message,
          },
          handle as SendHandle,
          () => closeHandle(handle),
        );
      else closeHandle(handle);
      return true;
    }
    return false;
  };
  let watched = watchChild(
    current.child,
    current.executable,
    current.manifest,
    reservation,
    current.identity,
    current.sentinelId,
    record,
    runDir,
    owner,
    timing,
    startupBudgetMs,
    { at: null },
    (message, handle) => route(initial.child, message, handle),
  );
  const requestPoll = setInterval(() => {
    try {
      if (owner.lost || pending.value !== null || current.child.exitCode !== null || current.child.signalCode !== null)
        return;
      const state = record.read();
      const serving =
        state.launch?.phase === 'serving' && state.launch.child?.pid === current.identity.pid ? current.manifest : null;
      settleRequests(record, owner.current, current.manifest, serving !== null);
      if (serving === null) return;
      const currentBuild = serving.buildSetId;
      for (const request of record.read().requests) {
        if (request.buildSetId === currentBuild && (request.status === 'recorded' || request.status === 'accepted')) {
          record.complete(owner.current, request.id, Date.now());
          continue;
        }
        if (
          (request.status !== 'recorded' && request.status !== 'accepted') ||
          Date.now() - (lastDispatch.get(request.id) ?? 0) < 10_000
        )
          continue;
        const manifest = targetValidation(request.executable);
        if (manifest === 'absent') {
          record.unavailable(owner.current, request.id, Date.now());
          continue;
        }
        if (manifest === 'indeterminate') continue;
        if (manifest?.buildSetId !== request.buildSetId) continue;
        const contenderReservation = record.reserve(owner.current, manifest.buildSetId, 'contender', Date.now());
        if (contenderReservation === null) continue;
        lastDispatch.set(request.id, Date.now());
        const running = spawnAdmittedChild(record, owner.current, contenderReservation, request.executable, [], runDir);
        if (running === null) break;
        const retirement: ChildRetirement = { at: null };
        const watch = watchChild(
          running.child,
          running.executable,
          running.manifest,
          contenderReservation,
          running.identity,
          running.sentinelId,
          record,
          runDir,
          owner,
          timing,
          startupBudgetMs,
          retirement,
          (message, handle) => route(running.child, message, handle),
        );
        pending.value = { reservation: contenderReservation, running, retirement, watch };
        void watch.then(() => {
          if (pending.value?.running.child === running.child && current.child !== running.child) pending.value = null;
        });
        break;
      }
    } catch (error: unknown) {
      process.stderr.write(`Coordinator request observation failed: ${String(error)}\n`);
    }
  }, 500);
  let result: WatchResult;
  while (true) {
    result = await watched;
    await Promise.resolve(startingAttempt);
    const successor = pending.value;
    if (successor === null || successor.running.child.exitCode !== null || successor.running.child.signalCode !== null)
      break;
    if (record.normalize(owner.current, Date.now()) === null) break;
    current = successor.running;
    watched = successor.watch;
    pending.value = null;
  }
  clearInterval(requestPoll);
  if (result.served) settleRequests(record, owner.current, current.manifest, true);
  if (
    result.served &&
    result.exitCode === 0 &&
    !result.wedged &&
    record.read().requests.every((request) => request.status === 'completed' || request.status === 'unavailable')
  ) {
    if (record.release(owner.current)) return true;
  }
  return false;
}

export async function runNamespaceSupervisor(
  executable: string,
  args: readonly string[],
  runDir: string,
  options: Readonly<{
    timing?: SentinelTiming;
    startupBudgetMs?: number;
    onChild?: (child: ChildProcess) => void;
  }> = {},
): Promise<number> {
  const timing = options.timing ?? SENTINEL_TIMING;
  if (!validSentinelTiming(timing)) throw new Error('Invalid coordinator supervisor timing');
  const startupBudgetMs = options.startupBudgetMs ?? STARTUP_BUDGET_MS;
  const originalManifest = validatedExecutable(executable);
  if (originalManifest === null) return 1;
  const record = new CoordinatorLaunchRecord(runDir);
  try {
    const acquisition = await acquireLaunchOwnership(record, executable, originalManifest);
    if (acquisition.kind === 'finished') return acquisition.exitCode;
    const { owner, holderIdentity, incarnation, replacement, recoveryChallenge } = acquisition;
    const original = { executable, buildSetId: originalManifest.buildSetId };
    const tried = new Set<string>();
    const inheritedWatch = new Map<string, InheritedWatch>();
    const lastInheritedRequest = new Map<string, number>();
    let repairBridge: ReturnType<typeof createRepairBridge> | null = null;
    let firstLaunch = true;
    while (true) {
      record.reconcileReplacementSignalHolds();
      const renewed = record.renew(owner.current, Date.now());
      if (renewed === null && !owner.lost) {
        const reacquired = record.acquire(holderIdentity, Date.now());
        if (reacquired !== null) {
          owner.current = reacquired;
          continue;
        }
      }
      if (renewed === null || owner.lost) {
        owner.lost = true;
        repairBridge?.close();
        repairBridge = null;
        while (true) {
          let ownsUnsettledChild = false;
          for (const slot of [record.read().launch, record.read().attempt]) {
            if (
              slot === null ||
              (slot.phase !== 'admitted' && slot.phase !== 'serving') ||
              slot.parent?.pid !== process.pid ||
              slot.parent.incarnation !== incarnation ||
              slot.child === undefined
            )
              continue;
            const liveness = incumbentLiveness(slot.child);
            if (liveness === 'alive' || liveness === 'unknown') ownsUnsettledChild = true;
          }
          if (!ownsUnsettledChild) break;
          await sleep(POLL_MS);
        }
        return 1;
      }
      owner.current = renewed;
      settleRequests(record, owner.current, null);
      const reconciled = await reconcileInheritedChildren({
        record,
        owner,
        runDir,
        originalManifest,
        timing,
        startupBudgetMs,
        inheritedWatch,
        lastInheritedRequest,
        repairBridge,
        replacement,
        recoveryChallenge,
        incarnation,
      });
      const { inherited } = reconciled;
      repairBridge = reconciled.repairBridge;
      if (owner.lost || record.read().owner?.epoch !== owner.current.epoch) {
        owner.lost = true;
        repairBridge?.close();
        repairBridge = null;
        continue;
      }
      record.normalize(owner.current, Date.now());
      const adoptedChild = repairBridge?.child(record.read().launch?.id);
      if (adoptedChild !== null && adoptedChild !== undefined) {
        let current: RepairChild = adoptedChild;
        const requestPoll = setInterval(() => {
          try {
            if (record.read().launch?.phase !== 'serving') return;
            settleRequests(record, owner.current, current.running.manifest, true);
            for (const request of record.read().requests) {
              if (request.status !== 'recorded' && request.status !== 'accepted') continue;
              const target = validatedExecutable(request.executable);
              if (
                target === null ||
                compareProductVersions(target.version, current.running.manifest.version) <= 0 ||
                Date.now() - (lastInheritedRequest.get(request.id) ?? 0) < 10_000
              )
                continue;
              lastInheritedRequest.set(request.id, Date.now());
              void requestInheritedSuccession(
                runDir,
                current.running.manifest.flavor,
                current.running.identity.pid,
                request.id,
                {
                  build: target,
                  pluginRootLabel: dirname(dirname(request.executable)),
                },
              );
              break;
            }
          } catch (error: unknown) {
            process.stderr.write(`Inherited successor request observation failed: ${String(error)}\n`);
          }
        }, 500);
        let result: WatchResult;
        try {
          while (true) {
            result = await current.watch;
            record.normalize(owner.current, Date.now());
            const next = repairBridge?.child(record.read().launch?.id);
            if (next === null || next === undefined || next.reservation.id === current.reservation.id) break;
            current = next;
          }
        } finally {
          clearInterval(requestPoll);
          repairBridge?.close();
          repairBridge = null;
        }
        if (result.served) settleRequests(record, owner.current, current.running.manifest, true);
        if (
          result.served &&
          result.exitCode === 0 &&
          !result.wedged &&
          record.read().requests.every((entry) => entry.status === 'completed' || entry.status === 'unavailable') &&
          record.release(owner.current)
        )
          return 0;
        continue;
      }
      const settled = record.read();
      const slots = [settled.launch, settled.attempt];
      if (
        slots.some(
          (slot) => slot !== null && (slot.parent?.pid !== process.pid || slot.parent.incarnation !== incarnation),
        ) &&
        slots.every((slot) => slot === null || slot.phase === 'exited') &&
        settled.requests.every((entry) => entry.status === 'completed' || entry.status === 'unavailable') &&
        controllerBuild(runDir).kind === 'none' &&
        record.release(owner.current)
      )
        return 0;
      if (inherited.length > 0) {
        await sleep(POLL_MS);
        continue;
      }
      const recordedIncumbents = record
        .read()
        .requests.filter((request) => request.status === 'recorded' || request.status === 'accepted')
        .flatMap((request) => (request.incumbent === undefined ? [] : [request.incumbent]));
      let incumbentHeld = false;
      for (const recorded of recordedIncumbents) {
        if (recorded.pid === process.pid) continue;
        const liveness = incumbentLiveness(recorded);
        if (liveness === 'alive' || liveness === 'unknown') incumbentHeld = true;
      }
      if (incumbentHeld) {
        await sleep(POLL_MS);
        continue;
      }
      const incumbent = incumbentAt(runDir);
      if (
        !firstLaunch &&
        incumbent !== null &&
        incumbent.pid !== process.pid &&
        incumbentLiveness(incumbent) !== 'absent'
      ) {
        await sleep(POLL_MS);
        continue;
      }
      const eligible = candidates(record, runDir, original, originalManifest);
      const available = eligible.filter((candidate) => !tried.has(candidate.executable));
      if (available.length === 0) {
        const controller = controllerBuild(runDir);
        const state = record.read();
        if (
          eligible.length === 0 &&
          controller.kind === 'none' &&
          state.requests.every((request) => request.status === 'completed' || request.status === 'unavailable') &&
          [state.launch, state.attempt].every((slot) => slot === null || slot.phase === 'exited') &&
          record.release(owner.current)
        )
          return 0;
        const unreadable = readCustodyLedger(
          createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
            baseDir: dirname(dirname(runDir)),
          }),
          runDir,
        ).find((entry) => entry.kind === 'unreadable');
        if (unreadable?.kind === 'unreadable') {
          if (!record.holdUnreadableCustody(owner.current, unreadable.path, Date.now())) continue;
        } else if (record.read().hold?.kind !== 'target-indeterminate') {
          if (
            !record.hold(
              owner.current,
              controller.kind === 'required' ? controller.buildSetId : controller.kind,
              Date.now(),
            )
          )
            continue;
        }
        tried.clear();
        await sleep(2_000);
        continue;
      }
      record.clearHold(owner.current, Date.now());
      const candidate = available[0];
      firstLaunch = false;
      tried.add(candidate.executable);
      const legacyRequest = record
        .read()
        .requests.find(
          (request) =>
            request.executable === candidate.executable &&
            request.incumbent !== undefined &&
            (request.status === 'accepted' || request.status === 'recorded'),
        );
      const purpose = legacyRequest !== undefined ? 'legacy-retirement' : tried.size === 1 ? 'startup' : 'recovery';
      const reservation = record.reserve(owner.current, candidate.buildSetId, purpose, Date.now());
      if (reservation === null) {
        await sleep(POLL_MS);
        continue;
      }
      const initial = spawnAdmittedChild(record, owner.current, reservation, candidate.executable, args, runDir);
      if (initial === null) {
        await sleep(POLL_MS);
        continue;
      }
      if (
        await superviseActiveChild({
          record,
          owner,
          initial,
          reservation,
          runDir,
          timing,
          startupBudgetMs,
          onChild: options.onChild,
        })
      )
        return 0;
    }
  } finally {
    record.close();
  }
}
