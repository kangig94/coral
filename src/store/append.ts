import type BetterSqlite3 from 'better-sqlite3';

import {
  createEmptyRegistry,
  journalEventInputSchema,
  type CoralEvent,
  type CoralEventInput,
  type UpcasterRegistry,
} from './envelope.js';
import type { ComposedReducers, Reducer } from './reducers.js';
import { applyReducer } from './reducers.js';

type Database = BetterSqlite3.Database;
type ReducerMap = Record<string, Reducer<unknown>>;

export interface AppendContext {
  now(): Date | number;
  reducers: ComposedReducers | ReducerMap;
  upcasters?: UpcasterRegistry;
}

export interface AppendedEvent extends CoralEvent {
  readonly seq: number;
  readonly ts: string;
}

export type AppendInput = CoralEventInput;

function isComposedReducers(reducers: ComposedReducers | ReducerMap): reducers is ComposedReducers {
  return (
    typeof reducers === 'object' &&
    reducers !== null &&
    'types' in reducers &&
    Array.isArray(reducers.types) &&
    'reducers' in reducers &&
    reducers.reducers instanceof Map &&
    'schemas' in reducers &&
    reducers.schemas instanceof Map
  );
}

function normalizeReducers(reducers: ComposedReducers | ReducerMap): ComposedReducers {
  if (isComposedReducers(reducers)) {
    return reducers;
  }

  const types = Object.keys(reducers);
  return {
    types,
    reducers: new Map(Object.entries(reducers)),
    schemas: new Map(),
  };
}

function toTimestamp(value: Date | number): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function appendEvents(
  db: Database,
  inputs: readonly AppendInput[],
  ctx: AppendContext,
): AppendedEvent[] {
  if (inputs.length === 0) return [];

  const reducers = normalizeReducers(ctx.reducers);
  const upcasters = ctx.upcasters ?? createEmptyRegistry();

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
