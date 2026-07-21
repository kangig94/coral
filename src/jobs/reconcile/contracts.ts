import type { AppServerRuntime, JobLaunch, JobRuntime, JobTerminalInput } from '../records.js';
import type { JobPhase } from '../phase.js';
import type { TerminalWriteOptions } from '../contracts/job-store.js';
import type { ProviderArtifactHandleInput } from '../../providers/contract.js';
import type { ProviderCredentialSourceRef } from '../../runtime/provider-credentials.js';

export interface RecoveryCapableService {
  validateProviderRecoveryAuthority(launchRecord: JobLaunch): boolean;
  providerCredentialSourceForRecovery(launchRecord: JobLaunch): ProviderCredentialSourceRef | null;
  finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(launchRecord: JobLaunch, runtimeRecord: JobRuntime): { adopted: boolean; cleanup: () => void };
  recoverQueuedJob(launchRecord: JobLaunch): string;
  interruptAppServerJob(launchRecord: JobLaunch, runtimeRecord: AppServerRuntime): Promise<void>;
  recordRecoveredArtifactHandles(
    sessionId: string,
    input: {
      readonly jobId: string;
      readonly provider: string;
      readonly handles: readonly ProviderArtifactHandleInput[];
    },
  ): Promise<{ readonly ok: true; readonly nextVersion: number } | { readonly ok: false }>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void;
}
