import type { ProviderContinuityBlob, ContinuitySnapshot } from './continuity.js';
import type { SessionContinuityMutation } from './continuity-mutation.js';
import type { ProviderInstruction } from '../providers/contract.js';
import type { SessionControllerProfile, SessionEntry } from './entry.js';

export type SessionAllocateOptions = {
  provider: string;
  name: string;
  model?: string;
  cwd: string;
  projectRoot: string;
  coordinatorNamespace: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
};

export type SessionJobContinuityCheckpointResult =
  | { ok: true; nextVersion: number }
  | { ok: false };

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
}

export interface SessionWorkflowPort extends SessionClaimAtomicPort {
  allocate(options: SessionAllocateOptions): SessionEntry;
  get(provider: string, sessionId: string): SessionEntry | null;
  setNonResumable(sessionId: string): void;
  releaseJob(sessionId: string, jobId: string): void;
}

export interface SessionRecoveryPort {
  get(provider: string, sessionId: string): SessionEntry | null;
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
}
