// Session event body schemas + types. Cycle-break sibling: events.ts assembles
// the DomainEventRegistry (which requires reducers from projections.ts), and
// projections.ts needs the body types — keeping schemas/types here lets both
// import without the events.ts ↔ projections.ts cycle. Same precedent as
// `kb/corpus/manifest-types.ts` and `jobs/event-bodies.ts`.

import { z } from 'zod';

import { causeRefSchema } from '../causality/cause-ref.js';
import { continuitySnapshotSchema } from './continuity.js';
import { retentionDiscardCompletedOutcomeSchema, sessionEntrySchema } from './entry.js';
import {
  sessionAdapterUnparseableFaultSchema,
  sessionInterruptedFaultSchema,
  sessionProviderFailedFaultSchema,
} from './fault.js';

export const sessionOpenedBodySchema = z
  .object({
    entry: sessionEntrySchema,
    controller: z.string().min(1),
    provider: z.string().min(1),
    scope_key: z.string().min(1),
  })
  .strict();

export const sessionContinuityCheckpointedBodySchema = z
  .object({
    entry: sessionEntrySchema,
    snapshot: continuitySnapshotSchema,
  })
  .strict();

export const sessionArtifactHandleRecordedBodySchema = z
  .object({
    entry: sessionEntrySchema,
    provider: z.string().min(1),
    handle: z.string().min(1),
    sourceJobId: z.string().min(1).optional(),
  })
  .strict();

export const sessionInterruptedBodySchema = z.union([
  sessionInterruptedFaultSchema,
  z
    .object({
      entry: sessionEntrySchema.optional(),
      fault: sessionInterruptedFaultSchema,
    })
    .strict(),
]);

export const sessionProviderFailedBodySchema = sessionProviderFailedFaultSchema;
export const sessionAdapterUnparseableBodySchema = sessionAdapterUnparseableFaultSchema;

export const sessionClaimedBodySchema = z
  .object({
    entry: sessionEntrySchema,
    jobId: z.string().min(1),
  })
  .strict();

export const sessionClaimReleasedBodySchema = z
  .object({
    entry: sessionEntrySchema,
    jobId: z.string().min(1),
  })
  .strict();

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
export type SessionRetentionDiscardRequestedBody = z.infer<typeof sessionRetentionDiscardRequestedBodySchema>;
export type SessionRetentionDiscardCompletedBody = z.infer<typeof sessionRetentionDiscardCompletedBodySchema>;
export type SessionRetentionDiscardFailedBody = z.infer<typeof sessionRetentionDiscardFailedBodySchema>;
