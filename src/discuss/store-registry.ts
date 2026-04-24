import { z } from 'zod';

import type { CoralEventInput } from '../store/envelope.js';
import type { DomainEventRegistry } from '../store/reducers.js';
import { reduceDiscussProjection } from './projections.js';
import {
  discussEventKinds,
  type DiscussDomainEvent,
  type DiscussEventEnvelope,
  type DiscussEventKind,
} from './events.js';

export type DiscussJournalBody<K extends DiscussEventKind = DiscussEventKind> =
  DiscussEventEnvelope<K, unknown>['payload'] & {
    sourceSeq: number;
  };

const discussJournalBodySchema = z
  .object({
    sourceSeq: z.number().int().positive(),
  })
  // Preserve the live discuss payload contract while Journal ownership stays additive.
  .passthrough();

function eventType(kind: DiscussEventKind): string {
  return `discuss.${kind}`;
}

export function toJournalInput(
  domainEvent: DiscussDomainEvent,
  options: {
    namespace?: string;
    correlationId?: string;
    causationSeq?: number;
  } = {},
): CoralEventInput<DiscussJournalBody> {
  return {
    type: eventType(domainEvent.kind),
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

const types = discussEventKinds.map((kind) => eventType(kind)) as readonly string[];

export const discussRegistry: DomainEventRegistry = {
  types,
  reducers: Object.fromEntries(types.map((type) => [type, reduceDiscussProjection])) as DomainEventRegistry['reducers'],
  schemas: Object.fromEntries(types.map((type) => [type, discussJournalBodySchema])) as DomainEventRegistry['schemas'],
};
