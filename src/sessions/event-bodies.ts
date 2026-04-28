// Session event body schemas + types. Cycle-break sibling: events.ts assembles
// the DomainEventRegistry (which requires reducers from projections.ts), and
// projections.ts needs the body types — keeping schemas/types here lets both
// import without the events.ts ↔ projections.ts cycle. Same precedent as
// `kb/corpus/manifest-types.ts` and `jobs/event-bodies.ts`.

import { z } from 'zod';

import { continuitySnapshotSchema } from './continuity.js';
import { sessionEntrySchema } from './entry.js';
import {
  sessionAdapterUnparseableFaultSchema,
  sessionCloseReasonSchema,
  type SessionCloseReasonInput,
  sessionInterruptedFaultSchema,
  sessionProviderFailedFaultSchema,
} from './fault.js';
import type { SessionEntry } from './entry.js';

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

export const sessionClosedBodySchema = z
  .object({
    entry: sessionEntrySchema.optional(),
    reason: sessionCloseReasonSchema,
  })
  .strict();

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

export type SessionOpenedBody = z.infer<typeof sessionOpenedBodySchema>;
export type SessionContinuityCheckpointedBody = z.infer<typeof sessionContinuityCheckpointedBodySchema>;
export type SessionInterruptedBody = z.infer<typeof sessionInterruptedBodySchema>;
export type SessionClosedBody = z.infer<typeof sessionClosedBodySchema>;
export interface SessionClosedInputBody<Scope = never> {
  entry?: SessionEntry;
  reason: SessionCloseReasonInput<Scope>;
}
export type SessionClaimedBody = z.infer<typeof sessionClaimedBodySchema>;
