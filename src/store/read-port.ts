import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { openStoreDatabase, type Database } from './db.js';
import { acquireStoreEpochReadLock, holdStoreEpochLockUntilClose, resolveCurrentStore } from './epoch.js';
import type { StoreFormatDescription } from './format-fingerprint.js';
import type { ReadonlyDatabase } from './read-types.js';

/**
 * Generic read-only SQLite primitives owned by the store layer. A domain
 * that needs a typed read surface wraps these primitives with its own
 * semantics — domains do not redeclare the underlying database/statement
 * shapes.
 */

type OpenReadOnlyStoreOptions = {
  readonly storeFormat: StoreFormatDescription;
  readonly path?: string;
  readonly busyTimeoutMs?: number;
};

export function asReadonlyDatabase(db: Database): ReadonlyDatabase {
  return db as unknown as ReadonlyDatabase;
}

export function openReadOnlyStoreDatabase(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage'>,
  options: OpenReadOnlyStoreOptions,
): ReadonlyDatabase {
  const resolved = resolveCurrentStore(runtime, options.path);
  const lease = resolved.epoch === null ? null : acquireStoreEpochReadLock(runtime, resolved.epoch);
  if (resolved.epochCandidate && lease === null) {
    throw documentedCoralSetupError('store_not_initialized', { path: resolved.path });
  }
  try {
    const db = openStoreDatabase({
      path: resolved.path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      readonly: true,
      busyTimeoutMs: options.busyTimeoutMs,
    });
    return holdStoreEpochLockUntilClose(db, lease);
  } catch (error: unknown) {
    lease?.();
    throw error;
  }
}
