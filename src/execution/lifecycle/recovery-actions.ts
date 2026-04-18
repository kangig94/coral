import { phaseForOutcome, type TerminalOutcome, wrapperCrashedFault } from '../../shared/coral-fault.js';
import { formatError } from '../../shared/utils.js';
import {
  isAppServerRuntime,
  isTerminalPhase,
  type DurableCliRuntimeRecord,
  type PersistedLaunchRecord,
  type PersistedRuntimeRecord,
  type TerminalResult,
} from '../../shared/types.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { ProviderArtifactRecovery } from '../../providers/types.js';
import type { ProgressStore } from '../progress-store.js';
import type { RecoveryAction } from '../recovery-core.js';
import type { RecoveryRegistry } from '../recovery-registry.js';
import type { Runtime } from '../../runtime/ports.js';
import { SessionManager } from '../session-manager.js';
import type { RecoveryCapableService } from '../service.js';
import { markJobAsError } from './job-helpers.js';

export type QueuedRecoverableJob = { jobId: string; launchRecord: PersistedLaunchRecord };
export type RunningRecoverableJob = {
  jobId: string;
  launchRecord: PersistedLaunchRecord;
  runtimeRecord: PersistedRuntimeRecord;
};
type ProviderLike = ProviderArtifactRecovery | undefined;
type RecoveryActionContext = {
  progressStore: ProgressStore;
  recoveryRegistry: RecoveryRegistry;
  queuedRecoverable: QueuedRecoverableJob[];
  runningRecoverable: RunningRecoverableJob[];
  log: (message: string) => void;
  runtime: Runtime;
  createCallerContext: (projectRoot: string) => CallerContext;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
};

export function applyRecoveryAction(action: RecoveryAction, ctx: RecoveryActionContext): void {
  const { progressStore, recoveryRegistry, queuedRecoverable, runningRecoverable, log, runtime, createCallerContext, getRecoveryService } = ctx;

  switch (action.type) {
    case 'deleteIncompleteDir':
      runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
      log(`Deleted incomplete admission: ${action.jobId}\n`);
      return;
    case 'markError': {
      markJobAsError(progressStore, action.status, action.fault, log);
      new SessionManager(action.status.projectRoot, runtime).releaseJob(action.status.sessionId, action.status.jobId);
      switch (action.fault.kind) {
        case 'stale_status_schema':
          log(`Marked incompatible old-format job: ${action.jobId}\n`);
          break;
        case 'ghost_launch':
          log(`Marked ghost launch job: ${action.jobId}\n`);
          break;
        default:
          log(`Marked recovery job as error: ${action.jobId}\n`);
          break;
      }
      return;
    }
    case 'registerQueued':
      recoveryRegistry.register(action.jobId, action.launchRecord);
      queuedRecoverable.push({ jobId: action.jobId, launchRecord: action.launchRecord });
      return;
    case 'registerRunning':
      if (isAppServerRuntime(action.runtimeRecord)) {
        const runtimeRecord = action.runtimeRecord;
        recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord, () => {
          const service = getRecoveryService(createCallerContext(action.launchRecord.projectRoot));
          void service.interruptAppServerJob(action.launchRecord, runtimeRecord).catch((error: unknown) => {
            log(`Failed to interrupt recovered app-server job ${action.jobId}: ${formatError(error)}\n`);
          });
        });
      } else {
        recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
      }
      runningRecoverable.push({ jobId: action.jobId, launchRecord: action.launchRecord, runtimeRecord: action.runtimeRecord });
      return;
    case 'releaseSessionClaim': {
      SessionManager.openShard(action.shardDir, runtime).releaseJob(action.sessionId, action.jobId);
      const status = progressStore.readStatus(action.jobId);
      if (status && isTerminalPhase(status.phase)) {
        log(`Released terminal session claim: ${action.sessionId}\n`);
      } else {
        log(`Released orphaned session claim: ${action.sessionId}\n`);
      }
      return;
    }
  }
}

export function logRecoveryActionFailure(action: RecoveryAction, error: unknown, log: (message: string) => void): void {
  switch (action.type) {
    case 'deleteIncompleteDir':
      log(`Failed to delete incomplete admission ${action.jobId}: ${formatError(error)}\n`);
      return;
    case 'markError':
      switch (action.fault.kind) {
        case 'stale_status_schema':
          log(`Failed to handle incompatible job ${action.jobId}: ${formatError(error)}\n`);
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
  launchRecord: PersistedLaunchRecord;
  runtimeRecord: DurableCliRuntimeRecord;
  service: RecoveryCapableService;
  provider: ProviderLike;
  progressStore: ProgressStore;
  log: (message: string) => void;
};

export function finalizeDeadAdoptedJob({
  jobId,
  launchRecord,
  runtimeRecord,
  service,
  provider,
  progressStore,
  log,
}: FinalizeDeadAdoptedJobContext): void {
  const exitRecord = progressStore.readExitRecord(jobId);
  if (exitRecord) {
    if (provider) {
      void provider
        .finalizeFromArtifacts({
          stdoutPath: runtimeRecord.stdoutPath,
          stderrPath: runtimeRecord.stderrPath,
          exitCode: exitRecord.exitCode,
          signal: exitRecord.signal,
          fallbackConversationRef: launchRecord.request.conversationRef,
        })
        .then((result) => {
          service.completeRecoveredJob(
            jobId,
            launchRecord.sessionId,
            {
              content: result.content,
              durationMs: result.durationMs,
              nonResumable: result.nonResumable,
              exitCode: result.exitCode,
              warnings: result.warnings,
              usage: result.usage,
              outcome: result.outcome,
            },
            phaseForOutcome(result.outcome),
            { conversationRef: result.conversationRef, nonResumable: result.nonResumable },
          );
        })
        .catch((recoverErr: unknown) => {
          log(`Provider recovery failed for job ${jobId}: ${formatError(recoverErr)}\n`);
          service.completeRecoveredJob(
            jobId,
            launchRecord.sessionId,
            {
              content: '',
              outcome: {
                kind: 'coral_fault',
                fault: {
                  kind: 'recovery_parse_failed',
                  cause: { message: formatError(recoverErr) },
                },
              },
            },
            'error',
          );
        });
      return;
    }

    const persistedPayload = progressStore.readTerminalPayload(jobId);
    if (persistedPayload !== null) {
      const phase = phaseForOutcome(persistedPayload.outcome);
      const payload: TerminalResult = persistedPayload.exitCode === undefined ? { ...persistedPayload, exitCode: exitRecord.exitCode } : persistedPayload;
      service.completeRecoveredJob(jobId, launchRecord.sessionId, payload, phase, { nonResumable: persistedPayload.nonResumable === true });
      return;
    }

    const outcome: TerminalOutcome =
      exitRecord.exitCode === null
        ? {
            kind: 'coral_fault',
            fault: wrapperCrashedFault(
              exitRecord.signal !== null
                ? `Provider wrapper exited via signal ${exitRecord.signal} without a terminal outcome`
                : 'Provider wrapper exited without a numeric exit code or terminal outcome',
            ),
          }
        : { kind: 'provider_exit', code: exitRecord.exitCode };
    service.completeRecoveredJob(
      jobId,
      launchRecord.sessionId,
      { content: '', exitCode: exitRecord.exitCode, outcome },
      phaseForOutcome(outcome),
    );
    return;
  }

  service.completeRecoveredJob(
    jobId,
    launchRecord.sessionId,
    { content: '', outcome: { kind: 'coral_fault', fault: { kind: 'wrapper_lost' } } },
    'error',
  );
}
