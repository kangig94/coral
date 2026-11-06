import { ExecutionAcceptanceRefusedError } from '../../../jobs/finishing.js';
import type { FailureDomainContainment } from '../../../infra/failure-domain.js';
import { durableCliFailureDomain } from '../durable-cli-failure-domain.js';
import { SuccessionWriterParkedError } from '../../../store/db.js';
import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage, formatError } from '../../../infra/error-format.js';
import {
  createFailureDomainContainmentObservation,
  ProcessContainmentError,
  type RecordedContainmentObservation,
} from '../../../infra/process-containment.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import { isAppServerRuntime } from '../../../jobs/records.js';
import type { JobStore } from '../../../jobs/store.js';
import type { AbortNextStep } from '../../../jobs/contracts/abort-registry.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { RecoveryAbortDisposition, RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { CommitEventsFn } from '../../../store/append.js';
import type { DurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import {
  readDurableCliContainmentStatus,
  readDurableCliPreReadyOwnershipEvidence,
  writeDurableCliContainmentStatus,
} from '../../../jobs/runtime-meta-store.js';
import type { RecoveryDisposition, RecoveryQuarantineRemedy } from '../../../recovery/containment.js';
import {
  COORDINATOR_NOT_APPLICABLE_FACTS,
  COORDINATOR_TERMINAL_OBLIGATION,
  durableOwnershipEvidenceHoldReason,
  durableOwnershipStatusEvidence,
  finalizeDeadAdoptedJob,
  type RunningRecoverableJob,
} from './actions.js';
import type { reapDurableCliProcess } from './actions.js';
import type { CoordinatorRecoveryItem } from './snapshot.js';
import type { CoordinatorRecoveryControls, CoordinatorWalkOptions, createRecoveryWalk } from './walk.js';

const RECOVERY_POLL_MS = 500;
const UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD = 10;

export type RunningRecoveryAdoptionContext = Readonly<{
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason: InterruptedAppServerReason;
  abandonHeldJob(jobId: string): RecoveryAbortDisposition;
}>;

type RunningRecoveryAdoptionState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  unansweredAdoptionProbes: Map<string, number>;
  recoveryPollIntervals: Map<string, TimerHandle>;
  adoptedRunningJobCleanups: Map<string, () => void>;
  teardownRequested: boolean;
};

type RunningRecoveryAdoptionDependencies = Readonly<{
  state: RunningRecoveryAdoptionState;
  progressStore: JobStore;
  runtime: Runtime;
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
    runtimeRecord: DurableRunningRuntime,
    observation?: ReturnType<typeof createFailureDomainContainmentObservation<FailureDomainContainment>>,
  ): Readonly<{
    evidence: DurableCliPreReadyOwnershipEvidence;
    observation: RecordedContainmentObservation;
  }>;
  runHeldRecoveryReap(
    jobId: string,
    record: Parameters<typeof reapDurableCliProcess>[1],
    parentSignal: AbortSignal,
    observation?: ReturnType<typeof createFailureDomainContainmentObservation<FailureDomainContainment>>,
  ): Promise<Awaited<ReturnType<typeof reapDurableCliProcess>> | Readonly<{ kind: 'superseded' }>>;
  deleteCoordinatorRecoveryQuarantine(jobId: string): boolean;
  runCoordinatorWalk(options: CoordinatorWalkOptions): Promise<unknown>;
  settleUnexpectedRecoveryFailure: ReturnType<typeof createRecoveryWalk>['settleUnexpectedRecoveryFailure'];
  settleFault: ReturnType<typeof createRecoveryWalk>['settleFault'];
  takeAdoptedJobCleanup(jobId: string): (() => void) | null;
  maybeReleaseRecoveryRegistry(): void;
}>;

type DurableRunningRuntime = Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'durable-cli' }>;
type AppServerRunningRuntime = Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'app-server' }>;
type DurableContainment = ReturnType<RunningRecoveryAdoptionDependencies['observeDurableRecoveryContainment']>;

type RunningRecoverySettlement = Readonly<{
  leaf: ReturnType<typeof createFailureDomainContainmentObservation<FailureDomainContainment>>;
  deps: RunningRecoveryAdoptionDependencies;
  recovery: RunningRecoverableJob;
  context: RunningRecoveryAdoptionContext;
  item: CoordinatorRecoveryItem;
  controls: CoordinatorRecoveryControls;
  service: RecoveryCapableService;
  settle(item: CoordinatorRecoveryItem, controls: CoordinatorRecoveryControls): Promise<RecoveryDisposition>;
}>;

