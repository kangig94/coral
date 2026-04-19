import { z } from 'zod';

import { CoralSetupError } from '../runtime/errors.js';
import { decodeEventBody } from './body-codec.js';
import type { EventsRow } from './schema.js';

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
      remediation: 'A migration likely introduced a new stream kind. Update the enum in src/store/envelope.ts and the assertStreamKind guard.',
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

type Upcaster = (body: unknown) => unknown;

interface UpcasterRecord {
  toVersion: number;
  fn: Upcaster;
}

export class UpcasterRegistry {
  private readonly entries = new Map<string, UpcasterRecord>();

  registerUpcaster(type: string, fromVersion: number, toVersion: number, fn: Upcaster): void {
    const key = `${type}|${fromVersion}`;
    if (this.entries.has(key)) {
      throw new CoralSetupError({
        code: 'upcaster_conflict',
        userMessage: `Upcaster already registered for type '${type}' from v${fromVersion}`,
        remediation: 'Remove the duplicate registerUpcaster call or use a different fromVersion.',
        context: { type, fromVersion },
      });
    }
    this.entries.set(key, { toVersion, fn });
  }

  parseBody<T>(type: string, bodyVersion: number, body: unknown, currentSchema: z.ZodType<T>): T {
    let current = body;
    let version = bodyVersion;
    const visited = new Set<number>([version]);

    while (true) {
      const rec = this.entries.get(`${type}|${version}`);
      if (!rec) {
        const parsed = currentSchema.safeParse(current);
        if (parsed.success) {
          return parsed.data;
        }

        throw new CoralSetupError({
          code: 'upcaster_missing',
          userMessage: `No upcaster chain from v${bodyVersion} to current for type '${type}'`,
          remediation: 'Register upcasters to bridge the gap, or verify bodyVersion.',
          context: { type, bodyVersion, stoppedAt: version, error: parsed.error.format() },
        });
      }

      current = rec.fn(current);
      version = rec.toVersion;
      if (visited.has(version)) {
        throw new CoralSetupError({
          code: 'upcaster_cycle',
          userMessage: `Upcaster chain cycle detected for type '${type}' at v${version}`,
          remediation: 'Inspect registerUpcaster calls for this type; a cycle makes the chain non-terminating.',
          context: { type, bodyVersion, cycleAt: version, chain: [...visited] },
        });
      }
      visited.add(version);
    }
  }
}

export function createEmptyRegistry(): UpcasterRegistry {
  return new UpcasterRegistry();
}
