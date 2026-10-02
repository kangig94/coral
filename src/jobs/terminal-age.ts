import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';

export function readJobTerminalAge(db: Database, terminal: EventsRow): number | 'unknown' | 'regression' {
  const terminalAt = Date.parse(terminal.ts);
  if (!Number.isFinite(terminalAt)) return 'unknown';
  const preceding = db
    .prepare<
      [string, number],
      { ts: string }
    >("SELECT ts FROM events INDEXED BY events_retention_age WHERE stream_kind = 'job' AND stream_id = ? AND seq < ? ORDER BY ts DESC LIMIT 1")
    .get(terminal.stream_id, terminal.seq);
  if (preceding === undefined) return terminalAt;
  const precedingAt = Date.parse(preceding.ts);
  if (!Number.isFinite(precedingAt)) return 'unknown';
  return terminalAt < precedingAt ? 'regression' : terminalAt;
}
