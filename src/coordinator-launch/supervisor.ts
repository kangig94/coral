import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection, Server, Socket } from 'node:net';
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
import { SupervisorLaunchMemory, type LaunchOwner, type LaunchProcess, type LaunchReservation } from './state.js';
import { attemptExclusiveFileLockSync, createSharedFileLockSync, type FileLockLease } from '../infra/fs-lock.js';
import { socketPathForRunDir, supervisorLockPath } from '../infra/path/index.js';
import {
  incarnationMayAuthorizeSignal,
  observeProcessLiveness,
  probeProcessIncarnation,
  type ProcessLiveness,
} from '../infra/node-process.js';
import { SENTINEL_TIMING, validSentinelTiming, type SentinelTiming } from '../infra/sentinel-timing.js';
import { readUpgradeIntent, retryUpgradeIntentCas, type UpgradeIntent } from '../infra/upgrade-intent.js';
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
import { listLaunchAdmissions, readLaunchAdmission } from '../infra/launch-admission-record.js';
import { replacementServing, requestInheritedSuccession } from './health.js';
import { recordLegacyUpgradeIntent } from './request.js';
import { relaunchRoots, validatedBuild } from './selection.js';

const STARTUP_BUDGET_MS = 120_000;
const POLL_MS = 200;
const UNIDENTIFIED_INCUMBENT = 'unidentified-starting-incumbent';

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

function pendingIntent(runDir: string): UpgradeIntent | null {
  const observed = readUpgradeIntent(runDir);
  return observed.kind === 'readable' &&
    observed.intent.legacyRetirement === true &&
    (observed.intent.disposition === 'pending' ||
      observed.intent.disposition === 'deferred' ||
      observed.intent.disposition === 'attempting')
    ? observed.intent
    : null;
}

function pendingExecutable(intent: UpgradeIntent): string {
  return join(intent.target.pluginRootLabel, 'bridge', 'coral-backend.cjs');
}

