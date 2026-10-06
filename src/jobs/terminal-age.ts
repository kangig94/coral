import { prepareCached, type Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';

/**
 * A terminal timestamped before an earlier row of its own job is a regression: the earlier row only bounds the
 * terminal's real time from below, so no cutoff can prove it expired.
 */
export function readJobTerminalAge(db: Database, terminal: EventsRow): number | 'unknown' | 'regression' {
  const terminalAt = Date.parse(terminal.ts);
  if (!Number.isFinite(terminalAt)) return 'unknown';
  const preceding = prepareCached<[string, number], { ts: string }>(
    db,
    hasRetentionAgeIndex(db)
      ? "SELECT ts FROM events INDEXED BY events_retention_age WHERE stream_kind = 'job' AND stream_id = ? AND seq < ? ORDER BY ts DESC LIMIT 1"
      : "SELECT ts FROM events WHERE type IN ('job.launch.requested', 'job.launch.rejected', 'job.queue.queued', 'job.queue.admitted', 'job.runtime.started', 'job.progress.emitted', 'job.terminal.recorded', 'job.aborted') AND stream_kind = 'job' AND stream_id = ? AND seq < ? ORDER BY ts DESC LIMIT 1",
  ).get(terminal.stream_id, terminal.seq);
  if (preceding === undefined) return terminalAt;
  const precedingAt = Date.parse(preceding.ts);
  if (!Number.isFinite(precedingAt)) return 'unknown';
  return terminalAt < precedingAt ? 'regression' : terminalAt;
}

/** A store opened before its maintenance indexes were installed has no age index, so the type-filtered read serves it. */
function hasRetentionAgeIndex(db: Database): boolean {
  return (
    prepareCached<[], { name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_retention_age'",
    ).get() !== undefined
  );
}
