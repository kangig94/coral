import type { Database } from './db.js';

import { decodeStoredBody, type StoreReadContext } from './body-codec.js';
import { prepareCached } from './db.js';
import { rowToCoralEvent, type CoralEvent, type StreamKind } from './envelope.js';
import type { EventsRow } from './schema.js';

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
  db: Database,
  stream: { kind: string; id: string },
  seq: number,
  ctx: StoreReadContext,
): CoralEvent | undefined {
  const row = prepareCached<[string, string, number], EventsRow | undefined>(
    db,
    `SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND seq = ?`,
  ).get(stream.kind, stream.id, seq);
  return row ? rowToCoralEvent(row, decodeStoredBody(row, ctx)) : undefined;
}

export function getEventsSince(
  db: Database,
  afterSeq: number,
  filter: EventsFilter = {},
  limit = 1000,
  ctx: StoreReadContext,
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

  const rows = prepareCached<unknown[], EventsRow>(
    db,
    `SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
  ).all(...params);

  const events = rows.map((row) => rowToCoralEvent(row, decodeStoredBody(row, ctx)));
  const nextCursor = events.length > 0 ? events[events.length - 1].seq : afterSeq;
  return { events, nextCursor };
}

export function readLatestEvent(
  db: Database,
  streamKind: StreamKind,
  streamId: string,
  type: string,
): EventsRow | null {
  const row = prepareCached<[StreamKind, string, string], EventsRow | undefined>(
    db,
    `SELECT *
       FROM events
      WHERE stream_kind = ? AND stream_id = ? AND type = ?
      ORDER BY seq DESC
      LIMIT 1`,
  ).get(streamKind, streamId, type);

  return row ?? null;
}
