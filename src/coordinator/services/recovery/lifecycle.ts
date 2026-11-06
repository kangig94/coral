import type { FailureDomainContainment } from '../../../infra/failure-domain.js';
import { durableCliFailureDomain } from '../durable-cli-failure-domain.js';
import {
  createFailureDomainContainmentObservation,
  createFailureDomainAbsenceObserver,
  observeRecordedContainment,
  type RecordedContainmentObservation,
} from '../../../infra/process-containment.js';
import { readDurableCliExecution } from '../../../jobs/durable-cli-execution.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import type { JobPhase } from '../../../jobs/phase.js';
import type { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { JobStore } from '../../../jobs/store.js';
import type { DurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import { readDurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import type { Runtime } from '../../../runtime/ports.js';
import { durableOwnershipEvidenceHoldReason, reapDurableCliProcess, type RunningRecoverableJob } from './actions.js';

/** Abandonment must be able to abort a destructive reap and wait for it, not merely ignore its result. */
type HeldRecoveryReapAttempt = Readonly<{ abort: AbortController; settlement: Promise<void> }>;

export type RecoveryCoordinatorState = {
  recoveryRegistry: RecoveryRegistry | null;
  onRecoverySettlement?: (jobId: string) => void;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  unansweredAdoptionProbes: Map<string, number>;
  recoveryPollIntervals: Map<string, TimerHandle>;
  heldRecoveryReapGenerations: Map<string, number>;
  heldRecoveryReapAttempts: Map<string, HeldRecoveryReapAttempt>;
  adoptedRunningJobCleanups: Map<string, () => void>;
  inflightFinalizations: Map<
    string,
    Readonly<{
      promise: Promise<void>;
      abort(): void;
      commitStarted(): boolean;
    }>
  >;
  providerOperationRecoveries: Map<
    string,
    Promise<Readonly<{ state: 'accepted'; jobId: string; owner: 'recovery-coordinator' }>>
  >;
  teardownRequested: boolean;
  teardownState:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; settlement: Promise<void> }>
    | Readonly<{ kind: 'settled' }>;
};

function trackRecoveryFinalization(
  state: RecoveryCoordinatorState,
  jobId: string,
  parentSignal: AbortSignal,
  run: (fence: { signal: AbortSignal; onCommitStart(): void }) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let commitStarted = false;
  const forwardAbort = (): void => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const promise = run({
    signal: controller.signal,
    onCommitStart: () => {
      commitStarted = true;
    },
  }).finally(() => {
    parentSignal.removeEventListener('abort', forwardAbort);
    if (state.inflightFinalizations.get(jobId)?.promise === promise) {
      state.inflightFinalizations.delete(jobId);
    }
  });
  const tracked = Object.freeze({
    promise,
    abort: () => controller.abort(),
    commitStarted: () => commitStarted,
  });
  state.inflightFinalizations.set(jobId, tracked);
  return promise;
}

export function observeDurableRecoveryContainmentFor(
  progressStore: JobStore,
  runtime: Runtime,
  jobId: string,
  runtimeRecord: Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'durable-cli' }>,
  containmentObservation?: ReturnType<typeof createFailureDomainContainmentObservation<FailureDomainContainment>>,
): Readonly<{
  evidence: DurableCliPreReadyOwnershipEvidence;
  observation: RecordedContainmentObservation;
  permitsIndependentAbsenceDecision: () => boolean;
  refresh: () => RecordedContainmentObservation;
}> {
  let failureDomain = containmentObservation?.failureDomain;
  const history =
    containmentObservation?.permitsIndependentAbsenceDecision ?? createFailureDomainAbsenceObserver(undefined);
  const observeLeaf = () => failureDomain?.observe() ?? ({ kind: 'missing' } as const);
  const retainedObservation = createFailureDomainContainmentObservation(
    { observe: observeLeaf, hasEntered: () => failureDomain?.hasEntered?.() === true },
    history,
  );
  let subject: { pid: number; incarnation: string } | null = null;
  let execution: number | null = null;
  const refresh = (): RecordedContainmentObservation => {
    const current = readDurableCliPreReadyOwnershipEvidence(progressStore.getDb(), jobId, runtimeRecord.pid);
    if (current.kind !== 'current' && current.kind !== 'provisional')
      return { kind: 'unobservable', reason: durableOwnershipEvidenceHoldReason(current) };
    const record = current.record;
    if (subject !== null && (record.pid !== subject.pid || record.incarnation !== subject.incarnation))
      return { kind: 'unobservable', reason: 'the recorded process identity changed during containment recovery' };
    subject = record;
    if (runtime.process.failureDomainRoot.kind === 'placed') {
      let currentExecution: number | null;
      try {
        currentExecution = readDurableCliExecution(progressStore.getDb(), jobId, record);
      } catch {
        return { kind: 'unobservable', reason: 'execution identity unavailable' };
      }
      if (execution !== null && currentExecution !== execution)
        return {
          kind: 'unobservable',
          reason: 'the recorded execution association changed during containment recovery',
        };
      execution = currentExecution;
    }
    failureDomain =
      containmentObservation?.failureDomain ?? durableCliFailureDomain(runtime, progressStore.getDb(), jobId, record);
    const observed = observeRecordedContainment(
      { ...record, childRoot: current.kind === 'current' ? current.record.childRoot : null },
      {
        failureDomain: retainedObservation.failureDomain,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
      },
    );
    return observed.kind === 'absent' && !history(observeLeaf())
      ? { kind: 'unobservable', reason: 'the observed leaf absence is no longer established' }
      : observed;
  };
  const evidence = readDurableCliPreReadyOwnershipEvidence(progressStore.getDb(), jobId, runtimeRecord.pid);
  return { evidence, observation: refresh(), permitsIndependentAbsenceDecision: () => history(observeLeaf()), refresh };
}

async function runHeldRecoveryReapAttempt(
  state: RecoveryCoordinatorState,
  runtime: Runtime,
  cancelHeldRecoveryReap: (jobId: string) => Promise<void> | null,
  jobId: string,
  record: Parameters<typeof reapDurableCliProcess>[1],
  parentSignal: AbortSignal,
  failureDomain?: ReturnType<typeof durableCliFailureDomain>,
  observation = createFailureDomainContainmentObservation(failureDomain),
): Promise<Awaited<ReturnType<typeof reapDurableCliProcess>> | Readonly<{ kind: 'superseded' }>> {
  const priorSettlement = cancelHeldRecoveryReap(jobId);
  if (priorSettlement !== null) await priorSettlement;
  const generation = (state.heldRecoveryReapGenerations.get(jobId) ?? 0) + 1;
  state.heldRecoveryReapGenerations.set(jobId, generation);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', forwardAbort, { once: true });
  let markSettled!: () => void;
  const attempt: HeldRecoveryReapAttempt = {
    abort: controller,
    settlement: new Promise<void>((resolve) => {
      markSettled = resolve;
    }),
  };
  state.heldRecoveryReapAttempts.set(jobId, attempt);
  try {
    const result = await reapDurableCliProcess(runtime, record, controller.signal, failureDomain, observation);
    if (state.heldRecoveryReapGenerations.get(jobId) !== generation || controller.signal.aborted) {
      return { kind: 'superseded' };
    }
    return result.kind === 'absence-confirmed' && !observation.permitsIndependentAbsenceDecision()
      ? { kind: 'held', reason: 'the durable job leaf absence is unobservable' }
      : result;
  } finally {
    parentSignal.removeEventListener('abort', forwardAbort);
    if (state.heldRecoveryReapAttempts.get(jobId) === attempt) {
      state.heldRecoveryReapAttempts.delete(jobId);
    }
    markSettled();
  }
}

async function performRecoveryLifecycleTeardown({
  state,
  runtime,
  eventBus,
  onPhaseChanged,
  cancelHeldRecoveryReap,
  releaseAdoptedJob,
  releaseStartupOwnership,
  resetRecoveryState,
}: {
  state: RecoveryCoordinatorState;
  runtime: Runtime;
  eventBus: JobEventBus;
  onPhaseChanged: (input: Readonly<{ jobId: string; phase: JobPhase; previousPhase: JobPhase }>) => void;
  cancelHeldRecoveryReap: (jobId: string) => Promise<void> | null;
  releaseAdoptedJob: (jobId: string) => void;
  releaseStartupOwnership: () => void;
  resetRecoveryState: (options?: { forceRegistryRelease?: boolean }) => void;
}): Promise<void> {
  eventBus.off('job:phase_changed', onPhaseChanged);
  state.teardownRequested = true;

  for (const pollInterval of state.recoveryPollIntervals.values()) {
    runtime.time.clearInterval(pollInterval);
  }
  state.recoveryPollIntervals.clear();
  const heldRecoveryReapSettlements = [...state.heldRecoveryReapAttempts].flatMap(([jobId]) => {
    const settlement = cancelHeldRecoveryReap(jobId);
    return settlement === null ? [] : [settlement];
  });
  await Promise.allSettled(heldRecoveryReapSettlements);
  state.heldRecoveryReapGenerations.clear();

  for (const jobId of [...state.adoptedRunningPids.keys()]) {
    releaseAdoptedJob(jobId);
  }
  for (const finalization of state.inflightFinalizations.values()) {
    finalization.abort();
  }
  await Promise.allSettled(
    [...state.inflightFinalizations.values()]
      .filter((finalization) => finalization.commitStarted())
      .map((finalization) => finalization.promise),
  );
  for (const cleanup of state.adoptedRunningJobCleanups.values()) {
    cleanup();
  }
  state.adoptedRunningJobCleanups.clear();
  state.adoptedRunningPids.clear();
  if (state.recoveryRegistry !== null) {
    for (const [jobId] of [...state.recoveryRegistry]) {
      state.recoveryRegistry.remove(jobId);
    }
  }
  state.cancelledRecoveryJobIds.clear();
  state.providerOperationRecoveries.clear();
  releaseStartupOwnership();
  resetRecoveryState({ forceRegistryRelease: true });
}

function createRecoveryCoordinatorState(
  onRecoverySettlement: ((jobId: string) => void) | undefined,
): RecoveryCoordinatorState {
  return {
    recoveryRegistry: null,
    onRecoverySettlement,
    cancelledRecoveryJobIds: new Set<string>(),
    adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
    unansweredAdoptionProbes: new Map<string, number>(),
    recoveryPollIntervals: new Map<string, TimerHandle>(),
    heldRecoveryReapGenerations: new Map<string, number>(),
    heldRecoveryReapAttempts: new Map(),
    adoptedRunningJobCleanups: new Map<string, () => void>(),
    inflightFinalizations: new Map(),
    providerOperationRecoveries: new Map(),
    teardownRequested: false,
    teardownState: { kind: 'pending' },
  };
}

export function createRecoveryLifecycle(
  deps: Readonly<{
    progressStore: JobStore;
    runtime: Runtime;
    runtimeState: { setLaunchFenceActive(active: boolean): void };
    eventBus: JobEventBus;
    onPhaseChanged(input: Readonly<{ jobId: string; phase: JobPhase; previousPhase: JobPhase }>): void;
    releaseStartupOwnership(): void;
    onRecoverySettlement?: (jobId: string) => void;
  }>,
) {
  const { progressStore, runtime, runtimeState, eventBus, onPhaseChanged, releaseStartupOwnership } = deps;
  const state = createRecoveryCoordinatorState(deps.onRecoverySettlement);

  eventBus.on('job:phase_changed', onPhaseChanged);

  const clearRecoveryPoller = (jobId: string): void => {
    const pollInterval = state.recoveryPollIntervals.get(jobId);
    if (!pollInterval) {
      return;
    }
    runtime.time.clearInterval(pollInterval);
    state.recoveryPollIntervals.delete(jobId);
  };

  const startTrackedFinalization = (
    jobId: string,
    parentSignal: AbortSignal,
    run: (fence: { signal: AbortSignal; onCommitStart(): void }) => Promise<void>,
  ): Promise<void> => trackRecoveryFinalization(state, jobId, parentSignal, run);

  const takeAdoptedJobCleanup = (jobId: string): (() => void) | null => {
    const cleanup = state.adoptedRunningJobCleanups.get(jobId) ?? null;
    state.adoptedRunningJobCleanups.delete(jobId);
    return cleanup;
  };

  const maybeReleaseRecoveryRegistry = (): void => {
    if (state.adoptedRunningPids.size === 0 && state.recoveryRegistry?.size === 0) {
      state.recoveryRegistry = null;
    }
  };

  const releaseAdoptedJob = (jobId: string): void => {
    if (state.recoveryRegistry?.has(jobId)) return;
    clearRecoveryPoller(jobId);
    state.adoptedRunningPids.delete(jobId);
    state.recoveryRegistry?.remove(jobId);
    takeAdoptedJobCleanup(jobId)?.();
    maybeReleaseRecoveryRegistry();
  };

  const observeDurableRecoveryContainment = (
    jobId: string,
    runtimeRecord: Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'durable-cli' }>,
    observation?: ReturnType<typeof createFailureDomainContainmentObservation<FailureDomainContainment>>,
  ) => observeDurableRecoveryContainmentFor(progressStore, runtime, jobId, runtimeRecord, observation);

  const cancelHeldRecoveryReap = (jobId: string): Promise<void> | null => {
    state.heldRecoveryReapGenerations.set(jobId, (state.heldRecoveryReapGenerations.get(jobId) ?? 0) + 1);
    const attempt = state.heldRecoveryReapAttempts.get(jobId);
    attempt?.abort.abort();
    return attempt?.settlement ?? null;
  };

  const runHeldRecoveryReap = (
    jobId: string,
    record: Parameters<typeof reapDurableCliProcess>[1],
    parentSignal: AbortSignal,
    observation?: ReturnType<typeof createFailureDomainContainmentObservation<FailureDomainContainment>>,
  ) =>
    runHeldRecoveryReapAttempt(
      state,
      runtime,
      cancelHeldRecoveryReap,
      jobId,
      record,
      parentSignal,
      observation?.failureDomain ?? durableCliFailureDomain(runtime, progressStore.getDb(), jobId, record),
      observation,
    );

  const resetRecoveryState = (options: { forceRegistryRelease?: boolean } = {}): void => {
    if (options.forceRegistryRelease) {
      state.recoveryRegistry = null;
    } else {
      maybeReleaseRecoveryRegistry();
    }
    runtimeState.setLaunchFenceActive(false);
  };

  const performTeardown = (): Promise<void> =>
    performRecoveryLifecycleTeardown({
      state,
      runtime,
      eventBus,
      onPhaseChanged,
      cancelHeldRecoveryReap,
      releaseAdoptedJob,
      releaseStartupOwnership,
      resetRecoveryState,
    });

  const teardown = (): Promise<void> => {
    if (state.teardownState.kind === 'settled') return Promise.resolve();
    if (state.teardownState.kind === 'in-flight') return state.teardownState.settlement;

    const settlement = performTeardown().then(
      () => {
        state.teardownState = { kind: 'settled' };
      },
      (error: unknown) => {
        state.teardownState = { kind: 'pending' };
        throw error;
      },
    );
    state.teardownState = { kind: 'in-flight', settlement };
    return settlement;
  };

  return {
    state,
    cancelHeldRecoveryReap,
    clearRecoveryPoller,
    maybeReleaseRecoveryRegistry,
    observeDurableRecoveryContainment,
    releaseAdoptedJob,
    resetRecoveryState,
    runHeldRecoveryReap,
    startTrackedFinalization,
    takeAdoptedJobCleanup,
    teardown,
  };
}
