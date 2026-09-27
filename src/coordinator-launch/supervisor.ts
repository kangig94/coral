import { spawn, type ChildProcess, type SendHandle } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Server, Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { isNoEntryError } from '../infra/fs-errors.js';
import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { createForeignTargetValidator } from '../infra/handoff-target.js';
import { compareProductVersions } from '../infra/product-version.js';
import {
  CoordinatorLaunchRecord,
  type LaunchOwner,
  type LaunchProcess,
  type LaunchReservation,
} from '../infra/coordinator-launch.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessLiveness } from '../infra/node-process.js';
import { SENTINEL_TIMING, validSentinelTiming, type SentinelTiming } from '../infra/sentinel-timing.js';
import { handoffCapsuleControllerBuildSetId } from '../provider-proxy/handoff-capsule.js';
import {
  providerHandoffCapsuleCandidatePaths,
  readProviderHandoffCapsuleCandidate,
} from '../provider-proxy/handoff-capsule-discovery.js';
import { createRealRuntime } from '../runtime/real.js';
import { childIsUninterruptible } from './child-state.js';
import { replacementServing } from './health.js';
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
      if (ready && order === 0 && request.buildSetId === serving.buildSetId) {
        if (request.status === 'recorded') record.accept(owner, request.id, Date.now());
        record.complete(owner, request.id, Date.now());
        continue;
      }
    }
    if (request.status === 'recorded') record.accept(owner, request.id, Date.now());
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

function controllerBuild(runDir: string): { kind: 'none' | 'unknown' } | { kind: 'required'; buildSetId: string } {
  const runtime = createRealRuntime(runDir.endsWith('run-dev') ? 'dev' : 'prod', { baseDir: dirname(dirname(runDir)) });
  let paths: readonly string[];
  try {
    paths = providerHandoffCapsuleCandidatePaths(runDir, runtime.storage);
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'none' } : { kind: 'unknown' };
  }
  const builds = new Set<string>();
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
    const capsule = candidate.capsule;
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
    if (observed === capsule.proxyIncarnation && observeProcessLiveness(capsule.proxyPid) !== 'absent')
      builds.add(handoffCapsuleControllerBuildSetId(capsule));
  }
  if (builds.size === 0) return { kind: 'none' };
  return builds.size === 1 ? { kind: 'required', buildSetId: [...builds][0] } : { kind: 'unknown' };
}

function candidates(record: CoordinatorLaunchRecord, runDir: string, original: Candidate): Candidate[] {
  const controller = controllerBuild(runDir);
  if (controller.kind === 'unknown') return [];
  const requested = record
    .read()
    .requests.filter((request) => request.status === 'recorded' || request.status === 'accepted')
    .flatMap((request) =>
      validatedExecutable(request.executable)?.buildSetId === request.buildSetId
        ? [{ executable: request.executable, buildSetId: request.buildSetId }]
        : [],
    );
  const manifest = validatedExecutable(original.executable);
  const recovery = relaunchRoots(runDir, manifest).flatMap((root) => {
    const build = validatedBuild(root);
    return build === null
      ? []
      : [{ executable: join(root, 'bridge', 'coral-backend.cjs'), buildSetId: build.buildSetId }];
  });
  const requiredBuild = controller.kind === 'required' ? controller.buildSetId : null;
  const retainedController =
    requiredBuild === null ? null : validatedBuild(join(dirname(runDir), 'builds', requiredBuild));
  const controllerCandidate =
    retainedController !== null &&
    retainedController.buildSetId === requiredBuild &&
    (manifest === null || retainedController.flavor === manifest.flavor)
      ? [
          {
            executable: join(dirname(runDir), 'builds', requiredBuild, 'bridge', 'coral-backend.cjs'),
            buildSetId: requiredBuild,
          },
        ]
      : [];
  const choices = [
    ...new Map(
      [...requested, ...controllerCandidate, ...recovery, ...(manifest === null ? [] : [original])].map((candidate) => [
        candidate.executable,
        candidate,
      ]),
    ).values(),
  ];
  return controller.kind === 'required'
    ? choices.filter((candidate) => candidate.buildSetId === controller.buildSetId)
    : choices;
}

type WatchResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  served: boolean;
  wedged: boolean;
}>;
type RunningChild = Readonly<{ child: ChildProcess; identity: LaunchProcess; sentinelId: string; executable: string }>;

function spawnAdmittedChild(
  record: CoordinatorLaunchRecord,
  owner: LaunchOwner,
  reservation: LaunchReservation,
  executable: string,
  args: readonly string[],
  runDir: string,
  attemptId?: string,
): RunningChild | null {
  const sentinelId = randomUUID();
  const legacy = !existsSync(join(dirname(executable), 'coral-sentinel.cjs'));
  const child = spawn(
    process.execPath,
    legacy ? [process.argv[1], '--launch-legacy', executable, ...args] : [executable, ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORAL_LAUNCH_ADMISSION: '1',
        CORAL_LAUNCH_PURPOSE: reservation.purpose,
        CORAL_SENTINEL_ID: sentinelId,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_STARTUP_ATTEMPT_ID: attemptId ?? process.env.CORAL_STARTUP_ATTEMPT_ID ?? randomUUID(),
        ...(attemptId === undefined ? {} : { CORAL_SUCCESSION_ATTEMPT_ID: attemptId }),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  child.on('error', (error) => process.stderr.write(`Coordinator spawn failed: ${String(error)}\n`));
  const pid = child.pid;
  const incarnation = pid === undefined ? null : probeProcessIncarnation(pid);
  if (pid === undefined || incarnation === null) {
    child.kill('SIGKILL');
    record.cancelReservation(owner, reservation, Date.now());
    return null;
  }
  return { child, identity: { pid, incarnation }, sentinelId, executable };
}

async function watchChild(
  child: ChildProcess,
  executable: string,
  reservation: LaunchReservation,
  identity: LaunchProcess,
  sentinelId: string,
  record: CoordinatorLaunchRecord,
  runDir: string,
  owner: { current: LaunchOwner },
  timing: SentinelTiming,
  startupBudgetMs: number,
  route: (message: unknown, handle: unknown) => boolean = () => false,
): Promise<WatchResult> {
  let armed = false;
  let pendingHello = false;
  let lastAnswer = Date.now();
  let lastWake = lastAnswer;
  let outstanding: number | null = null;
  let sequence = 0;
  let escalationAt: number | null = null;
  let killed = false;
  let wedged = false;
  let dStateSince: number | null = null;
  let served = false;
  let admitted = false;
  let startupDeadline = Date.now() + startupBudgetMs;
  let lastRenewal = Date.now();

  const childExit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.once('error', () => resolve({ exitCode: 1, signal: null }));
  });
  child.on('message', (message: unknown, handle: unknown) => {
    if (typeof message === 'object' && message !== null && 'kind' in message) {
      if (message.kind === 'coral-launch-admitted' && 'pid' in message && message.pid === child.pid) admitted = true;
      if (message.kind === 'coral-sentinel-hello' && 'id' in message && message.id === sentinelId) {
        pendingHello = true;
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
    if (child.connected)
      child.send(message as Parameters<typeof child.send>[0], handle as SendHandle, () => closeHandle(handle));
    else closeHandle(handle);
  };
  process.on('message', parentMessage);
  const interval = setInterval(() => {
    const now = Date.now();
    const gap = now - lastWake;
    lastWake = now;
    if (gap > timing.schedulingGapMs) {
      lastAnswer = now;
      outstanding = null;
      startupDeadline += gap;
    }
    if (now - lastRenewal >= 30_000) {
      const renewed = record.renew(owner.current, now);
      if (renewed !== null) owner.current = renewed;
      lastRenewal = now;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (escalationAt !== null) {
      if (!killed && now - escalationAt >= timing.graceMs) {
        child.kill('SIGKILL');
        killed = true;
      }
      return;
    }
    if (dStateSince !== null && child.pid !== undefined && !childIsUninterruptible(child.pid)) {
      dStateSince = null;
      lastAnswer = now;
      outstanding = null;
    }
    if (
      (!served && now >= startupDeadline) ||
      now - lastAnswer >= timing.lapseMs ||
      (dStateSince !== null && now - dStateSince >= timing.dStateDeferralMs)
    ) {
      if (child.pid !== undefined && childIsUninterruptible(child.pid) && dStateSince === null) dStateSince = now;
      if (dStateSince !== null && now - dStateSince < timing.dStateDeferralMs) {
        lastAnswer = now;
      } else {
        wedged = true;
        child.kill('SIGTERM');
        escalationAt = now;
      }
      return;
    }
    if (admitted && armed && outstanding === null && child.connected) {
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
    const candidateManifest = validatedExecutable(executable);
    if (candidateManifest === null) return;
    void replacementServing(runDir, candidateManifest.flavor, child.pid).then((ready) => {
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
  process.off('message', parentMessage);
  if (!record.exited(reservation, identity)) record.cancelReservation(owner.current, reservation, Date.now());
  return { exitCode, signal, served, wedged };
}

export async function runNamespaceSupervisor(
  executable: string,
  args: readonly string[],
  runDir: string,
  options: Readonly<{ timing?: SentinelTiming; startupBudgetMs?: number }> = {},
): Promise<number> {
  const timing = options.timing ?? SENTINEL_TIMING;
  if (!validSentinelTiming(timing)) throw new Error('Invalid coordinator supervisor timing');
  const startupBudgetMs = options.startupBudgetMs ?? STARTUP_BUDGET_MS;
  const originalManifest = validatedExecutable(executable);
  if (originalManifest === null) return 1;
  const record = new CoordinatorLaunchRecord(runDir);
  try {
    record.request(executable, originalManifest.buildSetId);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) return 1;
    const holder = record.acquire(
      {
        id: randomUUID(),
        process: { pid: process.pid, incarnation },
        buildSetId: originalManifest.buildSetId,
      },
      Date.now(),
    );
    if (holder === null) return 0;
    const owner = { current: holder };
    const original = { executable, buildSetId: originalManifest.buildSetId };
    const tried = new Set<string>();
    let firstLaunch = true;
    while (true) {
      const renewed = record.renew(owner.current, Date.now());
      if (renewed === null) return 1;
      owner.current = renewed;
      settleRequests(record, owner.current, null);
      const inherited = [record.read().launch, record.read().attempt].filter(
        (slot): slot is LaunchReservation =>
          slot !== null &&
          (slot.phase === 'admitted' || slot.phase === 'serving') &&
          (slot.parent?.pid !== process.pid || slot.parent.incarnation !== incarnation),
      );
      if (inherited.length > 0) {
        for (const slot of inherited) {
          if (slot.child !== undefined && incumbentLiveness(slot.child) === 'absent')
            record.settleAbsentChild(owner.current, slot, Date.now());
        }
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
      if (!firstLaunch && incumbentHeld) {
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
      const eligible = candidates(record, runDir, original);
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
        if (record.read().hold?.kind !== 'target-indeterminate')
          record.hold(
            owner.current,
            controller.kind === 'required' ? controller.buildSetId : controller.kind,
            Date.now(),
          );
        tried.clear();
        await sleep(2_000);
        continue;
      }
      record.clearHold(owner.current, Date.now());
      const candidate = available[0];
      const wasFirstLaunch = firstLaunch;
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
      const purpose =
        legacyRequest !== undefined && !wasFirstLaunch
          ? 'legacy-retirement'
          : tried.size === 1
            ? 'startup'
            : 'recovery';
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
      let current = initial;
      type PendingAttempt = Readonly<{
        attemptId?: string;
        running: RunningChild;
        watch: Promise<WatchResult>;
      }>;
      const pending: { value: PendingAttempt | null } = { value: null };
      const lastDispatch = new Map<string, number>();
      let startingAttempt: Promise<void> | null = null;
      const startAttempt = async (
        incumbentChild: ChildProcess,
        attemptId: string,
        bundleDir: string,
      ): Promise<void> => {
        const target = join(bundleDir, 'coral-backend.cjs');
        const manifest = validatedExecutable(target);
        const contender = pending.value;
        if (contender !== null && contender.attemptId === undefined) {
          contender.running.child.kill('SIGTERM');
          await contender.watch;
          if (pending.value === contender) pending.value = null;
        }
        if (manifest === null || pending.value !== null) {
          incumbentChild.send({
            kind: 'coral-supervisor-attempt-error',
            attemptId,
            reason: 'Succession target is unavailable',
          });
          return;
        }
        const attemptReservation = record.reserve(owner.current, manifest.buildSetId, 'succession', Date.now());
        if (attemptReservation === null) {
          incumbentChild.send({
            kind: 'coral-supervisor-attempt-error',
            attemptId,
            reason: 'Succession reservation was refused',
          });
          return;
        }
        const running = spawnAdmittedChild(record, owner.current, attemptReservation, target, [], runDir, attemptId);
        if (running === null) {
          incumbentChild.send({
            kind: 'coral-supervisor-attempt-error',
            attemptId,
            reason: 'Succession child did not spawn',
          });
          return;
        }
        const watch = watchChild(
          running.child,
          running.executable,
          attemptReservation,
          running.identity,
          running.sentinelId,
          record,
          runDir,
          owner,
          timing,
          startupBudgetMs,
          (message, handle) => route(running.child, message, handle),
        );
        pending.value = { attemptId, running, watch };
        incumbentChild.send({ kind: 'coral-supervisor-attempt-spawned', attemptId, pid: running.identity.pid });
        void watch.then((result) => {
          if (incumbentChild.connected)
            incumbentChild.send({
              kind: 'coral-supervisor-attempt-exit',
              attemptId,
              exitCode: result.exitCode,
              signal: result.signal,
            });
          if (pending.value?.attemptId === attemptId && current.child === incumbentChild) pending.value = null;
        });
      };
      const route = (source: ChildProcess, message: unknown, handle: unknown): boolean => {
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
              target.kill('SIGTERM');
            else if (target.connected)
              target.send(payload as Parameters<typeof target.send>[0], handle as SendHandle, () =>
                closeHandle(handle),
              );
            else closeHandle(handle);
            return true;
          }
          if (
            message.kind === 'coral-supervisor-retire-attempt' &&
            'attemptId' in message &&
            attempt !== null &&
            attempt.attemptId === message.attemptId
          ) {
            attempt.running.child.kill('SIGTERM');
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
        reservation,
        current.identity,
        current.sentinelId,
        record,
        runDir,
        owner,
        timing,
        startupBudgetMs,
        (message, handle) => route(initial.child, message, handle),
      );
      const requestPoll = setInterval(() => {
        try {
          if (pending.value !== null || current.child.exitCode !== null || current.child.signalCode !== null) return;
          const state = record.read();
          const currentManifest = validatedExecutable(current.executable);
          const serving = state.launch?.phase === 'serving' ? currentManifest : null;
          settleRequests(record, owner.current, currentManifest, serving !== null);
          if (serving === null) return;
          const currentBuild = serving.buildSetId;
          for (const request of state.requests) {
            if (
              request.buildSetId === currentBuild &&
              (request.status === 'recorded' || request.status === 'accepted')
            ) {
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
            const running = spawnAdmittedChild(
              record,
              owner.current,
              contenderReservation,
              request.executable,
              [],
              runDir,
            );
            if (running === null) break;
            const watch = watchChild(
              running.child,
              running.executable,
              contenderReservation,
              running.identity,
              running.sentinelId,
              record,
              runDir,
              owner,
              timing,
              startupBudgetMs,
              (message, handle) => route(running.child, message, handle),
            );
            pending.value = { running, watch };
            void watch.then(() => {
              if (pending.value?.running.child === running.child && current.child !== running.child)
                pending.value = null;
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
        if (
          successor === null ||
          successor.running.child.exitCode !== null ||
          successor.running.child.signalCode !== null
        )
          break;
        if (record.promoteAttempt(owner.current, Date.now()) === null) break;
        current = successor.running;
        watched = successor.watch;
        pending.value = null;
      }
      clearInterval(requestPoll);
      if (result.served) settleRequests(record, owner.current, validatedExecutable(current.executable), true);
      if (
        result.served &&
        result.exitCode === 0 &&
        !result.wedged &&
        record.read().requests.every((request) => request.status === 'completed' || request.status === 'unavailable')
      ) {
        if (record.release(owner.current)) return 0;
      }
    }
  } finally {
    record.close();
  }
}
