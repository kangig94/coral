import { z } from 'zod';

import type { DomainEventRegistry, Reducer } from '../store/reducers.js';
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
  types: [
    'session.opened',
    'session.continuity.checkpointed',
    'session.claimed',
    'session.claim.released',
    'session.interrupted',
    'session.provider_failed',
    'session.adapter_unparseable',
    'session.closed',
  ],
  reducers: {
    'session.opened': reduceSessionOpened as Reducer<unknown>,
    'session.continuity.checkpointed': reduceSessionContinuityCheckpointed as Reducer<unknown>,
    'session.claimed': reduceSessionClaimed as Reducer<unknown>,
    'session.claim.released': reduceSessionClaimReleased as Reducer<unknown>,
    'session.interrupted': reduceSessionInterrupted as Reducer<unknown>,
    'session.provider_failed': reduceSessionProviderFailed as Reducer<unknown>,
    'session.adapter_unparseable': reduceSessionAdapterUnparseable as Reducer<unknown>,
    'session.closed': reduceSessionClosed as Reducer<unknown>,
  },
  schemas: {
    'session.opened': sessionOpenedBodySchema,
    'session.continuity.checkpointed': sessionContinuityCheckpointedBodySchema,
    'session.claimed': sessionClaimedBodySchema,
    'session.claim.released': sessionClaimReleasedBodySchema,
    'session.interrupted': sessionInterruptedBodySchema,
    'session.provider_failed': sessionProviderFailedBodySchema,
    'session.adapter_unparseable': sessionAdapterUnparseableBodySchema,
    'session.closed': sessionClosedBodySchema,
  },
};
