import { z } from 'zod';

import { CoralSetupError } from '../runtime/errors.js';
import { decodeEventBody } from './body-codec.js';
import type { EventsRow } from './schema.js';
export { UpcasterRegistry, createEmptyRegistry } from './upcaster-registry.js';

const journalEventRefsSchema = z
  .object({
    jobId: z.string().optional(),
    sessionId: z.string().optional(),
    parentJobId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowSlotId: z.string().optional(),
    discussSessionId: z.string().optional(),
    kbRefs: z
      .array(
        z
          .object({
            entryId: z.string(),
            contentHash: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const journalEventEnvelopeSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: z.string().datetime(),
    type: z.string(),
    stream: z
      .object({
        kind: z.enum(['job', 'session', 'discuss', 'workflow']),
        id: z.string().min(1),
      })
      .strict(),
    namespace: z.string().optional(),
    project: z.string().optional(),
    correlationId: z.string().optional(),
    causationSeq: z.number().optional(),
    refs: journalEventRefsSchema.optional(),
    bodyVersion: z.number().int().positive(),
    body: z.unknown(),
  })
  .strict();

export const journalEventInputSchema = journalEventEnvelopeSchema
  .omit({
    seq: true,
    ts: true,
  })
  .extend({
    tsOverride: z.string().datetime().optional(),
  })
  .strict();

type EventEnvelopeShape = z.infer<typeof journalEventEnvelopeSchema>;
export type StreamKind = EventEnvelopeShape['stream']['kind'];

export interface CoralEvent<T = unknown> extends Omit<EventEnvelopeShape, 'body'> {
  body: T;
}

export interface CoralEventInput<T = unknown> extends Omit<CoralEvent<T>, 'seq' | 'ts'> {
  tsOverride?: string;
}

export const STREAM_KINDS: ReadonlySet<StreamKind> = new Set(['job', 'session', 'discuss', 'workflow']);

export function assertStreamKind(value: string): StreamKind {
  if (!STREAM_KINDS.has(value as StreamKind)) {
    throw new CoralSetupError({
      code: 'event_stream_kind_invalid',
      userMessage: `Unknown stream.kind in events row: '${value}'`,
      remediation: 'A schema update likely introduced a new stream kind. Update the enum in src/store/envelope.ts and the assertStreamKind guard.',
      context: { streamKind: value },
    });
  }

  return value as StreamKind;
}

export function rowToCoralEvent<T = unknown>(row: EventsRow, body: T = decodeEventBody(row.body) as T): CoralEvent<T> {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    stream: { kind: assertStreamKind(row.stream_kind), id: row.stream_id },
    namespace: row.namespace ?? undefined,
    project: row.project ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationSeq: row.causation_seq ?? undefined,
    refs: row.refs ? JSON.parse(row.refs) : undefined,
    bodyVersion: row.body_version,
    body,
  };
}