async function closeUnavailableLegacyRequest(runDir: string, requestId: string): Promise<void> {
  await retryUpgradeIntentCas(runDir, (observed) => {
    if (observed.kind !== 'readable') return { kind: 'settle', value: undefined };
    const intent = observed.intent;
    if (
      intent.requestId !== requestId ||
      intent.legacyRetirement !== true ||
      intent.disposition === 'closed' ||
      intent.disposition === 'completed' ||
      intent.attemptId !== null ||
      intent.attemptChild !== null ||
      targetValidation(pendingExecutable(intent)) !== 'absent'
    )
      return { kind: 'settle', value: undefined };
    return {
      kind: 'write',
      expectedRevision: intent.revision,
      change: { ...intent, disposition: 'closed' as const, retryCondition: null },
      settle: () => undefined,
    };
  });
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
  runDir: string,
  original: Candidate,
  originalManifest: StrictBundleManifest,
  originalOutstanding: boolean,
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
  const pending = pendingIntent(runDir);
  const requested =
    pending !== null && validatedExecutable(pendingExecutable(pending))?.buildSetId === pending.target.build.buildSetId
      ? [{ executable: pendingExecutable(pending), buildSetId: pending.target.build.buildSetId }]
      : [];
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
        ...(originalOutstanding ? [original] : []),
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
type OwnerHandle = { current: LaunchOwner; lost: boolean; release: FileLockLease };
type ChildRetirement = { at: number | null };
function retireOwnedChild(
  record: SupervisorLaunchMemory,
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
  record: SupervisorLaunchMemory,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  identity: LaunchProcess,
): boolean {
  const state = record.read();
  const slot = [state.launch, state.attempt].find((entry) => entry?.id === reservation.id);
  return (
    state.owner.id === owner.id &&
    slot?.terminationAt !== undefined &&
    slot.child?.pid === identity.pid &&
    slot.child.incarnation === identity.incarnation
  );
}

function signalInheritedChild(
  record: SupervisorLaunchMemory,
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
  record: SupervisorLaunchMemory,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  executable: string,
  args: readonly string[],
  runDir: string,
  attemptId?: string,
): RunningChild | null {
  const manifest = validatedExecutable(executable);
  if (manifest === null) {
    record.cancelReservation(reservation);
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
      record.cancelReservation(reservation);
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
  if (!record.spawned(reservation, owner.process, { pid, incarnation }))
    throw new Error('Spawned child lost its reservation');
  return { child, identity: { pid, incarnation }, sentinelId, executable, manifest };
}

type WatchChildContext = Readonly<{
  running: RunningChild;
  reservation: LaunchReservation;
  record: SupervisorLaunchMemory;
  runDir: string;
  owner: OwnerHandle;
  timing: SentinelTiming;
  startupBudgetMs: number;
  retirement: ChildRetirement;
  route?: (message: unknown, handle: unknown) => boolean;
  forwardParentMessages?: boolean;
}>;

type ChildWatchState = {
  armed: boolean;
  pendingHello: boolean;
  lastAnswer: number;
  lastWake: number;
  outstanding: number | null;
  sequence: number;
  escalationAt: number | null;
  killed: boolean;
  lastKillAttemptAt: number;
  wedged: boolean;
  dStateSince: number | null;
  served: boolean;
  discovered: boolean;
  admitted: boolean;
  startupDeadline: number;
  disconnectedAt: number | null;
};

function monitorChildHeartbeat(input: {
  child: ChildProcess;
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  timing: SentinelTiming;
  retirement: ChildRetirement;
  state: ChildWatchState;
  escalateChild: (now: number) => 'sent' | 'absent' | 'held' | 'refused';
}): void {
  const { child, record, owner, reservation, identity, timing, retirement, state, escalateChild } = input;
  const now = Date.now();
  const gap = now - state.lastWake;
  state.lastWake = now;
  if (gap > timing.schedulingGapMs) {
    state.lastAnswer = now;
    state.outstanding = null;
    state.startupDeadline += gap;
  }
  if (record.read().owner.id !== owner.current.id) {
    owner.lost = true;
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (owner.lost || record.read().owner.id !== owner.current.id) return;
  state.escalationAt ??= retirement.at;
  if (state.escalationAt !== null) {
    if (!state.killed && now - state.escalationAt >= timing.graceMs && now - state.lastKillAttemptAt >= 1_000) {
      state.lastKillAttemptAt = now;
      if (escalateChild(now) === 'sent') state.killed = true;
    }
    return;
  }
  state.disconnectedAt = child.connected ? null : (state.disconnectedAt ?? now);
  if (state.dStateSince !== null && child.pid !== undefined && !childIsUninterruptible(child.pid)) {
    state.dStateSince = null;
    state.lastAnswer = now;
    state.outstanding = null;
  }
  if (
    (!state.served && now >= state.startupDeadline) ||
    (state.disconnectedAt !== null && now - state.disconnectedAt >= timing.lapseMs) ||
    (child.connected &&
      state.pendingHello &&
      (now - state.lastAnswer >= timing.lapseMs ||
        (state.dStateSince !== null && now - state.dStateSince >= timing.dStateDeferralMs)))
  ) {
    if (child.pid !== undefined && childIsUninterruptible(child.pid) && state.dStateSince === null)
      state.dStateSince = now;
    if (state.dStateSince !== null && now - state.dStateSince < timing.dStateDeferralMs) {
      state.lastAnswer = now;
    } else {
      state.wedged = true;
      if (!record.commitTermination(owner.current, reservation, identity, now, timing.graceMs)) {
        owner.lost = true;
        return;
      }
      if (
        terminationCommitted(record, owner.current, reservation, identity) &&
        probeProcessIncarnation(identity.pid) === identity.incarnation
      )
        child.kill('SIGTERM');
      state.escalationAt = now;
    }
    return;
  }
  if (state.admitted && state.armed && state.pendingHello && state.outstanding === null && child.connected) {
    state.outstanding = ++state.sequence;
    child.send({ kind: 'coral-sentinel-challenge', id: state.outstanding });
  }
}

function relayWatchedChildMessage(input: {
  message: unknown;
  handle: unknown;
  child: ChildProcess;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  runDir: string;
  sentinelId: string;
  owner: OwnerHandle;
  record: SupervisorLaunchMemory;
  state: ChildWatchState;
  route: (message: unknown, handle: unknown) => boolean;
}): void {
  const { message, handle, child, reservation, identity, runDir, sentinelId, owner, record, state, route } = input;
  if (owner.lost || record.read().owner.id !== owner.current.id) {
    closeHandle(handle);
    return;
  }
  if (typeof message === 'object' && message !== null && 'kind' in message) {
    if (
      message.kind === 'coral-launch-admitted' &&
      'pid' in message &&
      message.pid === child.pid &&
      'launchId' in message &&
      typeof message.launchId === 'string'
    ) {
      const admission = readLaunchAdmission(runDir, message.launchId);
      if (
        admission.kind === 'readable' &&
        admission.admission.child.pid === child.pid &&
        admission.admission.child.incarnation === identity.incarnation &&
        admission.admission.parent.pid === process.pid &&
        admission.admission.parent.incarnation === owner.current.process.incarnation &&
        record.admit(reservation, owner.current.process, identity, admission.admission.admittedAt)
      ) {
        state.admitted = true;
        child.send({ kind: 'coral-launch-acknowledged', launchId: reservation.id });
      }
    }
    if (
      message.kind === 'coral-launch-discovered' &&
      state.admitted &&
      'pid' in message &&
      message.pid === child.pid &&
      'launchId' in message &&
      message.launchId === reservation.id
    )
      state.discovered = true;
    if (message.kind === 'coral-sentinel-hello' && 'id' in message && message.id === sentinelId) {
      state.pendingHello = true;
      state.lastAnswer = Date.now();
      if (state.armed) child.send({ kind: 'coral-sentinel-armed', id: sentinelId });
    }
    if (message.kind === 'coral-sentinel-answer' && 'id' in message && message.id === state.outstanding) {
      state.outstanding = null;
      state.lastAnswer = Date.now();
    }
    if (route(message, handle)) return;
    if (String(message.kind).startsWith('coral-')) return;
  } else if (route(message, handle)) return;
  if (process.connected)
    process.send?.(message as Parameters<NonNullable<typeof process.send>>[0], handle as SendHandle, () =>
      closeHandle(handle),
    );
  else closeHandle(handle);
}

function escalateWatchedChild(input: {
  child: ChildProcess;
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  timing: SentinelTiming;
  now: number;
}): 'sent' | 'absent' | 'held' | 'refused' {
  const { child, record, owner, reservation, identity, timing, now } = input;
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
      record.clearSignalRefusal(reservation);
      return 'sent';
    }
  }
  if (observeProcessLiveness(identity.pid) === 'absent') {
    record.settleAbsentChild(reservation);
    return 'absent';
  }
  return record.holdSignalRefusal(owner.current, reservation, identity) ? 'held' : 'refused';
}

function pollWatchedChildServing(input: {
  child: ChildProcess;
  manifest: StrictBundleManifest;
  reservation: LaunchReservation;
  identity: LaunchProcess;
  record: SupervisorLaunchMemory;
  runDir: string;
  state: ChildWatchState;
}): void {
  const { child, manifest, reservation, identity, record, runDir, state } = input;
  if (!state.admitted || child.pid === undefined || state.served) return;
  const launchState = record.read();
  if (
    ![launchState.launch, launchState.attempt].some(
      (launch) => launch?.id === reservation.id && launch.phase === 'admitted',
    )
  )
    return;
  void replacementServing(runDir, manifest.flavor, child.pid).then((ready) => {
    if (ready && record.serving(reservation, identity)) state.served = true;
  });
}

async function watchChild({
  running: { child, manifest, identity, sentinelId },
  reservation,
  record,
  runDir,
  owner,
  timing,
  startupBudgetMs,
  retirement,
  route = () => false,
  forwardParentMessages = true,
}: WatchChildContext): Promise<WatchResult> {
  const lastAnswer = Date.now();
  const state: ChildWatchState = {
    armed: false,
    pendingHello: false,
    lastAnswer,
    lastWake: lastAnswer,
    outstanding: null,
    sequence: 0,
    escalationAt: null,
    killed: false,
    lastKillAttemptAt: 0,
    wedged: false,
    dStateSince: null,
    served: false,
    discovered: false,
    admitted: false,
    startupDeadline: Date.now() + startupBudgetMs,
    disconnectedAt: null,
  };

  const childExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.on('message', (message: unknown, handle: unknown) =>
    relayWatchedChildMessage({
      message,
      handle,
      child,
      reservation,
      identity,
      runDir,
      sentinelId,
      owner,
      record,
      state,
      route,
    }),
  );
  const parentMessage = (message: unknown, handle: unknown): void => {
    if (owner.lost || record.read().owner.id !== owner.current.id) {
      closeHandle(handle);
      return;
    }
    if (child.connected)
      child.send(message as Parameters<typeof child.send>[0], handle as SendHandle, () => closeHandle(handle));
    else closeHandle(handle);
  };
  if (forwardParentMessages) process.on('message', parentMessage);
  const escalateChild = (now: number): 'sent' | 'absent' | 'held' | 'refused' =>
    escalateWatchedChild({ child, record, owner, reservation, identity, timing, now });
  const interval = setInterval(
    () =>
      monitorChildHeartbeat({ child, record, owner, reservation, identity, timing, retirement, state, escalateChild }),
    timing.challengeMs,
  );
  child.once('spawn', () => {
    child.send({
      kind: 'coral-launch-admit',
      runDir,
      launchId: reservation.id,
      build: {
        version: manifest.version,
        buildSetId: manifest.buildSetId,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
      },
      purpose: reservation.purpose,
      parent: owner.current.process,
    });
    state.armed = true;
    if (state.pendingHello) child.send({ kind: 'coral-sentinel-armed', id: sentinelId });
  });
  const servingPoll = setInterval(
    () => pollWatchedChildServing({ child, manifest, reservation, identity, record, runDir, state }),
    POLL_MS,
  );
  // A disconnected child can only be handed to a replacement supervisor that takes the released lock; until one does,
  // this parent reacquires before the disconnect lapse, so a child that wedges after release is still retired.
  let handoffReleasedAt: number | null = null;
  const detachedHealthPoll = setInterval(() => {
    if (child.connected || owner.lost) return;
    if (handoffReleasedAt !== null) {
      const attempt = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
      if (attempt.kind === 'contended') owner.lost = true;
      else if (attempt.kind === 'acquired') {
        if (Date.now() - handoffReleasedAt < timing.lapseMs / 2) attempt.lease();
        else {
          owner.release = attempt.lease;
          handoffReleasedAt = null;
        }
      }
      return;
    }
    void replacementServing(runDir, manifest.flavor, identity.pid).then((healthy) => {
      if (!healthy || child.connected || owner.lost || handoffReleasedAt !== null) return;
      if (!state.served && record.serving(reservation, identity)) state.served = true;
      owner.release();
      handoffReleasedAt = Date.now();
    });
  }, POLL_MS);
  const { exitCode, signal } = await childExit;
  clearInterval(interval);
  clearInterval(servingPoll);
  clearInterval(detachedHealthPoll);
  if (forwardParentMessages) process.off('message', parentMessage);
  removeExitedChildDiscovery(runDir, identity);
  if (!record.exited(reservation, identity)) record.cancelReservation(reservation);
  return { exitCode, signal, served: state.served || (state.discovered && exitCode === 0), wedged: state.wedged };
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
  record: SupervisorLaunchMemory;
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
  const launch = input.record.read().launch;
  if (
    launch?.phase === 'admitted' &&
    launch.child !== undefined &&
    (await replacementServing(input.runDir, manifest.flavor, launch.child.pid))
  )
    input.record.serving(launch, launch.child);
  const active = input.record.read().attempt;
  if (active !== null && active.phase !== 'exited') throw new Error('Succession attempt is already active');
  const reservation = input.record.reserve(input.owner.current, manifest.buildSetId, 'succession');
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
  const watch = watchChild({
    running,
    reservation,
    record: input.record,
    runDir: input.runDir,
    owner: input.owner,
    timing: input.timing,
    startupBudgetMs: input.startupBudgetMs,
    retirement,
    route: (message, handle) => input.route(running, message, handle),
    forwardParentMessages: input.forwardParentMessages,
  });
  const attempt = { reservation, running, retirement, watch };
  void watch.then((result) => input.onExit(attempt, result));
  return attempt;
}

function createRepairBridge(
  record: SupervisorLaunchMemory,
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
    if (owner.lost || record.read().owner.id !== owner.current.id) {
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
      record: SupervisorLaunchMemory;
      owner: OwnerHandle;
      incarnation: NonNullable<ReturnType<typeof probeProcessIncarnation>>;
      replacement: boolean;
      recoveryChallenge: string | undefined;
    }>;

function observedLaunchIncumbent(
  runDir: string,
  flavor: StrictBundleManifest['flavor'],
): UpgradeIntent['incumbent'] | null {
  const runtime = createRealRuntime(flavor, { baseDir: dirname(dirname(runDir)) });
  const discovery = readDiscoveryRecordDisposition(runtime);
  if (
    discovery.kind === 'record' &&
    discovery.record.instanceId !== undefined &&
    discovery.record.version !== undefined &&
    discovery.record.incarnation !== undefined &&
    probeProcessIncarnation(discovery.record.pid) === discovery.record.incarnation
  )
    return {
      instanceId: discovery.record.instanceId,
      pid: discovery.record.pid,
      incarnation: discovery.record.incarnation,
      version: discovery.record.version,
      bundleHash: discovery.record.bundleHash,
      flavor,
    };
  const admission = listLaunchAdmissions(runDir)
    .filter((entry): entry is Extract<typeof entry, { kind: 'readable' }> => entry.kind === 'readable')
    .map((entry) => entry.admission)
    .filter((entry) => probeProcessIncarnation(entry.child.pid) === entry.child.incarnation)
    .sort((a, b) => b.admittedAt - a.admittedAt)[0];
  if (admission === undefined) return null;
  if (admission.build.flavor !== flavor) return null;
  return {
    instanceId: `launch:${admission.launchId}`,
    pid: admission.child.pid,
    incarnation: admission.child.incarnation,
    version: admission.build.version,
    bundleHash: admission.build.bundleHash,
    flavor,
  };
}

function publishedNativeSupervision(runDir: string, slot: LaunchReservation): boolean {
  const child = slot.child;
  if (child === undefined) return false;
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
    baseDir: dirname(dirname(runDir)),
  });
  const discovery = readDiscoveryRecordDisposition(runtime);
  return (
    discovery.kind === 'record' &&
    discovery.record.pid === child.pid &&
    discovery.record.incarnation === child.incarnation &&
    discovery.record.supervision?.launchId === slot.id
  );
}

