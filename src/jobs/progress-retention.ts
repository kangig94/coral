import { setImmediate } from 'node:timers/promises';
import { decodeBody, StoreCodecError, StoreDecodeError, type StoreReadContext } from '../store/body-codec.js';
import { withImmediate, type Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import type { RetentionRunBudget } from '../store/retention-outcome.js';
import { jobProgressBodySchema } from './event-bodies.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';
import { errorMessage } from '../infra/error-format.js';

/** Fault diagnostics and causal evidence must remain readable by shipped strict codecs. */
export async function pruneJobProgress(input: {
  db: Database;
  readCtx: StoreReadContext;
  cutoff: number;
  afterSeq: number;
  budget: RetentionRunBudget;
}): Promise<number> {
  const { db, readCtx, cutoff, budget } = input;
  let afterSeq = input.afterSeq;
  const terminals = db
    .prepare<
      [number],
      EventsRow
    >("SELECT * FROM events WHERE type = 'job.terminal.recorded' AND seq > ? ORDER BY seq LIMIT 1000")
    .all(afterSeq);
  const references = new Set(
    db
      .prepare<[], { seq: number }>(
        `SELECT causation_seq AS seq FROM events WHERE causation_seq IS NOT NULL
     UNION SELECT json_extract(j.value, '$.seq') AS seq
       FROM events e, json_tree(e.body) j WHERE e.type <> 'job.progress.emitted' AND j.key = 'causeRef'`,
      )
      .all()
      .map(({ seq }) => seq),
  );
  const latestByJob = new Map(
    db
      .prepare<[], { stream_id: string; seq: number }>(
        "SELECT stream_id, MAX(seq) AS seq FROM events WHERE stream_kind = 'job' GROUP BY stream_id",
      )
      .all()
      .map(({ stream_id, seq }) => [stream_id, seq]),
  );
  for (const terminal of terminals) {
    if (!budget.canContinue()) return afterSeq;
    const subject = `progress:${terminal.stream_id}`;
    try {
      decodeBody(terminal, jobTerminalRecordedBodySchema, readCtx);
      if (latestByJob.get(terminal.stream_id) !== terminal.seq) {
        budget.record({ kind: 'kept', subject, reason: 'terminal-state-unproven' });
        afterSeq = terminal.seq;
        continue;
      }
      const terminalAt = Date.parse(terminal.ts);
      if (!Number.isFinite(terminalAt) || terminalAt >= cutoff) {
        budget.record({ kind: 'kept', subject, reason: 'terminal-not-expired-or-unknown' });
        afterSeq = terminal.seq;
        continue;
      }
      let cursor = 0;
      let deleted = 0;
      let kept = 0;
      while (budget.canContinue()) {
        const rows = db
          .prepare<
            [string, number],
            EventsRow
          >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.progress.emitted' AND seq > ? ORDER BY seq LIMIT 1000")
          .all(terminal.stream_id, cursor);
        if (rows.length === 0) break;
        const deletable: number[] = [];
        for (const row of rows) {
          const body = decodeBody(row, jobProgressBodySchema, readCtx);
          if (
            (body.kind === 'message' || body.kind === 'domain') &&
            !references.has(row.seq) &&
            row.seq < terminal.seq
          ) {
            deletable.push(row.seq);
          } else kept += 1;
        }
        if (!budget.canContinue()) break;
        if (deletable.length > 0) {
          withImmediate(db, () => {
            deleted += Number(
              db
                .prepare<number[]>(`DELETE FROM events WHERE seq IN (${deletable.map(() => '?').join(',')})`)
                .run(...deletable).changes,
            );
          });
        }
        cursor = rows[rows.length - 1].seq;
        await setImmediate();
      }
      if (deleted > 0) budget.record({ kind: 'deleted', subject, count: deleted });
      if (kept > 0) budget.record({ kind: 'kept', subject, reason: 'diagnostics-or-causal-evidence' });
      if (!budget.canContinue()) {
        budget.record({ kind: 'kept', subject, reason: 'run-interrupted' });
        return afterSeq;
      }
      afterSeq = terminal.seq;
    } catch (error: unknown) {
      budget.record({
        kind: error instanceof StoreCodecError || error instanceof StoreDecodeError ? 'kept' : 'failed',
        subject,
        reason: errorMessage(error),
      });
      afterSeq = terminal.seq;
    }
    await setImmediate();
  }
  return terminals.length < 1000 ? 0 : afterSeq;
}
