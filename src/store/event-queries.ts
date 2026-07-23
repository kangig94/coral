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
  const row = prepareCached<[number], EventsRow | undefined>(db, `SELECT * FROM events WHERE seq = ?`).get(seq);
  if (!row) return undefined;
  const event = rowToCoralEvent(row, decodeStoredBody(row, ctx));
  return event.stream.kind === stream.kind && event.stream.id === stream.id ? event : undefined;
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
    const eventTypes = [...ctx.streamKinds]
      .filter(([, streamKind]) => streamKind === filter.streamKind)
      .map(([type]) => type);
    if (eventTypes.length === 0) {
      return { events: [], nextCursor: afterSeq };
    }
    clauses.push(`type IN (${eventTypes.map(() => '?').join(', ')})`);
    params.push(...eventTypes);
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

export function readLatestEvent(db: Database, streamId: string, type: string): EventsRow | null {
  const row = prepareCached<[string, string], EventsRow | undefined>(
    db,
    `SELECT *
       FROM events
      WHERE stream_id = ? AND type = ?
      ORDER BY seq DESC
      LIMIT 1`,
  ).get(streamId, type);

  if (row === undefined) return null;
  rowToCoralEvent(row, null);
  return row;
}
