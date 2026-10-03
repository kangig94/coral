import { type ChildProcess } from 'node:child_process';

import { compareProductVersions } from '../infra/product-version.js';
import { type SentinelTiming } from '../infra/sentinel-timing.js';
import { createActiveChildRouter, type PendingAttempt } from './active-child-router.js';
import { launchSuccessionAttempt } from './attempt-launch.js';
import { retireOwnedChild, type RunningChild, spawnAdmittedChild } from './child-process.js';
import { watchChild, type WatchResult } from './child-watch.js';
import { targetValidation, validatedExecutable } from './executable.js';
import { requestInheritedSuccession } from './health.js';
import { type OwnerHandle } from './ownership.js';
import { closeUnavailableLegacyRequest, pendingExecutable, pendingIntent } from './pending-upgrade.js';
import { type createRepairBridge, type RepairChild } from './repair-bridge.js';
import { type SupervisorLaunchMemory, type LaunchReservation } from './state.js';

type PendingRequestDispatch = {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  current: RunningChild;
  pending: { value: PendingAttempt | null };
  lastDispatch: Map<string, number>;
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  route: (source: ChildProcess, message: unknown, handle: unknown) => boolean;
};

function pendingRequestCandidate(runDir: string, current: RunningChild, lastDispatch: Map<string, number>) {
  const intent = pendingIntent(runDir);
  if (
    intent === null ||
    intent.target.build.buildSetId === current.manifest.buildSetId ||
    Number(process.hrtime.bigint() / 1_000_000n) - (lastDispatch.get(intent.requestId) ?? 0) < 10_000
  )
    return null;
  const executable = pendingExecutable(intent);
  const manifest = targetValidation(executable);
  if (manifest === 'absent') {
    void closeUnavailableLegacyRequest(runDir, intent.requestId);
    return null;
  }
  if (manifest === 'indeterminate' || manifest.buildSetId !== intent.target.build.buildSetId) return null;
  return { requestId: intent.requestId, executable, manifest };
}

function createPendingAttempt(
  {
    record,
    owner,
    lastDispatch,
    runDir,
    timing,
    startupBudgetMs,
    route,
  }: Omit<PendingRequestDispatch, 'current' | 'pending'>,
  candidate: NonNullable<ReturnType<typeof pendingRequestCandidate>>,
): PendingAttempt | null {
  const contenderReservation = record.reserve(owner.current, candidate.manifest.buildSetId, 'contender');
  if (contenderReservation === null) return null;
  lastDispatch.set(candidate.requestId, Number(process.hrtime.bigint() / 1_000_000n));
  const running = spawnAdmittedChild(record, owner.current, contenderReservation, candidate.executable, [], runDir);
  if (running === null) return null;
  const retirement = record.childRetirement(contenderReservation);
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
  return { reservation: contenderReservation, running, retirement, watch };
}

function dispatchPendingRequest(input: PendingRequestDispatch): void {
  const { record, owner, current, pending, lastDispatch, runDir } = input;
  try {
    if (
      owner.lost ||
      !record.hasAuthority(owner.current) ||
      pending.value !== null ||
      current.child.exitCode !== null ||
      current.child.signalCode !== null
    )
      return;
    const state = record.read();
    if (state.launch?.phase !== 'serving' || state.launch.child?.pid !== current.identity.pid) return;
    const candidate = pendingRequestCandidate(runDir, current, lastDispatch);
    if (candidate === null) return;
    const attempt = createPendingAttempt(input, candidate);
    if (attempt === null) return;
    pending.value = attempt;
    const { running, watch } = attempt;
    void watch.then(() => {
      if (pending.value?.running.child === running.child && current.child !== running.child) pending.value = null;
    });
  } catch (error: unknown) {
    process.stderr.write(`Coordinator request observation failed: ${String(error)}\n`);
  }
}

type ActiveChildSupervision = {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  initial: RunningChild;
  reservation: LaunchReservation;
  runDir: string;
  timing: SentinelTiming;
  startupBudgetMs: number;
  onChild?: (child: ChildProcess) => void;
};

async function startActiveSuccession(
  { record, owner, runDir, timing, startupBudgetMs }: ActiveChildSupervision,
  pending: { value: PendingAttempt | null },
  current: () => RunningChild,
  route: (source: ChildProcess, message: unknown, handle: unknown) => boolean,
  incumbentChild: ChildProcess,
  attemptId: string,
  bundleDir: string,
): Promise<void> {
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
        if (pending.value?.attemptId === attemptId && current().child === incumbentChild) pending.value = null;
      },
    });
    pending.value = { ...attempt, attemptId };
    incumbentChild.send({ kind: 'coral-supervisor-attempt-spawned', attemptId, pid: attempt.running.identity.pid });
  } catch (error: unknown) {
    if (incumbentChild.connected)
      incumbentChild.send({ kind: 'coral-supervisor-attempt-error', attemptId, reason: String(error) });
  }
}

export async function superviseActiveChild(input: ActiveChildSupervision): Promise<boolean> {
  const { record, owner, initial, reservation, runDir, timing, startupBudgetMs, onChild } = input;
  onChild?.(initial.child);
  let current = initial;
  const pending: { value: PendingAttempt | null } = { value: null };
  const lastDispatch = new Map<string, number>();
  let startingAttempt: Promise<void> | null = null;
  const route = createActiveChildRouter({
    owner,
    record,
    pending,
    current: () => current,
    timing,
    startAttempt: (source, attemptId, bundleDir) => {
      startingAttempt = startActiveSuccession(input, pending, () => current, route, source, attemptId, bundleDir);
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
    retirement: record.childRetirement(reservation),
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
    record.normalize();
    if (record.read().launch?.id !== successor.reservation.id) break;
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

export async function superviseAdoptedChild(input: {
  record: SupervisorLaunchMemory;
  owner: OwnerHandle;
  runDir: string;
  repairBridge: ReturnType<typeof createRepairBridge>;
  adoptedChild: RepairChild;
  lastInheritedRequest: Map<string, number>;
}): Promise<boolean> {
  const { record, owner, runDir, repairBridge, adoptedChild, lastInheritedRequest } = input;
  let current: RepairChild = adoptedChild;
  const requestPoll = setInterval(() => {
    try {
      const authority = owner.current;
      if (!record.hasAuthority(authority) || record.read().launch?.phase !== 'serving') return;
      const intent = pendingIntent(runDir);
      if (intent === null) return;
      const target = validatedExecutable(pendingExecutable(intent));
      if (
        target === null ||
        compareProductVersions(target.version, current.running.manifest.version) <= 0 ||
        Number(process.hrtime.bigint() / 1_000_000n) - (lastInheritedRequest.get(intent.requestId) ?? 0) < 10_000
      )
        return;
      lastInheritedRequest.set(intent.requestId, Number(process.hrtime.bigint() / 1_000_000n));
      void requestInheritedSuccession(
        runDir,
        current.running.manifest.flavor,
        current.running.identity.pid,
        intent.requestId,
        intent.target,
        () => record.hasAuthority(authority),
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
