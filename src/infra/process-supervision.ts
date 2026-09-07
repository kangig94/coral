import { MAX_BUFFER, SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from './process-constants.js';
import { incarnationMayAuthorizeSignal, type ProcessIncarnation, type ProcessLiveness } from './node-process.js';
import type { ChildProcessLike, TimePort } from './port-types.js';
import type { Runtime } from '../runtime/ports.js';

type GracefulKillRuntime = Readonly<{
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
}>;

declare const spawnedProcessGroupCleanupBrand: unique symbol;
const spawnedProcessGroupAbsenceEvidenceBrand: unique symbol = Symbol(
  'coral.process-supervision.spawned-process-group-absence',
);

export type SpawnedProcessGroupCleanup<ProcessGroupId extends number = number> = Readonly<{
  processGroupId: ProcessGroupId;
  leaderIncarnation: ProcessIncarnation;
  cleanup(runtime: Runtime, signal?: AbortSignal): Promise<SpawnedProcessGroupCleanupDisposition<ProcessGroupId>>;
  [spawnedProcessGroupCleanupBrand]: true;
}>;

export type SpawnedProcessGroupCleanupSubject<ProcessGroupId extends number = number> = Readonly<{
  kind: 'process-group';
  processGroupId: ProcessGroupId;
}>;

export type SpawnedProcessGroupAbsenceEvidence<ProcessGroupId extends number = number> = Readonly<{
  subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId>;
  [spawnedProcessGroupAbsenceEvidenceBrand]: true;
}>;

export type SpawnedProcessGroupObservedAbsent<ProcessGroupId extends number = number> = Readonly<{
  kind: 'observed-absent';
  evidence: SpawnedProcessGroupAbsenceEvidence<ProcessGroupId>;
}>;

export type UnattributableSpawnedProcessGroupObservation<ProcessGroupId extends number = number> =
  | SpawnedProcessGroupObservedAbsent<ProcessGroupId>
  | Readonly<{
      kind: 'held-unattributable';
      subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId>;
      observation: 'unattributable';
    }>
  | Readonly<{
      kind: 'held-unobservable';
      subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId>;
      observation: 'unobservable';
    }>;

export type SpawnedProcessGroupCleanupDisposition<ProcessGroupId extends number = number> =
  | SpawnedProcessGroupObservedAbsent<ProcessGroupId>
  | Readonly<{
      kind: 'held-alive';
      subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId>;
      observation: 'alive';
      exit: 'process-group-absence';
      retry(signal?: AbortSignal): Promise<SpawnedProcessGroupCleanupDisposition<ProcessGroupId>>;
    }>
  | Readonly<{
      kind: 'held-unobservable';
      subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId>;
      observation: 'unobservable';
      exit: 'process-group-absence';
      retry(signal?: AbortSignal): Promise<SpawnedProcessGroupCleanupDisposition<ProcessGroupId>>;
    }>;

export function retainSpawnedProcessGroupCleanup<ProcessGroupId extends number>(
  processGroupId: ProcessGroupId,
  leaderIncarnation: ProcessIncarnation,
): SpawnedProcessGroupCleanup<ProcessGroupId> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new RangeError(`Spawned process-group id must be a positive safe integer; received ${processGroupId}.`);
  }
  const capability = Object.freeze({
    processGroupId,
    leaderIncarnation,
    cleanup: (runtime: Runtime, signal?: AbortSignal) => cleanupSpawnedProcessGroup(capability, runtime, signal),
  }) as SpawnedProcessGroupCleanup<ProcessGroupId>;
  return capability;
}

function observeSpawnedProcessGroup<ProcessGroupId extends number>(
  cleanup: SpawnedProcessGroupCleanup<ProcessGroupId>,
  runtime: Runtime,
): 'alive' | 'absent' | 'unobservable' {
  const platform = runtime.env.platform() as NodeJS.Platform;
  try {
    const observedIncarnation = runtime.process.readProcessIncarnation(cleanup.processGroupId, platform);
    const groupLiveness = runtime.process.observeLiveness(-cleanup.processGroupId);
    if (groupLiveness === 'absent') return 'absent';
    if (groupLiveness === 'unknown') return 'unobservable';
    if (!incarnationMayAuthorizeSignal(platform)) return 'unobservable';
    return observedIncarnation === cleanup.leaderIncarnation ? 'alive' : 'unobservable';
  } catch {
    return 'unobservable';
  }
}

