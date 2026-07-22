import type { AppServerRuntime, JobLaunch, JobRuntime, JobTerminalInput } from '../records.js';
import type { JobPhase } from '../phase.js';
import type { TerminalWriteOptions } from '../contracts/job-store.js';
import type { ProviderArtifactHandleInput } from '../../providers/contract.js';
import type { ProviderArtifactIdentity } from '../../providers/artifact-identity.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { LaunchPool } from '../contracts/admission.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';

export type ProviderRecoveryLaunch = JobLaunch & {
  readonly sessionId: string;
  readonly provider: string;
  readonly jobKind: 'provider';
};

/** The minimal captured session facts required after recovery authority validation. */
export type ProviderRecoverySession = Readonly<{
  sessionId: string;
  projectRoot: string;
  conversationRef?: string;
  providerContinuity: ProviderContinuityBlob | null;
  artifactHandles: readonly Readonly<{
    handle: string;
    identity: ProviderArtifactIdentity;
    sourceJobId: string;
  }>[];
  version: number;
}>;

export type ProviderRecoveryAuthority = Readonly<{
  launchRecord: ProviderRecoveryLaunch;
  session: ProviderRecoverySession;
  boundProvider: BoundProvider;
}>;

export interface RecoveryCapableService {
  captureProviderRecoveryAuthority(launchRecord: JobLaunch): Promise<ProviderRecoveryAuthority | null>;
  finalizeInterruptedAppServerJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: JobRuntime,
  ): Promise<{ adopted: boolean; cleanup: () => void }>;
  recoverQueuedJob(authority: ProviderRecoveryAuthority): Promise<string>;
  interruptAppServerJob(authority: ProviderRecoveryAuthority, runtimeRecord: AppServerRuntime): Promise<void>;
  recordRecoveredArtifactHandles(
    sessionId: string,
    input: {
      readonly jobId: string;
      readonly handles: readonly ProviderArtifactHandleInput[];
    },
  ): Promise<{ readonly ok: true; readonly nextVersion: number } | { readonly ok: false }>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions & { pool: LaunchPool; sessionContinuity?: ContinuitySnapshot | null },
  ): void;
}
