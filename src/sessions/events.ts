import { z } from 'zod';

import type { DomainEventRegistry, Reducer } from '../store/reducers.js';
import { continuitySnapshotSchema } from './continuity.js';
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
  reduceSessionOpened,
  reduceSessionProviderFailed,
} from './projections.js';

export const sessionOpenedBodySchema = z
  .object({
    controller: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();

export const sessionContinuityCheckpointedBodySchema = continuitySnapshotSchema;
export const sessionInterruptedBodySchema = sessionInterruptedFaultSchema;
export const sessionProviderFailedBodySchema = sessionProviderFailedFaultSchema;
export const sessionAdapterUnparseableBodySchema = sessionAdapterUnparseableFaultSchema;
export const sessionClosedBodySchema = z
  .object({
    reason: sessionCloseReasonSchema,
  })
  .strict();

export type SessionOpenedBody = z.infer<typeof sessionOpenedBodySchema>;
export type SessionContinuityCheckpointedBody = z.infer<typeof sessionContinuityCheckpointedBodySchema>;
export type SessionInterruptedBody = z.infer<typeof sessionInterruptedBodySchema>;
export type SessionProviderFailedBody = z.infer<typeof sessionProviderFailedBodySchema>;
export type SessionAdapterUnparseableBody = z.infer<typeof sessionAdapterUnparseableBodySchema>;
export type SessionClosedBody = z.infer<typeof sessionClosedBodySchema>;

export const sessionsRegistry: DomainEventRegistry = {
  types: [
    'session.opened',
    'session.continuity.checkpointed',
    'session.interrupted',
    'session.provider_failed',
    'session.adapter_unparseable',
    'session.closed',
  ],
  reducers: {
    'session.opened': reduceSessionOpened as Reducer<unknown>,
    'session.continuity.checkpointed': reduceSessionContinuityCheckpointed as Reducer<unknown>,
    'session.interrupted': reduceSessionInterrupted as Reducer<unknown>,
    'session.provider_failed': reduceSessionProviderFailed as Reducer<unknown>,
    'session.adapter_unparseable': reduceSessionAdapterUnparseable as Reducer<unknown>,
    'session.closed': reduceSessionClosed as Reducer<unknown>,
  },
  schemas: {
    'session.opened': sessionOpenedBodySchema,
    'session.continuity.checkpointed': sessionContinuityCheckpointedBodySchema,
    'session.interrupted': sessionInterruptedBodySchema,
    'session.provider_failed': sessionProviderFailedBodySchema,
    'session.adapter_unparseable': sessionAdapterUnparseableBodySchema,
    'session.closed': sessionClosedBodySchema,
  },
};
