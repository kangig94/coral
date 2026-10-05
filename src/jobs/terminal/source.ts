import { sameEpoch } from '../../store/epoch/identity.js';
import { STORE_LOCK_FILE_NAME } from '../../store/epoch/index.js';
import { dirname, join } from 'node:path';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import type { EventsRow } from '../../store/schema.js';
import { observeResolvedStoreEpoch, inspectResolvedStoreEpochKey } from '../../store/epoch/observation.js';
import { acquireSharedFileLockNoRepairSync } from '../../infra/fs-lock.js';
import { jobTerminalRecordedBodySchema } from './result.js';
import { observeStorePath } from '../../store/path-observation.js';

export function readAcceptedTerminal(db: Database, jobId: string): EventsRow | null {
  const row = db
    .prepare<
      [string],
      EventsRow
    >("SELECT * FROM events WHERE type = 'job.terminal.recorded' AND stream_kind = 'job' AND stream_id = ? ORDER BY seq DESC LIMIT 1")
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
  if (!epoch) throw new Error('Source epoch identity cannot be observed');
  const path = observeStorePath(runtime.storage, epoch.path);
  if (path === 'absent') return null;
  let release: (() => void) | null = null;
  let db: Database | null = null;
  try {
    release = acquireSharedFileLockNoRepairSync(join(dirname(epoch.path), STORE_LOCK_FILE_NAME));
    const identity = inspectResolvedStoreEpochKey(runtime, epoch);
    if (!sameEpoch(identity, epochKey)) throw new Error('Source epoch identity cannot be confirmed');
    db = runtime.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true }) as Database;
    return read(db);
  } finally {
    db?.close();
    release?.();
  }
}
