import { z } from 'zod';

import { causeRefSchema } from '../../causality/cause-ref.js';
import { providerArtifactIdentitySchema } from '../../providers/artifact-identity.js';
import type { JobConversationFacet } from '../launch.js';
import type { ProviderContinuityBlob } from './continuity.js';

export const retentionPolicySchema = z.enum(['retain', 'discard_provider_artifacts_on_terminal']);
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const providerArtifactHandleSchema = z
  .object({
    handle: z.string().min(1),
    identity: providerArtifactIdentitySchema,
    identityKey: z.string().min(1),
    execution: z.number().int().positive().safe(),
    sourceJobId: z.string().min(1),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type ProviderArtifactHandle = z.infer<typeof providerArtifactHandleSchema>;

export const retentionDiscardCompletedOutcomeSchema = z.enum([
  'discarded',
  'skipped_no_handles',
  'provider_declares_none',
]);

export const retentionDiscardAttemptSchema = z
  .object({
    execution: z.number().int().positive().safe(),
    attempt: z.number().int().nonnegative().safe(),
    handles: z.array(z.string()).readonly(),
    status: z.enum(['requested', 'completed', 'failed']),
    outcome: retentionDiscardCompletedOutcomeSchema.optional(),
    reason: z.string().optional(),
    causeRef: causeRefSchema.optional(),
  })
  .strict();
export type RetentionDiscardAttempt = z.infer<typeof retentionDiscardAttemptSchema>;

export type ConversationControllerId = string;
export const CONVERSATION_CONTROLLER_PROFILE_FIELDS = ['owner', 'effort', 'claudeModelCap'] as const;
export type ConversationControllerProfile = NonNullable<JobConversationFacet['controllerProfile']>;

export interface JobConversation extends JobConversationFacet {
  readonly jobId: string;
  readonly execution: number;
  readonly open: boolean;
  readonly finishing: boolean;
  readonly conversationRef?: string;
  readonly providerContinuity: ProviderContinuityBlob | null;
  readonly artifactHandles: readonly ProviderArtifactHandle[];
  readonly retentionDiscard: { readonly attempts: readonly RetentionDiscardAttempt[] };
  readonly projectRoot: string;
  readonly backendNamespace: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export function jobConversationProvider(conversation: Pick<JobConversation, 'binding'>): string {
  return conversation.binding.provider;
}

export function conversationControllerFromProfile(profile?: ConversationControllerProfile): ConversationControllerId {
  const owner = profile?.owner ?? 'default';
  return owner.length === 0 ? 'default' : owner;
}

export function hasUnterminalRetentionDiscardRequest(
  entry: Pick<JobConversation, 'retentionDiscard' | 'execution'>,
): boolean {
  return entry.retentionDiscard.attempts.some(
    (attempt) => attempt.execution === entry.execution && attempt.status === 'requested',
  );
}
