import { defineDomainEvent, type DomainEventRegistry } from '../store/reducers.js';
import {
  sessionAdapterUnparseableBodySchema,
  sessionClaimReleasedBodySchema,
  sessionClaimedBodySchema,
  sessionContinuityCheckpointedBodySchema,
  sessionInterruptedBodySchema,
  sessionOpenedBodySchema,
  sessionProviderFailedBodySchema,
} from './event-bodies.js';
import {
  reduceSessionAdapterUnparseable,
  reduceSessionContinuityCheckpointed,
  reduceSessionInterrupted,
  reduceSessionClaimReleased,
  reduceSessionClaimed,
  reduceSessionOpened,
  reduceSessionProviderFailed,
} from './projections.js';

export const sessionsRegistry: DomainEventRegistry = {
  streamKind: 'session',
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
    defineDomainEvent({
      type: 'session.interrupted',
      schema: sessionInterruptedBodySchema,
      reducer: reduceSessionInterrupted,
    }),
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
  ],
};