function upgradeOutstanding(runDir: string, buildSetId: string): boolean {
  const observed = readUpgradeIntent(runDir);
  if (
    observed.kind !== 'readable' ||
    observed.intent.disposition === 'completed' ||
    observed.intent.disposition === 'closed'
  )
    return false;
  return (
    observed.intent.target.build.buildSetId === buildSetId ||
    observed.intent.nextTarget?.target.build.buildSetId === buildSetId
  );
}

async function socketClaimedBeforeDiscovery(runDir: string, flavor: StrictBundleManifest['flavor']): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPathForRunDir(runDir, flavor, { platform: process.platform }));
    const finish = (claimed: boolean): void => {
      socket.destroy();
      resolve(claimed);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function recordUnidentifiedIncumbentRequest(
  runDir: string,
  owner: LaunchOwner,
  target: UpgradeIntent['target'],
): Promise<void> {
  await retryUpgradeIntentCas(runDir, (observed) => {
    if (observed.kind !== 'absent' && observed.kind !== 'readable') return { kind: 'settle', value: undefined };
    const current = observed.kind === 'readable' ? observed.intent : null;
    if (current !== null && current.disposition !== 'closed' && current.disposition !== 'completed')
      return { kind: 'settle', value: undefined };
    return {
      kind: 'write',
      expectedRevision: current?.revision ?? null,
      change: {
        requestId: randomUUID(),
        incumbent: {
          instanceId: UNIDENTIFIED_INCUMBENT,
          pid: owner.process.pid,
          incarnation: owner.process.incarnation,
          version: '0.0.0',
          bundleHash: 'unidentified',
          flavor: target.build.flavor,
        },
        target,
        legacyRetirement: true,
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        disposition: 'deferred' as const,
        blockers: [{ owner: 'protocol', reason: 'bound incumbent has not published its identity' }],
        retryCondition: { kind: 'obligation-change' as const, evidence: 'incumbent discovery' },
        attemptDeadline: null,
        completionReceipt: null,
      },
      settle: () => undefined,
    };
  });
}

async function acquireLaunchOwnership(
  runDir: string,
  executable: string,
  manifest: StrictBundleManifest,
): Promise<OwnershipAcquisition> {
  const incarnation = probeProcessIncarnation(process.pid);
  if (incarnation === null) return { kind: 'finished', exitCode: 1 };
  const sourcePid = Number(process.env.CORAL_RECOVERY_SOURCE_PID);
  const recoveryChallenge = process.env.CORAL_RECOVERY_CHALLENGE;
  const sourceIncarnation = process.env.CORAL_RECOVERY_SOURCE_INCARNATION;
  const replacement =
    Number.isSafeInteger(sourcePid) &&
    sourcePid > 0 &&
    recoveryChallenge !== undefined &&
    sourceIncarnation !== undefined;
  let offered = false;
  const onOffer = (message: unknown): void => {
    if (
      !replacement ||
      process.ppid !== sourcePid ||
      probeProcessIncarnation(sourcePid) !== sourceIncarnation ||
      typeof message !== 'object' ||
      message === null ||
      !('kind' in message) ||
      message.kind !== 'coral-recovery-offer' ||
      !('challenge' in message) ||
      message.challenge !== recoveryChallenge
    )
      return;
    offered = true;
  };
  if (replacement) {
    process.on('message', onOffer);
    process.send?.({ kind: 'coral-recovery-ready', challenge: recoveryChallenge });
  }
  try {
    const path = supervisorLockPath(runDir);
    let requested = false;
    for (let retry = 0; !replacement || retry < 150; retry += 1) {
      if (replacement && (!process.connected || process.ppid !== sourcePid)) return { kind: 'finished', exitCode: 1 };
      if (replacement && !offered) {
        await sleep(POLL_MS);
        continue;
      }
      if (requested && !upgradeOutstanding(runDir, manifest.buildSetId)) return { kind: 'finished', exitCode: 0 };
      if (!existsSync(path)) {
        try {
          createSharedFileLockSync(path)();
        } catch {
          await sleep(POLL_MS);
          continue;
        }
      }
      const attempt = attemptExclusiveFileLockSync(path);
      if (attempt.kind === 'acquired') {
        try {
          const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, manifest.buildSetId);
          if (replacement) process.send?.({ kind: 'coral-recovery-owned', challenge: recoveryChallenge });
          return {
            kind: 'owned',
            record,
            owner: { current: record.read().owner, lost: false, release: attempt.lease },
            incarnation,
            replacement,
            recoveryChallenge,
          };
        } catch (error: unknown) {
          attempt.lease();
          throw error;
        }
      }
      if (attempt.kind === 'malformed') throw new Error(`Supervisor lock is malformed: ${path}`);
      if (attempt.kind === 'unobservable') throw attempt.cause;
      if (!replacement) {
        if (requested) {
          await sleep(POLL_MS);
          continue;
        }
        const incumbent = observedLaunchIncumbent(runDir, manifest.flavor);
        if (
          incumbent !== null &&
          incumbent.version === manifest.version &&
          incumbent.bundleHash === manifest.bundleHash
        ) {
          if (await replacementServing(runDir, manifest.flavor, incumbent.pid))
            return { kind: 'finished', exitCode: 0 };
        } else if (incumbent !== null) {
          const recorded = await recordLegacyUpgradeIntent({
            runDir,
            requestId: randomUUID(),
            incumbent,
            target: { build: manifest, pluginRootLabel: dirname(dirname(executable)) },
          });
          if (recorded.kind !== 'refused' || recorded.disposition !== 'deferred') {
            if (recorded.kind !== 'waiting') return { kind: 'finished', exitCode: 0 };
            requested = true;
            continue;
          }
        }
      }
      await sleep(POLL_MS);
    }
    return { kind: 'finished', exitCode: 1 };
  } finally {
    if (replacement) process.off('message', onOffer);
  }
}

