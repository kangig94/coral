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
    causationSeq: z.number().int().positive().optional(),
    refs: journalEventRefsSchema.optional(),
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

export function decodeEventRefs(row: Pick<EventsRow, 'seq' | 'refs'>): CoralEvent['refs'] {
  if (!row.refs) {
    return undefined;
  }

  return journalEventRefsSchema.parse(decodeEventJson(row.refs, { seq: row.seq, column: 'refs' }));
}

export function rowToCoralEvent<T = unknown>(row: EventsRow, body: T): CoralEvent<T> {
  const decoded = journalEventEnvelopeSchema.safeParse({
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    stream: { kind: row.stream_kind, id: row.stream_id },
    namespace: row.namespace ?? undefined,
    project: row.project ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationSeq: row.causation_seq ?? undefined,
    refs: decodeEventRefs(row),
    body,
  });
  if (!decoded.success) {
    if (decoded.error.issues.some((issue) => issue.path[0] === 'stream' && issue.path[1] === 'kind')) {
      throw new CoralSetupError({
        code: 'event_stream_kind_invalid',
        userMessage: `Unknown stream.kind in events row: '${row.stream_kind}'`,
        remediation: 'The persisted event envelope does not match this Coral store format.',
        context: { streamKind: row.stream_kind },
      });
    }
    throw decoded.error;
  }
  return decoded.data as CoralEvent<T>;
}
