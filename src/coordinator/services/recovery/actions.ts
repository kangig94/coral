import { errorMessage, formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobRuntime } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { JobStore } from '../../../jobs/store.js';
import type { RecoveryAction } from '../../../jobs/reconcile/plan.js';
import type { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { RecoveryCommitFence } from '../../../jobs/reconcile/contracts.js';
import {
  readDurableCliContainmentStatus,
  readDurableCliPreReadyOwnershipEvidence,
  writeDurableCliContainmentStatus,
} from '../../../jobs/runtime-meta-store.js';
import type {
  DurableCliProcessRuntimeEvidence,
  DurableCliProcessRuntimeMeta,
  DurableCliProvisionalProcessRuntimeMeta,
} from '../../../jobs/runtime-meta.js';
import type { DurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  abortRecordedContainment,
  reapRecordedContainment,
  type RecordedContainmentAbortResult,
} from '../../../infra/process-containment.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../../../infra/process-constants.js';
import type {
  RecoveryDisposition,
  RecoveryObligationId,
  RecoverySettlementFact,
} from '../../../recovery/containment.js';

export const COORDINATOR_TERMINAL_OBLIGATION = 'coordinator-job-terminal' as RecoveryObligationId;
export const COORDINATOR_CLAIM_RELEASE_OBLIGATION = 'coordinator-session-claim-release' as RecoveryObligationId;
const durableRecoveryClockScope = Symbol('durable-recovery');
const DURABLE_RECOVERY_REAP_DEADLINE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;
const DURABLE_RECOVERY_ABORT_DEADLINE_MS = 2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS + 1;

export const COORDINATOR_NOT_APPLICABLE_FACTS: readonly RecoverySettlementFact[] = Object.freeze([
  Object.freeze({ obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'not-applicable' as const }),
  Object.freeze({ obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION, outcome: 'not-applicable' as const }),
]);

export type QueuedRecoverableJob = { jobId: string; authority: ProviderRecoveryAuthority };
export type RunningRecoverableJob = {
  jobId: string;
  authority: ProviderRecoveryAuthority;
  runtimeRecord: JobRuntime;
};

async function reapDurableCliProcess(
  runtime: Runtime,
  record: DurableCliProcessRuntimeMeta | DurableCliProvisionalProcessRuntimeMeta,
  signal: AbortSignal,
): Promise<Readonly<{ kind: 'absence-confirmed' }> | Readonly<{ kind: 'held'; reason: string }>> {
  const clock = createMonotonicClock(durableRecoveryClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds),
  });
  try {
    const outcome = await reapRecordedContainment(
      { pid: record.pid, incarnation: record.incarnation, processGroupId: record.processGroupId },
      'childRoot' in record ? [record.childRoot] : [],
      clock.shiftMilliseconds(clock.now(), DURABLE_RECOVERY_REAP_DEADLINE_MS),
      {
        maxRecordedRoots: 'childRoot' in record ? 1 : 0,
        clock,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        signal,
      },
    );
    return outcome.kind === 'containment-absent'
      ? { kind: 'absence-confirmed' }
      : { kind: 'held', reason: 'the recorded leader is gone but its process group remains unattributable' };
  } catch (error: unknown) {
    return { kind: 'held', reason: errorMessage(error) };
  }
}

function abortDurableCliProcess(
  runtime: Runtime,
  evidence: DurableCliPreReadyOwnershipEvidence,
): RecordedContainmentAbortResult {
  if (evidence.kind !== 'current' && evidence.kind !== 'provisional') {
    return { kind: 'refused', reason: durableOwnershipEvidenceHoldReason(evidence) };
  }
  const record = evidence.record;
  const subject = 'childRoot' in record ? record : { ...record, childRoot: null };
  const clock = createMonotonicClock(durableRecoveryClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds),
  });
  return abortRecordedContainment(subject, clock.shiftMilliseconds(clock.now(), DURABLE_RECOVERY_ABORT_DEADLINE_MS), {
    maxRecordedRoots: 1,
    clock,
    process: runtime.process,
    platform: runtime.env.platform() as NodeJS.Platform,
    readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
  });
}