type RecoveredProgress = Readonly<{
  drain(): void;
  runtimeRecord(): DurableRunningRuntime;
}>;

function nextStepDetail(nextStep: AbortNextStep | undefined): string | null {
  if (nextStep === undefined) return null;
  return typeof nextStep === 'string' ? nextStep : nextStep.detail;
}

function nextStepRemedy(nextStep: AbortNextStep | undefined): RecoveryQuarantineRemedy | undefined {
  return typeof nextStep === 'object' ? nextStep.remedy : undefined;
}

function settledRecoveryFacts(jobId: string) {
  return [
    { obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'done' as const, authorityRef: `job:${jobId}:terminal` },
  ];
}

function holdInterruptedAppServerRecovery(settlement: RunningRecoverySettlement, error: unknown): RecoveryDisposition {
  const { deps, recovery, controls } = settlement;
  const { jobId } = recovery;
  controls.clearProcessLocalCleanup();
  if (!deps.state.recoveryPollIntervals.has(jobId)) {
    let inFlight = false;
    const interval = deps.runtime.time.setInterval(() => {
      if (inFlight || deps.state.teardownRequested || settlement.context.signal.aborted) return;
      inFlight = true;
      void resumeHeldRecoveryFinalization(settlement)
        .catch((failure: unknown) => {
          try {
            deps.log(`Interrupted app-server recovery retry failed for ${jobId}: ${formatError(failure)}\n`);
          } catch {
            /* The timer retains ownership if reporting fails. */
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, RECOVERY_POLL_MS);
    interval.unref?.();
    deps.state.recoveryPollIntervals.set(jobId, interval);
  }
  const detail = `${errorMessage(error)} Automatic interrupted app-server recovery retries every ${RECOVERY_POLL_MS}ms until carrier absence and finalization are confirmed.`;
  controls.report(`Held interrupted app-server recovery for ${jobId}: ${detail}\n`);
  return { kind: 'quarantine', detail };
}

async function finalizeRecoveredAppServer(
  settlement: RunningRecoverySettlement,
  runtimeRecord: AppServerRunningRuntime,
): Promise<RecoveryDisposition> {
  const { deps, recovery, context, controls, service } = settlement;
  const { state, startTrackedFinalization } = deps;
  const { jobId, authority } = recovery;
  const { signal, interruptedAppServerReason } = context;
  const abortDisposition = state.recoveryRegistry?.getAbortDisposition(jobId);
  const userCancelled = abortDisposition?.kind === 'finalization-pending';
  if (abortDisposition !== undefined && !userCancelled) {
    controls.clearProcessLocalCleanup();
    const nextStep = nextStepDetail(abortDisposition.nextStep);
    controls.report(`Held recovered app-server abort for ${jobId}: ${abortDisposition.reason}\n`);
    return {
      kind: 'quarantine',
      detail: nextStep === null ? abortDisposition.reason : `${abortDisposition.reason}. ${nextStep}`,
      ...(nextStepRemedy(abortDisposition.nextStep) === undefined
        ? {}
        : { remedy: nextStepRemedy(abortDisposition.nextStep) }),
    };
  }
  if (!userCancelled) {
    state.recoveryRegistry?.setAbortHandler(jobId, () => ({
      kind: 'refused',
      reason: 'startup recovery already owns app-server finalization',
      nextStep: {
        detail: 'Wait for startup recovery to finish before retrying an abort.',
        remedy: { kind: 'jobs-detail', jobId },
      },
    }));
  }
  signal.throwIfAborted();
  try {
    await startTrackedFinalization(jobId, signal, (fence) =>
      service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
        reason: userCancelled ? 'user_abort' : interruptedAppServerReason,
        ...fence,
      }),
    );
  } catch (error: unknown) {
    const carrierRefusal =
      error instanceof ProcessContainmentError ||
      (error instanceof ExecutionAcceptanceRefusedError && error.cause instanceof ProcessContainmentError);
    if (userCancelled || carrierRefusal) return holdInterruptedAppServerRecovery(settlement, error);
    throw error;
  }
  signal.throwIfAborted();
  controls.setProcessLocalCleanup(() => releaseRunningRecovery(settlement));
  controls.report(
    userCancelled
      ? `Finalized user-aborted recovered app-server job: ${jobId}\n`
      : `Recovered interrupted app-server job: ${jobId}\n`,
  );
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts: settledRecoveryFacts(jobId),
    detail: userCancelled ? 'user-aborted app-server job finalized' : 'interrupted app-server job finalized',
  };
}

function appendRecoveryProgress(settlement: RunningRecoverySettlement, message: string): void {
  const { jobId, authority } = settlement.recovery;
  const status = settlement.deps.progressStore.readStatus(jobId);
  if (status?.execution !== authority.launchRecord.execution || status.finishing === true) return;
  settlement.deps.progressStore.appendProgress(jobId, message);
}

function createRecoveredProgress(
  settlement: RunningRecoverySettlement,
  initialRuntimeRecord: DurableRunningRuntime,
): RecoveredProgress {
  const { progressStore } = settlement.deps;
  const { jobId, authority } = settlement.recovery;
  const { boundProvider } = authority;
  let adoptedRuntimeRecord = initialRuntimeRecord;
  return {
    drain(): void {
      if (progressStore.readStatus(jobId)?.finishing === true) return;
      if (!boundProvider.recovery?.extractProgress) return;
      try {
        const { messages, newOffset } = boundProvider.recovery.extractProgress({
          stdoutPath: adoptedRuntimeRecord.stdoutPath,
          fromOffset: adoptedRuntimeRecord.tailWatermark ?? 0,
        });
        if (newOffset !== (adoptedRuntimeRecord.tailWatermark ?? 0)) {
          const nextRuntimeRecord = { ...adoptedRuntimeRecord, tailWatermark: newOffset };
          progressStore.appendRuntimeStarted(jobId, nextRuntimeRecord);
          adoptedRuntimeRecord = nextRuntimeRecord;
        }
        for (const message of messages) appendRecoveryProgress(settlement, message);
      } catch (error: unknown) {
        if (error instanceof SuccessionWriterParkedError) throw error;
        settlement.controls.report(`Failed to tail recovered progress for job ${jobId}: ${formatError(error)}\n`);
      }
    },
    runtimeRecord: () => adoptedRuntimeRecord,
  };
}

function requireDurableRecoveryAbsence(settlement: RunningRecoverySettlement): void {
  if (!settlement.leaf.permitsIndependentAbsenceDecision()) {
    throw new ProcessContainmentError(
      'process_containment_reap_failed',
      'The durable job leaf absence is unobservable.',
    );
  }
}

function releaseRunningRecovery(settlement: RunningRecoverySettlement): void {
  const { state, clearRecoveryPoller, takeAdoptedJobCleanup, maybeReleaseRecoveryRegistry } = settlement.deps;
  const { jobId } = settlement.recovery;
  clearRecoveryPoller(jobId);
  state.adoptedRunningPids.delete(jobId);
  state.unansweredAdoptionProbes.delete(jobId);
  const cleanup = takeAdoptedJobCleanup(jobId);
  state.recoveryRegistry?.remove(jobId);
  state.recoveryRegistry?.clearCancelled(jobId);
  cleanup?.();
  maybeReleaseRecoveryRegistry();
}

function wrapperIsAbsent(settlement: RunningRecoverySettlement, containment: DurableContainment): boolean {
  if (containment.evidence.kind !== 'current' && containment.evidence.kind !== 'provisional') return false;
  const { runtime } = settlement.deps;
  const { pid, incarnation } = containment.evidence.record;
  const observed = runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform);
  return (observed !== null && observed !== incarnation) || runtime.process.observeLiveness(pid) === 'absent';
}

