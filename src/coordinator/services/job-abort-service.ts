import { backendLog } from '../../shared/backend-log.js';
import { errorMessage } from '../../shared/utils.js';
import {
  isAppServerRuntime,
  type AbortReason,
  type AppServerRuntime,
  type JobLaunch,
} from '../../jobs/api.js';
import type { AbortRegistry } from '../../jobs/shell/abort-registry.js';
import type { ProgressStore } from '../../jobs/job-store.js';
import type { ExecutionLaunchCoordinator, ExecutionLaunchPool as LaunchPool } from '../contracts.js';
import type { LaunchOrchestrator } from '../../jobs/shell/launch.js';
import type { AbortResult } from '../../shared/execution-contracts.js';

export interface JobAbortServiceDeps {
  abortRegistry: AbortRegistry;
  progressStore: ProgressStore;
  launchCoordinator: ExecutionLaunchCoordinator;
  jobPools: Map<string, LaunchPool>;
  launchOrchestrator: LaunchOrchestrator;
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
      if (status?.phase === 'queued' && this.deps.launchCoordinator.cancelQueued(jobId, pool)) {
        this.finishQueuedAbort(jobId, status.sessionId, 'queue_shutdown');
        aborted.push(jobId);
        continue;
      }

      const runtimeRecord = this.deps.progressStore.readRuntimeRecord(jobId);
      const launchRecord = this.deps.progressStore.readLaunchRecord(jobId);
      if (launchRecord && isAppServerRuntime(runtimeRecord)) {
        void this.deps.interruptAppServerJob(launchRecord, runtimeRecord).catch((error: unknown) => {
          backendLog.error(`Failed to interrupt app-server job ${jobId}: ${errorMessage(error)}`);
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