export function durableRuntimeEvidenceHoldReason(
  evidence: Exclude<DurableCliProcessRuntimeEvidence, { kind: 'current' }>,
): string {
  if (evidence.kind === 'predecessor') {
    return (
      `predecessor v1 evidence identifies pid ${evidence.record.pid} and its incarnation, but it does not name ` +
      'the process group or child root and cannot authorize a signal'
    );
  }
  switch (evidence.reason) {
    case 'missing':
      return 'durable process containment evidence is missing';
    case 'corrupt-current':
      return 'the current durable process containment evidence is corrupt';
    case 'corrupt-predecessor':
      return 'the predecessor durable process containment evidence is corrupt';
    case 'identity-mismatch':
      return 'the durable process containment evidence does not match the journal identity';
  }
  const exhaustive: never = evidence.reason;
  return exhaustive;
}

type RecoveryActionContext = {
  progressStore: JobStore;
  recoveryRegistry: RecoveryRegistry;
  queuedRecoverable: QueuedRecoverableJob[];
  runningRecoverable: RunningRecoverableJob[];
  log: (message: string) => void;
  runtime: Runtime;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  signal: AbortSignal;
  settleFault(fault: JobLifecycleFault | JobProgressFault, content?: string): readonly RecoverySettlementFact[];
  settleClaim(jobId: string): readonly RecoverySettlementFact[];
  setProcessLocalCleanup(cleanup: () => void): void;
  clearProcessLocalCleanup(): void;
  abandonHeldJob?(jobId: string): RecordedContainmentAbortResult;
};

export async function applyRecoveryAction(
  action: RecoveryAction,
  ctx: RecoveryActionContext,
): Promise<RecoveryDisposition> {
  switch (action.type) {
    case 'discardIncompleteAdmission':
      return discardIncompleteAdmission(action, ctx);
    case 'markError':
      return markRecoveryError(action, ctx);
    case 'resolvePreReadyLaunch':
      return resolvePreReadyLaunch(action, ctx);
    case 'registerQueued':
      return registerQueuedRecovery(action, ctx);
    case 'registerRunning':
      return registerRunningRecovery(action, ctx);
    case 'releaseSessionClaim':
      return releaseSessionClaim(action, ctx);
  }
}

export function durableOwnershipEvidenceHoldReason(evidence: DurableCliPreReadyOwnershipEvidence): string {
  if (evidence.kind === 'current' || evidence.kind === 'provisional') {
    return 'recorded durable containment absence is not yet proven';
  }
  if (evidence.kind === 'predecessor') return durableRuntimeEvidenceHoldReason(evidence);
  switch (evidence.reason) {
    case 'missing':
      return 'durable process containment evidence is missing';
    case 'corrupt-current':
      return 'the current durable process containment evidence is corrupt';
    case 'corrupt-provisional':
      return 'the provisional durable process containment evidence is corrupt';
    case 'corrupt-predecessor':
      return 'the predecessor durable process containment evidence is corrupt';
    case 'identity-mismatch':
      return 'the durable process containment evidence names a different job';
  }
}

export function durableOwnershipStatusEvidence(
  evidence: DurableCliPreReadyOwnershipEvidence,
): DurableCliProcessRuntimeEvidence {
  if (evidence.kind === 'current' || evidence.kind === 'predecessor') return evidence;
  if (evidence.kind === 'provisional') return { kind: 'unavailable', reason: 'missing' };
  return {
    kind: 'unavailable',
    reason: evidence.reason === 'corrupt-provisional' ? 'corrupt-current' : evidence.reason,
  };
}

