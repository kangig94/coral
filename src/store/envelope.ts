import { z } from 'zod';

import { CoralSetupError } from '../runtime/errors.js';
import { decodeEventJson } from './body-codec.js';
import type { EventsRow } from './schema.js';
import type { CauseRefToken } from '../causality/cause-ref.js';

declare const RESOLVABLE_INPUT_SCOPE: unique symbol;

export const journalEventRefsSchema = z
  .object({
    jobId: z.string().optional(),
    sessionId: z.string().optional(),
    parentJobId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowSlotId: z.string().optional(),
    discussSessionId: z.string().optional(),
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
    bodyVersion: z.number().int().min(1).max(1),
    body: z.unknown(),
  })
  .strict();

/**
 * `tsOverride` lets a producer supply a historical timestamp for an event —
 * used by discuss restoration, which replays bids/speeches from an external
 * archive at their original wall-clock time.
 *
 * `ts` is **informational only**. It is NOT monotone w.r.t. `seq`: a producer
 * setting `tsOverride` to a value earlier than `MAX(ts)` is permitted by
 * design. The substrate enforces strict monotonicity on `seq` (coordinator
 * reservation under BEGIN IMMEDIATE; see append.ts:readCurrentMaxSeq).
 *
 * Consumers that need ordering MUST use `seq`. Spec §4.1.
 */
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

export type ResolvableCoralEventInput<Scope, T = never> = CoralEventInput<T> & {
  readonly [RESOLVABLE_INPUT_SCOPE]?: {
    readonly consume: (scope: Scope) => void;
    readonly produce: () => Scope;
    readonly token: CauseRefToken<Scope>;
  };
};

const STREAM_KINDS: ReadonlySet<StreamKind> = new Set(['job', 'session', 'discuss', 'workflow']);

function assertStreamKind(value: string): StreamKind {
  if (!STREAM_KINDS.has(value as StreamKind)) {
    throw new CoralSetupError({
      code: 'event_stream_kind_invalid',
      userMessage: `Unknown stream.kind in events row: '${value}'`,
      remediation:
        'A schema update likely introduced a new stream kind. Update the enum in src/store/envelope.ts and the assertStreamKind guard.',
      context: { streamKind: value },
    });
  }

  return value as StreamKind;
}

export function decodeEventRefs(row: Pick<EventsRow, 'seq' | 'refs'>): CoralEvent['refs'] {
  if (!row.refs) {
    return undefined;
  }

  return journalEventRefsSchema.parse(decodeEventJson(row.refs, { seq: row.seq, column: 'refs' }));
}

export function rowToCoralEvent<T = unknown>(row: EventsRow, body: T): CoralEvent<T> {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    stream: { kind: assertStreamKind(row.stream_kind), id: row.stream_id },
    namespace: row.namespace ?? undefined,
    project: row.project ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationSeq: row.causation_seq ?? undefined,
    refs: decodeEventRefs(row),
    bodyVersion: row.body_version,
    body,
  };
}
