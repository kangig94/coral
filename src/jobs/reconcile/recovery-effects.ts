import {
  type JobLifecycleFault,
  type JobProgressFault,
  type TerminalOutcomeInput,
} from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobStatus } from '../records.js';
import type { ProgressStore } from '../job-store.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import type { CommitContext } from '../../store/append.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

function jobRecoveryNeedsDomainEvent(fault: JobRecoveryError): boolean {
  return fault.kind === 'missing_launch_record' || fault.kind === 'recovery_parse_failed';
}

export function listLiveJobs(progressStore: ProgressStore, namespace: string): JobStatus[] {
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
  progressStore: Pick<
    ProgressStore,
    'commit' | 'readLaunchProjection' | 'appendLaunchRequested'
  >,
  status: JobStatus,
  fault: JobRecoveryError,
  _log: (message: string) => void,
): void {
  if (
    status.jobKind !== 'kb' &&
    jobRecoveryNeedsDomainEvent(fault) &&
    progressStore.readLaunchProjection(status.jobId) === null
  ) {
    progressStore.appendLaunchRequested(status.jobId, syntheticLaunchRecord(status));
  }

  progressStore.commit((c) => {
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