async function finalizeContainedDurableRecovery(
  settlement: RunningRecoverySettlement,
  progress: RecoveredProgress,
  operatorAbandoned: boolean,
): Promise<RecoveryDisposition> {
  const { state, progressStore, startTrackedFinalization } = settlement.deps;
  const { jobId, authority } = settlement.recovery;
  const { signal } = settlement.context;
  if (operatorAbandoned) state.cancelledRecoveryJobIds.add(jobId);
  else requireDurableRecoveryAbsence(settlement);
  progress.drain();
  await startTrackedFinalization(jobId, signal, (fence) =>
    finalizeDeadAdoptedJob({
      jobId,
      runtimeRecord: progress.runtimeRecord(),
      service: settlement.service,
      authority,
      progressStore,
      cancelledJobIds: state.cancelledRecoveryJobIds,
      fence: {
        ...fence,
        onCommitStart: () => {
          if (!operatorAbandoned) requireDurableRecoveryAbsence(settlement);
          fence.onCommitStart();
        },
      },
    }),
  );
  if (!operatorAbandoned) requireDurableRecoveryAbsence(settlement);
  settlement.controls.setProcessLocalCleanup(() => {
    if (!operatorAbandoned) requireDurableRecoveryAbsence(settlement);
    releaseRunningRecovery(settlement);
  });
  settlement.controls.report(
    operatorAbandoned
      ? `Finalized operator-abandoned durable recovery job: ${jobId}\n`
      : `Finalized dead durable recovery job: ${jobId}\n`,
  );
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts: settledRecoveryFacts(jobId),
    detail: operatorAbandoned
      ? 'operator-abandoned durable job finalized without process absence proof'
      : 'dead durable job finalized',
  };
}

