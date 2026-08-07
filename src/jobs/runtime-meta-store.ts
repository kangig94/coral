import type { Database } from '../store/db.js';
import {
  decodeDurableCliProcessRuntimeMeta,
  decodeProviderOperationRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliProcessRuntimeMeta,
  encodeProviderOperationRuntimeMeta,
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
 * A decode failure answers `null` rather than throwing, for the same reason the durable-CLI reader does — the
 * only caller that asks is observation, and a corrupt record is exactly as usable to it as an absent one.
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

/**
 * W2.3 step 3 of the closed publication order: the coordinator's one committed locator, written after
 * `operation.prepare.v1` returns the reservation/root/containment receipt and before
 * `guardian.operation-activate.v1` is ever called. Plain `INSERT OR REPLACE`, not wrapped in its own
 * `BEGIN IMMEDIATE`/`COMMIT` — the same shape `writeDurableCliProcessRuntimeMeta` already uses. Callers that
 * need this write atomic with something else (W2.5's provider-event watermark advance, alongside whichever
 * domain effect a given event applies) run it on a `Database` that already has a transaction open; a bare
 * `INSERT` composes into that transaction for free, exactly as every other statement on the same connection
 * does. A caller with nothing else to combine it with may call this directly — a single statement is its own
 * atomic unit.
 */
export function writeProviderOperationRuntimeMeta(db: Database, meta: ProviderOperationRuntimeMeta): void {
  db.prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    providerOperationRuntimeMetaKey(meta.jobId, meta.operationId),
    encodeProviderOperationRuntimeMeta(meta),
  );
}

/**
 * W2.3's activation-expiry compensation: delete the exact matching locator before
 * `operation.cancel-pending.v1`/`guardian.operation-release.v1` — never the other order, and never a delete
 * keyed on anything looser than the exact `(jobId, operationId)` this reservation named. A key nothing wrote
 * is a no-op, matching `deleteDurableCliProcessRuntimeMeta`: compensation must be safe to run against a
 * locator that a racing durable-effect commit already released past.
 */
export function deleteProviderOperationRuntimeMeta(db: Database, jobId: string, operationId: string): void {
  db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(providerOperationRuntimeMetaKey(jobId, operationId));
}
