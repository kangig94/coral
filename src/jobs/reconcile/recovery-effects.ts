import { type JobLifecycleFault, type JobProgressFault, type TerminalOutcomeInput } from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobStatus } from '../records.js';
import type { JobStore } from '../store.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import type { CommitContext } from '../../store/append.js';
import type { CoralEventInput } from '../../store/envelope.js';
import type { ProviderJobLaunchRequestBody } from '../launch.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

function jobRecoveryNeedsDomainEvent(fault: JobRecoveryError): boolean {
  return fault.kind === 'missing_launch_record' || fault.kind === 'recovery_parse_failed';
}

export function listLiveJobs(progressStore: JobStore, namespace: string): JobStatus[] {
  const results: JobStatus[] = [];

  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status || !isLivePhase(status.phase)) continue;

    const backendNamespace =
      typeof status.backendNamespace === 'string' && status.backendNamespace.length > 0
        ? status.backendNamespace
        : null;
    if (backendNamespace === namespace) {
      results.push(status);
    }
  }

  return results;
}

export function markJobAsError(
  progressStore: Pick<JobStore, 'commit' | 'readLaunchProjection'>,
  status: JobStatus,
  fault: JobRecoveryError,
  _log: (message: string) => void,
): void {
  const needsSyntheticLaunch =
    status.jobKind !== 'kb' &&
    jobRecoveryNeedsDomainEvent(fault) &&
    progressStore.readLaunchProjection(status.jobId) === null;

  progressStore.commit((c) => {
    if (needsSyntheticLaunch) {
      c.append(syntheticLaunchRequestedEvent(status));
    }

    const outcome = materializeJobRecoveryFaultInCommit(c, status, fault);
    appendJobTerminalRecorded(c, {
      jobId: status.jobId,
      sessionId: status.sessionId,
      namespace: status.backendNamespace,
      project: status.projectRoot,
      terminal: { content: '', outcome },
      continuity: null,
    });
    return undefined;
  });
}

function materializeJobRecoveryFaultInCommit<Scope>(
  c: CommitContext<Scope>,
  status: JobStatus,
  fault: JobRecoveryError,
): TerminalOutcomeInput<Scope> {
  switch (fault.kind) {
    case 'ghost_launch':
    case 'wrapper_lost':
    case 'wrapper_crashed':
      return { kind: 'job_fault', fault };
    case 'missing_launch_record':
    case 'recovery_parse_failed': {
      const cause = c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: status.jobId },
        namespace: status.backendNamespace,
        project: status.projectRoot,
        refs: {
          jobId: status.jobId,
          ...(status.sessionId === null ? {} : { sessionId: status.sessionId }),
        },
        bodyVersion: 1,
        body: fault,
      });
      return failedTerminalOutcome(cause);
    }
  }
}

function syntheticLaunchRecord(status: JobStatus): JobLaunch {
  return {
    jobId: status.jobId,
    sessionId: status.sessionId,
    provider: status.provider,
    projectRoot: status.projectRoot,
    backendNamespace: status.backendNamespace,
    ...(status.bundleHash === undefined ? {} : { bundleHash: status.bundleHash }),
    jobKind: status.jobKind,
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

function syntheticLaunchRequestedEvent(status: JobStatus): CoralEventInput<ProviderJobLaunchRequestBody> {
  const launch = syntheticLaunchRecord(status);
  if (launch.sessionId === null || launch.provider === null) {
    throw new Error(`Provider job '${status.jobId}' requires sessionId and provider.`);
  }
  if (launch.jobKind === 'kb') {
    throw new Error(`Synthetic recovery launch for '${status.jobId}' requires a provider or workflow job.`);
  }

  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: status.jobId },
    namespace: launch.backendNamespace,
    project: launch.projectRoot,
    refs: {
      jobId: status.jobId,
      sessionId: launch.sessionId,
    },
    bodyVersion: 1,
    body: {
      sessionId: launch.sessionId,
      provider: launch.provider,
      projectRoot: launch.projectRoot,
      backendNamespace: launch.backendNamespace,
      bundleHash: launch.bundleHash,
      jobKind: launch.jobKind,
      pool: launch.pool,
      enqueueSequence: launch.enqueueSequence,
      providerAction: launch.providerAction ?? 'exec',
      request: {
        prompt: launch.request.prompt ?? '',
        cwd: launch.request.cwd ?? launch.projectRoot,
        bypassPermissions: launch.request.bypassPermissions ?? false,
        coralEnv: { ...(launch.request.coralEnv ?? {}) },
      },
      createdAt: launch.createdAt,
    },
  };
}
