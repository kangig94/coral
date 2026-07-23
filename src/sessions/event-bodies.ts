// Session event body schemas + types. Cycle-break sibling: events.ts assembles
// the DomainEventRegistry (which requires reducers from projections.ts), and
// projections.ts needs the body types — keeping schemas/types here lets both
// import without the events.ts ↔ projections.ts cycle. Same precedent as
// `kb/corpus/manifest-types.ts` and `jobs/event-bodies.ts`.

import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

import { causeRefSchema } from '../causality/cause-ref.js';
import { providerArtifactIdentityKey, providerArtifactIdentitySchema } from '../providers/artifact-identity.js';
import { continuitySnapshotSchema } from './continuity.js';
import {
  claimedContinuationLeaseSchema,
  clearedContinuationLeaseSchema,
  expiredContinuationLeaseSchema,
  pendingContinuationLeaseSchema,
  retentionDiscardCompletedOutcomeSchema,
  providerSessionSchema,
  providerSessionProvider,
  sessionControllerFromProfile,
} from './entry.js';
import {
  sessionAdapterUnparseableFaultSchema,
  sessionInterruptedFaultSchema,
  sessionProviderFailedFaultSchema,
} from './fault.js';

export const sessionOpenedBodySchema = z
  .object({
    entry: providerSessionSchema,
    controller: z.string().min(1),
    scope_key: z.string().min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      body.entry.state !== 'pending' ||
      body.entry.activeJobId !== undefined ||
      body.entry.conversationRef !== undefined ||
      body.entry.providerContinuity !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entry'],
        message: 'A newly opened provider session must have empty pending continuity and no active job.',
      });
    }
    if (body.controller !== sessionControllerFromProfile(body.entry.controllerProfile)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['controller'],
        message: 'Session controller must be derived from entry.controllerProfile.',
      });
    }
  })
  .describe('validate-session-opened-authority');

export const sessionContinuityCheckpointedBodySchema = z
  .object({
    entry: providerSessionSchema,
    snapshot: continuitySnapshotSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    const expected = {
      conversationRef: body.entry.conversationRef ?? null,
      resumable: body.entry.state === 'ready',
      providerContinuity: body.entry.providerContinuity ?? null,
    };
    if (!isDeepStrictEqual(body.snapshot, expected)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot'],
        message: 'Continuity snapshot must exactly describe the persisted ProviderSession entry.',
      });
    }
  })
  .describe('validate-session-continuity-snapshot');

export const sessionArtifactHandleRecordedBodySchema = z
  .object({
    entry: providerSessionSchema,
    handle: z.string().min(1),
    identity: providerArtifactIdentitySchema,
    identityKey: z.string().min(1),
    sourceJobId: z.string().min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    const expectedIdentityKey = providerArtifactIdentityKey(providerSessionProvider(body.entry), body.identity);
    if (body.identityKey !== expectedIdentityKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityKey'],
        message: 'Artifact identityKey must be derived from entry.binding.provider and identity.',
      });
    }
    const recorded = body.entry.artifactHandles.some(
      (artifact) =>
        artifact.handle === body.handle &&
        artifact.identityKey === body.identityKey &&
        artifact.sourceJobId === body.sourceJobId &&
        JSON.stringify(artifact.identity) === JSON.stringify(body.identity),
    );
    if (!recorded) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entry', 'artifactHandles'],
        message: 'Artifact event detail must identify the handle embedded in the ProviderSession entry.',
      });
    }
  })
  .describe('validate-session-artifact-handle-recording');

export const sessionInterruptedBodySchema = sessionInterruptedFaultSchema;

export const sessionProviderFailedBodySchema = sessionProviderFailedFaultSchema;
export const sessionAdapterUnparseableBodySchema = sessionAdapterUnparseableFaultSchema;

export const sessionClaimedBodySchema = z
  .object({
    entry: providerSessionSchema,
    jobId: z.string().min(1),
  })
  .strict();

export const sessionClaimReleasedBodySchema = z
  .object({
    entry: providerSessionSchema,
    jobId: z.string().min(1),
  })
  .strict();