async function resumeHeldRecoveryFinalization(settlement: RunningRecoverySettlement): Promise<void> {
  const { deleteCoordinatorRecoveryQuarantine, runCoordinatorWalk, settleUnexpectedRecoveryFailure } = settlement.deps;
  const { jobId } = settlement.recovery;
  const { signal, coordinatorCommit } = settlement.context;
  if (!deleteCoordinatorRecoveryQuarantine(jobId)) return;
  await runCoordinatorWalk({
    subjectKey: jobId,
    signal,
    coordinatorCommit,
    summary: `Held interrupted recovery finalization for ${jobId}`,
    settle: settlement.settle,
    settleFailure: (item, error, retryControls) =>
      settleUnexpectedRecoveryFailure(
        item,
        jobId,
        'Held interrupted recovery finalization failed',
        error,
        coordinatorCommit,
        retryControls.report,
      ),
  });
}

async function retryHeldCleanup(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  retryIntervalMs: number,
): Promise<void> {
  const { state, progressStore, clearRecoveryPoller, observeDurableRecoveryContainment, runHeldRecoveryReap } =
    settlement.deps;
  const { jobId } = settlement.recovery;
  const { signal } = settlement.context;
  if (state.teardownRequested) return;

  const currentStatus = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
  if (currentStatus.kind === 'valid' && currentStatus.status.disposition.kind === 'operator-abandoned') {
    clearRecoveryPoller(jobId);
    return;
  }
  const containment = observeDurableRecoveryContainment(jobId, runtimeRecord, settlement.leaf);
  let cleanup =
    containment.observation.kind === 'absent'
      ? ({ kind: 'absence-confirmed' } as const)
      : containment.evidence.kind === 'current' || containment.evidence.kind === 'provisional'
        ? await runHeldRecoveryReap(jobId, containment.evidence.record, signal, settlement.leaf)
        : { kind: 'held' as const, reason: durableOwnershipEvidenceHoldReason(containment.evidence) };
  if (cleanup.kind === 'superseded') return;
  if (cleanup.kind === 'absence-confirmed' && !settlement.leaf.permitsIndependentAbsenceDecision()) {
    cleanup = { kind: 'held', reason: 'the durable job leaf absence is unobservable' };
  }

  const statusAfterRetry = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
  if (statusAfterRetry.kind === 'valid' && statusAfterRetry.status.disposition.kind === 'operator-abandoned') {
    clearRecoveryPoller(jobId);
    return;
  }
  if (cleanup.kind === 'absence-confirmed') {
    await resumeHeldRecoveryFinalization(settlement);
    return;
  }

  writeDurableCliContainmentStatus(progressStore.getDb(), {
    jobId,
    evidence: durableOwnershipStatusEvidence(containment.evidence),
    disposition: { kind: 'held', reason: cleanup.reason, retryIntervalMs, abandonment: 'abort-job' },
  });
  if (
    currentStatus.kind !== 'valid' ||
    currentStatus.status.disposition.kind !== 'held' ||
    currentStatus.status.disposition.reason !== cleanup.reason
  ) {
    appendRecoveryProgress(settlement, `Durable recovery cleanup remains held (${cleanup.reason}).`);
  }
}