type ReconcileInheritedInput = {
  record: SupervisorLaunchMemory;
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
};

async function reconcileInheritedChild(
  input: ReconcileInheritedInput,
  snapshot: LaunchReservation,
  repairBridge: ReturnType<typeof createRepairBridge> | null,
  currentInheritedChild: (snapshot: LaunchReservation, child: LaunchProcess) => LaunchReservation | null,
): Promise<ReturnType<typeof createRepairBridge> | null> {
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
  } = input;
  let slot = snapshot;
  const child = slot.child;
  if (child === undefined) return repairBridge;
  if (incumbentLiveness(child) === 'absent' || childHasExited(child.pid)) {
    record.settleAbsentChild(slot);
    inheritedWatch.delete(slot.id);
    return repairBridge;
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
    return repairBridge;
  }
  slot = current;
  watch.terminationAt = slot.terminationAt ?? watch.terminationAt;
  now = Date.now();
  if (healthy && watch.terminationAt === null) {
    watch.lastHealthy = now;
    record.observeInheritedHealth(slot, now);
    if (process.connected && process.ppid === child.pid && probeProcessIncarnation(child.pid) === child.incarnation) {
      if (repairBridge === null) {
        repairBridge = createRepairBridge(record, owner, runDir, timing, startupBudgetMs);
        if (replacement) process.send?.({ kind: 'coral-repair-bridge-ready', challenge: recoveryChallenge });
      }
    }
    const incumbentManifest =
      slot.buildSetId === originalManifest.buildSetId
        ? originalManifest
        : validatedBuild(join(dirname(runDir), 'builds', slot.buildSetId));
    const intent = pendingIntent(runDir);
    if (
      repairBridge !== null &&
      incumbentManifest !== null &&
      intent !== null &&
      (record.read().attempt === null || record.read().attempt?.phase === 'exited') &&
      intent.target.build.buildSetId !== slot.buildSetId &&
      now - (lastInheritedRequest.get(intent.requestId) ?? 0) >= 10_000
    ) {
      const target = validatedExecutable(pendingExecutable(intent));
      if (target !== null && compareProductVersions(target.version, incumbentManifest.version) > 0) {
        lastInheritedRequest.set(intent.requestId, now);
        await requestInheritedSuccession(runDir, incumbentManifest.flavor, child.pid, intent.requestId, intent.target);
      }
    }
  }
  const live = currentInheritedChild(snapshot, child);
  if (live === null) {
    inheritedWatch.delete(snapshot.id);
    return repairBridge;
  }
  slot = live;
  watch.terminationAt = slot.terminationAt ?? watch.terminationAt;
  now = Date.now();
  const overdue =
    (slot.phase === 'admitted' && now >= (slot.admittedAt ?? watch.firstSeen) + startupBudgetMs) ||
    (slot.phase === 'serving' && now - watch.lastHealthy >= timing.lapseMs);
  if (!overdue && watch.terminationAt === null) return repairBridge;
  if (watch.terminationAt !== null) {
    if (
      now >= (slot.killAt ?? watch.terminationAt + timing.graceMs) &&
      record.commitTermination(owner.current, slot, child, now, timing.graceMs) &&
      !signalInheritedChild(record, owner.current, slot, 'SIGKILL')
    ) {
      if (!record.holdInheritedChild(owner.current, slot)) inheritedWatch.delete(slot.id);
    }
    return repairBridge;
  }
  if (childIsUninterruptible(child.pid)) {
    watch.uninterruptibleSince ??= now;
    if (now - watch.uninterruptibleSince < timing.dStateDeferralMs) return repairBridge;
  } else {
    watch.uninterruptibleSince = null;
  }
  if (record.commitTermination(owner.current, slot, child, now, timing.graceMs)) {
    watch.terminationAt = now;
    if (!signalInheritedChild(record, owner.current, slot, 'SIGTERM')) {
      if (!record.holdInheritedChild(owner.current, slot)) inheritedWatch.delete(slot.id);
    }
  } else if (!record.holdInheritedChild(owner.current, slot)) inheritedWatch.delete(slot.id);
  return repairBridge;
}

