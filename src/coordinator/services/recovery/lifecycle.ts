import { observeRecordedContainment, type RecordedContainmentObservation } from '../../../infra/process-containment.js';
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

export function createRecoveryLifecycle(
  deps: Readonly<{
    progressStore: JobStore;
    runtime: Runtime;
    runtimeState: { setLaunchFenceActive(active: boolean): void };
    eventBus: JobEventBus;
    onPhaseChanged(input: Readonly<{ jobId: string; phase: JobPhase; previousPhase: JobPhase }>): void;
    releaseStartupOwnership(): void;
  }>,
) {
  const { progressStore, runtime, runtimeState, eventBus, onPhaseChanged, releaseStartupOwnership } = deps;
  const state: RecoveryCoordinatorState = {
    recoveryRegistry: null,
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
  ): Promise<void> => {
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
  };

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
  ): Readonly<{
    evidence: DurableCliPreReadyOwnershipEvidence;
    observation: RecordedContainmentObservation;
  }> => {
    const evidence = readDurableCliPreReadyOwnershipEvidence(progressStore.getDb(), jobId, runtimeRecord.pid);
    const observation =
      evidence.kind === 'current' || evidence.kind === 'provisional'
        ? observeRecordedContainment(
            {
              ...evidence.record,
              childRoot: evidence.kind === 'current' ? evidence.record.childRoot : null,
            },
            {
              process: runtime.process,
              platform: runtime.env.platform() as NodeJS.Platform,
              readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
            },
          )
        : { kind: 'unobservable' as const, reason: durableOwnershipEvidenceHoldReason(evidence) };
    return { evidence, observation };
  };

  const cancelHeldRecoveryReap = (jobId: string): Promise<void> | null => {
    state.heldRecoveryReapGenerations.set(jobId, (state.heldRecoveryReapGenerations.get(jobId) ?? 0) + 1);
    const attempt = state.heldRecoveryReapAttempts.get(jobId);
    attempt?.abort.abort();
    return attempt?.settlement ?? null;
  };

  const runHeldRecoveryReap = async (
    jobId: string,
    record: Parameters<typeof reapDurableCliProcess>[1],
    parentSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof reapDurableCliProcess>> | Readonly<{ kind: 'superseded' }>> => {
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
      const result = await reapDurableCliProcess(runtime, record, controller.signal);
      return state.heldRecoveryReapGenerations.get(jobId) === generation && !controller.signal.aborted
        ? result
        : { kind: 'superseded' };
    } finally {
      parentSignal.removeEventListener('abort', forwardAbort);
      if (state.heldRecoveryReapAttempts.get(jobId) === attempt) {
        state.heldRecoveryReapAttempts.delete(jobId);
      }
      markSettled();
    }
  };

  const resetRecoveryState = (options: { forceRegistryRelease?: boolean } = {}): void => {
    if (options.forceRegistryRelease) {
      state.recoveryRegistry = null;
    } else {
      maybeReleaseRecoveryRegistry();
    }
    runtimeState.setLaunchFenceActive(false);
  };

  const performTeardown = async (): Promise<void> => {
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
  };

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
