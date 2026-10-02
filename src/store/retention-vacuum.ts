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
    const pages = db.prepare<[], { page_count: number }>('PRAGMA page_count').get()?.page_count;
    const pageSize = db.prepare<[], { page_size: number }>('PRAGMA page_size').get()?.page_size;
    if (free === undefined || pages === undefined || pageSize === undefined || mode === undefined) {
      return { kind: 'kept', subject, reason: 'vacuum-metadata-unknown' };
    }
    if (free === 0) return { kind: 'kept', subject, reason: 'no-free-pages' };
    if (db.isTransaction) return { kind: 'kept', subject, reason: 'writer-transaction-active' };
    if (mode !== 2 && pages * pageSize > 320 * 1024 * 1024) {
      return { kind: 'kept', subject, reason: 'full-vacuum-size-bound' };
    }
    const timeout = db.prepare<[], { timeout: number }>('PRAGMA busy_timeout').get()?.timeout;
    if (timeout === undefined) return { kind: 'kept', subject, reason: 'busy-timeout-unknown' };
    try {
      db.exec('PRAGMA busy_timeout = 25');
      if (mode === 2) {
        let remaining = free;
        while (remaining > 0 && budget.canContinue()) {
          db.exec('PRAGMA incremental_vacuum(256)');
          const next =
            db.prepare<[], { freelist_count: number }>('PRAGMA freelist_count').get()?.freelist_count ?? remaining;
          if (next >= remaining) break;
          remaining = next;
          await setImmediate();
        }
      } else {
        db.exec('PRAGMA auto_vacuum = INCREMENTAL');
        db.exec('VACUUM');
      }
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } finally {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
    const remaining = db.prepare<[], { freelist_count: number }>('PRAGMA freelist_count').get()?.freelist_count ?? free;
    return { kind: 'deleted', subject, count: free - remaining };
  } catch (error: unknown) {
    return { kind: 'failed', subject, reason: errorMessage(error) };
  }
}
