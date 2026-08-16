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
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import {
  providerBindingFailureDisposition,
  type ProviderBindingFailure,
} from '../../../providers/contracts/binding.js';
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
    if (providerBindingFailureDisposition(captured.failure) === 'operator-repairable') {
      return providerBindingQuarantine(action.jobId, captured.failure, captured.remediation);
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
    if (providerBindingFailureDisposition(captured.failure) === 'operator-repairable') {
      return providerBindingQuarantine(action.jobId, captured.failure, captured.remediation);
    }
    const durableRecord = isDurableCliRuntime(action.runtimeRecord) ? action.runtimeRecord : null;
    if (durableRecord === null) {
      return providerBindingCarrierQuarantine(
        action.jobId,
        captured.failure,
        captured.remediation,
        'the runtime carrier is not directly PID-addressable',
      );
    }
    const durableLiveness = runtime.process.observeLiveness(durableRecord.pid);
    if (durableLiveness !== 'absent') {
      const carrierState =
        durableLiveness === 'alive'
          ? `durable process ${durableRecord.pid} is alive`
          : `durable process ${durableRecord.pid} has unknown liveness`;
      return providerBindingCarrierQuarantine(action.jobId, captured.failure, captured.remediation, carrierState);
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

function providerBindingQuarantine(
  jobId: string,
  failure: ProviderBindingFailure,
  remediation: string,
): RecoveryDisposition {
  return {
    kind: 'quarantine',
    detail:
      `Provider '${failure.provider}' recovery binding failed: ${failure.reason}. ${remediation} ` +
      `After repairing the binding, run 'coral-cli backend recovery-quarantine list', then clear the exact ` +
      `coordinator-job-recovery entry for job '${jobId}'.`,
  };
}

function providerBindingCarrierQuarantine(
  jobId: string,
  failure: ProviderBindingFailure,
  remediation: string,
  carrierState: string,
): RecoveryDisposition {
  return {
    kind: 'quarantine',
    detail:
      `Provider '${failure.provider}' recovery binding is persisted-invalid (${failure.reason}), but ` +
      `${carrierState}; terminalization requires observed process absence. ${remediation} ` +
      `After the carrier is absent, clear the exact coordinator-job-recovery entry for job '${jobId}'.`,
  };
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