function observedSpawnedProcessGroupAbsent<ProcessGroupId extends number>(
  processGroupId: ProcessGroupId,
): SpawnedProcessGroupObservedAbsent<ProcessGroupId> {
  const subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId> = {
    kind: 'process-group',
    processGroupId,
  };
  return {
    kind: 'observed-absent',
    evidence: Object.freeze({ subject, [spawnedProcessGroupAbsenceEvidenceBrand]: true as const }),
  };
}

function heldSpawnedProcessGroupCleanup<ProcessGroupId extends number>(
  cleanup: SpawnedProcessGroupCleanup<ProcessGroupId>,
  runtime: Runtime,
  observation: 'alive' | 'unobservable',
): SpawnedProcessGroupCleanupDisposition<ProcessGroupId> {
  const subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId> = {
    kind: 'process-group',
    processGroupId: cleanup.processGroupId,
  };
  const retry = (signal?: AbortSignal) => cleanupSpawnedProcessGroup(cleanup, runtime, signal);
  return observation === 'alive'
    ? { kind: 'held-alive', subject, observation, exit: 'process-group-absence', retry }
    : { kind: 'held-unobservable', subject, observation, exit: 'process-group-absence', retry };
}

export function observeRetainedSpawnedProcessGroup<ProcessGroupId extends number>(
  cleanup: SpawnedProcessGroupCleanup<ProcessGroupId>,
  runtime: Runtime,
): SpawnedProcessGroupCleanupDisposition<ProcessGroupId> {
  const observation = observeSpawnedProcessGroup(cleanup, runtime);
  return observation === 'absent'
    ? observedSpawnedProcessGroupAbsent(cleanup.processGroupId)
    : heldSpawnedProcessGroupCleanup(cleanup, runtime, observation);
}

/**
 * The kernel may recycle a process-group id, so a present group under that number is not evidence that the
 * spawned group is alive; only its absence is decisive for whatever once held the number.
 */
export function observeUnattributableSpawnedProcessGroup<ProcessGroupId extends number>(
  processGroupId: ProcessGroupId,
  runtime: Runtime,
): UnattributableSpawnedProcessGroupObservation<ProcessGroupId> {
  const subject: SpawnedProcessGroupCleanupSubject<ProcessGroupId> = { kind: 'process-group', processGroupId };
  let liveness: ProcessLiveness;
  try {
    liveness = runtime.process.observeLiveness(-processGroupId);
  } catch {
    return { kind: 'held-unobservable', subject, observation: 'unobservable' };
  }
  if (liveness === 'absent') return observedSpawnedProcessGroupAbsent(processGroupId);
  if (liveness === 'alive') return { kind: 'held-unattributable', subject, observation: 'unattributable' };
  return { kind: 'held-unobservable', subject, observation: 'unobservable' };
}

function signalSpawnedProcessGroup<ProcessGroupId extends number>(
  cleanup: SpawnedProcessGroupCleanup<ProcessGroupId>,
  runtime: Runtime,
  signal: NodeJS.Signals,
  abortSignal?: AbortSignal,
): 'delivered' | 'alive' | 'absent' | 'unobservable' {
  if (abortSignal?.aborted) return observeSpawnedProcessGroup(cleanup, runtime);
  const platform = runtime.env.platform() as NodeJS.Platform;
  if (!incarnationMayAuthorizeSignal(platform)) return observeSpawnedProcessGroup(cleanup, runtime);
  try {
    const observedIncarnation = runtime.process.readProcessIncarnation(cleanup.processGroupId, platform);
    if (observedIncarnation !== cleanup.leaderIncarnation) return observeSpawnedProcessGroup(cleanup, runtime);
    const groupLiveness = runtime.process.observeLiveness(-cleanup.processGroupId);
    if (groupLiveness !== 'alive') return groupLiveness === 'absent' ? 'absent' : 'unobservable';
    if (abortSignal?.aborted) return 'alive';
    runtime.process.kill(-cleanup.processGroupId, signal);
    return 'delivered';
  } catch {
    return observeSpawnedProcessGroup(cleanup, runtime);
  }
}

function dispositionForSpawnedProcessGroupObservation<ProcessGroupId extends number>(
  cleanup: SpawnedProcessGroupCleanup<ProcessGroupId>,
  runtime: Runtime,
  observation: 'alive' | 'absent' | 'unobservable',
): SpawnedProcessGroupCleanupDisposition<ProcessGroupId> {
  return observation === 'absent'
    ? observedSpawnedProcessGroupAbsent(cleanup.processGroupId)
    : heldSpawnedProcessGroupCleanup(cleanup, runtime, observation);
}

