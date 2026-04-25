import { formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime } from '../../../jobs/records.js';
import type { JobLaunch, JobRuntime } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { ProviderRecoveryContract } from '../../../providers/contract.js';
import { phaseForOutcome, type TerminalOutcome } from '../../../jobs/outcome.js';
import type { ProgressStore } from '../../../jobs/job-store.js';
import type { RecoveryAction } from '../../../jobs/reconcile/plan.js';
import type { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SessionLookup } from '../../../sessions/lookup.js';
import { releaseSessionJobClaim } from '../../../sessions/job-release.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import { markJobAsError } from '../../../jobs/reconcile/recovery-effects.js';
import {
  materializeJobRecoveryFault,
  materializeProviderTerminal,
} from '../../../jobs/terminal-materializer.js';
import { writeResultArtifact } from '../../../jobs/result-export.js';

export type QueuedRecoverableJob = { jobId: string; launchRecord: JobLaunch };
export type RunningRecoverableJob = {
  jobId: string;
  launchRecord: JobLaunch;
  runtimeRecord: JobRuntime;
};
type ProviderLike = ProviderRecoveryContract | undefined;
type RecoveryActionContext = {
  progressStore: ProgressStore;
  recoveryRegistry: RecoveryRegistry;
  queuedRecoverable: QueuedRecoverableJob[];
  runningRecoverable: RunningRecoverableJob[];
  log: (message: string) => void;
  runtime: Runtime;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>;
  emitSessionReleased: (payload: { sessionId: string; jobId: string }) => void;
};

export function applyRecoveryAction(action: RecoveryAction, ctx: RecoveryActionContext): void {
  const {
    progressStore,
    recoveryRegistry,
    queuedRecoverable,
    runningRecoverable,
    log,
    runtime,
    createInvocationContext,
    getRecoveryService,
    sessionLookup,
    emitSessionReleased,
  } = ctx;

  switch (action.type) {
    case 'discardIncompleteAdmission':
      runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
      log(`Discarded incomplete admission: ${action.jobId}\n`);
      return;
    case 'markError': {
      markJobAsError(progressStore, action.status, action.fault, log);
      if (action.status.jobKind === 'workflow') {
        try {
          writeResultArtifact(runtime.storage, action.status.jobId, '');
        } catch (error: unknown) {
          log(`Failed to write result artifact for ${action.status.jobId}: ${formatError(error)}\n`);
        }
      }
      if (action.status.sessionId !== null) {
        releaseSessionJobClaim({
          projectRoot: action.status.projectRoot,
          runtime,
          emitSessionReleased,
          db: progressStore.getDb(),
          sessionId: action.status.sessionId,
          jobId: action.status.jobId,
        });
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
          const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
          void service.interruptAppServerJob(action.launchRecord, runtimeRecord).catch((error: unknown) => {
            log(`Failed to interrupt recovered app-server job ${action.jobId}: ${formatError(error)}\n`);
          });
        });
      } else {
        recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
      }
      runningRecoverable.push({
        jobId: action.jobId,
        launchRecord: action.launchRecord,
        runtimeRecord: action.runtimeRecord,
      });
      return;
    case 'releaseSessionClaim': {
      const session = sessionLookup.readSessionEntry(action.sessionId);
      if (!session) {
        log(`Skipped releasing session claim for ${action.sessionId}: session lookup missing\n`);
        return;
      }

      releaseSessionJobClaim({
        projectRoot: session.projectRoot,
        runtime,
        emitSessionReleased,
        db: progressStore.getDb(),
        sessionId: action.sessionId,
        jobId: action.jobId,
      });
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
  launchRecord: JobLaunch;
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
  const sessionId = launchRecord.sessionId;
  if (sessionId === null) {
    log(`Skipped provider recovery for job ${jobId}: launch record has no session id\n`);
    return;
  }

  const exitRecord = progressStore.readExitProjection(jobId);
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
          const materialized = materializeProviderTerminal(progressStore, result.terminal, {
            jobId,
            sessionId,
          });
          service.completeRecoveredJob(
            jobId,
            sessionId,
            materialized.terminal,
            phaseForOutcome(materialized.terminal.outcome),
            {
              ...(result.continuity ? { continuity: result.continuity } : {}),
              diagnostics: materialized.diagnostics,
            },
          );
        })
        .catch((recoverErr: unknown) => {
          log(`Provider recovery failed for job ${jobId}: ${formatError(recoverErr)}\n`);
          const outcome = materializeJobRecoveryFault(
            progressStore,
            {
              kind: 'recovery_parse_failed',
              cause: { message: formatError(recoverErr) },
            },
            { jobId, sessionId },
          );
          service.completeRecoveredJob(
            jobId,
            sessionId,
            {
              content: '',
              outcome,
            },
            'error',
          );
        });
      return;
    }

    const persistedPayload = progressStore.readTerminalProjection(jobId);
    if (persistedPayload !== null) {
      const phase = phaseForOutcome(persistedPayload.outcome);
      service.completeRecoveredJob(jobId, sessionId, persistedPayload, phase);
      return;
    }

    const outcome: TerminalOutcome =
      exitRecord.exitCode === null
        ? {
            kind: 'job_fault',
            fault: {
              kind: 'wrapper_crashed',
              cause: {
                message:
                  exitRecord.signal !== null
                    ? `Provider wrapper exited via signal ${exitRecord.signal} without a terminal outcome`
                    : 'Provider wrapper exited without a numeric exit code or terminal outcome',
              },
            },
          }
        : { kind: 'provider_exit', code: exitRecord.exitCode };
    service.completeRecoveredJob(jobId, sessionId, { content: '', outcome }, phaseForOutcome(outcome));
    return;
  }

  service.completeRecoveredJob(
    jobId,
    sessionId,
    {
      content: '',
      outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
    },
    'error',
  );
}
