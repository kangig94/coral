import type { Database } from './db.js';
import type { RetentionOutcome } from './retention-outcome.js';
import type { RetentionRunBudget } from './retention-outcome.js';
import { errorMessage } from '../infra/error-format.js';
import { setImmediate } from 'node:timers/promises';

/** The fenced database owns every vacuum write turn, including succession park exclusion. */
export async function vacuumRetainedJournal(
  db: Database,
  budget: Pick<RetentionRunBudget, 'canContinue'>,
): Promise<RetentionOutcome> {
  const subject = 'journal-vacuum';
  try {
    if (!budget.canContinue()) return { kind: 'kept', subject, reason: 'run-interrupted' };
    const free = db.prepare<[], { freelist_count: number }>('PRAGMA freelist_count').get()?.freelist_count;
    const mode = db.prepare<[], { auto_vacuum: number }>('PRAGMA auto_vacuum').get()?.auto_vacuum;
    if (free === undefined || mode === undefined) {
      return { kind: 'kept', subject, reason: 'vacuum-metadata-unknown' };
    }
    if (free === 0) return { kind: 'kept', subject, reason: 'no-free-pages', pending: false };
    if (db.isTransaction) return { kind: 'kept', subject, reason: 'writer-transaction-active' };
    if (mode !== 2) return { kind: 'kept', subject, reason: 'free-pages-reusable-until-next-epoch', pending: false };
    const timeout = db.prepare<[], { timeout: number }>('PRAGMA busy_timeout').get()?.timeout;
    if (timeout === undefined) return { kind: 'kept', subject, reason: 'busy-timeout-unknown' };
    let remaining = free;
    while (remaining > 0 && budget.canContinue()) {
      try {
        db.exec('PRAGMA busy_timeout = 25');
        db.exec('PRAGMA incremental_vacuum(32)');
      } finally {
        db.exec(`PRAGMA busy_timeout = ${timeout}`);
      }
      const next =
        db.prepare<[], { freelist_count: number }>('PRAGMA freelist_count').get()?.freelist_count ?? remaining;
      if (next >= remaining) break;
      remaining = next;
      await setImmediate();
    }
    return { kind: 'deleted', subject, count: free - remaining };
  } catch (error: unknown) {
    return { kind: 'failed', subject, reason: errorMessage(error) };
  }
}