async function waitForSpawnedProcessGroupGrace(
  runtime: Runtime,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runtime.time.sleep(milliseconds, signal === undefined ? undefined : { signal });
  } catch (error: unknown) {
    if (!signal?.aborted) throw error;
  }
}

export async function cleanupSpawnedProcessGroup<ProcessGroupId extends number>(
  cleanup: SpawnedProcessGroupCleanup<ProcessGroupId>,
  runtime: Runtime,
  signal?: AbortSignal,
): Promise<SpawnedProcessGroupCleanupDisposition<ProcessGroupId>> {
  const initialObservation = observeSpawnedProcessGroup(cleanup, runtime);
  if (initialObservation !== 'alive' || signal?.aborted)
    return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, initialObservation);

  const sigterm = signalSpawnedProcessGroup(cleanup, runtime, 'SIGTERM', signal);
  if (sigterm !== 'delivered') return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, sigterm);
  const immediatelyAfterSigterm = observeSpawnedProcessGroup(cleanup, runtime);
  if (immediatelyAfterSigterm !== 'alive')
    return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, immediatelyAfterSigterm);
  await waitForSpawnedProcessGroupGrace(runtime, SIGTERM_GRACE_MS, signal);

  const afterSigterm = observeSpawnedProcessGroup(cleanup, runtime);
  if (afterSigterm !== 'alive' || signal?.aborted)
    return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, afterSigterm);

  const sigkill = signalSpawnedProcessGroup(cleanup, runtime, 'SIGKILL', signal);
  if (sigkill !== 'delivered') return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, sigkill);
  const immediatelyAfterSigkill = observeSpawnedProcessGroup(cleanup, runtime);
  if (immediatelyAfterSigkill !== 'alive')
    return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, immediatelyAfterSigkill);
  await waitForSpawnedProcessGroupGrace(runtime, SIGKILL_GRACE_MS, signal);

  const afterSigkill = observeSpawnedProcessGroup(cleanup, runtime);
  return dispositionForSpawnedProcessGroupObservation(cleanup, runtime, afterSigkill);
}

type GracefulKillByPidSignalRefusal = Readonly<{
  kind: 'signal-refused';
  pid: number;
  reason:
    | 'recorded-incarnation-unavailable'
    | 'platform-incarnation-cannot-authorize-signal'
    | 'signal-authorizing-incarnation-unavailable'
    | 'expected-incarnation-mismatch';
}>;

type GracefulKillByPidSignalFailure = Readonly<{
  kind: 'signal-failed';
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
  reason: 'kill-port-returned-false';
}>;

export type GracefulKillByPidOutcome =
  | GracefulKillByPidSignalRefusal
  | GracefulKillByPidSignalFailure
  | Readonly<{ kind: 'observed-absent'; pid: number }>
  | Readonly<{ kind: 'target-unobservable'; pid: number; stage: 'after-sigterm' | 'after-sigkill' }>
  | Readonly<{ kind: 'target-alive'; pid: number; stage: 'after-sigkill' }>;

export type GracefulKillByPidDisposition =
  | Readonly<{ kind: 'escalation-scheduled'; pid: number; settlement: Promise<GracefulKillByPidOutcome> }>
  | GracefulKillByPidSignalRefusal
  | GracefulKillByPidSignalFailure;

