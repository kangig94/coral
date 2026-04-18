import type BetterSqlite3 from 'better-sqlite3';

import type { CoralEvent } from '../envelope.js';

export interface EventsFilter {
  streamKind?: 'job' | 'session' | 'discuss' | 'workflow';
  type?: string;
  correlationId?: string;
}

export interface EventsPage {
  events: CoralEvent[];
  nextCursor: number;
}

function decodeRow(row: {
  seq: number;
  ts: string;
  type: string;
  stream_kind: string;
  stream_id: string;
  namespace: string | null;
  project: string | null;
  correlation_id: string | null;
  causation_seq: number | null;
  refs: string | null;
  body_version: number;
  body: Uint8Array | Buffer;
}): CoralEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    stream: { kind: row.stream_kind as CoralEvent['stream']['kind'], id: row.stream_id },
    namespace: row.namespace ?? undefined,
    project: row.project ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationSeq: row.causation_seq ?? undefined,
    refs: row.refs ? JSON.parse(row.refs) : undefined,
    bodyVersion: row.body_version,
    body: JSON.parse(new TextDecoder().decode(row.body)),
  };
}

export function getEvent(
  db: BetterSqlite3.Database,
  stream: { kind: string; id: string },
  seq: number,
): CoralEvent | undefined {
  const row = db
    .prepare(`SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND seq = ?`)
    .get(stream.kind, stream.id, seq) as Parameters<typeof decodeRow>[0] | undefined;
  return row ? decodeRow(row) : undefined;
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
    .all(...params) as Parameters<typeof decodeRow>[0][];

  const events = rows.map(decodeRow);
  const nextCursor = events.length > 0 ? events[events.length - 1]!.seq : afterSeq;
  return { events, nextCursor };
}
