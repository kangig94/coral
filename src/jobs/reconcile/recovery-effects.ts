import { type JobLifecycleFault, type JobProgressFault, type TerminalOutcomeInput } from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobStatus } from '../records.js';
import { buildJobEventRefs } from '../refs.js';
import type { JobStore } from '../store.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import type { CommitContext } from '../../store/append.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

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
  progressStore.commit((c) => {
    const outcome = recoveryFaultOutcome(c, status, fault);
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

function recoveryFaultOutcome<Scope>(
  c: CommitContext<Scope>,
  status: JobStatus,
  fault: JobRecoveryError,
): TerminalOutcomeInput<Scope> {
  switch (fault.kind) {
    case 'ghost_launch':
    case 'wrapper_lost':
    case 'wrapper_crashed':
    case 'provider_credential_source':
      return { kind: 'job_fault', fault };
    case 'missing_launch_record':
    case 'recovery_parse_failed': {
      const cause = c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: status.jobId },
        namespace: status.backendNamespace,
        project: status.projectRoot,
        refs: buildJobEventRefs({ jobId: status.jobId, sessionId: status.sessionId }),
        bodyVersion: 1,
        body: fault,
      });
      return failedTerminalOutcome(cause);
    }
  }
}
