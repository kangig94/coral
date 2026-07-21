import { z } from 'zod';

import { causeRefSchema } from '../causality/cause-ref.js';
import { providerInstructionSchema, type ProviderInstruction } from '../providers/contract.js';
import { providerArtifactIdentityKey, providerArtifactIdentitySchema } from '../providers/artifact-identity.js';
import {
  providerCredentialSourceRefSchema,
  type ProviderCredentialSourceRef,
} from '../runtime/provider-credentials.js';
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
    provider: z.string().min(1),
    handle: z.string().min(1),
    identity: providerArtifactIdentitySchema,
    identityKey: z.string().min(1).optional(),
    sourceJobId: z.string().min(1).optional(),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .transform((artifact) => {
    const identity = artifact.identity;
    return {
      ...artifact,
      identity,
      identityKey: artifact.identityKey ?? providerArtifactIdentityKey(artifact.provider, identity),
    };
  });

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
    attempts: z.array(retentionDiscardAttemptSchema).default([]).readonly(),
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
    reason: continuationLeaseReasonSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export type RecordContinuationLeaseInput = z.infer<typeof recordContinuationLeaseInputSchema>;

export const claimContinuationLeaseInputSchema = z
  .object({
    sessionId: z.string().min(1),
    staleJobId: z.string().min(1),
    resumedJobId: z.string().min(1),
  })
  .strict();

export type ClaimContinuationLeaseInput = z.infer<typeof claimContinuationLeaseInputSchema>;

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
  .passthrough()
  .transform((profile) => ({
    ...(profile.owner !== undefined ? { owner: profile.owner } : {}),
    ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
    ...(profile.claudeModelCap !== undefined ? { claudeModelCap: profile.claudeModelCap } : {}),
  }));

export type SessionControllerProfile = z.infer<typeof sessionControllerProfileSchema>;

export type SessionAuthority = { kind: 'provider'; source: ProviderCredentialSourceRef } | { kind: 'orchestration' };

export const sessionAuthoritySchema = z.union([
  z.object({ kind: z.literal('provider'), source: providerCredentialSourceRefSchema }).strict(),
  z.object({ kind: z.literal('orchestration') }).strict(),
]);

export interface SessionEntry {
  sessionId: string;
  provider: string;
  sessionAuthority: SessionAuthority;
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

export const sessionEntrySchema = z
  .object({
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    sessionAuthority: sessionAuthoritySchema,
    name: z.string().min(1),
    state: sessionStateSchema,
    retention: retentionPolicySchema.default('retain'),
    artifactHandles: z.array(providerArtifactHandleSchema).default([]).readonly(),
    retentionDiscard: retentionDiscardStateSchema.default({ attempts: [] }),
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
  .strict();

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

export function hasUnterminalRetentionDiscardRequest(entry: Pick<SessionEntry, 'retentionDiscard'>): boolean {
  return entry.retentionDiscard.attempts.some((attempt) => attempt.status === 'requested');
}
