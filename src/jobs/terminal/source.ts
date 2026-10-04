import { dirname, join } from 'node:path';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import type { EventsRow } from '../../store/schema.js';
import { observeResolvedStoreEpoch, inspectResolvedStoreEpochKey } from '../../store/epoch/observation.js';
import { acquireSharedFileLockNoRepairSync } from '../../infra/fs-lock.js';
import { jobTerminalRecordedBodySchema } from './result.js';

export function readAcceptedTerminal(db: Database, jobId: string): EventsRow | null {
  const row = db
    .prepare<
      [string],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? ORDER BY seq DESC LIMIT 1")
    .get(jobId);
  if (!row || row.type !== 'job.terminal.recorded') return null;
  jobTerminalRecordedBodySchema.parse(JSON.parse(Buffer.from(row.body).toString('utf8')));
  return row;
}

/** The source guard protects the full epoch identity against retirement and path replacement. */
export function withTerminalSource<T>(
  runtime: Pick<Runtime, 'storage'>,
  epochKey: string,
  read: (db: Database) => T,
): T | null {
  const epoch = observeResolvedStoreEpoch(runtime, epochKey);
  if (!epoch || !runtime.storage.existsSync(epoch.path)) return null;
  let release: (() => void) | null = null;
  let db: Database | null = null;
  try {
    release = acquireSharedFileLockNoRepairSync(join(dirname(epoch.path), '.lock'));
    const identity = inspectResolvedStoreEpochKey(runtime, epoch);
    if (identity !== epochKey) return null;
    db = runtime.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true }) as Database;
    return read(db);
  } finally {
    db?.close();
    release?.();
  }
}
