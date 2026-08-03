import { formatError } from '../../../infra/error-format.js';
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
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import { gracefulKillByPid } from '../../live/process-supervision.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import type { RecoveryObligationId, RecoverySettlementFact } from '../../../recovery/containment.js';

export const COORDINATOR_TERMINAL_OBLIGATION = 'coordinator-job-terminal' as RecoveryObligationId;
export const COORDINATOR_CLAIM_RELEASE_OBLIGATION = 'coordinator-session-claim-release' as RecoveryObligationId;

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
};

export async function applyRecoveryAction(
  action: RecoveryAction,
  ctx: RecoveryActionContext,
): Promise<readonly RecoverySettlementFact[]> {
  switch (action.type) {
    case 'discardIncompleteAdmission':
      return discardIncompleteAdmission(action, ctx);
    case 'markError':
      return markRecoveryError(action, ctx);
    case 'registerQueued':
      return registerQueuedRecovery(action, ctx);
    case 'registerRunning':
      return registerRunningRecovery(action, ctx);
    case 'releaseSessionClaim':
      return releaseSessionClaim(action, ctx);
  }
}

function discardIncompleteAdmission(
  action: Extract<RecoveryAction, { type: 'discardIncompleteAdmission' }>,
  ctx: RecoveryActionContext,
): readonly RecoverySettlementFact[] {
  const { runtime, progressStore, log } = ctx;
  runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
  log(`Discarded incomplete admission: ${action.jobId}\n`);
  return COORDINATOR_NOT_APPLICABLE_FACTS;
}

function markRecoveryError(
  action: Extract<RecoveryAction, { type: 'markError' }>,
  ctx: RecoveryActionContext,
): readonly RecoverySettlementFact[] {
  const { runtime, log, settleFault } = ctx;
  const facts = settleFault(action.fault);
  if (action.status.jobKind === 'workflow') {
    try {
      writeResultArtifact(runtime.storage, runtime.paths.coral.exports.jobsRoot, action.status.jobId, '');
    } catch (error: unknown) {
      log(`Failed to write result artifact for ${action.status.jobId}: ${formatError(error)}\n`);
    }
  }
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
  return facts;
}

async function registerQueuedRecovery(
  action: Extract<RecoveryAction, { type: 'registerQueued' }>,
  ctx: RecoveryActionContext,
): Promise<readonly RecoverySettlementFact[]> {
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
    return facts;
  }
  const { authority } = captured;
  queuedRecoverable.push({ jobId: action.jobId, authority });
  clearProcessLocalCleanup();
  return COORDINATOR_NOT_APPLICABLE_FACTS;
}

async function registerRunningRecovery(
  action: Extract<RecoveryAction, { type: 'registerRunning' }>,
  ctx: RecoveryActionContext,
): Promise<readonly RecoverySettlementFact[]> {
  const {
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
  } = ctx;
  const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
  recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
  setProcessLocalCleanup(() => recoveryRegistry.remove(action.jobId));
  const captured = await service.captureProviderRecoveryAuthority(action.launchRecord);
  signal.throwIfAborted();
  if (!captured.ok) {
    if (isDurableCliRuntime(action.runtimeRecord) && runtime.process.isAlive(action.runtimeRecord.pid)) {
      const pid = action.runtimeRecord.pid;
      const releaseRegistry = (): void => recoveryRegistry.remove(action.jobId);
      setProcessLocalCleanup(() => {
        gracefulKillByPid(runtime, pid);
        releaseRegistry();
      });
    }
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
    log(
      `Rejected running recovery with invalid provider authority: terminalized ${action.jobId}. Run coral-cli jobs detail ${action.jobId} for the recorded reason.\n`,
    );
    return facts;
  }
  const { authority } = captured;
  if (isAppServerRuntime(action.runtimeRecord)) {
    const runtimeRecord = action.runtimeRecord;
    recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord, () => {
      void service.interruptAppServerJob(authority, runtimeRecord).catch((error: unknown) => {
        log(`Failed to interrupt recovered app-server job ${action.jobId}: ${formatError(error)}\n`);
      });
    });
  } else {
    recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
  }
  runningRecoverable.push({
    jobId: action.jobId,
    authority,
    runtimeRecord: action.runtimeRecord,
  });
  clearProcessLocalCleanup();
  return COORDINATOR_NOT_APPLICABLE_FACTS;
}

function releaseSessionClaim(
  action: Extract<RecoveryAction, { type: 'releaseSessionClaim' }>,
  ctx: RecoveryActionContext,
): readonly RecoverySettlementFact[] {
  const { progressStore, log, settleClaim } = ctx;
  const facts = settleClaim(action.jobId);
  const status = progressStore.readStatus(action.jobId);
  if (status && isTerminalPhase(status.phase)) {
    log(`Terminal session claim ${action.sessionId} settled.\n`);
  } else {
    log(`Orphaned session claim ${action.sessionId} settled.\n`);
  }
  return facts;
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
