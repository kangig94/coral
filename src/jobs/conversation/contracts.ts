import type { ProviderValidatedContinuitySnapshot } from './continuity.js';
import type { ProviderInstruction } from '../../providers/contract.js';
import type { ProviderArtifactIdentity } from '../../providers/artifact-identity.js';
import type { ProviderBindingEnvelope } from '../../infra/provider-binding-envelope.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { JobConversation, RetentionPolicy, ConversationControllerProfile } from './entry.js';

export type ConversationAllocateOptions = {
  jobId?: string;
  binding: ProviderBindingEnvelope;
  name: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  cwd: CanonicalWorkDir;
  projectRoot: string;
  backendNamespace: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: ConversationControllerProfile;
  retention?: RetentionPolicy;
};

export type ConversationWriteResult = { ok: true; execution: number } | { ok: false };
export type ConversationArtifactHandleRecordOptions = {
  execution: number;
  handle: string;
  identity: ProviderArtifactIdentity;
};

export interface ConversationReadPort {
  get(provider: string, jobId: string): JobConversation | null;
}

export interface ConversationContinuityPort extends ConversationReadPort {
  checkpointJobContinuityAtomic(
    jobId: string,
    options: {
      execution: number;
      snapshot: ProviderValidatedContinuitySnapshot;
    },
  ): Promise<ConversationWriteResult>;
  recordArtifactHandleAtomic(
    jobId: string,
    options: ConversationArtifactHandleRecordOptions,
  ): Promise<ConversationWriteResult>;
}

export interface ConversationInitialLaunchPort {
  prepare(options: ConversationAllocateOptions): JobConversation;
  readById(jobId: string): JobConversation | null;
}

export interface ConversationExecutionPort extends ConversationInitialLaunchPort, ConversationReadPort {
  list(provider: string): JobConversation[];
}

export interface ConversationRecoveryPort extends ConversationContinuityPort {
  readById(jobId: string): JobConversation | null;
}