function installHeldCleanupRetryPoller(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  retryIntervalMs: number,
): void {
  const { state, runtime, log } = settlement.deps;
  const { jobId } = settlement.recovery;
  if (state.recoveryPollIntervals.has(jobId)) return;

  let retryInFlight = false;
  const pollInterval = runtime.time.setInterval(() => {
    if (retryInFlight) return;
    retryInFlight = true;
    void retryHeldCleanup(settlement, runtimeRecord, retryIntervalMs)
      .catch((error: unknown) => {
        log(`Held durable recovery retry failed for ${jobId}: ${formatError(error)}\n`);
      })
      .finally(() => {
        retryInFlight = false;
      });
  }, retryIntervalMs);
  pollInterval.unref?.();
  state.recoveryPollIntervals.set(jobId, pollInterval);
}

async function reconcileHeldContainmentStatus(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  containment: DurableContainment,
  retryIntervalMs: number,
): Promise<
  RecoveryDisposition | Readonly<{ kind: 'reconciled'; operatorAbandoned: boolean; absenceConfirmed: boolean }>
> {
  const { state, progressStore, runHeldRecoveryReap } = settlement.deps;
  const { jobId } = settlement.recovery;
  const { signal, abandonHeldJob } = settlement.context;
  let cleanup =
    containment.evidence.kind === 'current' || containment.evidence.kind === 'provisional'
      ? await runHeldRecoveryReap(jobId, containment.evidence.record, signal, settlement.leaf)
      : { kind: 'held' as const, reason: durableOwnershipEvidenceHoldReason(containment.evidence) };
  if (cleanup.kind === 'superseded') {
    signal.throwIfAborted();
    return {
      kind: 'deferred',
      authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
      detail: 'durable containment reap ownership transferred',
    };
  }

  if (cleanup.kind === 'absence-confirmed' && !settlement.leaf.permitsIndependentAbsenceDecision()) {
    cleanup = { kind: 'held', reason: 'the durable job leaf absence is unobservable' };
  }

  const statusAfterCleanup = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
  const operatorAbandoned =
    statusAfterCleanup.kind === 'valid' && statusAfterCleanup.status.disposition.kind === 'operator-abandoned';
  if (cleanup.kind === 'absence-confirmed' || operatorAbandoned) {
    return { kind: 'reconciled', operatorAbandoned, absenceConfirmed: cleanup.kind === 'absence-confirmed' };
  }

  writeDurableCliContainmentStatus(progressStore.getDb(), {
    jobId,
    evidence: durableOwnershipStatusEvidence(containment.evidence),
    disposition: { kind: 'held', reason: cleanup.reason, retryIntervalMs, abandonment: 'abort-job' },
  });
  if (!state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId))) {
    throw new Error('Durable containment hold was not accepted by the recovery registry.');
  }
  installHeldCleanupRetryPoller(settlement, runtimeRecord, retryIntervalMs);
  if (!state.recoveryPollIntervals.has(jobId)) {
    throw new Error('Durable containment retry was not accepted by the recovery coordinator.');
  }

  settlement.controls.clearProcessLocalCleanup();
  const detail =
    `${cleanup.reason}. Identity-safe reaping continues every ${retryIntervalMs}ms until absence is confirmed. ` +
    'Operator abandonment remains available without proving process absence or sending another signal.';
  appendRecoveryProgress(settlement, detail);
  settlement.controls.report(`Held durable recovery cleanup: ${jobId}: ${cleanup.reason}\n`);
  return {
    kind: 'deferred',
    continuation: { kind: 'durable-containment-reap', key: jobId },
    detail,
    remedy: { kind: 'abort-job', jobId },
  };
}

