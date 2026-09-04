import { withImmediate, type Database } from '../store/db.js';
import {
  decodeDurableCliContainmentStatus,
  decodeDurableCliProcessRuntimeMeta,
  decodeDurableCliProcessRuntimeMetaV1,
  durableCliContainmentStatusKey,
  durableCliProcessRuntimeMetaKey,
  durableCliProcessRuntimeMetaV1Key,
  encodeDurableCliContainmentStatus,
  encodeDurableCliProcessRuntimeMeta,
  type DurableCliContainmentStatus,
  type DurableCliProcessRuntimeEvidence,
  type DurableCliProcessRuntimeMeta,
} from './runtime-meta.js';

type MetaRow = { value: string };

function readMetaValue(db: Database, key: string): string | null {
  const row = db.prepare<[string], MetaRow>('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function readDurableCliProcessRuntimeMeta(db: Database, jobId: string): DurableCliProcessRuntimeMeta | null {
  return decodeDurableCliProcessRuntimeMeta(readMetaValue(db, durableCliProcessRuntimeMetaKey(jobId)));
}

export function readDurableCliProcessRuntimeEvidence(
  db: Database,
  jobId: string,
  journalPid: number,
): DurableCliProcessRuntimeEvidence {
  const currentRaw = readMetaValue(db, durableCliProcessRuntimeMetaKey(jobId));
  if (currentRaw !== null) {
    const current = decodeDurableCliProcessRuntimeMeta(currentRaw);
    if (current === null) return { kind: 'unavailable', reason: 'corrupt-current' };
    return current.jobId === jobId && current.pid === journalPid
      ? { kind: 'current', record: current }
      : { kind: 'unavailable', reason: 'identity-mismatch' };
  }

  const predecessorRaw = readMetaValue(db, durableCliProcessRuntimeMetaV1Key(jobId));
  if (predecessorRaw === null) return { kind: 'unavailable', reason: 'missing' };
  const predecessor = decodeDurableCliProcessRuntimeMetaV1(predecessorRaw);
  if (predecessor === null) return { kind: 'unavailable', reason: 'corrupt-predecessor' };
  return predecessor.jobId === jobId && predecessor.pid === journalPid
    ? { kind: 'predecessor', record: predecessor }
    : { kind: 'unavailable', reason: 'identity-mismatch' };
}

export function readMatchingDurableCliProcessRuntimeMeta(
  db: Database,
  jobId: string,
  journalPid: number,
): DurableCliProcessRuntimeMeta | null {
  const meta = readDurableCliProcessRuntimeMeta(db, jobId);
  return meta?.jobId === jobId && meta.pid === journalPid ? meta : null;
}

export function writeDurableCliProcessRuntimeMeta(db: Database, meta: DurableCliProcessRuntimeMeta): void {
  db.prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    durableCliProcessRuntimeMetaKey(meta.jobId),
    encodeDurableCliProcessRuntimeMeta(meta),
  );
}

export function readDurableCliContainmentStatus(db: Database, jobId: string): DurableCliContainmentStatus | null {
  return decodeDurableCliContainmentStatus(readMetaValue(db, durableCliContainmentStatusKey(jobId)));
}

export function listDurableCliContainmentStatuses(db: Database): readonly DurableCliContainmentStatus[] {
  const prefix = durableCliContainmentStatusKey('');
  const rows = db
    .prepare<[string], MetaRow>("SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC")
    .all(`${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
  return rows.flatMap((row) => {
    const status = decodeDurableCliContainmentStatus(row.value);
    return status === null ? [] : [status];
  });
}

export function writeDurableCliContainmentStatus(db: Database, status: DurableCliContainmentStatus): void {
  db.prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    durableCliContainmentStatusKey(status.jobId),
    encodeDurableCliContainmentStatus(status),
  );
}

export function deleteDurableCliContainmentStatus(db: Database, jobId: string): void {
  db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(durableCliContainmentStatusKey(jobId));
}

/** Terminal cleanup must remain idempotent for jobs that never captured durable identity. */
export function deleteDurableCliProcessRuntimeMeta(db: Database, jobId: string): void {
  withImmediate(db, () => {
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(durableCliProcessRuntimeMetaKey(jobId));
    deleteDurableCliContainmentStatus(db, jobId);
  });
}
