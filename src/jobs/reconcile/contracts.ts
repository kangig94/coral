import type { AppServerRuntime, JobLaunch, JobRuntime, JobTerminal, JobTerminalInput } from '../records.js';
import type { JobPhase } from '../phase.js';
import type { TerminalWriteOptions } from '../contracts/job-store.js';
import type { ProviderArtifactIdentity } from '../../providers/artifact-identity.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { LaunchPool } from '../contracts/admission.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { ProviderBindingFailure } from '../../providers/contracts/binding.js';

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

export type RecoveryCommitFence = Readonly<{
  signal: AbortSignal;
  onCommitStart(): void;
}>;

export type ProviderRecoveryAuthorityCapture =
  | Readonly<{ ok: true; authority: ProviderRecoveryAuthority }>
  | Readonly<{ ok: false; failure: ProviderBindingFailure }>;

export interface RecoveryCapableService {
  captureProviderRecoveryAuthority(launchRecord: JobLaunch): Promise<ProviderRecoveryAuthorityCapture>;
  finalizeProviderRecoveryBindingFailure(launchRecord: JobLaunch, failure: ProviderBindingFailure): void;
  finalizeInterruptedAppServerJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' } & RecoveryCommitFence,
  ): Promise<void>;
  finalizeInterruptedDurableJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: DurableCliRuntimeRecord,
    observation: Readonly<{
      exit: DurableProcessExit | null;
      terminal: JobTerminal | null;
      cancelled: boolean;
    }>,
    fence: RecoveryCommitFence,
  ): Promise<void>;
  adoptRunningJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: JobRuntime,
  ): Promise<{ adopted: boolean; cleanup: () => void }>;
  recoverQueuedJob(authority: ProviderRecoveryAuthority): Promise<string>;
  interruptAppServerJob(authority: ProviderRecoveryAuthority, runtimeRecord: AppServerRuntime): Promise<void>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions & { pool: LaunchPool },
  ): void;
}
