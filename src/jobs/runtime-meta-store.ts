import type { Database } from '../store/db.js';
import {
  decodeDurableCliProcessRuntimeMeta,
  decodeProviderOperationRuntimeMeta,
  durableCliProcessRuntimeMetaKey,
  encodeDurableCliProcessRuntimeMeta,
  encodeProviderOperationRuntimeMeta,
  providerOperationRuntimeMetaKey,
  providerOperationRuntimeMetaKeyPrefix,
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

export function deleteProviderOperationRuntimeMeta(db: Database, jobId: string, operationId: string): void {
  db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(providerOperationRuntimeMetaKey(jobId, operationId));
}

/**
 * Whether any `provider_operation.v1` row is committed for `jobId`, regardless of which operation id — the
 * compatibility signal that a job's `leaseState: 'acquired'` `hostRef` names a provider proxy set that is
 * still executing or awaiting confirmed release rather than a local `ProviderHostManager` entry. Recovery
 * reads this before treating a recovered app-server job's `hostRef` as local: crash-recovery adoption is
 * W2.5 territory, not something a fresh coordinator generation with an empty registry can do, so this is only
 * ever used to *not* mistake one for a local host — never to adopt it.
 */
export function hasProviderOperationRuntimeMetaForJob(db: Database, jobId: string): boolean {
  // `jobId` is a canonical UUID by construction (`providerOperationRuntimeMetaKeyPrefix`'s own doc) and so
  // never contains a `LIKE` metacharacter; the trailing `%` is the only wildcard in this pattern.
  const row = db
    .prepare<[string], MetaRow>('SELECT value FROM meta WHERE key LIKE ? LIMIT 1')
    .get(`${providerOperationRuntimeMetaKeyPrefix(jobId)}%`);
  return row !== undefined;
}

/**
 * W2.5's decoded counterpart to `hasProviderOperationRuntimeMetaForJob`: interrupted app-server recovery
 * needs the locator's fields (which proxy and provider root to reap), not just its presence. Only one
 * operation is ever committed for a non-terminal job, so the same unordered `LIKE` match that presence
 * checking already accepts is exact here too.
 *
 * Unlike `readProviderOperationRuntimeMeta`, a decode failure here is not reported as absence: this caller
 * classifies whether an `acquired` `hostRef` is safe to probe, and a corrupt row silently read as "no
 * locator" would route straight back through the probe/`openReplacement` path this exists to close off.
 * Corruption of a coordinator-only-written row is a genuine invariant violation and must fail loud.
 */
export function readProviderOperationRuntimeMetaForJob(
  db: Database,
  jobId: string,
): ProviderOperationRuntimeMeta | null {
  const row = db
    .prepare<[string], MetaRow>('SELECT value FROM meta WHERE key LIKE ? LIMIT 1')
    .get(`${providerOperationRuntimeMetaKeyPrefix(jobId)}%`);
  return row === undefined ? null : decodeProviderOperationRuntimeMeta(row.value);
}
