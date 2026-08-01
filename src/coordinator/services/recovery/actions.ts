import { errorMessage, formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobRuntime } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { TerminalOutcome } from '../../../jobs/outcome.js';
import type { JobStore } from '../../../jobs/store.js';
import type { RecoveryAction } from '../../../jobs/reconcile/plan.js';
import type { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SessionLookup } from '../../../sessions/lookup.js';
import { describeSessionJobClaimReleaseResult, releaseSessionJobClaim } from '../../../sessions/job-release.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { RecoveryCommitFence } from '../../../jobs/reconcile/contracts.js';
import { markJobAsError } from '../../../jobs/reconcile/recovery-effects.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import type { CommitEventsFn } from '../../../store/append.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import { gracefulKillByPid } from '../../live/process-supervision.js';

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
  sessionLookup: Pick<SessionLookup, 'readProviderSession'>;
  emitSessionReleased: (payload: { sessionId: string; jobId: string }) => void;
  coordinatorCommit: CommitEventsFn;
  signal: AbortSignal;
};

export async function applyRecoveryAction(action: RecoveryAction, ctx: RecoveryActionContext): Promise<void> {
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
    coordinatorCommit,
    signal,
  } = ctx;

  switch (action.type) {
    case 'discardIncompleteAdmission':
      runtime.storage.rmSync(progressStore.jobDir(action.jobId), { recursive: true, force: true });
      log(`Discarded incomplete admission: ${action.jobId}\n`);
      return;
    case 'markError': {
      markJobAsError(progressStore, action.status, action.fault, runtime.time.now(), log);
      if (action.status.jobKind === 'workflow') {
        try {
          writeResultArtifact(runtime.storage, runtime.paths.coral.exports.jobsRoot, action.status.jobId, '');
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
          commitEvents: coordinatorCommit,
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
    case 'registerQueued': {
      const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
      recoveryRegistry.register(action.jobId, action.launchRecord);
      const captured = await service.captureProviderRecoveryAuthority(action.launchRecord);
      signal.throwIfAborted();
      if (!captured.ok) {
        const releaseResult = service.finalizeProviderRecoveryBindingFailure(action.launchRecord, captured.failure);
        recoveryRegistry.remove(action.jobId);
        log(
          `Rejected queued recovery with invalid provider authority: ${action.jobId}; session claim disposition: ${describeSessionJobClaimReleaseResult(releaseResult)}.\n`,
        );
        return;
      }
      const { authority } = captured;
      queuedRecoverable.push({ jobId: action.jobId, authority });
      return;
    }
    case 'registerRunning': {
      const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
      recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
      const captured = await service.captureProviderRecoveryAuthority(action.launchRecord);
      signal.throwIfAborted();
      if (!captured.ok) {
        // A rejected authority is a per-job fault, never a process verdict: throwing
        // here is fatal to startup because the register loop runs outside the adoption
        // try/catch, which would abandon every other job's recovery too.
        if (isDurableCliRuntime(action.runtimeRecord) && runtime.process.isAlive(action.runtimeRecord.pid)) {
          try {
            gracefulKillByPid(runtime, action.runtimeRecord.pid);
          } catch (error: unknown) {
            log(
              `Failed to send SIGTERM to rejected recovery process ${action.runtimeRecord.pid} for job ${action.jobId}; recovery finalization will continue: ${errorMessage(error)}\n`,
            );
          }
        }
        const releaseResult = service.finalizeProviderRecoveryBindingFailure(action.launchRecord, captured.failure);
        recoveryRegistry.remove(action.jobId);
        log(
          `Rejected running recovery with invalid provider authority: terminalized ${action.jobId}; session claim disposition: ${describeSessionJobClaimReleaseResult(releaseResult)}. Run coral-cli jobs detail ${action.jobId} for the recorded reason.\n`,
        );
        return;
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
      return;
    }
    case 'releaseSessionClaim': {
      const session = sessionLookup.readProviderSession(action.sessionId);
      if (!session) {
        log(`Skipped releasing session claim for ${action.sessionId}: session lookup missing\n`);
        return;
      }

      const releaseResult = releaseSessionJobClaim({
        projectRoot: session.projectRoot,
        runtime,
        emitSessionReleased,
        db: progressStore.getDb(),
        commitEvents: coordinatorCommit,
        sessionId: action.sessionId,
        jobId: action.jobId,
      });
      const status = progressStore.readStatus(action.jobId);
      if (status && isTerminalPhase(status.phase)) {
        log(
          `Terminal session claim ${action.sessionId} disposition: ${describeSessionJobClaimReleaseResult(releaseResult)}.\n`,
        );
      } else {
        log(
          `Orphaned session claim ${action.sessionId} disposition: ${describeSessionJobClaimReleaseResult(releaseResult)}.\n`,
        );
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
  runtimeRecord: DurableCliRuntimeRecord;
  service: RecoveryCapableService;
  authority: ProviderRecoveryAuthority;
  progressStore: JobStore;
  cancelledJobIds?: ReadonlySet<string>;
  fence: RecoveryCommitFence;
};

type FinalizeAbortedRecoveredJobContext = {
  jobId: string;
  authority: ProviderRecoveryAuthority;
  service: RecoveryCapableService;
  runtime: Pick<Runtime, 'time'>;
};

export function finalizeAbortedRecoveredJob({
  jobId,
  authority,
  service,
  runtime,
}: FinalizeAbortedRecoveredJobContext): void {
  const { launchRecord, session } = authority;
  const sessionId = session.sessionId;

  const outcome: TerminalOutcome = { kind: 'aborted', reason: 'user_abort' };
  service.completeRecoveredJob(
    jobId,
    sessionId,
    {
      content: '',
      durationMs: elapsedDurationMs(launchRecord.createdAt, runtime.time.now(), `job ${jobId}`),
      outcome,
    },
    'aborted',
    { pool: launchRecord.pool },
  );
}

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
