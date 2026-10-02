import type { Runtime } from '../runtime/ports.js';
import type { Database } from './db.js';
import type { RetentionOutcome } from './retention-outcome.js';
import type { SuccessionWriterEntitlement } from './succession-writer-generation.js';
import { errorMessage } from '../infra/error-format.js';
import { refreshStoreDatabaseAfterMaintenance } from './db.js';
import { retentionIndexStatements } from './retention-indexes.js';

const CONVERSION_BUDGET_MS = 30_000;
const CONVERSION_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec('PRAGMA busy_timeout=25; PRAGMA synchronous=FULL');
  if (db.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 2) db.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
  for (const sql of JSON.parse(process.argv[2])) db.exec(sql);
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
} finally { db.close(); }
`;

/** Only startup may hold a writer turn over a full rebuild; the helper has no children or signal handlers. */
export async function convertRetentionJournalAtStartup(input: {
  runtime: Runtime;
  db: Database;
  path: string;
  writer: Pick<SuccessionWriterEntitlement, 'beginWriteTurn' | 'assertCurrent'>;
  signal: AbortSignal;
}): Promise<RetentionOutcome> {
  const { runtime, db, path, writer, signal } = input;
  const subject = 'journal-startup-conversion';
  try {
    if (signal.aborted) return { kind: 'kept', subject, reason: 'shutdown' };
    const indexesPresent = retentionIndexStatements.every(
      (sql) =>
        db
          .prepare<[string]>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(sql.split(' ')[5]) !== undefined,
    );
    if (db.prepare<[], { auto_vacuum: number }>('PRAGMA auto_vacuum').get()?.auto_vacuum === 2 && indexesPresent)
      return { kind: 'kept', subject, reason: 'already-incremental' };
    if (path === ':memory:' || db.isTransaction) return { kind: 'kept', subject, reason: 'startup-store-unavailable' };
    const release = writer.beginWriteTurn();
    try {
      writer.assertCurrent();
      const child = runtime.process.spawn({
        command: process.execPath,
        args: ['--input-type=commonjs', '-e', CONVERSION_SCRIPT, path, JSON.stringify(retentionIndexStatements)],
        env: {},
      });
      child.stdin?.end();
      let interrupted = false;
      const cancel = (): void => {
        interrupted = true;
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = runtime.time.setTimeout(cancel, CONVERSION_BUDGET_MS);
      try {
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.on('close', (code) => resolve(code));
          child.on('error', reject);
        });
        refreshStoreDatabaseAfterMaintenance(db);
        if (interrupted)
          return {
            kind: 'failed',
            subject,
            reason: signal.aborted ? 'shutdown; retry-next-boot' : 'conversion-deadline; retry-next-boot',
          };
        if (exit !== 0) return { kind: 'failed', subject, reason: 'conversion-failed; retry-next-boot' };
        return { kind: 'deleted', subject, count: 0 };
      } finally {
        runtime.time.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      }
    } finally {
      release();
    }
  } catch (error: unknown) {
    return { kind: 'failed', subject, reason: `${errorMessage(error)}; retry-next-boot` };
  }
}
