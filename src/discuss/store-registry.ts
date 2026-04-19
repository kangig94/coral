import { z } from 'zod';

import type { CoralEventInput } from '../store/envelope.js';
import type { DomainEventRegistry as StoreDomainEventRegistry } from '../store/reducers.js';
import { reduceDiscussProjection } from './projections.js';
import {
  discussEventKinds,
  type DiscussDomainEvent,
  type DiscussEventEnvelope,
  type DiscussEventKind,
} from './events.js';

export type DiscussJournalBody<K extends DiscussEventKind = DiscussEventKind> =
  DiscussEventEnvelope<K, unknown>['payload'] & {
    legacySeq: number;
  };

const discussJournalBodySchema = z
  .object({
    legacySeq: z.number().int().positive(),
  })
  // Preserve the Phase 1 live discuss payload contract while Journal ownership stays additive.
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
      legacySeq: domainEvent.seq,
    },
    tsOverride: domainEvent.ts,
  };
}

const types = discussEventKinds.map((kind) => eventType(kind)) as readonly string[];

export const DomainEventRegistry: StoreDomainEventRegistry = {
  types,
  reducers: Object.fromEntries(types.map((type) => [type, reduceDiscussProjection])) as StoreDomainEventRegistry['reducers'],
  schemas: Object.fromEntries(types.map((type) => [type, discussJournalBodySchema])) as StoreDomainEventRegistry['schemas'],
};

export const discussRegistry = DomainEventRegistry;