function validateContinuationLeaseBody(
  body: { entry: { sessionId: string; continuationLease?: unknown }; sessionId: string; lease: unknown },
  ctx: z.RefinementCtx,
): void {
  if (body.sessionId !== body.entry.sessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'Continuation lease sessionId must equal entry.sessionId.',
    });
  }
  if (!isDeepStrictEqual(body.lease, body.entry.continuationLease)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lease'],
      message: 'Continuation lease detail must exactly equal entry.continuationLease.',
    });
  }
}

export const sessionContinuationLeaseRecordedBodySchema = z
  .object({
    entry: providerSessionSchema,
    sessionId: z.string().min(1),
    lease: pendingContinuationLeaseSchema,
  })
  .strict()
  .superRefine(validateContinuationLeaseBody)
  .describe('validate-recorded-continuation-lease-snapshot');

export const sessionContinuationLeaseClaimedBodySchema = z
  .object({
    entry: providerSessionSchema,
    sessionId: z.string().min(1),
    lease: claimedContinuationLeaseSchema,
  })
  .strict()
  .superRefine(validateContinuationLeaseBody)
  .describe('validate-claimed-continuation-lease-snapshot');

export const sessionContinuationLeaseClearedBodySchema = z
  .object({
    entry: providerSessionSchema,
    sessionId: z.string().min(1),
    lease: clearedContinuationLeaseSchema,
  })
  .strict()
  .superRefine(validateContinuationLeaseBody)
  .describe('validate-cleared-continuation-lease-snapshot');

export const sessionContinuationLeaseExpiredBodySchema = z
  .object({
    entry: providerSessionSchema,
    sessionId: z.string().min(1),
    lease: expiredContinuationLeaseSchema,
  })
  .strict()
  .superRefine(validateContinuationLeaseBody)
  .describe('validate-expired-continuation-lease-snapshot');

const retentionDiscardHandlesSchema = z.array(z.string()).readonly();
const retentionDiscardAttemptSchema = z.number().int().nonnegative();

export const sessionRetentionDiscardRequestedBodySchema = z
  .object({
    sessionId: z.string().min(1),
    attempt: retentionDiscardAttemptSchema,
    handles: retentionDiscardHandlesSchema,
  })
  .strict();

export const sessionRetentionDiscardCompletedBodySchema = z
  .object({
    sessionId: z.string().min(1),
    attempt: retentionDiscardAttemptSchema,
    handles: retentionDiscardHandlesSchema,
    outcome: retentionDiscardCompletedOutcomeSchema,
  })
  .strict();

export const sessionRetentionDiscardFailedBodySchema = z
  .object({
    sessionId: z.string().min(1),
    attempt: retentionDiscardAttemptSchema,
    handles: retentionDiscardHandlesSchema,
    reason: z.string(),
    causeRef: causeRefSchema.optional(),
  })
  .strict();

export type SessionOpenedBody = z.infer<typeof sessionOpenedBodySchema>;
export type SessionContinuityCheckpointedBody = z.infer<typeof sessionContinuityCheckpointedBodySchema>;
export type SessionArtifactHandleRecordedBody = z.infer<typeof sessionArtifactHandleRecordedBodySchema>;
export type SessionInterruptedBody = z.infer<typeof sessionInterruptedBodySchema>;
export type SessionClaimedBody = z.infer<typeof sessionClaimedBodySchema>;
export type SessionClaimReleasedBody = z.infer<typeof sessionClaimReleasedBodySchema>;
export type SessionContinuationLeaseRecordedBody = z.infer<typeof sessionContinuationLeaseRecordedBodySchema>;
export type SessionContinuationLeaseClaimedBody = z.infer<typeof sessionContinuationLeaseClaimedBodySchema>;
export type SessionContinuationLeaseClearedBody = z.infer<typeof sessionContinuationLeaseClearedBodySchema>;
export type SessionContinuationLeaseExpiredBody = z.infer<typeof sessionContinuationLeaseExpiredBodySchema>;
export type SessionRetentionDiscardRequestedBody = z.infer<typeof sessionRetentionDiscardRequestedBodySchema>;
export type SessionRetentionDiscardCompletedBody = z.infer<typeof sessionRetentionDiscardCompletedBodySchema>;
export type SessionRetentionDiscardFailedBody = z.infer<typeof sessionRetentionDiscardFailedBodySchema>;
