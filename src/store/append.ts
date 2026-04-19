import type BetterSqlite3 from 'better-sqlite3';

import {
  journalEventInputSchema,
  type CoralEvent,
  type CoralEventInput,
  type UpcasterRegistry,
} from './envelope.js';
import type { ComposedReducers } from './reducers.js';
import { applyReducer } from './reducers.js';

type Database = BetterSqlite3.Database;

export interface AppendContext {
  now(): Date;
  reducers: ComposedReducers;
  upcasters: UpcasterRegistry;
}

export interface AppendedEvent extends CoralEvent {
  readonly seq: number;
  readonly ts: string;
}

export type AppendInput = CoralEventInput;
export type AppendEventsFn = (inputs: readonly AppendInput[]) => void;
export const noopAppendEvents: AppendEventsFn = () => {};

function toTimestamp(value: Date): string {
  return value.toISOString();
}

export function appendEvents(
  db: Database,
  inputs: readonly AppendInput[],
  ctx: AppendContext,
): AppendedEvent[] {
  if (inputs.length === 0) return [];

  const reducers = ctx.reducers;
  const upcasters = ctx.upcasters;

  const insertStmt = db.prepare<
    [string, string, CoralEvent['stream']['kind'], string, string | null, string | null, string | null, number | null, string | null, number, Buffer],
    { seq: number }
  >(
    `INSERT INTO events (ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body_version, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING seq`,
  );

  const prepared = inputs.map((rawInput) => {
    const input = journalEventInputSchema.parse(rawInput) as AppendInput;
    const schema = reducers.schemas.get(input.type);
    const parsedBody = schema
      ? upcasters.parseBody(input.type, input.bodyVersion, input.body, schema)
      : input.body;
    // Persist RAW input bytes (not parsedBody) per architecture §4.2: "Old events
    // are never rewritten; only the in-memory interpretation evolves." Upcasters
    // run on READ (rebuild/read paths) against the stored body_version. Storing
    // parsedBody here would double-upcast on later rebuild.
    const bodyBytes = Buffer.from(JSON.stringify(input.body), 'utf-8');

    return { input, parsedBody, bodyBytes };
  });

  const txn = db.transaction((items: typeof prepared): AppendedEvent[] => {
    const assigned: AppendedEvent[] = [];
    const ts = prepared[0]?.input.tsOverride ?? toTimestamp(ctx.now());

    for (const { input, parsedBody, bodyBytes } of items) {
      const row = insertStmt.get(
        input.tsOverride ?? ts,
        input.type,
        input.stream.kind,
        input.stream.id,
        input.namespace ?? null,
        input.project ?? null,
        input.correlationId ?? null,
        input.causationSeq ?? null,
        input.refs ? JSON.stringify(input.refs) : null,
        input.bodyVersion,
        bodyBytes,
      );

      if (!row) {
        throw new Error(`appendEvents: INSERT did not return seq for type '${input.type}'`);
      }

      const event: AppendedEvent = {
        seq: row.seq,
        ts: input.tsOverride ?? ts,
        type: input.type,
        stream: input.stream,
        namespace: input.namespace,
        project: input.project,
        correlationId: input.correlationId,
        causationSeq: input.causationSeq,
        refs: input.refs,
        bodyVersion: input.bodyVersion,
        body: parsedBody,
      };

      applyReducer(db, event, reducers);
      assigned.push(event);
    }

    return assigned;
  });

  return txn.immediate(prepared);
}
