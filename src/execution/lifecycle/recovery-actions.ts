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
import type { TypedEventBus } from '../event-bus.js';
import type { ProgressStore } from '../progress-store.js';
import type { RecoveryAction } from '../recovery-core.js';
import type { RecoveryRegistry } from '../recovery-registry.js';
import type { Runtime } from '../runtime.js';
import { SessionManager } from '../session-manager.js';
import type { RecoveryCapableService } from '../service.js';
import { GHOST_LAUNCH_NOTICE, OLD_FORMAT_NOTICE } from '../recovery-notices.js';
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
  eventBus: TypedEventBus;
  runtime: Runtime;
  createCallerContext: (projectRoot: string) => CallerContext;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
};

export function applyRecoveryAction(action: RecoveryAction, ctx: RecoveryActionContext): void {
  const { progressStore, recoveryRegistry, queuedRecoverable, runningRecoverable, log, eventBus, runtime, createCallerContext, getRecoveryService } = ctx;

  switch (action.type) {
    case 'deleteIncompleteDir':
      runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
      log(`Deleted incomplete admission: ${action.jobId}\n`);
      return;
    case 'markError': {
      markJobAsError(progressStore, action.status, action.notice, log);
      new SessionManager(action.status.projectRoot, runtime, eventBus).releaseJob(action.status.sessionId, action.status.jobId);
      if (action.notice === OLD_FORMAT_NOTICE) {
        log(`Marked incompatible old-format job: ${action.jobId}\n`);
      } else if (action.notice === GHOST_LAUNCH_NOTICE) {
        log(`Marked ghost launch job: ${action.jobId}\n`);
      } else {
        log(`Marked recovery job as error: ${action.jobId}\n`);
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
      SessionManager.openShard(action.shardDir, runtime, eventBus).releaseJob(action.sessionId, action.jobId);
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
      if (action.notice === OLD_FORMAT_NOTICE) {
        log(`Failed to handle incompatible job ${action.jobId}: ${formatError(error)}\n`);
      } else if (action.notice === GHOST_LAUNCH_NOTICE) {
        log(`Failed to handle ghost launch job ${action.jobId}: ${formatError(error)}\n`);
      } else {
        log(`Failed to handle recovery error-mark job ${action.jobId}: ${formatError(error)}\n`);
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
          const phase = result.aborted ? ('aborted' as const) : ('completed' as const);
          service.completeRecoveredJob(
            jobId,
            launchRecord.sessionId,
            {
              content: result.content,
              durationMs: result.durationMs,
              aborted: result.aborted,
              nonResumable: result.nonResumable,
              exitCode: result.exitCode,
              notice: result.notice,
              errors: result.errors,
              warnings: result.warnings,
              usage: result.usage,
            },
            phase,
            { conversationRef: result.conversationRef, nonResumable: result.nonResumable },
          );
        })
        .catch((recoverErr: unknown) => {
          log(`Provider recovery failed for job ${jobId}: ${formatError(recoverErr)}\n`);
          service.completeRecoveredJob(
            jobId,
            launchRecord.sessionId,
            { content: '', notice: `Provider recovery failed: ${formatError(recoverErr)}` },
            'error',
          );
        });
      return;
    }

    const persistedPayload = progressStore.readTerminalPayload(jobId);
    if (persistedPayload !== null) {
      const phase: 'aborted' | 'completed' | 'error' =
        persistedPayload.aborted === true ? 'aborted' : exitRecord.exitCode === 0 ? 'completed' : 'error';
      const payload: TerminalResult = persistedPayload.exitCode === undefined ? { ...persistedPayload, exitCode: exitRecord.exitCode } : persistedPayload;
      service.completeRecoveredJob(jobId, launchRecord.sessionId, payload, phase, { nonResumable: persistedPayload.nonResumable === true });
      return;
    }

    service.completeRecoveredJob(jobId, launchRecord.sessionId, { content: '', exitCode: exitRecord.exitCode }, exitRecord.exitCode === 0 ? 'completed' : 'error');
    return;
  }

  service.completeRecoveredJob(jobId, launchRecord.sessionId, { content: '', notice: 'Wrapper process lost — no exit.json found' }, 'error');
}
