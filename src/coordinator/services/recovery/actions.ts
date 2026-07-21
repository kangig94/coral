import { formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobLaunch, type JobRuntime, type JobStatus } from '../../../jobs/records.js';
import type { DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { ProviderArtifactHandleInput, ProviderRecoveryContract } from '../../../providers/contract.js';
import type { ProviderBindingCatalog } from '../../../providers/catalog.js';
import { phaseForOutcome, type TerminalOutcome } from '../../../jobs/outcome.js';
import type { JobStore } from '../../../jobs/store.js';
import type { RecoveryAction } from '../../../jobs/reconcile/plan.js';
import type { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SessionLookup } from '../../../sessions/lookup.js';
import { releaseSessionJobClaim } from '../../../sessions/job-release.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import { markJobAsError } from '../../../jobs/reconcile/recovery-effects.js';
import { recordJobRecoveryFaultTerminal, recordProviderTerminal } from '../terminal-materializer.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import type { CommitEventsFn } from '../../../store/append.js';

export type QueuedRecoverableJob = { jobId: string; launchRecord: JobLaunch };
export type RunningRecoverableJob = {
  jobId: string;
  launchRecord: JobLaunch;
  runtimeRecord: JobRuntime;
};
type ProviderLike = ProviderRecoveryContract | undefined;
type RecoveryActionContext = {
  progressStore: JobStore;
  recoveryRegistry: RecoveryRegistry;
  queuedRecoverable: QueuedRecoverableJob[];
  runningRecoverable: RunningRecoverableJob[];
  log: (message: string) => void;
  runtime: Runtime;
  providerRegistry: ProviderBindingCatalog;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>;
  emitSessionReleased: (payload: { sessionId: string; jobId: string }) => void;
  coordinatorCommit: CommitEventsFn;
};

function recoveryAuthorityLaunch(status: JobStatus): JobLaunch | null {
  if (status.jobKind !== 'provider' || status.sessionId === null || status.provider === null) return null;
  return {
    jobId: status.jobId,
    sessionId: status.sessionId,
    provider: status.provider,
    projectRoot: status.projectRoot,
    backendNamespace: status.backendNamespace,
    ...(status.bundleHash === undefined ? {} : { bundleHash: status.bundleHash }),
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: status.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: status.updatedAt,
  };
}

export async function applyRecoveryAction(action: RecoveryAction, ctx: RecoveryActionContext): Promise<void> {
  const {
    progressStore,
    recoveryRegistry,
    queuedRecoverable,
    runningRecoverable,
    log,
    runtime,
    providerRegistry,
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
      const launchRecord = progressStore.readLaunchProjection(action.jobId);
      if (action.status.jobKind === 'provider') {
        const authorityLaunch = launchRecord ?? recoveryAuthorityLaunch(action.status);
        if (authorityLaunch === null) {
          log(`Rejected stale provider job without recoverable authority: ${action.jobId}\n`);
          return;
        }
        const service = getRecoveryService(createInvocationContext(action.status.projectRoot));
        if (!(await service.validateProviderRecoveryAuthority(authorityLaunch))) {
          log(`Rejected stale-job recovery with invalid provider authority: ${action.jobId}\n`);
          return;
        }
      }
      markJobAsError(progressStore, action.status, action.fault, log);
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
    case 'registerQueued':
      recoveryRegistry.register(action.jobId, action.launchRecord);
      queuedRecoverable.push({ jobId: action.jobId, launchRecord: action.launchRecord });
      return;
    case 'registerRunning': {
      if (isAppServerRuntime(action.runtimeRecord)) {
        const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
        if (!(await service.validateProviderRecoveryAuthority(action.launchRecord))) {
          log(`Rejected running recovery with invalid provider authority: ${action.jobId}\n`);
          return;
        }
        const runtimeRecord = action.runtimeRecord;
        const interrupt =
          action.launchRecord.provider === null
            ? undefined
            : providerRegistry.get(action.launchRecord.provider)?.appServer?.interrupt;
        recoveryRegistry.register(
          action.jobId,
          action.launchRecord,
          action.runtimeRecord,
          interrupt === undefined
            ? undefined
            : () => {
                const service = getRecoveryService(createInvocationContext(action.launchRecord.projectRoot));
                void service.interruptAppServerJob(action.launchRecord, runtimeRecord).catch((error: unknown) => {
                  log(`Failed to interrupt recovered app-server job ${action.jobId}: ${formatError(error)}\n`);
                });
              },
        );
      } else {
        recoveryRegistry.register(action.jobId, action.launchRecord, action.runtimeRecord);
      }
      runningRecoverable.push({
        jobId: action.jobId,
        launchRecord: action.launchRecord,
        runtimeRecord: action.runtimeRecord,
      });
      return;
    }
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
  launchRecord: JobLaunch;
  runtimeRecord: DurableCliRuntimeRecord;
  service: RecoveryCapableService;
  provider: ProviderLike;
  progressStore: JobStore;
  runtime: Runtime;
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>;
  cancelledJobIds?: ReadonlySet<string>;
  log: (message: string) => void;
};

type FinalizeAbortedRecoveredJobContext = {
  jobId: string;
  launchRecord: JobLaunch;
  service: RecoveryCapableService;
  progressStore: Pick<JobStore, 'readStatus'>;
  log: (message: string) => void;
};

export function finalizeAbortedRecoveredJob({
  jobId,
  launchRecord,
  service,
  progressStore,
  log,
}: FinalizeAbortedRecoveredJobContext): void {
  const status = progressStore.readStatus(jobId);
  const sessionId = launchRecord.sessionId ?? status?.sessionId ?? null;
  if (sessionId === null) {
    log(`Skipped aborted recovery terminal for job ${jobId}: session id is unavailable\n`);
    return;
  }

  const outcome: TerminalOutcome = { kind: 'aborted', reason: 'user_abort' };
  service.completeRecoveredJob(jobId, sessionId, { content: '', outcome }, 'aborted');
}

export async function finalizeDeadAdoptedJob({
  jobId,
  launchRecord,
  runtimeRecord,
  service,
  provider,
  progressStore,
  runtime,
  sessionLookup,
  cancelledJobIds,
  log,
}: FinalizeDeadAdoptedJobContext): Promise<void> {
  const sessionId = launchRecord.sessionId;
  const providerName = launchRecord.provider;
  if (sessionId === null || providerName === null) {
    log(`Skipped provider recovery for job ${jobId}: launch record is not a provider session launch\n`);
    return;
  }
  const credentialSource = await service.providerCredentialSourceForRecovery(launchRecord);
  if (credentialSource === null) {
    log(`Provider recovery skipped for job ${jobId}: provider credential source is no longer valid\n`);
    return;
  }

  const exitRecord = progressStore.readExitProjection(jobId);
  if (exitRecord) {
    if (provider) {
      void provider
        .finalizeFromArtifacts({
          source: credentialSource,
          stdoutPath: runtimeRecord.stdoutPath,
          stderrPath: runtimeRecord.stderrPath,
          exitCode: exitRecord.exitCode,
          signal: exitRecord.signal,
          providerMeta: runtimeRecord.providerMeta,
          fallbackConversationRef: launchRecord.request.conversationRef,
          knownArtifactHandles: readKnownArtifactHandles(sessionLookup, sessionId, providerName, jobId),
          storage: runtime.storage,
        })
        .then(async (result) => {
          if (result.artifactHandles && result.artifactHandles.length > 0) {
            const recorded = await service.recordRecoveredArtifactHandles(sessionId, {
              jobId,
              provider: providerName,
              handles: result.artifactHandles,
            });
            if (!recorded.ok) {
              log(`Recovered artifact handle recording went stale for job ${jobId}; continuing terminal recovery\n`);
            }
          }

          const status = progressStore.readStatus(jobId);
          recordProviderTerminal(
            progressStore,
            result.terminal,
            {
              jobId,
              sessionId,
              namespace: status?.backendNamespace ?? launchRecord.backendNamespace,
              project: status?.projectRoot ?? launchRecord.projectRoot,
            },
            {
              continuity: result.continuity ?? null,
            },
          );
          const persistedPayload = progressStore.readTerminalProjection(jobId);
          if (persistedPayload === null) {
            throw new Error(`Provider recovery did not record a terminal payload for ${jobId}.`);
          }
          service.completeRecoveredJob(jobId, sessionId, persistedPayload, phaseForOutcome(persistedPayload.outcome), {
            ...(result.continuity ? { continuity: result.continuity } : {}),
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
            { content: '' },
          );
          const persistedPayload = progressStore.readTerminalProjection(jobId);
          if (persistedPayload === null) {
            throw new Error(`Provider recovery failure did not record a terminal payload for ${jobId}.`);
          }
          service.completeRecoveredJob(jobId, sessionId, persistedPayload, phaseForOutcome(persistedPayload.outcome));
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

  if (cancelledJobIds?.has(jobId)) {
    finalizeAbortedRecoveredJob({ jobId, launchRecord, service, progressStore, log });
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
      outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
    },
    'error',
  );
}

function readKnownArtifactHandles(
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>,
  sessionId: string,
  provider: string,
  jobId: string,
): readonly ProviderArtifactHandleInput[] | undefined {
  const session = sessionLookup.readSessionEntry(sessionId);
  if (session === null) {
    return undefined;
  }

  const handles: ProviderArtifactHandleInput[] = [];
  for (const artifact of session.artifactHandles) {
    if (artifact.provider !== provider) {
      continue;
    }
    if (artifact.sourceJobId !== undefined && artifact.sourceJobId !== jobId) {
      continue;
    }
    handles.push({
      handle: artifact.handle,
      identity: artifact.identity,
      ...(artifact.sourceJobId === undefined ? {} : { sourceJobId: artifact.sourceJobId }),
    });
  }
  return handles.length === 0 ? undefined : handles;
}
