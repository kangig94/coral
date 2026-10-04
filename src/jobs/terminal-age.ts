import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';

export function readJobTerminalAge(db: Database, terminal: EventsRow): number | 'unknown' | 'regression' {
  const terminalAt = Date.parse(terminal.ts);
  if (!Number.isFinite(terminalAt)) return 'unknown';
  const preceding = db
    .prepare<
      [string, number],
      { ts: string }
    >("SELECT ts FROM events WHERE stream_kind = 'job' AND stream_id = ? AND seq < ? ORDER BY ts DESC LIMIT 1")
    .get(terminal.stream_id, terminal.seq);
  if (preceding === undefined) return terminalAt;
  const precedingAt = Date.parse(preceding.ts);
  if (!Number.isFinite(precedingAt)) return 'unknown';
  return terminalAt < precedingAt ? 'regression' : terminalAt;
}

/** A pruned prefix cannot establish the preceding timestamp evidence for a legacy backfill. */
export function readIntactJobTerminalAge(db: Database, terminal: EventsRow): number | 'unknown' | 'regression' {
  const prefix = db
    .prepare<[number], { count: number }>('SELECT COUNT(*) AS count FROM events WHERE seq < ?')
    .get(terminal.seq);
  if (prefix?.count !== terminal.seq - 1) return 'unknown';
  return readJobTerminalAge(db, terminal);
}
