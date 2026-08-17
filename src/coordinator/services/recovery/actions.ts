import { backendLog } from '../../../infra/backend-log.js';
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
import { gracefulKillByPid } from '../../../infra/process-supervision.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import type {
  RecoveryDisposition,
  RecoveryObligationId,
  RecoverySettlementFact,
} from '../../../recovery/containment.js';

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
): Promise<RecoveryDisposition> {
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
    // Settling here is a known gap, deliberately left in place rather than half-closed, and the argument that
    // used to justify it was checked and found false: `profile-unavailable`, `identity-unavailable` and
    // `subject-mismatch` are operator-repairable, so a retry after the operator restores the profile does find
    // something new. The correct disposition is a durable quarantine — but a quarantine that hands the job back
    // while its carrier is still running releases the only owner that can abort it, and the successor owner does
    // not exist yet. Both halves are docs/todo/coordinator-process-disposition.md; until they ship together this
    // path terminalizes as it always has, and this comment is the honest reason rather than a justification.
    //
    // What the three liveness answers do decide is the carrier:
    // `alive`: install the pid-kill cleanup.
    // `absent`: nothing to clean up.
    // `unknown`: install nothing — signalling a pid nobody could observe is the one action this must not take —
    //   but report the process that is being left behind rather than terminalizing over it in silence.
    const durableRecord = isDurableCliRuntime(action.runtimeRecord) ? action.runtimeRecord : null;
    const durableLiveness = durableRecord === null ? 'absent' : runtime.process.observeLiveness(durableRecord.pid);
    if (durableRecord !== null && durableLiveness === 'alive') {
      const pid = durableRecord.pid;
      const releaseRegistry = (): void => recoveryRegistry.remove(action.jobId);
      setProcessLocalCleanup(() => {
        gracefulKillByPid(runtime, pid);
        releaseRegistry();
      });
    } else if (durableRecord !== null && durableLiveness === 'unknown') {
      backendLog.warn(
        `Terminalizing job ${action.jobId} for a provider binding failure while its durable process ` +
          `(pid ${durableRecord.pid}) could not be observed; no signal was sent, so it may still be running ` +
          'and nothing in Coral will reclaim it. That pid is not safe to act on by itself — the probe that ' +
          'could not answer is also what would have proved the number still belongs to this job — so identify ' +
          'the process independently before stopping it.',
      );
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
    return completed(facts, 'persisted-invalid running provider binding settled');
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
