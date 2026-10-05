import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';

export function readJobTerminalAge(db: Database, terminal: EventsRow): number | 'unknown' | 'regression' {
  const terminalAt = Date.parse(terminal.ts);
  if (!Number.isFinite(terminalAt)) return 'unknown';
  const preceding = db
    .prepare<
      [string, number],
      { ts: string }
    >("SELECT ts FROM events WHERE type IN ('job.launch.requested', 'job.launch.rejected', 'job.queue.queued', 'job.queue.admitted', 'job.runtime.started', 'job.progress.emitted', 'job.terminal.recorded', 'job.aborted') AND stream_kind = 'job' AND stream_id = ? AND seq < ? ORDER BY ts DESC LIMIT 1")
    .get(terminal.stream_id, terminal.seq);
  if (preceding === undefined) return terminalAt;
  const precedingAt = Date.parse(preceding.ts);
  if (!Number.isFinite(precedingAt)) return 'unknown';
  return terminalAt < precedingAt ? 'regression' : terminalAt;
}

/** Pruning outside the trusted window cannot hide a later timestamp than an inside-window terminal. */
export function readIntactJobTerminalAge(
  db: Database,
  terminal: EventsRow,
  cutoff: number | null = null,
): number | 'unknown' | 'regression' {
  if (cutoff === null) return 'unknown';
  const age = readJobTerminalAge(db, terminal);
  if (typeof age === 'number') return age;
  if (age !== 'regression') return age;
  const newest = db
    .prepare<
      [string, number],
      { ts: string }
    >("SELECT ts FROM events WHERE stream_kind = 'job' AND stream_id = ? AND seq <= ? ORDER BY ts DESC LIMIT 1")
    .get(terminal.stream_id, terminal.seq);
  const newestAt = newest ? Date.parse(newest.ts) : NaN;
  return Number.isFinite(newestAt) && newestAt < cutoff ? newestAt : age;
}