async function resolvePreReadyLaunch(
  action: Extract<RecoveryAction, { type: 'resolvePreReadyLaunch' }>,
  ctx: RecoveryActionContext,
): Promise<RecoveryDisposition> {
  const persistedStatus = readDurableCliContainmentStatus(ctx.progressStore.getDb(), action.jobId);
  if (persistedStatus.kind === 'valid' && persistedStatus.status.disposition.kind === 'operator-abandoned') {
    return markRecoveryError(
      { type: 'markError', jobId: action.jobId, fault: { kind: 'ghost_launch' }, status: action.status },
      ctx,
    );
  }

  const evidence = readDurableCliPreReadyOwnershipEvidence(ctx.progressStore.getDb(), action.jobId);
  if (evidence.kind === 'unavailable' && evidence.reason === 'missing' && persistedStatus.kind === 'missing') {
    return markRecoveryError(
      { type: 'markError', jobId: action.jobId, fault: { kind: 'ghost_launch' }, status: action.status },
      ctx,
    );
  }

  let holdReason: string;
  if (persistedStatus.kind === 'corrupt') {
    holdReason = 'the durable containment status is corrupt';
  } else if (evidence.kind === 'current' || evidence.kind === 'provisional') {
    const cleanup = await reapDurableCliProcess(ctx.runtime, evidence.record, ctx.signal);
    if (cleanup.kind === 'absence-confirmed') {
      return markRecoveryError(
        { type: 'markError', jobId: action.jobId, fault: { kind: 'ghost_launch' }, status: action.status },
        ctx,
      );
    }
    holdReason = cleanup.reason;
  } else {
    holdReason =
      evidence.kind === 'unavailable' &&
      evidence.reason === 'missing' &&
      persistedStatus.kind === 'valid' &&
      persistedStatus.status.disposition.kind === 'held'
        ? persistedStatus.status.disposition.reason
        : durableOwnershipEvidenceHoldReason(evidence);
  }

  ctx.recoveryRegistry.register(
    action.jobId,
    action.launchRecord,
    undefined,
    () =>
      ctx.abandonHeldJob?.(action.jobId) ?? {
        kind: 'refused',
        reason: 'durable containment abandonment is unavailable',
      },
  );
  ctx.setProcessLocalCleanup(() => ctx.recoveryRegistry.remove(action.jobId));
  writeDurableCliContainmentStatus(ctx.progressStore.getDb(), {
    jobId: action.jobId,
    evidence: durableOwnershipStatusEvidence(evidence),
    disposition: {
      kind: 'held',
      reason: holdReason,
      retryIntervalMs: 500,
      abandonment: 'abort-job',
    },
  });
  if (!ctx.recoveryRegistry.has(action.jobId)) {
    throw new Error('Pre-ready durable containment hold was not accepted by the recovery registry.');
  }
  ctx.clearProcessLocalCleanup();
  const detail =
    `Pre-ready durable containment cleanup remains held because ${holdReason}; recovery remains owned by the ` +
    `recovery registry. Retry the coordinator-job-recovery quarantine, or run coral-cli abort jobs ${action.jobId} ` +
    'to abandon job ownership without proving process absence or sending another signal.';
  ctx.log(`Held pre-ready durable recovery for ${action.jobId}: ${detail}\n`);
  return { kind: 'quarantine', detail };
}

function discardIncompleteAdmission(
  action: Extract<RecoveryAction, { type: 'discardIncompleteAdmission' }>,
  ctx: RecoveryActionContext,
): RecoveryDisposition {
  const { runtime, progressStore, log } = ctx;
  runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
  log(`Discarded incomplete admission: ${action.jobId}\n`);
  return completed(COORDINATOR_NOT_APPLICABLE_FACTS, 'incomplete admission discarded');
}

function markRecoveryError(
  action: Extract<RecoveryAction, { type: 'markError' }>,
  ctx: RecoveryActionContext,
): RecoveryDisposition {
  const { log, settleFault } = ctx;
  const facts = settleFault(action.fault);
  // Deliberately no export write. The settled fault is the durable answer, and
  // `ensureResultMarkdownArtifact` renders it on the next read; an empty placeholder would satisfy the
  // existence check that guards regeneration and leave that answer permanently unreachable.
  switch (action.fault.kind) {
    case 'missing_launch_record':
      log(`Marked live job with missing launch record: ${action.jobId}\n`);
      break;
    case 'ghost_launch':
      log(`Marked ghost launch job: ${action.jobId}\n`);
      break;
    default:
      log(`Marked recovery job as error: ${action.jobId}\n`);
      break;
  }
  return completed(facts, 'recovery fault settled');
}

