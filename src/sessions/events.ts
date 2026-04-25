import { z } from 'zod';

import { defineDomainEvent, type DomainEventRegistry } from '../store/reducers.js';
import { continuitySnapshotSchema } from './continuity.js';
import { sessionEntrySchema } from './entry.js';
import {
  sessionAdapterUnparseableFaultSchema,
  sessionCloseReasonSchema,
  sessionInterruptedFaultSchema,
  sessionProviderFailedFaultSchema,
} from './fault.js';
import {
  reduceSessionAdapterUnparseable,
  reduceSessionClosed,
  reduceSessionContinuityCheckpointed,
  reduceSessionInterrupted,
  reduceSessionClaimReleased,
  reduceSessionClaimed,
  reduceSessionOpened,
  reduceSessionProviderFailed,
} from './projections.js';

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
export type SessionProviderFailedBody = z.infer<typeof sessionProviderFailedBodySchema>;
export type SessionAdapterUnparseableBody = z.infer<typeof sessionAdapterUnparseableBodySchema>;
export type SessionClosedBody = z.infer<typeof sessionClosedBodySchema>;
export type SessionClaimedBody = z.infer<typeof sessionClaimedBodySchema>;
export type SessionClaimReleasedBody = z.infer<typeof sessionClaimReleasedBodySchema>;

export const sessionsRegistry: DomainEventRegistry = {
  entries: [
    defineDomainEvent({ type: 'session.opened', schema: sessionOpenedBodySchema, reducer: reduceSessionOpened }),
    defineDomainEvent({
      type: 'session.continuity.checkpointed',
      schema: sessionContinuityCheckpointedBodySchema,
      reducer: reduceSessionContinuityCheckpointed,
    }),
    defineDomainEvent({ type: 'session.claimed', schema: sessionClaimedBodySchema, reducer: reduceSessionClaimed }),
    defineDomainEvent({
      type: 'session.claim.released',
      schema: sessionClaimReleasedBodySchema,
      reducer: reduceSessionClaimReleased,
    }),
    defineDomainEvent({ type: 'session.interrupted', schema: sessionInterruptedBodySchema, reducer: reduceSessionInterrupted }),
    defineDomainEvent({
      type: 'session.provider_failed',
      schema: sessionProviderFailedBodySchema,
      reducer: reduceSessionProviderFailed,
    }),
    defineDomainEvent({
      type: 'session.adapter_unparseable',
      schema: sessionAdapterUnparseableBodySchema,
      reducer: reduceSessionAdapterUnparseable,
    }),
    defineDomainEvent({ type: 'session.closed', schema: sessionClosedBodySchema, reducer: reduceSessionClosed }),
  ],
};