async function reconcileInheritedChildren(
  input: ReconcileInheritedInput,
): Promise<Readonly<{ inherited: LaunchReservation[]; repairBridge: ReturnType<typeof createRepairBridge> | null }>> {
  const { record, owner, incarnation } = input;
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
      state.owner.id === owner.current.id &&
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
      repairBridge = await reconcileInheritedChild(input, snapshot, repairBridge, currentInheritedChild);
    }
  }
  return { inherited, repairBridge };
}

type PendingAttempt = Readonly<{
  attemptId?: string;
  reservation: LaunchReservation;
  running: RunningChild;
  retirement: ChildRetirement;
  watch: Promise<WatchResult>;
}>;

function dispatchPendingRequest(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  current: RunningChild;
  pending: { value: PendingAttempt | null };
  lastDispatch: Map<string, number>;
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  route: (source: ChildProcess, message: unknown, handle: unknown) => boolean;
}): void {
  const { record, owner, current, pending, lastDispatch, runDir, timing, startupBudgetMs, route } = input;
  try {
    if (owner.lost || pending.value !== null || current.child.exitCode !== null || current.child.signalCode !== null)
      return;
    const state = record.read();
    if (state.launch?.phase !== 'serving' || state.launch.child?.pid !== current.identity.pid) return;
    const intent = pendingIntent(runDir);
    if (
      intent === null ||
      intent.target.build.buildSetId === current.manifest.buildSetId ||
      Date.now() - (lastDispatch.get(intent.requestId) ?? 0) < 10_000
    )
      return;
    const executable = pendingExecutable(intent);
    const manifest = targetValidation(executable);
    if (manifest === 'absent') {
      void closeUnavailableLegacyRequest(runDir, intent.requestId);
      return;
    }
    if (manifest === 'indeterminate' || manifest.buildSetId !== intent.target.build.buildSetId) return;
    {
      const contenderReservation = record.reserve(owner.current, manifest.buildSetId, 'contender');
      if (contenderReservation === null) return;
      lastDispatch.set(intent.requestId, Date.now());
      const running = spawnAdmittedChild(record, owner.current, contenderReservation, executable, [], runDir);
      if (running === null) return;
      const retirement: ChildRetirement = { at: null };
      const watch = watchChild({
        running,
        reservation: contenderReservation,
        record,
        runDir,
        owner,
        timing,
        startupBudgetMs,
        retirement,
        route: (message, handle) => route(running.child, message, handle),
      });
      pending.value = { reservation: contenderReservation, running, retirement, watch };
      void watch.then(() => {
        if (pending.value?.running.child === running.child && current.child !== running.child) pending.value = null;
      });
    }
  } catch (error: unknown) {
    process.stderr.write(`Coordinator request observation failed: ${String(error)}\n`);
  }
}