async function registerQueuedRecovery(
  action: Extract<RecoveryAction, { type: 'registerQueued' }>,
  ctx: RecoveryActionContext,
): Promise<RecoveryDisposition> {
  const {
    recoveryRegistry,
    queuedRecoverable,
    log,
    createInvocationContext,
    getRecoveryService,
    signal,
    settleFault,
    setProcessLocalCleanup,
    clearProcessLocalCleanup,
  } = ctx;
  const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
  recoveryRegistry.register(action.jobId, action.launchRecord);
  setProcessLocalCleanup(() => recoveryRegistry.remove(action.jobId));
  const captured = await service.captureProviderRecoveryAuthority(action.launchRecord);
  signal.throwIfAborted();
  if (!captured.ok) {
    const message = `Provider '${captured.failure.provider}' recovery binding failed: ${captured.failure.reason}.`;
    const facts = settleFault(
      {
        kind: 'provider_binding',
        provider: captured.failure.provider,
        reason: captured.failure.reason,
        message,
      },
      message,
    );
    log(`Rejected queued recovery with invalid provider authority: ${action.jobId}.\n`);
    return completed(facts, 'persisted-invalid queued provider binding settled');
  }
  const { authority } = captured;
  queuedRecoverable.push({ jobId: action.jobId, authority });
  clearProcessLocalCleanup();
  return completed(COORDINATOR_NOT_APPLICABLE_FACTS, 'queued recovery registered');
}

async function registerRunningRecovery(
  action: Extract<RecoveryAction, { type: 'registerRunning' }>,
  ctx: RecoveryActionContext,
): Promise<RecoveryDisposition> {
  const {
    progressStore,
    recoveryRegistry,
    runningRecoverable,
    log,
    runtime,
    createInvocationContext,
    getRecoveryService,
    signal,
    settleFault,
    setProcessLocalCleanup,
    clearProcessLocalCleanup,
    abandonHeldJob = () => ({ kind: 'refused', reason: 'durable containment abandonment is unavailable' }),
  } = ctx;
  const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
  const recordedContainment = isDurableCliRuntime(action.runtimeRecord)
    ? readDurableCliPreReadyOwnershipEvidence(progressStore.getDb(), action.jobId, action.runtimeRecord.pid)
    : null;
  recoveryRegistry.register(
    action.jobId,
    action.launchRecord,
    action.runtimeRecord,
    isDurableCliRuntime(action.runtimeRecord)
      ? () => abortDurableCliProcess(runtime, recordedContainment ?? { kind: 'unavailable', reason: 'missing' })
      : undefined,
  );
  setProcessLocalCleanup(() => recoveryRegistry.remove(action.jobId));
  const captured = await service.captureProviderRecoveryAuthority(action.launchRecord);
  signal.throwIfAborted();
  if (!captured.ok) {
    const durableRecord = isDurableCliRuntime(action.runtimeRecord) ? action.runtimeRecord : null;
    const message = `Provider '${captured.failure.provider}' recovery binding failed: ${captured.failure.reason}.`;
    if (durableRecord === null) {
      clearProcessLocalCleanup();
      const detail =
        `${message} The running carrier has no locally observable durable process identity, so recovery ` +
        'remains owned. Retry after repairing the provider binding so adoption can succeed.';
      log(`Held running recovery for ${action.jobId}: ${detail}\n`);
      return { kind: 'quarantine', detail };
    }

    const recordedEvidence = readDurableCliPreReadyOwnershipEvidence(
      progressStore.getDb(),
      action.jobId,
      durableRecord.pid,
    );
    let cleanupHold: string | null = null;
    if (recordedEvidence.kind !== 'current' && recordedEvidence.kind !== 'provisional') {
      cleanupHold = durableOwnershipEvidenceHoldReason(recordedEvidence);
    } else {
      const cleanup = await reapDurableCliProcess(runtime, recordedEvidence.record, signal);
      if (cleanup.kind === 'held') cleanupHold = cleanup.reason;
    }

    if (cleanupHold !== null) {
      writeDurableCliContainmentStatus(progressStore.getDb(), {
        jobId: action.jobId,
        evidence: durableOwnershipStatusEvidence(recordedEvidence),
        disposition: {
          kind: 'held',
          reason: cleanupHold,
          retryIntervalMs: 500,
          abandonment: 'abort-job',
        },
      });
      recoveryRegistry.setAbortHandler(action.jobId, () => abandonHeldJob(action.jobId));
      clearProcessLocalCleanup();
      const detail =
        `${message} Durable process cleanup remains held because ${cleanupHold}; recovery remains owned by the ` +
        'recovery registry. Retry after repairing the provider binding so adoption can succeed, or after the ' +
        'recorded containment and child root are observed absent so fault settlement can complete.';
      log(`Held running recovery for ${action.jobId}: ${detail}\n`);
      return { kind: 'quarantine', detail };
    }

    const facts = settleFault(
      {
        kind: 'provider_binding',
        provider: captured.failure.provider,
        reason: captured.failure.reason,
        message,
      },
      message,
    );
    log(`Settled running recovery ${action.jobId} after its durable process was observed absent.\n`);
    return completed(facts, 'persisted-invalid running provider binding settled');
  }
  const { authority } = captured;
  if (isAppServerRuntime(action.runtimeRecord)) {
    const runtimeRecord = action.runtimeRecord;
    recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord, () => {
      void service.interruptAppServerJob(authority, runtimeRecord).catch((error: unknown) => {
        log(`Failed to interrupt recovered app-server job ${action.jobId}: ${formatError(error)}\n`);
      });
      return { kind: 'accepted' };
    });
  } else {
    recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord, () =>
      abortDurableCliProcess(runtime, recordedContainment ?? { kind: 'unavailable', reason: 'missing' }),
    );
  }
  runningRecoverable.push({
    jobId: action.jobId,
    authority,
    runtimeRecord: action.runtimeRecord,
  });
  clearProcessLocalCleanup();
  return completed(COORDINATOR_NOT_APPLICABLE_FACTS, 'running recovery registered');
}

