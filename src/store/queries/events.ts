import type BetterSqlite3 from 'better-sqlite3';

import { rowToCoralEvent, type CoralEvent, type StreamKind } from '../envelope.js';
import type { EventsRow } from '../schema.js';

export interface EventsFilter {
  streamKind?: StreamKind;
  type?: string;
  correlationId?: string;
}

export interface EventsPage {
  events: CoralEvent[];
  nextCursor: number;
}

export function getEvent(
  db: BetterSqlite3.Database,
  stream: { kind: string; id: string },
  seq: number,
): CoralEvent | undefined {
  const row = db
    .prepare(`SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND seq = ?`)
    .get(stream.kind, stream.id, seq) as EventsRow | undefined;
  return row ? rowToCoralEvent(row) : undefined;
}

export function getEventsSince(
  db: BetterSqlite3.Database,
  afterSeq: number,
  filter: EventsFilter = {},
  limit = 1000,
): EventsPage {
  const clauses: string[] = ['seq > ?'];
  const params: unknown[] = [afterSeq];

  if (filter.streamKind) {
    clauses.push('stream_kind = ?');
    params.push(filter.streamKind);
  }
  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.correlationId) {
    clauses.push('correlation_id = ?');
    params.push(filter.correlationId);
  }
  params.push(limit);

  const rows = db
    .prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`)
    .all(...params) as EventsRow[];

  const events = rows.map((row) => rowToCoralEvent(row));
  const nextCursor = events.length > 0 ? events[events.length - 1].seq : afterSeq;
  return { events, nextCursor };
}

export function readLatestEvent(
  db: BetterSqlite3.Database,
  streamKind: StreamKind,
  streamId: string,
  type: string,
): EventsRow | null {
  const row = db
    .prepare(
      `SELECT *
         FROM events
        WHERE stream_kind = ? AND stream_id = ? AND type = ?
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(streamKind, streamId, type) as EventsRow | undefined;

  return row ?? null;
}
