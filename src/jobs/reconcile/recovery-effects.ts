import { type JobLifecycleFault, type JobProgressFault, type TerminalOutcomeInput } from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobStatus } from '../records.js';
import { buildJobEventRefs } from '../refs.js';
import type { JobStore } from '../store.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../terminal/recording.js';
import type { CommitContext } from '../../store/append.js';
import { elapsedDurationMs } from '../duration.js';

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
  endTimeMs: number,
  _log: (message: string) => void,
): void {
  const launch = progressStore.readLaunchProjection(status.jobId);
  if (launch === null && fault.kind !== 'missing_launch_record') {
    throw new Error(`Cannot record recovery terminal for ${status.jobId} without its launch record.`);
  }
  const durationMs = launch === null ? 0 : elapsedDurationMs(launch.createdAt, endTimeMs, `job ${status.jobId}`);
  progressStore.commit((c) => {
    const outcome = recoveryFaultOutcome(c, status, fault);
    appendJobTerminalRecorded(c, {
      jobId: status.jobId,
      sessionId: status.sessionId,
      namespace: status.backendNamespace,
      project: status.projectRoot,
      terminal: { content: '', durationMs, outcome },
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
    case 'provider_binding':
      return { kind: 'job_fault', fault };
    case 'missing_launch_record':
    case 'recovery_parse_failed': {
      const cause = c.append({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: status.jobId },
        namespace: status.backendNamespace,
        project: status.projectRoot,
        refs: buildJobEventRefs({ jobId: status.jobId, sessionId: status.sessionId }),
        body: fault,
      });
      return failedTerminalOutcome(cause);
    }
  }
}
