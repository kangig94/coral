import type { ProviderValidatedContinuitySnapshot } from './continuity.js';
import type { ProviderValidatedSessionContinuityMutation } from './continuity-mutation.js';
import type { CommitContext } from '../store/append.js';
import type { ProviderInstruction } from '../providers/contract.js';
import type { ProviderArtifactIdentity } from '../providers/artifact-identity.js';
import type { ProviderBindingEnvelope } from '../infra/provider-binding-envelope.js';
import type {
  ClearContinuationLeaseInput,
  RecordContinuationLeaseInput,
  RetentionPolicy,
  SessionControllerProfile,
  ProviderSession,
} from './entry.js';

export type SessionAllocateOptions = {
  binding: ProviderBindingEnvelope;
  name: string;
  model?: string;
  cwd: string;
  projectRoot: string;
  backendNamespace: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
  retention?: RetentionPolicy;
};

export type SessionJobContinuityCheckpointResult = { ok: true; nextVersion: number } | { ok: false };
export type SessionArtifactHandleRecordResult = { ok: true; nextVersion: number } | { ok: false };

export type SessionArtifactHandleRecordOptions = {
  expectedActiveJobId: string;
  expectedVersion: number;
  handle: string;
  identity: ProviderArtifactIdentity;
  sourceJobId: string;
};

export interface SessionJobReadPort {
  get(provider: string, sessionId: string): ProviderSession | null;
}

export interface SessionJobClaimPort extends SessionJobReadPort {
  releaseJob(sessionId: string, jobId: string): void;
  checkpointJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      snapshot: ProviderValidatedContinuitySnapshot;
    },
  ): Promise<SessionJobContinuityCheckpointResult>;
  recordArtifactHandleAtomic(
    sessionId: string,
    options: SessionArtifactHandleRecordOptions,
  ): Promise<SessionArtifactHandleRecordResult>;
  releaseJobClaimAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
    },
  ): Promise<boolean>;
}

export interface SessionInitialLaunchPort {
  prepare(options: SessionAllocateOptions): ProviderSession;
  appendPreparedClaim<Scope>(commit: CommitContext<Scope>, prepared: ProviderSession, jobId: string): ProviderSession;
  appendJobClaim<Scope>(
    commit: CommitContext<Scope>,
    input: { sessionId: string; jobId: string; expectedVersion: number },
  ): ProviderSession;
  appendContinuationReplacementClaim<Scope>(
    commit: CommitContext<Scope>,
    input: {
      sessionId: string;
      staleJobId: string;
      resumedJobId: string;
      workflowId: string;
      workflowSlotId: string;
      replacementGeneration: number;
      expectedVersion: number;
    },
  ): ProviderSession;
  observeCommittedEntry(entry: ProviderSession): void;
}

export interface SessionExecutionPort extends SessionInitialLaunchPort {
  allocate(options: SessionAllocateOptions): ProviderSession;
  get(provider: string, sessionId: string): ProviderSession | null;
  list(provider: string): ProviderSession[];
  releaseJob(sessionId: string, jobId: string): void;
  recordContinuationLease(input: RecordContinuationLeaseInput): void;
  clearContinuationLease(input: ClearContinuationLeaseInput): Promise<boolean>;
}

export interface SessionRecoveryPort {
  get(provider: string, sessionId: string): ProviderSession | null;
  readById(sessionId: string, options?: { forceFresh?: boolean }): ProviderSession | null;
  releaseJob(sessionId: string, jobId: string): void;
  finalizeJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      mutation: ProviderValidatedSessionContinuityMutation;
      appendBeforeRelease?: <Scope>(commit: CommitContext<Scope>) => void;
    },
  ): Promise<boolean>;
  recordArtifactHandleAtomic(
    sessionId: string,
    options: SessionArtifactHandleRecordOptions,
  ): Promise<SessionArtifactHandleRecordResult>;
}
