import { z } from 'zod';
import { readRetentionMeta } from '../store/retention-meta.js';
import { readJobTerminalAge } from './terminal-age.js';
import { setImmediate } from 'node:timers/promises';
import { decodeBody, StoreCodecError, StoreDecodeError, type StoreReadContext } from '../store/body-codec.js';
import { withImmediate, type Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import type { RetentionRunBudget } from '../store/retention-outcome.js';
import { retentionCausePaths, unknownRetentionCause } from '../store/retention-indexes.js';
import { jobProgressBodySchema } from './event-bodies.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';
import { errorMessage } from '../infra/error-format.js';

const CURSOR_KEY = 'storage-retention.progress.v1';
const PAGE_SIZE = 64;

/** Fault diagnostics and causal evidence must remain readable by shipped strict codecs. */
export async function pruneJobProgress(input: {
  db: Database;
  readCtx: StoreReadContext;
  cutoff: number;
  afterSeq: number;
  budget: RetentionRunBudget;
}): Promise<number> {
  const { db, readCtx, cutoff, budget } = input;
  if (!budget.canContinue()) return input.afterSeq;
  const write = <T>(operation: () => T): T => {
    if (budget.canMutate?.() === false) throw new Error('progress-retention-owner-expired');
    const timeout = db.prepare<[], { timeout: number }>('PRAGMA busy_timeout').get()?.timeout;
    if (timeout === undefined) throw new Error('progress-write-settings-unknown');
    try {
      db.exec('PRAGMA busy_timeout = 25');
      return withImmediate(db, operation);
    } finally {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  };
  const { value: cursor } = readRetentionMeta({
    db,
    key: CURSOR_KEY,
    decode: (value) =>
      z
        .object({
          afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          progressSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          ceiling: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .passthrough()
        .parse(JSON.parse(value)),
    fresh: (reset) => ({
      afterSeq: reset ? 0 : input.afterSeq,
      progressSeq: 0,
      ceiling: undefined as number | undefined,
    }),
    mutate: write,
    record: budget.record,
  });
  const save = (): void => {
    if (budget.canMutate?.() === false) return;
    const persist = (): void => {
      db.prepare<[string, string]>('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        CURSOR_KEY,
        JSON.stringify(cursor),
      );
    };
    if (db.isTransaction) persist();
    else write(persist);
  };
  const advance = (seq: number): void => {
    cursor.afterSeq = seq;
    cursor.progressSeq = 0;
    save();
  };
  if (cursor.ceiling === undefined) {
    cursor.afterSeq = 0;
    cursor.progressSeq = 0;
    cursor.ceiling =
      db
        .prepare<
          [],
          { seq: number }
        >("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE type = 'job.terminal.recorded'")
        .get()?.seq ?? 0;
  }
  const finish = (): number => {
    cursor.ceiling = undefined;
    advance(0);
    return 0;
  };
  let scanned = 0;
  while (budget.canContinue() && scanned < 1000) {
    const terminals = db
      .prepare<
        [number, number, number],
        EventsRow
      >("SELECT * FROM events WHERE type = 'job.terminal.recorded' AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?")
      .all(cursor.afterSeq, cursor.ceiling, Math.min(PAGE_SIZE, 1000 - scanned));
    if (terminals.length === 0) {
      return finish();
    }
    for (const terminal of terminals) {
      if (!budget.canContinue()) {
        save();
        return cursor.afterSeq || terminal.seq;
      }
      const subject = `progress:${terminal.stream_id}`;
      let deleted = 0;
      let kept = 0;
      let unknownEvidence = false;
      try {
        decodeBody(terminal, jobTerminalRecordedBodySchema, readCtx);
        const reason = progressRetentionKeepReason(db, terminal, cutoff);
        if (reason) {
          budget.record({ kind: 'kept', subject, reason });
        } else {
          while (budget.canContinue()) {
            const rows = db
              .prepare<
                [string, number],
                EventsRow
              >("SELECT * FROM events WHERE type = 'job.progress.emitted' AND stream_id = ? AND seq > ? ORDER BY seq LIMIT 64")
              .all(terminal.stream_id, cursor.progressSeq);
            if (rows.length === 0) break;
            const candidates = rows.filter((row) => {
              const body = decodeBody(row, jobProgressBodySchema, readCtx);
              return (
                row.stream_kind === 'job' &&
                row.seq < terminal.seq &&
                (body.kind === 'message' || body.kind === 'domain')
              );
            });
            if (!budget.canContinue()) break;
            write(() => {
              const unknown = db
                .prepare(
                  `SELECT seq FROM events INDEXED BY events_retention_unknown_cause_v2 WHERE ${unknownRetentionCause} LIMIT 1`,
                )
                .get();
              unknownEvidence ||= unknown !== undefined;
              const referenceQueries = [
                db.prepare<[number]>(
                  'SELECT seq FROM events INDEXED BY events_retention_causation WHERE causation_seq = ? LIMIT 1',
                ),
                ...retentionCausePaths.map((path, index) =>
                  db.prepare<[number]>(
                    `SELECT seq FROM events INDEXED BY events_retention_cause_${index} WHERE CASE WHEN json_valid(body) THEN json_extract(body, '${path}') END = ? LIMIT 1`,
                  ),
                ),
              ];
              const deletable =
                unknown === undefined
                  ? candidates.filter((row) => referenceQueries.every((query) => query.get(row.seq) === undefined))
                  : [];
              if (deletable.length > 0)
                deleted += Number(
                  db
                    .prepare<number[]>(`DELETE FROM events WHERE seq IN (${deletable.map(() => '?').join(',')})`)
                    .run(...deletable.map((row) => row.seq)).changes,
                );
              kept += rows.length - deletable.length;
              cursor.progressSeq = rows[rows.length - 1].seq;
              save();
            });
            await setImmediate();
          }
          if (deleted > 0) budget.record({ kind: 'deleted', subject, count: deleted });
          if (kept > 0)
            budget.record({
              kind: 'kept',
              subject,
              reason: 'diagnostics-or-causal-evidence',
              pending: unknownEvidence,
            });
          if (!budget.canContinue()) {
            budget.record({ kind: 'kept', subject, reason: 'scan-pending' });
            return cursor.afterSeq || terminal.seq;
          }
        }
        advance(terminal.seq);
      } catch (error: unknown) {
        if ([5, 6].includes((error as { errcode?: number }).errcode ?? 0)) {
          budget.record({ kind: 'kept', subject, reason: 'scan-pending' });
          return cursor.afterSeq || terminal.seq;
        }
        budget.record({
          kind: error instanceof StoreCodecError || error instanceof StoreDecodeError ? 'kept' : 'failed',
          subject,
          reason: errorMessage(error),
        });
        advance(terminal.seq);
      }
      if (cursor.afterSeq >= cursor.ceiling) return finish();
      scanned += 1;
      await setImmediate();
    }
  }
  save();
  budget.record({ kind: 'kept', subject: 'journal-progress', reason: 'scan-pending' });
  return cursor.afterSeq;
}

function progressRetentionKeepReason(db: Database, terminal: EventsRow, cutoff: number): string | undefined {
  const latest = db
    .prepare<
      [string],
      { seq: number }
    >("SELECT seq FROM events INDEXED BY events_retention_stream WHERE stream_kind = 'job' AND stream_id = ? ORDER BY seq DESC LIMIT 1")
    .get(terminal.stream_id);
  if (latest?.seq !== terminal.seq) return 'terminal-state-unproven';
  const age = readJobTerminalAge(db, terminal);
  if (age === 'regression') return 'terminal-clock-regression';
  if (age === 'unknown' || age >= cutoff) return 'terminal-not-expired-or-unknown';
  return undefined;
}

export function jobProgressRetentionExpired(db: Database, terminal: EventsRow, cutoff: number): boolean {
  return progressRetentionKeepReason(db, terminal, cutoff) === undefined;
}
