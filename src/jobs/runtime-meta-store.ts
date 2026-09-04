import type { Database } from '../store/db.js';
import {
  decodeDurableCliProcessRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliProcessRuntimeMeta,
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

export function writeDurableCliProcessRuntimeMeta(db: Database, meta: DurableCliProcessRuntimeMeta): void {
  db.prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    durableCliProcessRuntimeMetaKey(meta.jobId),
    encodeDurableCliProcessRuntimeMeta(meta),
  );
}

/** Terminal cleanup's counterpart to the write above. A key that was never written is a no-op, not a fault —
 *  cleanup runs for every terminal job, including ones that never captured an identity. */
export function deleteDurableCliProcessRuntimeMeta(db: Database, jobId: string): void {
  db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(durableCliProcessRuntimeMetaKey(jobId));
}
