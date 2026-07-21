import type { CoralEventInput } from '../store/envelope.js';
import { CoralSetupError } from '../runtime/errors.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
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

const validateDiscussCreation: DomainAppendValidator = (ctx, inputs) => {
  const created = new Map<string, boolean>();
  for (const input of inputs) {
    if (input.stream.kind !== 'discuss') continue;
    let exists = created.get(input.stream.id);
    exists ??=
      ctx.db
        .prepare<
          [string],
          { found: number }
        >("SELECT 1 AS found FROM events WHERE stream_kind = 'discuss' AND stream_id = ? AND type = 'discuss.session.created' LIMIT 1")
        .get(input.stream.id) !== undefined;
    const isCreate = input.type === 'discuss.session.created';
    if (!exists && !isCreate) {
      throw new CoralSetupError({
        code: 'provider_credential_source_missing',
        userMessage: `Discuss session '${input.stream.id}' must be created before later events.`,
        remediation: 'Append discuss.session.created first in the same batch.',
      });
    }
    if (exists && isCreate) {
      throw new CoralSetupError({
        code: 'provider_credential_source_invalid',
        userMessage: `Discuss session '${input.stream.id}' is already created.`,
        remediation: 'Do not append a second discuss.session.created event.',
      });
    }
    created.set(input.stream.id, exists || isCreate);
  }
};

export const discussRegistry: DomainEventRegistry = {
  streamKind: 'discuss',
  entries: discussEventKinds.map((kind) =>
    defineDomainEvent({
      type: discussEventType(kind),
      schema: discussEventBodySchemas[kind],
      reducer: reduceDiscussProjection,
    }),
  ),
  appendValidators: [validateDiscussCreation],
};