function createActiveChildRouter({
  owner,
  record,
  pending,
  current,
  timing,
  startAttempt,
}: {
  owner: OwnerHandle;
  record: SupervisorLaunchMemory;
  pending: { value: PendingAttempt | null };
  current: () => RunningChild;
  timing: SentinelTiming;
  startAttempt: (source: ChildProcess, attemptId: string, bundleDir: string) => void;
}): (source: ChildProcess, message: unknown, handle: unknown) => boolean {
  return (source, message, handle) => {
    if (owner.lost || record.read().owner.id !== owner.current.id) {
      closeHandle(handle);
      return true;
    }
    if (typeof message !== 'object' || message === null || !('kind' in message)) return false;
    const attempt = pending.value;
    if (source === current().child) {
      if (
        message.kind === 'coral-supervisor-start-attempt' &&
        'attemptId' in message &&
        typeof message.attemptId === 'string' &&
        'bundleDir' in message &&
        typeof message.bundleDir === 'string'
      ) {
        startAttempt(source, message.attemptId, message.bundleDir);
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
      if (current().child.connected)
        current().child.send(
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
}

async function superviseActiveChild(input: {
  record: SupervisorLaunchMemory;
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
  const route = createActiveChildRouter({
    owner,
    record,
    pending,
    current: () => current,
    timing,
    startAttempt: (source, attemptId, bundleDir) => {
      startingAttempt = startAttempt(source, attemptId, bundleDir);
    },
  });
  let watched = watchChild({
    running: current,
    reservation,
    record,
    runDir,
    owner,
    timing,
    startupBudgetMs,
    retirement: { at: null },
    route: (message, handle) => route(initial.child, message, handle),
  });
  const requestPoll = setInterval(
    () =>
      dispatchPendingRequest({ record, owner, current, pending, lastDispatch, runDir, timing, startupBudgetMs, route }),
    500,
  );
  let result: WatchResult;
  while (true) {
    result = await watched;
    await Promise.resolve(startingAttempt);
    const successor = pending.value;
    if (successor === null || successor.running.child.exitCode !== null || successor.running.child.signalCode !== null)
      break;
    if (record.normalize() === null) break;
    current = successor.running;
    watched = successor.watch;
    pending.value = null;
  }
  clearInterval(requestPoll);
  return releaseAfterSettledServedExit(record, runDir, result);
}

function releaseAfterSettledServedExit(record: SupervisorLaunchMemory, runDir: string, result: WatchResult): boolean {
  const pending = pendingIntent(runDir);
  return (
    result.served &&
    result.exitCode === 0 &&
    !result.wedged &&
    (pending === null || targetValidation(pendingExecutable(pending)) === 'absent') &&
    record.release()
  );
}

async function superviseAdoptedChild(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  repairBridge: ReturnType<typeof createRepairBridge>;
  adoptedChild: RepairChild;
  lastInheritedRequest: Map<string, number>;
}): Promise<boolean> {
  const { record, runDir, repairBridge, adoptedChild, lastInheritedRequest } = input;
  let current: RepairChild = adoptedChild;
  const requestPoll = setInterval(() => {
    try {
      if (record.read().launch?.phase !== 'serving') return;
      const intent = pendingIntent(runDir);
      if (intent === null) return;
      const target = validatedExecutable(pendingExecutable(intent));
      if (
        target === null ||
        compareProductVersions(target.version, current.running.manifest.version) <= 0 ||
        Date.now() - (lastInheritedRequest.get(intent.requestId) ?? 0) < 10_000
      )
        return;
      lastInheritedRequest.set(intent.requestId, Date.now());
      void requestInheritedSuccession(
        runDir,
        current.running.manifest.flavor,
        current.running.identity.pid,
        intent.requestId,
        intent.target,
      );
    } catch (error: unknown) {
      process.stderr.write(`Inherited successor request observation failed: ${String(error)}\n`);
    }
  }, 500);
  let result: WatchResult;
  try {
    while (true) {
      result = await current.watch;
      record.normalize();
      const next = repairBridge?.child(record.read().launch?.id);
      if (next === null || next === undefined || next.reservation.id === current.reservation.id) break;
      current = next;
    }
  } finally {
    clearInterval(requestPoll);
    repairBridge?.close();
  }
  return releaseAfterSettledServedExit(record, runDir, result);
}

async function selectNextCandidate(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  original: Candidate;
  originalManifest: StrictBundleManifest;
  tried: Set<string>;
  firstLaunch: boolean;
}): Promise<{ kind: 'released' } | { kind: 'retry' } | { kind: 'candidate'; candidate: Candidate }> {
  const { record, owner, runDir, original, originalManifest, tried, firstLaunch } = input;
  let requested = pendingIntent(runDir);
  if (incumbentAt(runDir) === null && (await socketClaimedBeforeDiscovery(runDir, originalManifest.flavor))) {
    if (requested === null)
      await recordUnidentifiedIncumbentRequest(runDir, owner.current, {
        build: originalManifest,
        pluginRootLabel: dirname(dirname(original.executable)),
      });
    await sleep(POLL_MS);
    return { kind: 'retry' };
  }
  if (requested?.incumbent.instanceId === UNIDENTIFIED_INCUMBENT) {
    const identified = observedLaunchIncumbent(runDir, originalManifest.flavor);
    if (identified !== null && identified.pid !== process.pid) {
      const refreshed = await recordLegacyUpgradeIntent({
        runDir,
        requestId: requested.requestId,
        incumbent: identified,
        target: requested.target,
      });
      if (refreshed.kind === 'refused' && refreshed.disposition === 'redundant')
        await retryUpgradeIntentCas(runDir, (observed) =>
          observed.kind === 'readable' && observed.intent.requestId === requested?.requestId
            ? {
                kind: 'write',
                expectedRevision: observed.intent.revision,
                change: { ...observed.intent, disposition: 'closed' as const },
                settle: () => undefined,
              }
            : { kind: 'settle', value: undefined },
        );
      requested = pendingIntent(runDir);
    }
  }
  if (requested !== null && targetValidation(pendingExecutable(requested)) === 'absent')
    await closeUnavailableLegacyRequest(runDir, requested.requestId);
  const recordedIncumbents = requested === null ? [] : [requested.incumbent];
  let incumbentHeld = false;
  for (const recorded of recordedIncumbents) {
    if (recorded.pid === process.pid) continue;
    const liveness = incumbentLiveness(recorded);
    if (liveness === 'alive' || liveness === 'unknown') incumbentHeld = true;
  }
  if (incumbentHeld) {
    await sleep(POLL_MS);
    return { kind: 'retry' };
  }
  const incumbent = incumbentAt(runDir);
  if (
    !firstLaunch &&
    incumbent !== null &&
    incumbent.pid !== process.pid &&
    incumbentLiveness(incumbent) !== 'absent'
  ) {
    await sleep(POLL_MS);
    return { kind: 'retry' };
  }
  const eligible = candidates(runDir, original, originalManifest, !record.hasServed(original.buildSetId));
  const available = eligible.filter((candidate) => !tried.has(candidate.executable));
  if (available.length === 0) {
    const controller = controllerBuild(runDir);
    const state = record.read();
    if (
      eligible.length === 0 &&
      controller.kind === 'none' &&
      (requested === null || targetValidation(pendingExecutable(requested)) === 'absent') &&
      [state.launch, state.attempt].every((slot) => slot === null || slot.phase === 'exited') &&
      record.release()
    )
      return { kind: 'released' };
    const unreadable = readCustodyLedger(
      createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', {
        baseDir: dirname(dirname(runDir)),
      }),
      runDir,
    ).find((entry) => entry.kind === 'unreadable');
    if (unreadable?.kind === 'unreadable') {
      if (!record.holdUnreadableCustody(owner.current, unreadable.path)) return { kind: 'retry' };
    } else {
      if (!record.hold(owner.current, controller.kind === 'required' ? controller.buildSetId : controller.kind))
        return { kind: 'retry' };
    }
    tried.clear();
    await sleep(2_000);
    return { kind: 'retry' };
  }
  return { kind: 'candidate', candidate: available[0] };
}

function releaseSettledInheritedLaunch(record: SupervisorLaunchMemory, incarnation: string, runDir: string): boolean {
  const settled = record.read();
  const slots = [settled.launch, settled.attempt];
  return (
    slots.some(
      (slot) => slot !== null && (slot.parent?.pid !== process.pid || slot.parent.incarnation !== incarnation),
    ) &&
    slots.every((slot) => slot === null || slot.phase === 'exited') &&
    pendingIntent(runDir) === null &&
    controllerBuild(runDir).kind === 'none' &&
    record.release()
  );
}

async function superviseSelectedCandidate(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  candidate: Candidate;
  triedCount: number;
  args: readonly string[];
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  onChild?: (child: ChildProcess) => void;
}): Promise<boolean> {
  const { record, owner, candidate, triedCount, args, runDir, timing, startupBudgetMs, onChild } = input;
  const intent = pendingIntent(runDir);
  const purpose =
    intent !== null && pendingExecutable(intent) === candidate.executable
      ? 'legacy-retirement'
      : triedCount === 1
        ? 'startup'
        : 'recovery';
  const reservation = record.reserve(owner.current, candidate.buildSetId, purpose);
  if (reservation === null) {
    await sleep(POLL_MS);
    return false;
  }
  const initial = spawnAdmittedChild(record, owner.current, reservation, candidate.executable, args, runDir);
  if (initial === null) {
    await sleep(POLL_MS);
    return false;
  }
  return superviseActiveChild({ record, owner, initial, reservation, runDir, timing, startupBudgetMs, onChild });
}