async function settleDurableContainment(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  progress: RecoveredProgress,
): Promise<RecoveryDisposition | Readonly<{ kind: 'observable-live'; containment: DurableContainment }>> {
  const { state, progressStore, observeDurableRecoveryContainment } = settlement.deps;
  const { jobId } = settlement.recovery;
  const { abandonHeldJob } = settlement.context;
  const { controls } = settlement;
  const persistedContainment = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
  if (persistedContainment.kind === 'corrupt') {
    const reason = 'The durable containment status is corrupt.';
    appendRecoveryProgress(
      settlement,
      `${reason} Repair or remove the status row before retrying this recovery coordinate.`,
    );
    state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId));
    controls.clearProcessLocalCleanup();
    controls.report(`Held durable recovery job with corrupt containment status: ${jobId}\n`);
    return {
      kind: 'quarantine',
      detail: `${reason} Repair or remove the status row before retrying this recovery coordinate.`,
      remedy: { kind: 'abort-job', jobId },
    };
  }

  const containment = observeDurableRecoveryContainment(jobId, runtimeRecord, settlement.leaf);
  const operatorAbandoned =
    persistedContainment.kind === 'valid' && persistedContainment.status.disposition.kind === 'operator-abandoned';
  const absenceConfirmed =
    containment.observation.kind === 'absent' && settlement.leaf.permitsIndependentAbsenceDecision();
  if (
    !absenceConfirmed &&
    !operatorAbandoned &&
    ((persistedContainment.kind === 'valid' && persistedContainment.status.disposition.kind === 'held') ||
      wrapperIsAbsent(settlement, containment))
  ) {
    const reconciliation = await reconcileHeldContainmentStatus(
      settlement,
      runtimeRecord,
      containment,
      persistedContainment.kind === 'valid' && persistedContainment.status.disposition.kind === 'held'
        ? persistedContainment.status.disposition.retryIntervalMs
        : RECOVERY_POLL_MS,
    );
    if (reconciliation.kind !== 'reconciled') return reconciliation;
    if (reconciliation.absenceConfirmed || reconciliation.operatorAbandoned) {
      return finalizeContainedDurableRecovery(settlement, progress, reconciliation.operatorAbandoned);
    }
  }

  if (absenceConfirmed || operatorAbandoned) {
    return finalizeContainedDurableRecovery(settlement, progress, operatorAbandoned);
  }
  return { kind: 'observable-live', containment };
}

function holdUnobservableDurableRecovery(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  containment: DurableContainment,
): RecoveryDisposition {
  const { state, progressStore } = settlement.deps;
  const { jobId } = settlement.recovery;
  const { abandonHeldJob } = settlement.context;
  if (containment.observation.kind !== 'unobservable') {
    throw new Error('Unobservable durable recovery hold requires an unobservable containment result.');
  }
  const { reason } = containment.observation;
  writeDurableCliContainmentStatus(progressStore.getDb(), {
    jobId,
    evidence: durableOwnershipStatusEvidence(containment.evidence),
    disposition: { kind: 'held', reason, retryIntervalMs: RECOVERY_POLL_MS, abandonment: 'abort-job' },
  });
  const detail =
    `${reason}. Recorded containment is retried automatically every ${RECOVERY_POLL_MS}ms until absence is confirmed. ` +
    'Operator abandonment remains available without proving process absence or sending a signal.';
  appendRecoveryProgress(settlement, `Durable recovery containment pid=${runtimeRecord.pid} is held (${detail})`);
  state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId));
  installHeldCleanupRetryPoller(settlement, runtimeRecord, RECOVERY_POLL_MS);
  settlement.controls.clearProcessLocalCleanup();
  settlement.controls.report(`Held durable recovery job: ${jobId}: ${reason}\n`);
  return {
    kind: 'deferred',
    continuation: { kind: 'durable-containment-reap', key: jobId },
    detail,
    remedy: { kind: 'abort-job', jobId },
  };
}

