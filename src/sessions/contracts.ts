import type { ProviderContinuityBlob, ContinuitySnapshot } from './continuity.js';
import type { SessionContinuityMutation } from './continuity-mutation.js';
import type { ProviderInstruction } from '../providers/contract.js';
import type { ProviderArtifactIdentity } from '../providers/artifact-identity.js';
import type {
  ClaimContinuationLeaseInput,
  ClearContinuationLeaseInput,
  RecordContinuationLeaseInput,
  RetentionPolicy,
  SessionControllerProfile,
  SessionEntry,
} from './entry.js';

export type SessionAllocateOptions = {
  provider: string;
  sessionAuthority: SessionEntry['sessionAuthority'];
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
  provider: string;
  handle: string;
  identity: ProviderArtifactIdentity;
  sourceJobId?: string;
};

export interface SessionJobReadPort {
  get(provider: string, sessionId: string): SessionEntry | null;
}

export interface SessionJobClaimPort extends SessionJobReadPort {
  releaseJob(sessionId: string, jobId: string): void;
  checkpointJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      snapshot: ContinuitySnapshot;
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

export interface SessionClaimAtomicPort {
  claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean>;
}

export interface SessionExecutionPort extends SessionClaimAtomicPort {
  allocate(options: SessionAllocateOptions): SessionEntry;
  get(provider: string, sessionId: string): SessionEntry | null;
  list(provider: string): SessionEntry[];
  releaseJob(sessionId: string, jobId: string): void;
  recordContinuationLease(input: RecordContinuationLeaseInput): void;
  claimContinuationLease(input: ClaimContinuationLeaseInput): Promise<boolean>;
  clearContinuationLease(input: ClearContinuationLeaseInput): Promise<boolean>;
}

export interface SessionWorkflowPort extends SessionClaimAtomicPort {
  allocate(options: SessionAllocateOptions): SessionEntry;
  get(provider: string, sessionId: string): SessionEntry | null;
  setNonResumable(sessionId: string): void;
  releaseJob(sessionId: string, jobId: string): void;
}

export interface SessionRecoveryPort {
  get(provider: string, sessionId: string): SessionEntry | null;
  readById(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null;
  checkpointProviderContinuity(
    sessionId: string,
    update: { providerContinuity: ProviderContinuityBlob; conversationRef?: string },
  ): void;
  setConversationRef(sessionId: string, conversationRef: string): void;
  setNonResumable(sessionId: string): void;
  releaseJob(sessionId: string, jobId: string): void;
  finalizeJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      mutation: SessionContinuityMutation;
    },
  ): Promise<boolean>;
  recordArtifactHandleAtomic(
    sessionId: string,
    options: SessionArtifactHandleRecordOptions,
  ): Promise<SessionArtifactHandleRecordResult>;
}
