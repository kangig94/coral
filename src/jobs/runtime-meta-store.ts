import type { Database } from '../store/db.js';
import {
  decodeDurableCliProcessRuntimeMeta,
  decodeProviderOperationRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliProcessRuntimeMeta,
  providerOperationRuntimeMetaKey,
  type DurableCliProcessRuntimeMeta,
  type ProviderOperationRuntimeMeta,
} from './runtime-meta.js';

/**
 * The generic `key`/`value` `meta` table (`src/store/schema.sql`) holding the two runtime-meta records
 * `runtime-meta.ts` defines. Kept a sibling of that pure codec rather than folded into it: the codec has no
 * store dependency and stays testable without a database, while this module owns the one thing that
 * actually touches SQL for these keys. The store owns the table's schema; this module — not the store, and
 * not the coordinator — owns the queries, because `provider_operation.v1` and `durable_cli_process.v1` are
 * jobs vocabulary, not domain event history and not coordinator equipment.
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

/**
 * Read-only: the write side of `provider_operation.v1` belongs to the coordinator seam that commits it
 * alongside guardian/proxy activation, not to this module. A decode failure answers `null` rather than
 * throwing, for the same reason the durable-CLI reader does — the only caller that asks is observation, and
 * a corrupt record is exactly as usable to it as an absent one.
 */
export function readProviderOperationRuntimeMeta(
  db: Database,
  jobId: string,
  operationId: string,
): ProviderOperationRuntimeMeta | null {
  const raw = readMetaValue(db, providerOperationRuntimeMetaKey(jobId, operationId));
  if (raw === null) return null;
  try {
    return decodeProviderOperationRuntimeMeta(raw);
  } catch {
    return null;
  }
}