async function finalizeAdoptedRuntime(
  settlement: RunningRecoverySettlement,
  progress: RecoveredProgress,
  fence: { signal: AbortSignal; onCommitStart(): void },
): Promise<void> {
  const { state, progressStore, runCoordinatorWalk, settleUnexpectedRecoveryFailure } = settlement.deps;
  const { jobId, authority } = settlement.recovery;
  const { signal, coordinatorCommit } = settlement.context;
  if (!settlement.deps.deleteCoordinatorRecoveryQuarantine(jobId)) return;
  await runCoordinatorWalk({
    subjectKey: jobId,
    signal,
    coordinatorCommit,
    summary: `Adopted durable recovery finalization for ${jobId}`,
    settle: async (finalItem, finalControls) => {
      finalControls.setProcessLocalCleanup(() => {
        requireDurableRecoveryAbsence(settlement);
        releaseRunningRecovery(settlement);
      });
      await finalizeDeadAdoptedJob({
        jobId,
        runtimeRecord: progress.runtimeRecord(),
        service: settlement.service,
        authority,
        progressStore,
        cancelledJobIds: state.cancelledRecoveryJobIds,
        fence: {
          ...fence,
          onCommitStart: () => {
            requireDurableRecoveryAbsence(settlement);
            fence.onCommitStart();
          },
        },
      });
      requireDurableRecoveryAbsence(settlement);
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts: settledRecoveryFacts(jobId),
        detail: 'adopted durable job finalized',
      };
    },
    settleFailure: (item, error, finalControls) =>
      settleUnexpectedRecoveryFailure(
        item,
        jobId,
        'Adopted durable recovery finalization failed',
        error,
        coordinatorCommit,
        finalControls.report,
      ),
  });
}

async function pollAdoptedContainment(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  progress: RecoveredProgress,
): Promise<void> {
  const { state, observeDurableRecoveryContainment, startTrackedFinalization } = settlement.deps;
  const { jobId } = settlement.recovery;
  const { signal } = settlement.context;
  if (state.teardownRequested) return;
  const containment = observeDurableRecoveryContainment(jobId, runtimeRecord, settlement.leaf);
  const { observation } = containment;
  progress.drain();
  if (wrapperIsAbsent(settlement, containment)) {
    await resumeHeldRecoveryFinalization(settlement);
    return;
  }
  if (observation.kind === 'unobservable') {
    const unanswered = (state.unansweredAdoptionProbes.get(jobId) ?? 0) + 1;
    state.unansweredAdoptionProbes.set(jobId, unanswered);
    if (unanswered === UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD) {
      backendLog.warn(
        `Containment of adopted job ${jobId} (pid ${runtimeRecord.pid}) has been unobservable for ` +
          `${unanswered} checks; it stays adopted until a probe answers.`,
      );
    }
    return;
  }
  state.unansweredAdoptionProbes.delete(jobId);
  if (observation.kind === 'alive' || !settlement.leaf.permitsIndependentAbsenceDecision()) return;
  if (state.recoveryRegistry?.getAbortDisposition(jobId)?.settlement !== undefined) return;

  if (state.teardownRequested) return;
  progress.drain();
  await startTrackedFinalization(jobId, signal, (fence) => finalizeAdoptedRuntime(settlement, progress, fence));
}

async function pollAdoptedRuntime(
  settlement: RunningRecoverySettlement,
  runtimeRecord: DurableRunningRuntime,
  progress: RecoveredProgress,
): Promise<RecoveryDisposition> {
  const { state, runtime } = settlement.deps;
  const { jobId, authority } = settlement.recovery;
  const { launchRecord } = authority;
  const { signal } = settlement.context;
  signal.throwIfAborted();
  const adoption = await settlement.service.adoptRunningJob(authority, runtimeRecord);
  if (!adoption.adopted) {
    settlement.controls.report(`Rejected running recovery before adoption: ${jobId}\n`);
    return {
      kind: 'advanced',
      outcome: 'settled',
      facts: COORDINATOR_NOT_APPLICABLE_FACTS,
      detail: 'running adoption rejected',
    };
  }
  if (signal.aborted) {
    adoption.cleanup();
    throw signal.reason;
  }

  let cleaned = false;
  const cleanupOnce = (): void => {
    if (cleaned) return;
    cleaned = true;
    adoption.cleanup();
  };
  state.adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });
  state.adoptedRunningJobCleanups.set(jobId, cleanupOnce);

  let pollInFlight = false;
  const pollInterval = runtime.time.setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    void pollAdoptedContainment(settlement, runtimeRecord, progress)
      .catch((error: unknown) => {
        if (error instanceof SuccessionWriterParkedError) return;
        try {
          settlement.deps.log(
            `Durable finalization cleanup failed for ${jobId}: ${formatError(error)}; the poller retries every ${RECOVERY_POLL_MS}ms.\n`,
          );
        } catch {
          // A logging failure must not create another unowned rejection after async cleanup fails.
        }
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, RECOVERY_POLL_MS);
  pollInterval.unref?.();
  state.recoveryPollIntervals.set(jobId, pollInterval);
  settlement.controls.clearProcessLocalCleanup();
  settlement.controls.report(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts: COORDINATOR_NOT_APPLICABLE_FACTS,
    detail: 'running job adopted',
  };
}

