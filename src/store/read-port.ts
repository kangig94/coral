import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { openStoreDatabase, type Database } from './db.js';
import {
  acquireStoreEpochReadLock,
  holdStoreEpochLockUntilClose,
  resolveCurrentStorePath,
  storeEpochAtPath,
} from './epoch.js';
import type { StoreFormatDescription } from './format-fingerprint.js';
import type { ReadonlyDatabase } from './read-types.js';
export type { ReadonlyDatabase, ReadonlyStatement } from './read-types.js';

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
  const path = resolveCurrentStorePath(runtime, options.path);
  const lease = acquireStoreEpochReadLock(runtime, path);
  if (storeEpochAtPath(runtime.paths.coral.store.dbDir, path) !== null && lease === null) {
    throw documentedCoralSetupError('store_not_initialized', { path });
  }
  try {
    const db = openStoreDatabase({
      path: path,
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
