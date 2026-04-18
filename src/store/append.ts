import type BetterSqlite3 from 'better-sqlite3';

import type { CoralEvent, CoralEventInput } from './envelope.js';
import { journalEventEnvelopeSchema } from './envelope.js';

export interface AppendInput extends CoralEventInput {}

export interface AppendedEvent extends CoralEvent {}

export type Reducer = (db: BetterSqlite3.Database, event: CoralEvent) => void;

export interface AppendContext {
  now(): number;
  reducers: Record<string, Reducer>;
}

const appendInputSchema = journalEventEnvelopeSchema.omit({ seq: true, ts: true });

export function appendEvents(
  db: BetterSqlite3.Database,
  inputs: readonly AppendInput[],
  ctx: AppendContext,
): AppendedEvent[] {
  const validatedInputs = inputs.map((input) => appendInputSchema.parse(input));
  const appended: AppendedEvent[] = [];
  const insertEvent = db.prepare(
    [
      'INSERT INTO events (',
      '  ts,',
      '  type,',
      '  stream_kind,',
      '  stream_id,',
      '  namespace,',
      '  project,',
      '  correlation_id,',
      '  causation_seq,',
      '  refs,',
      '  body_version,',
      '  body',
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ].join('\n'),
  );

  const tx = db.transaction(() => {
    for (const input of validatedInputs) {
      const ts = new Date(ctx.now()).toISOString();
      const bodyBytes = Buffer.from(JSON.stringify(input.body), 'utf-8');
      const refs = input.refs ? JSON.stringify(input.refs) : null;
      const result = insertEvent.run(
        ts,
        input.type,
        input.stream.kind,
        input.stream.id,
        input.namespace ?? null,
        input.project ?? null,
        input.correlationId ?? null,
        input.causationSeq ?? null,
        refs,
        input.bodyVersion,
        bodyBytes,
      );
      const event: AppendedEvent = {
        seq: Number(result.lastInsertRowid),
        ts,
        type: input.type,
        stream: input.stream,
        namespace: input.namespace ?? undefined,
        project: input.project ?? undefined,
        correlationId: input.correlationId ?? undefined,
        causationSeq: input.causationSeq ?? undefined,
        refs: input.refs ?? undefined,
        bodyVersion: input.bodyVersion,
        body: input.body,
      };
      appended.push(event);
      ctx.reducers[input.type]?.(db, event);
    }
  });

  tx.immediate();
  return appended;
}