async function selectAndSuperviseCandidate(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  original: Candidate;
  originalManifest: StrictBundleManifest;
  tried: Set<string>;
  firstLaunch: boolean;
  args: readonly string[];
  timing: SentinelTiming;
  startupBudgetMs: number;
  onChild?: (child: ChildProcess) => void;
}): Promise<{ released: boolean; firstLaunch: boolean }> {
  const {
    record,
    owner,
    runDir,
    original,
    originalManifest,
    tried,
    firstLaunch,
    args,
    timing,
    startupBudgetMs,
    onChild,
  } = input;
  const selection = await selectNextCandidate({
    record,
    owner,
    runDir,
    original,
    originalManifest,
    tried,
    firstLaunch,
  });
  if (selection.kind === 'released') return { released: true, firstLaunch };
  if (selection.kind === 'retry') return { released: false, firstLaunch };
  const candidate = selection.candidate;
  record.clearHold();
  tried.add(candidate.executable);
  const released = await superviseSelectedCandidate({
    record,
    owner,
    candidate,
    triedCount: tried.size,
    args,
    runDir,
    timing,
    startupBudgetMs,
    onChild,
  });
  return { released, firstLaunch: false };
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
  const acquisition = await acquireLaunchOwnership(runDir, executable, originalManifest);
  if (acquisition.kind === 'finished') return acquisition.exitCode;
  const { record, owner, incarnation, replacement, recoveryChallenge } = acquisition;
  try {
    const original = { executable, buildSetId: originalManifest.buildSetId };
    const tried = new Set<string>();
    const inheritedWatch = new Map<string, InheritedWatch>();
    const lastInheritedRequest = new Map<string, number>();
    let repairBridge: ReturnType<typeof createRepairBridge> | null = null;
    let firstLaunch = true;
    while (true) {
      if (owner.lost) {
        repairBridge?.close();
        repairBridge = null;
        while (true) {
          let ownedChildMayLive = false;
          for (const slot of [record.read().launch, record.read().attempt]) {
            if (slot?.parent?.pid !== process.pid || slot.child === undefined) continue;
            const liveness = incumbentLiveness(slot.child);
            if (liveness === 'alive' || liveness === 'unknown') ownedChildMayLive = true;
          }
          if (!ownedChildMayLive) break;
          await sleep(POLL_MS);
        }
        return 1;
      }
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
      if (owner.lost || record.read().owner.id !== owner.current.id) {
        owner.lost = true;
        repairBridge?.close();
        repairBridge = null;
        continue;
      }
      const observedInherited = record.read().launch;
      if (
        observedInherited !== null &&
        observedInherited.phase === 'serving' &&
        observedInherited.observedHealthyAt !== undefined &&
        observedInherited.parent?.pid !== process.pid &&
        observedInherited.child?.pid !== process.ppid &&
        repairBridge === null &&
        publishedNativeSupervision(runDir, observedInherited)
      ) {
        const incumbent = observedLaunchIncumbent(runDir, originalManifest.flavor);
        if (incumbent !== null)
          await recordLegacyUpgradeIntent({
            runDir,
            requestId: randomUUID(),
            incumbent,
            target: { build: originalManifest, pluginRootLabel: dirname(dirname(executable)) },
          });
        return 0;
      }
      if (
        replacement &&
        inherited.length === 1 &&
        inherited[0].phase === 'serving' &&
        inherited[0].child?.pid !== process.ppid &&
        repairBridge === null &&
        pendingIntent(runDir) !== null
      )
        return 0;
      record.normalize();
      const adoptedChild = repairBridge?.child(record.read().launch?.id);
      if (adoptedChild !== null && adoptedChild !== undefined && repairBridge !== null) {
        const released = await superviseAdoptedChild({
          record,
          owner,
          runDir,
          repairBridge,
          adoptedChild,
          lastInheritedRequest,
        });
        repairBridge = null;
        if (released) return 0;
        continue;
      }
      if (releaseSettledInheritedLaunch(record, incarnation, runDir)) return 0;
      if (inherited.length > 0) {
        await sleep(POLL_MS);
        continue;
      }
      const selection = await selectAndSuperviseCandidate({
        record,
        owner,
        runDir,
        original,
        originalManifest,
        tried,
        firstLaunch,
        args,
        timing,
        startupBudgetMs,
        onChild: options.onChild,
      });
      firstLaunch = selection.firstLaunch;
      if (selection.released) return 0;
    }
  } finally {
    owner.release();
  }
}
