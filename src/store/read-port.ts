import { dirname } from 'node:path';

import type { Runtime } from '../runtime/ports.js';
import { openStoreDatabase, type Database } from './db.js';

/**
 * Generic read-only SQLite primitives owned by the store layer. Domain-
 * specific read ports (e.g. `kb/read-port.ts:KbReadPort`) wrap these
 * primitives with their own semantics — domains do not redeclare the
 * underlying database/statement shapes.
 */

export interface ReadonlyStatement<BindParameters extends unknown[] = unknown[], Result = unknown> {
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
  iterate(...params: BindParameters): IterableIterator<Result>;
}

export interface ReadonlyDatabase {
  prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(
    source: string,
  ): ReadonlyStatement<BindParameters, Result>;
  close(): void;
}

type OpenReadOnlyStoreOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
};

export function asReadonlyDatabase(db: Database): ReadonlyDatabase {
  return db as unknown as ReadonlyDatabase;
}

export function openReadOnlyStoreDatabase(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  options: OpenReadOnlyStoreOptions = {},
): ReadonlyDatabase {
  const path = options.path ?? runtime.paths.coral.store.dbFile;
  if (path !== ':memory:') {
    runtime.storage.mkdirSync(dirname(path), { recursive: true });
  }

  return openStoreDatabase({
    path: path,
    storage: runtime.storage,
    readonly: true,
    busyTimeoutMs: options.busyTimeoutMs,
  });
}
