import { coordinatorLog } from '../../infra/coordinator-log.js';
import { errorMessage } from '../../infra/error-format.js';
import {
  isAppServerRuntime,
  type AppServerRuntime,
  type JobLaunch,
} from '../../jobs/records.js';
import type { AbortReason } from '../../jobs/outcome.js';
import type { JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../jobs/contracts/progress-store.js';
import type { JobAdmissionPort, LaunchPool } from '../../jobs/contracts/admission.js';
import type { QueuedJobAbortPort } from '../../jobs/contracts/job-runner.js';
import type { AbortResult } from '../../jobs/contracts/abort-registry.js';

export interface JobAbortServiceDeps {
  abortRegistry: JobAbortRegistryPort;
  progressStore: JobProgressStore;
  launchAdmission: JobAdmissionPort;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: QueuedJobAbortPort;
  interruptAppServerJob: (launchRecord: JobLaunch, runtimeRecord: AppServerRuntime) => Promise<void>;
}

export class JobAbortService {
  constructor(private readonly deps: JobAbortServiceDeps) {}

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
      if (status?.phase === 'queued' && status.sessionId !== null && this.deps.launchAdmission.cancelQueued(jobId, pool)) {
        this.finishQueuedAbort(jobId, status.sessionId, 'queue_shutdown');
        aborted.push(jobId);
        continue;
      }

      const runtimeRecord = this.deps.progressStore.readRuntimeProjection(jobId);
      const launchRecord = this.deps.progressStore.readLaunchProjection(jobId);
      if (launchRecord && isAppServerRuntime(runtimeRecord)) {
        void this.deps.interruptAppServerJob(launchRecord, runtimeRecord).catch((error: unknown) => {
          coordinatorLog.error(`Failed to interrupt app-server job ${jobId}: ${errorMessage(error)}`);
        });
      }

      this.deps.abortRegistry.abort([jobId]);
      aborted.push(jobId);
    }

    return { aborted, notFound };
  }

  finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.deps.launchOrchestrator.finishQueuedAbort(jobId, sessionId, reason);
  }
}
