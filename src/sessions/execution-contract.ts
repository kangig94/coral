import type { ProviderContinuityBlob } from './continuity.js';
import type { SessionContinuityMutation } from './continuity-mutation.js';
import type { SessionAllocateOptions } from './allocation-contract.js';
import type { SessionEntry } from './entry.js';

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
