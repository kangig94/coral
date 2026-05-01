import type { CoralEventInput } from '../store/envelope.js';
import { defineDomainEvent, type DomainEventRegistry } from '../store/reducers.js';
import { reduceDiscussProjection } from './projections.js';
import {
  discussEventKinds,
  discussEventBodySchemas,
  discussEventType,
  type DiscussDomainEvent,
  type DiscussJournalBody,
} from './events.js';

export function toJournalInput(
  domainEvent: DiscussDomainEvent,
  options: {
    namespace?: string;
    correlationId?: string;
    causationSeq?: number;
  } = {},
): CoralEventInput<DiscussJournalBody> {
  return {
    type: discussEventType(domainEvent.kind),
    stream: {
      kind: 'discuss',
      id: domainEvent.sessionId,
    },
    namespace: options.namespace,
    project: domainEvent.projectRoot,
    correlationId: options.correlationId,
    causationSeq: options.causationSeq,
    refs: {
      discussSessionId: domainEvent.sessionId,
    },
    bodyVersion: 1,
    body: {
      ...domainEvent.payload,
      sourceSeq: domainEvent.seq,
    },
    tsOverride: domainEvent.ts,
  };
}

export const discussRegistry: DomainEventRegistry = {
  streamKind: 'discuss',
  entries: discussEventKinds.map((kind) =>
    defineDomainEvent({
      type: discussEventType(kind),
      schema: discussEventBodySchemas[kind],
      reducer: reduceDiscussProjection,
    }),
  ),
};
