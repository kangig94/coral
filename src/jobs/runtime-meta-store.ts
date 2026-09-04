import { withImmediate, type Database } from '../store/db.js';
import {
  decodeDurableCliContainmentStatus,
  decodeDurableCliProvisionalProcessRuntimeMeta,
  decodeDurableCliProcessRuntimeMeta,
  decodeDurableCliProcessRuntimeMetaV1,
  durableCliContainmentStatusKey,
  durableCliProvisionalProcessRuntimeMetaKey,
  durableCliProcessRuntimeMetaKey,
  durableCliProcessRuntimeMetaV1Key,
  encodeDurableCliContainmentStatus,
  encodeDurableCliProvisionalProcessRuntimeMeta,
  encodeDurableCliProcessRuntimeMeta,
  type DurableCliContainmentStatus,
  type DurableCliProvisionalProcessRuntimeMeta,
  type DurableCliProcessRuntimeEvidence,
  type DurableCliProcessRuntimeMeta,
} from './runtime-meta.js';

type MetaRow = { key: string; value: string };

export type DurableCliContainmentStatusRead =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'corrupt'; jobId: string }>
  | Readonly<{ kind: 'valid'; status: DurableCliContainmentStatus }>;

export type ListedDurableCliContainmentStatus = Exclude<DurableCliContainmentStatusRead, { kind: 'missing' }>;

export type DurableCliPreReadyOwnershipEvidence =
  | Readonly<{ kind: 'current'; record: DurableCliProcessRuntimeMeta }>
  | Readonly<{ kind: 'provisional'; record: DurableCliProvisionalProcessRuntimeMeta }>
  | Extract<DurableCliProcessRuntimeEvidence, { kind: 'predecessor' }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'missing' | 'corrupt-current' | 'corrupt-provisional' | 'corrupt-predecessor' | 'identity-mismatch';
    }>;

function readMetaValue(db: Database, key: string): string | null {
  const row = db.prepare<[string], Pick<MetaRow, 'value'>>('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function readDurableCliProcessRuntimeMeta(db: Database, jobId: string): DurableCliProcessRuntimeMeta | null {
  return decodeDurableCliProcessRuntimeMeta(readMetaValue(db, durableCliProcessRuntimeMetaKey(jobId)));
}

export function readDurableCliPreReadyOwnershipEvidence(
  db: Database,
  jobId: string,
  journalPid?: number,
): DurableCliPreReadyOwnershipEvidence {
  const currentRaw = readMetaValue(db, durableCliProcessRuntimeMetaKey(jobId));
  if (currentRaw !== null) {
    const current = decodeDurableCliProcessRuntimeMeta(currentRaw);
    if (current === null) return { kind: 'unavailable', reason: 'corrupt-current' };
    return current.jobId === jobId && (journalPid === undefined || current.pid === journalPid)
      ? { kind: 'current', record: current }
      : { kind: 'unavailable', reason: 'identity-mismatch' };
  }

  const provisionalRaw = readMetaValue(db, durableCliProvisionalProcessRuntimeMetaKey(jobId));
  if (provisionalRaw !== null) {
    const provisional = decodeDurableCliProvisionalProcessRuntimeMeta(provisionalRaw);
    if (provisional === null) return { kind: 'unavailable', reason: 'corrupt-provisional' };
    return provisional.jobId === jobId && (journalPid === undefined || provisional.pid === journalPid)
      ? { kind: 'provisional', record: provisional }
      : { kind: 'unavailable', reason: 'identity-mismatch' };
  }

  const predecessorRaw = readMetaValue(db, durableCliProcessRuntimeMetaV1Key(jobId));
  if (predecessorRaw === null) return { kind: 'unavailable', reason: 'missing' };
  const predecessor = decodeDurableCliProcessRuntimeMetaV1(predecessorRaw);
  if (predecessor === null) return { kind: 'unavailable', reason: 'corrupt-predecessor' };
  return predecessor.jobId === jobId && (journalPid === undefined || predecessor.pid === journalPid)
    ? { kind: 'predecessor', record: predecessor }
    : { kind: 'unavailable', reason: 'identity-mismatch' };
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
  withImmediate(db, () => {
    db.prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      durableCliProcessRuntimeMetaKey(meta.jobId),
      encodeDurableCliProcessRuntimeMeta(meta),
    );
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(durableCliProvisionalProcessRuntimeMetaKey(meta.jobId));
  });
}

export function writeDurableCliProvisionalProcessRuntimeMeta(
  db: Database,
  meta: DurableCliProvisionalProcessRuntimeMeta,
): void {
  db.prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    durableCliProvisionalProcessRuntimeMetaKey(meta.jobId),
    encodeDurableCliProvisionalProcessRuntimeMeta(meta),
  );
}

export function readDurableCliContainmentStatus(db: Database, jobId: string): DurableCliContainmentStatusRead {
  const raw = readMetaValue(db, durableCliContainmentStatusKey(jobId));
  if (raw === null) return { kind: 'missing' };
  const status = decodeDurableCliContainmentStatus(raw);
  return status === null || status.jobId !== jobId ? { kind: 'corrupt', jobId } : { kind: 'valid', status };
}

export function listDurableCliContainmentStatuses(db: Database): readonly ListedDurableCliContainmentStatus[] {
  const prefix = durableCliContainmentStatusKey('');
  const rows = db
    .prepare<[string], MetaRow>("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC")
    .all(`${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
  return rows.map((row) => {
    const jobId = row.key.slice(prefix.length);
    const status = decodeDurableCliContainmentStatus(row.value);
    return status === null || status.jobId !== jobId ? { kind: 'corrupt', jobId } : { kind: 'valid', status };
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
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(durableCliProcessRuntimeMetaV1Key(jobId));
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(durableCliProvisionalProcessRuntimeMetaKey(jobId));
    deleteDurableCliContainmentStatus(db, jobId);
  });
}
