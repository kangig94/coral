import type { AppServerRuntime, JobLaunch, JobRuntime } from '../records.js';
import type { JobContinuitySnapshot } from '../continuity.js';
import type { JobTerminal } from '../result.js';
import type { JobPhase } from '../phase.js';

export interface RecoveryCapableService {
  finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(launchRecord: JobLaunch, runtimeRecord: JobRuntime): { cleanup: () => void };
  recoverQueuedJob(launchRecord: JobLaunch): string;
  interruptAppServerJob(launchRecord: JobLaunch, runtimeRecord: AppServerRuntime): Promise<void>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminal,
    phase: JobPhase,
    options?: {
      continuity?: JobContinuitySnapshot;
    },
  ): void;
}

export interface LaunchFenceState {
  setLaunchFenceActive(active: boolean): void;
}
