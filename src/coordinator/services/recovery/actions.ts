import { formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobRuntime } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { ProviderArtifactHandleInput } from '../../../providers/contract.js';
import { phaseForOutcome, type TerminalOutcome } from '../../../jobs/outcome.js';
import type { JobStore } from '../../../jobs/store.js';
import type { RecoveryAction } from '../../../jobs/reconcile/plan.js';
import type { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SessionLookup } from '../../../sessions/lookup.js';
import { releaseSessionJobClaim } from '../../../sessions/job-release.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import { markJobAsError } from '../../../jobs/reconcile/recovery-effects.js';
import { recordJobRecoveryFaultTerminal, recordProviderTerminal } from '../terminal-materializer.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import type { CommitEventsFn } from '../../../store/append.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';

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
      const authority = await service.captureProviderRecoveryAuthority(action.launchRecord);
      if (authority === null) {
        log(`Rejected queued recovery with invalid provider authority: ${action.jobId}\n`);
        return;
      }
      recoveryRegistry.register(action.jobId, action.launchRecord);
      queuedRecoverable.push({ jobId: action.jobId, authority });
      return;
    }
    case 'registerRunning': {
      const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
      const authority = await service.captureProviderRecoveryAuthority(action.launchRecord);
      if (authority === null) {
        if (isDurableCliRuntime(action.runtimeRecord)) {
          try {
            runtime.process.kill(action.runtimeRecord.pid, 'SIGTERM');
          } catch (error: unknown) {
            log(`Failed to stop rejected recovery process ${action.runtimeRecord.pid}: ${formatError(error)}\n`);
          }
        }
        log(`Rejected running recovery with invalid provider authority: ${action.jobId}\n`);
        return;
      }
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

      releaseSessionJobClaim({
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
  runtimeRecord: DurableCliRuntimeRecord;
  service: RecoveryCapableService;
  authority: ProviderRecoveryAuthority;
  progressStore: JobStore;
  runtime: Runtime;
  cancelledJobIds?: ReadonlySet<string>;
  log: (message: string) => void;
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
  runtime,
  cancelledJobIds,
  log,
}: FinalizeDeadAdoptedJobContext): Promise<void> {
  const { launchRecord, session, boundProvider } = authority;
  const sessionId = session.sessionId;
  const recovery = boundProvider.recovery;

  const exitRecord = progressStore.readExitProjection(jobId);
  if (exitRecord) {
    const persistedPayload = progressStore.readTerminalProjection(jobId);
    if (persistedPayload !== null) {
      const phase = phaseForOutcome(persistedPayload.outcome);
      service.completeRecoveredJob(jobId, sessionId, persistedPayload, phase, { pool: launchRecord.pool });
      return;
    }

    if (recovery !== undefined) {
      void recovery
        .finalizeFromArtifacts({
          stdoutPath: runtimeRecord.stdoutPath,
          stderrPath: runtimeRecord.stderrPath,
          exitCode: exitRecord.exitCode,
          signal: exitRecord.signal,
          durationMs: elapsedDurationMs(runtimeRecord.startTime, Date.parse(exitRecord.endTime), `job ${jobId}`),
          fallbackConversationRef: session.conversationRef,
          knownArtifactHandles: readKnownArtifactHandles(session, jobId),
          storage: runtime.storage,
        })
        .then(async (result) => {
          if (result.artifactHandles && result.artifactHandles.length > 0) {
            const recorded = await service.recordRecoveredArtifactHandles(sessionId, {
              jobId,
              handles: result.artifactHandles,
            });
            if (!recorded.ok) {
              log(`Recovered artifact handle recording went stale for job ${jobId}; continuing terminal recovery\n`);
            }
          }

          const status = progressStore.readStatus(jobId);
          recordProviderTerminal(progressStore, result.terminal, {
            jobId,
            sessionId,
            namespace: status?.backendNamespace ?? launchRecord.backendNamespace,
            project: status?.projectRoot ?? launchRecord.projectRoot,
          });
          const persistedPayload = progressStore.readTerminalProjection(jobId);
          if (persistedPayload === null) {
            throw new Error(`Provider recovery did not record a terminal payload for ${jobId}.`);
          }
          service.completeRecoveredJob(jobId, sessionId, persistedPayload, phaseForOutcome(persistedPayload.outcome), {
            pool: launchRecord.pool,
            ...(result.continuity
              ? {
                  sessionContinuity: {
                    ...result.continuity,
                    providerContinuity: result.continuity.providerContinuity ?? null,
                  },
                }
              : {}),
          });
        })
        .catch((recoverErr: unknown) => {
          log(`Provider recovery failed for job ${jobId}: ${formatError(recoverErr)}\n`);
          const status = progressStore.readStatus(jobId);
          recordJobRecoveryFaultTerminal(
            progressStore,
            {
              kind: 'recovery_parse_failed',
              cause: { message: formatError(recoverErr) },
            },
            {
              jobId,
              sessionId,
              namespace: status?.backendNamespace ?? launchRecord.backendNamespace,
              project: status?.projectRoot ?? launchRecord.projectRoot,
            },
            {
              content: '',
              durationMs: elapsedDurationMs(runtimeRecord.startTime, runtime.time.now(), `job ${jobId}`),
            },
          );
          const persistedPayload = progressStore.readTerminalProjection(jobId);
          if (persistedPayload === null) {
            throw new Error(`Provider recovery failure did not record a terminal payload for ${jobId}.`);
          }
          service.completeRecoveredJob(jobId, sessionId, persistedPayload, phaseForOutcome(persistedPayload.outcome), {
            pool: launchRecord.pool,
          });
        });
      return;
    }

    finalizeUnsupportedProviderRecovery({ authority, jobId, runtimeRecord, service, progressStore, runtime });
    return;
  }

  if (cancelledJobIds?.has(jobId)) {
    finalizeAbortedRecoveredJob({ jobId, authority, service, runtime });
    return;
  }

  if (recovery === undefined) {
    finalizeUnsupportedProviderRecovery({ authority, jobId, runtimeRecord, service, progressStore, runtime });
    return;
  }

  // No exit metadata means no stdout/stderr artifact locator inputs exist here.
  // AC4 excludes this wrapper_lost branch from authoritative handle recording;
  // retention enforcement later records the durable skipped_no_handles outcome.
  service.completeRecoveredJob(
    jobId,
    sessionId,
    {
      content: '',
      durationMs: elapsedDurationMs(runtimeRecord.startTime, runtime.time.now(), `job ${jobId}`),
      outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
    },
    'error',
    { pool: launchRecord.pool },
  );
}

function readKnownArtifactHandles(
  session: ProviderRecoveryAuthority['session'],
  jobId: string,
): readonly ProviderArtifactHandleInput[] | undefined {
  const handles: ProviderArtifactHandleInput[] = [];
  for (const artifact of session.artifactHandles) {
    if (artifact.sourceJobId !== jobId) {
      continue;
    }
    handles.push({
      handle: artifact.handle,
      identity: artifact.identity,
      sourceJobId: artifact.sourceJobId,
    });
  }
  return handles.length === 0 ? undefined : handles;
}

function finalizeUnsupportedProviderRecovery(options: {
  authority: ProviderRecoveryAuthority;
  jobId: string;
  runtimeRecord: DurableCliRuntimeRecord;
  service: RecoveryCapableService;
  progressStore: JobStore;
  runtime: Runtime;
}): void {
  const { authority, jobId, runtimeRecord, service, progressStore, runtime } = options;
  const { launchRecord, session, boundProvider } = authority;
  recordJobRecoveryFaultTerminal(
    progressStore,
    {
      kind: 'recovery_parse_failed',
      cause: { message: `Bound provider '${boundProvider.name}' does not expose durable recovery capability.` },
    },
    {
      jobId,
      sessionId: session.sessionId,
      namespace: launchRecord.backendNamespace,
      project: launchRecord.projectRoot,
    },
    {
      content: '',
      durationMs: elapsedDurationMs(runtimeRecord.startTime, runtime.time.now(), `job ${jobId}`),
    },
  );
  const persistedPayload = progressStore.readTerminalProjection(jobId);
  if (persistedPayload === null) {
    throw new Error(`Unsupported provider recovery did not record a terminal payload for ${jobId}.`);
  }
  service.completeRecoveredJob(jobId, session.sessionId, persistedPayload, phaseForOutcome(persistedPayload.outcome), {
    pool: launchRecord.pool,
  });
}
