import { sameEpoch } from '../../store/epoch/identity.js';
import { type ResolvedStoreEpoch, STORE_LOCK_FILE_NAME } from '../../store/epoch/index.js';
import { dirname, join } from 'node:path';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import type { EventsRow } from '../../store/schema.js';
import { observeResolvedStoreEpoch, inspectResolvedStoreEpochKey } from '../../store/epoch/observation.js';
import { acquireSharedFileLockNoRepairSync } from '../../infra/fs-lock.js';
import { observeStorePath } from '../../store/path-observation.js';
import { decodeBody, type StoreReadContext } from '../../store/body-codec.js';
import { jobExecutionEndedBodySchema, jobExecutionOutcomeAcceptedBodySchema } from './result.js';

export function readEndedExecutionOutcome(db: Database, ended: EventsRow, ctx: StoreReadContext) {
  const end = decodeBody(ended, jobExecutionEndedBodySchema, ctx);
  const accepted = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(end.causeRef.seq);
  if (
    ended.type !== 'job.execution.ended' ||
    ended.stream_kind !== 'job' ||
    accepted === undefined ||
    accepted.type !== 'job.execution.outcome.accepted' ||
    accepted.stream_kind !== 'job' ||
    accepted.stream_id !== ended.stream_id ||
    accepted.seq >= ended.seq ||
    end.causeRef.stream.kind !== 'job' ||
    end.causeRef.stream.id !== ended.stream_id
  )
    throw new Error('Execution end must cite its accepted outcome.');
  const outcome = decodeBody(accepted, jobExecutionOutcomeAcceptedBodySchema, ctx);
  if (outcome.execution !== end.execution) throw new Error('Execution end cites another execution.');
  return outcome;
}

export function readAcceptedTerminal(db: Database, jobId: string, execution?: number): EventsRow | null {
  const row =
    execution === undefined
      ? db
          .prepare<
            [string],
            EventsRow
          >("SELECT * FROM events WHERE type = 'job.execution.ended' AND stream_kind = 'job' AND stream_id = ? AND json_extract(CAST(body AS TEXT), '$.execution') = (SELECT execution FROM projection_jobs WHERE job_id = events.stream_id) ORDER BY seq DESC LIMIT 1")
          .get(jobId)
      : db
          .prepare<
            [string, number],
            EventsRow
          >("SELECT * FROM events WHERE type = 'job.execution.ended' AND stream_kind = 'job' AND stream_id = ? AND json_extract(CAST(body AS TEXT), '$.execution') = ? ORDER BY seq DESC LIMIT 1")
          .get(jobId, execution);
  return row ?? null;
}

/** The source guard protects the full epoch identity against retirement and path replacement. */
export function withTerminalSource<T>(
  runtime: Pick<Runtime, 'storage'>,
  epochKey: string,
  read: (db: Database) => T,
  closedSource?: ResolvedStoreEpoch,
): T | null {
  const epoch = closedSource ?? observeResolvedStoreEpoch(runtime, epochKey);
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
