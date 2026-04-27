import {
  type JobLifecycleFault,
  type JobProgressFault,
} from '../outcome.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobStatus, JobTerminalInput } from '../records.js';
import type { ProgressStore } from '../job-store.js';
import {
  jobRecoveryNeedsDomainEvent,
  materializeJobRecoveryFault,
} from '../terminal/materializer.js';

type JobRecoveryError = JobLifecycleFault | JobProgressFault;

export function listLiveJobs(progressStore: ProgressStore, namespace: string): JobStatus[] {
  const results: JobStatus[] = [];

  for (const jobId of progressStore.listJobIds()) {
    const status = progressStore.readStatus(jobId);
    if (!status || !isLivePhase(status.phase)) continue;

    const coordinatorNamespace =
      typeof status.coordinatorNamespace === 'string' && status.coordinatorNamespace.length > 0
        ? status.coordinatorNamespace
        : null;
    if (coordinatorNamespace === namespace) {
      results.push(status);
    }
  }

  return results;
}

export function markJobAsError(
  progressStore: Pick<
    ProgressStore,
    'appendEventsWithResult' | 'appendTerminal' | 'readLaunchProjection' | 'readStatus' | 'appendLaunchRequested'
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

  const outcome = materializeJobRecoveryFault(progressStore, fault, {
    jobId: status.jobId,
    sessionId: status.sessionId,
  });
  const terminalResult: JobTerminalInput = { content: '', outcome };
  progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
}

function syntheticLaunchRecord(status: JobStatus): JobLaunch {
  return {
    jobId: status.jobId,
    sessionId: status.sessionId,
    provider: status.provider,
    projectRoot: status.projectRoot,
    coordinatorNamespace: status.coordinatorNamespace,
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