export function safeKill(child: ChildProcessLike, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

export function gracefulKill(
  child: ChildProcessLike,
  runtime: GracefulKillRuntime,
  observeLiveness: (pid: number) => ProcessLiveness,
): void {
  safeKill(child, 'SIGTERM');
  const killTimer = runtime.time.setTimeout(() => {
    if (child.pid === undefined) return;
    try {
      if (observeLiveness(child.pid) !== 'alive') return;
    } catch {
      return;
    }
    safeKill(child, 'SIGKILL');
  }, SIGTERM_GRACE_MS);
  killTimer.unref?.();
  child.on('close', () => runtime.time.clearTimeout(killTimer));
}

function observeRecordedTarget(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
  expectedIncarnation: ProcessIncarnation,
): 'alive' | 'absent' | 'unobservable' {
  try {
    const observedIncarnation = runtime.process.readProcessIncarnation(pid, platform);
    if (observedIncarnation !== null) {
      if (observedIncarnation !== expectedIncarnation) return 'absent';
      const liveness = runtime.process.observeLiveness(pid);
      return liveness === 'unknown' ? 'unobservable' : liveness;
    }
    return runtime.process.observeLiveness(pid) === 'absent' ? 'absent' : 'unobservable';
  } catch {
    return 'unobservable';
  }
}

function settleAfterSigkill(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
  expectedIncarnation: ProcessIncarnation,
): Promise<GracefulKillByPidOutcome> {
  return new Promise((resolve) => {
    const settlement = runtime.time.setTimeout(() => {
      const observation = observeRecordedTarget(runtime, pid, platform, expectedIncarnation);
      if (observation === 'absent') {
        resolve({ kind: 'observed-absent', pid });
        return;
      }
      if (observation === 'unobservable') {
        resolve({ kind: 'target-unobservable', pid, stage: 'after-sigkill' });
        return;
      }
      resolve({ kind: 'target-alive', pid, stage: 'after-sigkill' });
    }, SIGKILL_GRACE_MS);
    settlement.unref?.();
  });
}

function settleGracefulKillByPid(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
  expectedIncarnation: ProcessIncarnation,
): Promise<GracefulKillByPidOutcome> {
  try {
    const immediateLiveness = runtime.process.observeLiveness(pid);
    if (immediateLiveness === 'absent') return Promise.resolve({ kind: 'observed-absent', pid });
    if (immediateLiveness === 'unknown') {
      return Promise.resolve({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
    }
  } catch {
    return Promise.resolve({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
  }

  return new Promise<GracefulKillByPidOutcome>((resolve, reject) => {
    const escalation = runtime.time.setTimeout(() => {
      try {
        if (!incarnationMayAuthorizeSignal(platform)) {
          resolve({ kind: 'signal-refused', pid, reason: 'platform-incarnation-cannot-authorize-signal' });
          return;
        }
        const observation = observeRecordedTarget(runtime, pid, platform, expectedIncarnation);
        if (observation === 'absent') {
          resolve({ kind: 'observed-absent', pid });
          return;
        }
        if (observation === 'unobservable') {
          resolve({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
          return;
        }
        if (!runtime.process.kill(pid, 'SIGKILL')) {
          resolve({ kind: 'signal-failed', pid, signal: 'SIGKILL', reason: 'kill-port-returned-false' });
          return;
        }
        resolve(settleAfterSigkill(runtime, pid, platform, expectedIncarnation));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, SIGTERM_GRACE_MS);
    escalation.unref?.();
  });
}

export function gracefulKillByPid(
  runtime: Runtime,
  pid: number,
  expectedIncarnation: ProcessIncarnation | null,
): GracefulKillByPidDisposition {
  const platform = runtime.env.platform() as NodeJS.Platform;
  if (expectedIncarnation === null) {
    return { kind: 'signal-refused', pid, reason: 'recorded-incarnation-unavailable' };
  }
  if (!incarnationMayAuthorizeSignal(platform)) {
    return { kind: 'signal-refused', pid, reason: 'platform-incarnation-cannot-authorize-signal' };
  }
  let observedIncarnation: ProcessIncarnation | null;
  try {
    observedIncarnation = runtime.process.readProcessIncarnation(pid, platform);
  } catch {
    observedIncarnation = null;
  }
  if (observedIncarnation === null) {
    return { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
  }
  if (observedIncarnation !== expectedIncarnation) {
    return { kind: 'signal-refused', pid, reason: 'expected-incarnation-mismatch' };
  }
  if (!runtime.process.kill(pid, 'SIGTERM')) {
    return { kind: 'signal-failed', pid, signal: 'SIGTERM', reason: 'kill-port-returned-false' };
  }

  return {
    kind: 'escalation-scheduled',
    pid,
    settlement: settleGracefulKillByPid(runtime, pid, platform, observedIncarnation),
  };
}

export function requirePipedHandles(
  child: ChildProcessLike,
  command: string,
): {
  stdin: NonNullable<ChildProcessLike['stdin']>;
  stdout: NonNullable<ChildProcessLike['stdout']>;
  stderr: NonNullable<ChildProcessLike['stderr']>;
} {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(`Failed to spawn ${command}: piped stdio handles are unavailable`);
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

export function appendBuffer(current: string, chunk: string): string {
  if (current.length >= MAX_BUFFER) return current;
  const combined = current + chunk;
  if (combined.length > MAX_BUFFER) {
    return `${combined.slice(0, MAX_BUFFER)}\n[output truncated at 10MB]`;
  }
  return combined;
}
