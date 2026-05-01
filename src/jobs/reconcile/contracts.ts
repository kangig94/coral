import type { AppServerRuntime, JobLaunch, JobRuntime, JobTerminalInput } from '../records.js';
import type { JobPhase } from '../phase.js';
import type { TerminalWriteOptions } from '../contracts/job-store.js';

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
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}
