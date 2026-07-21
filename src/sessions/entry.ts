import { z } from 'zod';

import { causeRefSchema } from '../causality/cause-ref.js';
import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import { providerArtifactIdentityKey, providerArtifactIdentitySchema } from '../providers/artifact-identity.js';
import { providerBindingEnvelopeSchema, type ProviderBindingEnvelope } from '../infra/provider-binding-envelope.js';
import { continuityRefSchema, type ProviderContinuityBlob } from './continuity.js';

const sessionStateSchema = z.enum(['pending', 'ready', 'non_resumable']);

type SessionState = z.infer<typeof sessionStateSchema>;

export const retentionPolicySchema = z
  .enum(['retain', 'discard_provider_artifacts_on_terminal'])
  .describe(
    'Controls whether provider session files (e.g. ~/.claude/projects/.../*.jsonl) are deleted when the session ends',
  );

export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

const providerArtifactHandleSchema = z
  .object({
    handle: z.string().min(1),
    identity: providerArtifactIdentitySchema,
    identityKey: z.string().min(1),
    sourceJobId: z.string().min(1),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .describe('provider-artifact-handle');

export type ProviderArtifactHandle = z.infer<typeof providerArtifactHandleSchema>;

export const retentionDiscardCompletedOutcomeSchema = z.enum([
  'discarded',
  'skipped_no_handles',
  'provider_declares_none',
  'skipped_protected',
]);

export type RetentionDiscardCompletedOutcome = z.infer<typeof retentionDiscardCompletedOutcomeSchema>;

const retentionDiscardAttemptSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    handles: z.array(z.string()).readonly(),
    status: z.enum(['requested', 'completed', 'failed']),
    outcome: retentionDiscardCompletedOutcomeSchema.optional(),
    reason: z.string().optional(),
    causeRef: causeRefSchema.optional(),
  })
  .strict();

export type RetentionDiscardAttempt = z.infer<typeof retentionDiscardAttemptSchema>;

const retentionDiscardStateSchema = z
  .object({
    attempts: z.array(retentionDiscardAttemptSchema).readonly(),
  })
  .strict();

type RetentionDiscardState = z.infer<typeof retentionDiscardStateSchema>;

const continuationLeaseReasonSchema = z.enum(['stale_recovery']);

const continuationLeaseClearOutcomeSchema = z.enum([
  'resume_rejected',
  'launch_failed',
  'resumed_released',
  'explicit_clear',
]);

const continuationLeaseBaseSchema = z
  .object({
    staleJobId: z.string().min(1),
    workflowId: z.string().min(1),
    workflowSlotId: z.string().min(1),
    replacementGeneration: z.number().int().positive(),
    reason: continuationLeaseReasonSchema,
    expiresAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
  })
  .strict();

export const pendingContinuationLeaseSchema = continuationLeaseBaseSchema.extend({
  status: z.literal('pending'),
});

export const claimedContinuationLeaseSchema = continuationLeaseBaseSchema.extend({
  status: z.literal('claimed'),
  resumedJobId: z.string().min(1),
  claimedAt: z.string().datetime(),
});

export const clearedContinuationLeaseSchema = continuationLeaseBaseSchema.extend({
  status: z.literal('cleared'),
  resumedJobId: z.string().min(1).optional(),
  claimedAt: z.string().datetime().optional(),
  clearedAt: z.string().datetime(),
  clearedByJobId: z.string().min(1),
  outcome: continuationLeaseClearOutcomeSchema,
});

export const expiredContinuationLeaseSchema = continuationLeaseBaseSchema.extend({
  status: z.literal('expired'),
  expiredAt: z.string().datetime(),
});

const sessionContinuationLeaseSchema = z.discriminatedUnion('status', [
  pendingContinuationLeaseSchema,
  claimedContinuationLeaseSchema,
  clearedContinuationLeaseSchema,
  expiredContinuationLeaseSchema,
]);

export type PendingContinuationLease = z.infer<typeof pendingContinuationLeaseSchema>;
export type ClaimedContinuationLease = z.infer<typeof claimedContinuationLeaseSchema>;
export type ClearedContinuationLease = z.infer<typeof clearedContinuationLeaseSchema>;
export type ExpiredContinuationLease = z.infer<typeof expiredContinuationLeaseSchema>;
export type SessionContinuationLease = z.infer<typeof sessionContinuationLeaseSchema>;