async function settleRunningRecovery(settlement: RunningRecoverySettlement): Promise<RecoveryDisposition> {
  const { state, settleFault } = settlement.deps;
  const { recovery, context, item, controls } = settlement;
  const { jobId, runtimeRecord } = recovery;
  controls.setProcessLocalCleanup(() => {
    if (isDurableCliRuntime(runtimeRecord)) {
      const status = readDurableCliContainmentStatus(settlement.deps.progressStore.getDb(), jobId);
      if (status.kind !== 'valid' || status.status.disposition.kind !== 'operator-abandoned') {
        requireDurableRecoveryAbsence(settlement);
      }
    }
    state.recoveryRegistry?.remove(jobId);
    state.recoveryRegistry?.clearCancelled(jobId);
  });
  const pendingAbort = state.recoveryRegistry?.getAbortDisposition(jobId)?.settlement;
  if (pendingAbort !== undefined) {
    void (await pendingAbort.catch(() => undefined));
    context.signal.throwIfAborted();
  }
  if (isAppServerRuntime(runtimeRecord)) return finalizeRecoveredAppServer(settlement, runtimeRecord);
  if (!isDurableCliRuntime(runtimeRecord)) {
    const facts = settleFault(item, jobId, { kind: 'wrapper_lost' }, context.coordinatorCommit);
    controls.report(`Skipped adopting unsupported runtime for job: ${jobId}\n`);
    return { kind: 'advanced', outcome: 'settled', facts, detail: 'unsupported runtime finalized' };
  }

  const progress = createRecoveredProgress(settlement, runtimeRecord);
  const containment = await settleDurableContainment(settlement, runtimeRecord, progress);
  if (containment.kind !== 'observable-live') return containment;
  if (containment.containment.observation.kind === 'unobservable') {
    return holdUnobservableDurableRecovery(settlement, runtimeRecord, containment.containment);
  }
  return pollAdoptedRuntime(settlement, runtimeRecord, progress);
}

export function createRunningRecoveryAdoption(deps: RunningRecoveryAdoptionDependencies) {
  return async function runRunningRecovery(
    recovery: RunningRecoverableJob,
    context: RunningRecoveryAdoptionContext,
    direct?: Readonly<{ item: CoordinatorRecoveryItem; controls: CoordinatorRecoveryControls }>,
  ): Promise<RecoveryDisposition | void> {
    const { jobId, authority } = recovery;
    const service = deps.getRecoveryService(deps.createInvocationContext(authority.launchRecord.projectRoot));
    const evidence = isDurableCliRuntime(recovery.runtimeRecord)
      ? readDurableCliPreReadyOwnershipEvidence(deps.progressStore.getDb(), jobId, recovery.runtimeRecord.pid)
      : null;
    const failureDomain =
      evidence?.kind === 'current' || evidence?.kind === 'provisional'
        ? durableCliFailureDomain(deps.runtime, deps.progressStore.getDb(), jobId, evidence.record)
        : isDurableCliRuntime(recovery.runtimeRecord)
          ? durableCliFailureDomain(
              deps.runtime,
              deps.progressStore.getDb(),
              jobId,
              undefined,
              recovery.runtimeRecord.pid,
            )
          : undefined;
    const leaf = recovery.containmentObservation ?? createFailureDomainContainmentObservation(failureDomain);
    const settle = (
      item: CoordinatorRecoveryItem,
      controls: CoordinatorRecoveryControls,
    ): Promise<RecoveryDisposition> =>
      settleRunningRecovery({ deps, recovery, context, item, controls, service, settle, leaf });
    if (direct?.item.jobId === jobId) return settle(direct.item, direct.controls);
    await deps.runCoordinatorWalk({
      subjectKey: jobId,
      signal: context.signal,
      coordinatorCommit: context.coordinatorCommit,
      summary: `Running recovery adoption for ${jobId}`,
      settle,
      settleFailure: (item, error, controls) =>
        deps.settleUnexpectedRecoveryFailure(
          item,
          jobId,
          'Running recovery adoption failed',
          error,
          context.coordinatorCommit,
          controls.report,
        ),
    });
  };
}
