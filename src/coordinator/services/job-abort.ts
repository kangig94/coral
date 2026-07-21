import type { AbortReason } from '../../jobs/outcome.js';
import type { JobAbortRegistryPort, AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { JobAdmissionPort, LaunchPool } from '../../jobs/contracts/admission.js';
import type { QueuedJobAbortPort } from '../../jobs/contracts/job-runner.js';

export interface JobAbortServiceDeps {
  abortRegistry: JobAbortRegistryPort;
  progressStore: JobProgressStore;
  launchAdmission: JobAdmissionPort;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: QueuedJobAbortPort;
}

export class JobAbortService {
  private readonly deps: JobAbortServiceDeps;
  constructor(deps: JobAbortServiceDeps) {
    this.deps = deps;
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];

    for (const jobId of jobIds) {
      if (!this.deps.abortRegistry.has(jobId)) {
        notFound.push(jobId);
        continue;
      }

      const status = this.deps.progressStore.readStatus(jobId);
      const pool = this.deps.jobPools.get(jobId) ?? 'default';
      if (
        status?.phase === 'queued' &&
        status.sessionId !== null &&
        this.deps.launchAdmission.cancelQueued(jobId, pool)
      ) {
        this.finishQueuedAbort(jobId, status.sessionId, 'queue_shutdown');
        aborted.push(jobId);
        continue;
      }

      // The bound provider runtime observes this signal and interrupts with its
      // live lease/key. Durable recovery intentionally has no access to those
      // epoch-local credentials.
      this.deps.abortRegistry.abort([jobId]);
      aborted.push(jobId);
    }

    return { aborted, notFound };
  }

  finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.deps.launchOrchestrator.finishQueuedAbort(jobId, sessionId, reason);
  }
}