function releaseSessionClaim(
  action: Extract<RecoveryAction, { type: 'releaseSessionClaim' }>,
  ctx: RecoveryActionContext,
): RecoveryDisposition {
  const { progressStore, log, settleClaim } = ctx;
  const facts = settleClaim(action.jobId);
  const status = progressStore.readStatus(action.jobId);
  if (status && isTerminalPhase(status.phase)) {
    log(`Terminal session claim ${action.sessionId} settled.\n`);
  } else {
    log(`Orphaned session claim ${action.sessionId} settled.\n`);
  }
  return completed(facts, 'session claim released');
}

function completed(facts: readonly RecoverySettlementFact[], detail: string): RecoveryDisposition {
  return { kind: 'advanced', outcome: 'settled', facts, detail };
}

export function logRecoveryActionFailure(action: RecoveryAction, error: unknown, log: (message: string) => void): void {
  switch (action.type) {
    case 'discardIncompleteAdmission':
      log(`Failed to discard incomplete admission ${action.jobId}: ${formatError(error)}\n`);
      return;
    case 'markError':
      switch (action.fault.kind) {
        case 'missing_launch_record':
          log(`Failed to handle live job with missing launch record ${action.jobId}: ${formatError(error)}\n`);
          break;
        case 'ghost_launch':
          log(`Failed to handle ghost launch job ${action.jobId}: ${formatError(error)}\n`);
          break;
        default:
          log(`Failed to handle recovery error-mark job ${action.jobId}: ${formatError(error)}\n`);
          break;
      }
      return;
    case 'resolvePreReadyLaunch':
      log(`Failed to resolve pre-ready launch ${action.jobId}: ${formatError(error)}\n`);
      return;
    case 'registerQueued':
      log(`Failed to register queued recovery job ${action.jobId}: ${formatError(error)}\n`);
      return;
    case 'registerRunning':
      log(`Failed to register running recovery job ${action.jobId}: ${formatError(error)}\n`);
      return;
    case 'releaseSessionClaim':
      log(`Failed to release session claim ${action.sessionId}: ${formatError(error)}\n`);
      return;
  }
}

type FinalizeDeadAdoptedJobContext = {
  jobId: string;
  runtimeRecord: DurableCliRuntimeRecord;
  service: RecoveryCapableService;
  authority: ProviderRecoveryAuthority;
  progressStore: JobStore;
  cancelledJobIds?: ReadonlySet<string>;
  fence: RecoveryCommitFence;
};

export async function finalizeDeadAdoptedJob({
  jobId,
  runtimeRecord,
  service,
  authority,
  progressStore,
  cancelledJobIds,
  fence,
}: FinalizeDeadAdoptedJobContext): Promise<void> {
  const exitRecord = progressStore.readExitProjection(jobId);
  await service.finalizeInterruptedDurableJob(
    authority,
    runtimeRecord,
    {
      exit: exitRecord,
      terminal: exitRecord === null ? null : progressStore.readTerminalProjection(jobId),
      cancelled: cancelledJobIds?.has(jobId) ?? false,
    },
    fence,
  );
}
