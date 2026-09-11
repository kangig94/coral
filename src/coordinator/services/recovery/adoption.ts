import { errorMessage } from '../../../infra/error-format.js';
import type { RecordedContainmentObservation } from '../../../infra/process-containment.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { JobStore } from '../../../jobs/store.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { RecoveryAbortDisposition, RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { CommitEventsFn } from '../../../store/append.js';
import type { DurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import type { RecoveryDisposition, RecoveryReport, RecoverySettlementFact } from '../../../recovery/containment.js';
import { COORDINATOR_NOT_APPLICABLE_FACTS, type QueuedRecoverableJob, type RunningRecoverableJob } from './actions.js';
import type { reapDurableCliProcess } from './actions.js';
import type { CoordinatorRecoveryItem } from './snapshot.js';
import type { CoordinatorRecoveryControls, CoordinatorSettlementOptions, CoordinatorWalkOptions } from './walk.js';
import { createRunningRecoveryAdoption } from './running-adoption.js';

type RecoveryAdoptionContext = {
  queuedJobs: QueuedRecoverableJob[];
  runningJobs: RunningRecoverableJob[];
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason: InterruptedAppServerReason;
  abandonHeldJob(jobId: string): RecoveryAbortDisposition;
};

export type RecoveryAdoptionState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  unansweredAdoptionProbes: Map<string, number>;
  recoveryPollIntervals: Map<string, TimerHandle>;
  adoptedRunningJobCleanups: Map<string, () => void>;
  teardownRequested: boolean;
};

export interface RecoveryAdoption {
  run(
    context: RecoveryAdoptionContext,
    direct?: Readonly<{ item: CoordinatorRecoveryItem; controls: CoordinatorRecoveryControls }>,
  ): Promise<RecoveryDisposition | void>;
  acceptQueued(
    job: QueuedRecoverableJob,
    signal: AbortSignal,
    coordinatorCommit: CommitEventsFn,
    failureMode: 'settle' | 'retry',
  ): Promise<void>;
  recoverQueued(
    item: CoordinatorRecoveryItem,
    job: QueuedRecoverableJob,
    signal: AbortSignal,
    coordinatorCommit: CommitEventsFn,
    controls: CoordinatorRecoveryControls,
  ): Promise<RecoveryDisposition>;
}

export function createRecoveryAdoption(
  deps: Readonly<{
    state: RecoveryAdoptionState;
    progressStore: JobStore;
    runtime: Runtime;
    eventBus: JobEventBus;
    getRecoveryService(ctx: InvocationContext): RecoveryCapableService;
    createInvocationContext(projectRoot: string): InvocationContext;
    log(message: string): void;
    clearRecoveryPoller(jobId: string): void;
    startTrackedFinalization(
      jobId: string,
      parentSignal: AbortSignal,
      run: (fence: { signal: AbortSignal; onCommitStart(): void }) => Promise<void>,
    ): Promise<void>;
    observeDurableRecoveryContainment(
      jobId: string,
      runtimeRecord: Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'durable-cli' }>,
    ): Readonly<{
      evidence: DurableCliPreReadyOwnershipEvidence;
      observation: RecordedContainmentObservation;
    }>;
    runHeldRecoveryReap(
      jobId: string,
      record: Parameters<typeof reapDurableCliProcess>[1],
      parentSignal: AbortSignal,
    ): Promise<Awaited<ReturnType<typeof reapDurableCliProcess>> | Readonly<{ kind: 'superseded' }>>;
    deleteCoordinatorRecoveryQuarantine(jobId: string): boolean;
    runCoordinatorWalk(options: CoordinatorWalkOptions): Promise<RecoveryReport<CoordinatorRecoveryItem>>;
    settleUnexpectedRecoveryFailure(
      item: CoordinatorRecoveryItem,
      jobId: string,
      summary: string,
      error: unknown,
      coordinatorCommit: CommitEventsFn,
      report: (message: string) => void,
    ): RecoveryDisposition;
    settleFault(
      item: CoordinatorRecoveryItem,
      jobId: string,
      fault: JobLifecycleFault | JobProgressFault,
      coordinatorCommit: CommitEventsFn,
      content?: string,
    ): readonly RecoverySettlementFact[];
    takeAdoptedJobCleanup(jobId: string): (() => void) | null;
    maybeReleaseRecoveryRegistry(): void;
    settleCoordinatorRecoveryItem(
      item: CoordinatorRecoveryItem,
      options: CoordinatorSettlementOptions,
    ): readonly RecoverySettlementFact[];
  }>,
): RecoveryAdoption {
  const {
    state,
    progressStore,
    runtime,
    eventBus,
    getRecoveryService,
    createInvocationContext,
    runCoordinatorWalk,
    settleUnexpectedRecoveryFailure,
    settleCoordinatorRecoveryItem,
  } = deps;
  const runRunningRecovery = createRunningRecoveryAdoption(deps);
  const recoverQueuedItem = async (
    item: CoordinatorRecoveryItem,
    { jobId, authority }: QueuedRecoverableJob,
    signal: AbortSignal,
    coordinatorCommit: CommitEventsFn,
    controls: CoordinatorRecoveryControls,
  ): Promise<RecoveryDisposition> => {
    const { launchRecord } = authority;
    controls.setProcessLocalCleanup(() => {
      state.recoveryRegistry?.remove(jobId);
      state.recoveryRegistry?.clearCancelled(jobId);
    });
    const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
    signal.throwIfAborted();
    if (state.cancelledRecoveryJobIds.has(jobId)) {
      const facts = settleCoordinatorRecoveryItem(item, {
        jobId,
        terminal: {
          kind: 'terminal',
          terminal: {
            content: '',
            durationMs: elapsedDurationMs(launchRecord.createdAt, runtime.time.now(), `job ${jobId}`),
            outcome: { kind: 'aborted', reason: 'user_abort' },
          },
        },
        coordinatorCommit,
        nowMs: runtime.time.now(),
        emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
      });
      controls.report(`Aborted queued recovery job: ${jobId}\n`);
      return { kind: 'advanced', outcome: 'settled', facts, detail: 'queued recovery aborted' };
    }
    await service.recoverQueuedJob(authority);
    controls.report(`Recovered queued job: ${jobId}\n`);
    return {
      kind: 'advanced',
      outcome: 'settled',
      facts: COORDINATOR_NOT_APPLICABLE_FACTS,
      detail: 'queued job recovered',
    };
  };

  const acceptQueuedRecovery = async (
    job: QueuedRecoverableJob,
    signal: AbortSignal,
    coordinatorCommit: CommitEventsFn,
    failureMode: 'settle' | 'retry',
  ): Promise<void> => {
    const { jobId } = job;
    let acceptanceError: Error | null = null;
    await runCoordinatorWalk({
      subjectKey: jobId,
      signal,
      coordinatorCommit,
      summary: `Queued recovery adoption for ${jobId}`,
      settle: async (item, controls) => {
        try {
          return await recoverQueuedItem(item, job, signal, coordinatorCommit, controls);
        } catch (error: unknown) {
          acceptanceError = error instanceof Error ? error : new Error(errorMessage(error));
          throw acceptanceError;
        }
      },
      ...(failureMode === 'settle'
        ? {
            settleFailure: (item: CoordinatorRecoveryItem, error: unknown, controls: CoordinatorRecoveryControls) =>
              settleUnexpectedRecoveryFailure(
                item,
                jobId,
                'Queued recovery adoption failed',
                error,
                coordinatorCommit,
                controls.report,
              ),
          }
        : {}),
    });
    if (failureMode === 'retry' && acceptanceError !== null) {
      throw new Error(errorMessage(acceptanceError));
    }
  };

  async function runRecoveryAdoption(
    {
      queuedJobs,
      runningJobs,
      signal,
      coordinatorCommit,
      interruptedAppServerReason,
      abandonHeldJob,
    }: RecoveryAdoptionContext,
    direct?: Readonly<{ item: CoordinatorRecoveryItem; controls: CoordinatorRecoveryControls }>,
  ): Promise<RecoveryDisposition | void> {
    queuedJobs.sort((a, b) => a.authority.launchRecord.enqueueSequence - b.authority.launchRecord.enqueueSequence);

    let maxRecoverableSeq: number | null = null;
    for (const job of queuedJobs) {
      maxRecoverableSeq =
        maxRecoverableSeq === null
          ? job.authority.launchRecord.enqueueSequence
          : Math.max(maxRecoverableSeq, job.authority.launchRecord.enqueueSequence);
    }
    for (const job of runningJobs) {
      maxRecoverableSeq =
        maxRecoverableSeq === null
          ? job.authority.launchRecord.enqueueSequence
          : Math.max(maxRecoverableSeq, job.authority.launchRecord.enqueueSequence);
    }
    if (maxRecoverableSeq !== null) {
      progressStore.seedEnqueueSequence(maxRecoverableSeq);
    }

    for (const job of runningJobs) {
      const disposition = await runRunningRecovery(
        job,
        { signal, coordinatorCommit, interruptedAppServerReason, abandonHeldJob },
        direct,
      );
      if (disposition !== undefined) return disposition;
    }

    for (const job of queuedJobs) {
      await acceptQueuedRecovery(job, signal, coordinatorCommit, 'settle');
    }

    signal.throwIfAborted();
  }

  return {
    run: runRecoveryAdoption,
    acceptQueued: acceptQueuedRecovery,
    recoverQueued: recoverQueuedItem,
  };
}
