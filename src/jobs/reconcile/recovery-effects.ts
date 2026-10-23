import { type JobLifecycleFault, type JobProgressFault, type TerminalOutcomeInput } from '../outcome.js';
import type { JobStatus } from '../records.js';
import { buildJobEventRefs } from '../refs.js';
import type { JobStore } from '../store.js';
import { appendJobExecutionOutcomeAccepted, failedTerminalOutcome } from '../terminal/recording.js';
import type { CommitContext } from '../../store/append.js';
import { elapsedDurationMs } from '../duration.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

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
  if (status.execution === null) throw new Error(`Job '${status.jobId}' has no requested execution.`);
  const execution = status.execution;
  const durationMs = launch === null ? 0 : elapsedDurationMs(launch.createdAt, endTimeMs, `job ${status.jobId}`);
  progressStore.commit((c) => {
    const outcome = recoveryFaultOutcome(c, status, fault);
    appendJobExecutionOutcomeAccepted(c, {
      jobId: status.jobId,
      execution,
      namespace: status.backendNamespace ?? undefined,
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
        type: 'job.execution.progress',
        stream: { kind: 'job', id: status.jobId },
        namespace: status.backendNamespace ?? undefined,
        project: status.projectRoot,
        refs: buildJobEventRefs({ jobId: status.jobId }),
        body: { ...fault, execution: status.execution },
      });
      return failedTerminalOutcome(cause);
    }
  }
}
