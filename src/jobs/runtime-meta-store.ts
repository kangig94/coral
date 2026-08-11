import type { Database } from '../store/db.js';
import {
  decodeDurableCliProcessRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliProcessRuntimeMeta,
  type DurableCliProcessRuntimeMeta,
} from './runtime-meta.js';

/**
 * The generic `key`/`value` `meta` table (`src/store/schema.sql`) holding the durable CLI runtime record.
 * Kept a sibling of its pure codec rather than folded into it: the codec has no
 * store dependency and stays testable without a database, while this module owns the one thing that
 * actually touches SQL for these keys. The store owns the table's schema; this module — not the store, and
 * not the coordinator — owns the queries because `durable_cli_process.v1` is jobs vocabulary, not domain
 * event history and not coordinator equipment.
 */

type MetaRow = { value: string };

function readMetaValue(db: Database, key: string): string | null {
  const row = db.prepare<[string], MetaRow>('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

/** `null` for every unusable reply — absent row, corrupt bytes, or a foreign shape — matching what the only
 *  caller that asks (observation) already treats as "nothing to check the process against". */
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