export const recordContinuationLeaseInputSchema = z
  .object({
    sessionId: z.string().min(1),
    jobId: z.string().min(1),
    workflowId: z.string().min(1),
    workflowSlotId: z.string().min(1),
    replacementGeneration: z.number().int().positive(),
    reason: continuationLeaseReasonSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export type RecordContinuationLeaseInput = z.infer<typeof recordContinuationLeaseInputSchema>;

export const clearContinuationLeaseInputSchema = z
  .object({
    sessionId: z.string().min(1),
    jobId: z.string().min(1),
    outcome: continuationLeaseClearOutcomeSchema,
  })
  .strict();

export type ClearContinuationLeaseInput = z.infer<typeof clearContinuationLeaseInputSchema>;

/** Identifier string for the session controller selecting per-session
 * provider continuity defaults. Distinct from the in-process
 * `SingleSessionController` class in `providers/claude/appserver/` — that
 * one orchestrates the live turn lifecycle, this one just names the
 * profile. */
export type SessionControllerId = string;

const DEFAULT_SESSION_CONTROLLER: SessionControllerId = 'default';
export const SESSION_CONTROLLER_PROFILE_FIELDS = ['owner', 'effort', 'claudeModelCap'] as const;

const sessionControllerProfileSchema = z
  .object({
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
  })
  .strict();

export type SessionControllerProfile = z.infer<typeof sessionControllerProfileSchema>;

export interface ProviderSession {
  sessionId: string;
  binding: ProviderBindingEnvelope;
  name: string;
  state: SessionState;
  retention: RetentionPolicy;
  artifactHandles: readonly ProviderArtifactHandle[];
  retentionDiscard: RetentionDiscardState;
  continuationLease?: SessionContinuationLease;
  activeJobId?: string;
  conversationRef?: string;
  providerContinuity: ProviderContinuityBlob | null;
  model?: string;
  cwd: string;
  projectRoot: string;
  backendNamespace: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
  createdAt: string;
  lastUsedAt: string;
  version: number;
}

export const providerSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    binding: providerBindingEnvelopeSchema,
    name: z.string().min(1),
    state: sessionStateSchema,
    retention: retentionPolicySchema,
    artifactHandles: z.array(providerArtifactHandleSchema).readonly(),
    retentionDiscard: retentionDiscardStateSchema,
    continuationLease: sessionContinuationLeaseSchema.optional(),
    activeJobId: z.string().min(1).optional(),
    conversationRef: continuityRefSchema.optional(),
    providerContinuity: z.record(z.unknown()).nullable(),
    model: z.string().optional(),
    cwd: z.string(),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    agentName: z.string().optional(),
    instruction: providerInstructionSchema.optional(),
    bypassPermissions: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    controllerProfile: sessionControllerProfileSchema.optional(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((session, ctx) => {
    for (const [index, artifact] of session.artifactHandles.entries()) {
      const expected = providerArtifactIdentityKey(session.binding.provider, artifact.identity);
      if (artifact.identityKey !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifactHandles', index, 'identityKey'],
          message: 'Artifact identityKey must be derived from binding.provider and identity.',
        });
      }
    }
  })
  .describe('validate-provider-session-artifact-identity-keys');

/** The provider owning a conversation is defined solely by its durable binding. */
export function providerSessionProvider(session: Pick<ProviderSession, 'binding'>): string {
  return session.binding.provider;
}

export function sessionControllerFromProfile(profile?: SessionControllerProfile): SessionControllerId {
  if (typeof profile?.owner === 'string' && profile.owner.length > 0) {
    return profile.owner;
  }
  return DEFAULT_SESSION_CONTROLLER;
}

export function isProtectiveContinuationLease(lease: SessionContinuationLease | undefined, nowMs: number): boolean {
  if (lease === undefined) {
    return false;
  }
  switch (lease.status) {
    case 'pending':
      return Date.parse(lease.expiresAt) > nowMs;
    case 'claimed':
      return true;
    case 'cleared':
    case 'expired':
      return false;
  }
}

export function hasUnterminalRetentionDiscardRequest(entry: Pick<ProviderSession, 'retentionDiscard'>): boolean {
  return entry.retentionDiscard.attempts.some((attempt) => attempt.status === 'requested');
}
