import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Runtime, StoragePort } from '../runtime/ports.js';
import { applyStoreSchemas, assertSupportedStoreSchema, ensureStoreSchemasDir } from './schema-loader.js';

type ReadonlyStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
  readonly readonly: true;
  readonly busyTimeoutMs?: number;
  readonly schemasDir?: string;
};

type WritableStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
  readonly readonly?: false;
  readonly busyTimeoutMs?: number;
  readonly schemasDir: string;
};

export type OpenStoreOptions = ReadonlyStoreOptions | WritableStoreOptions;

export function openStoreDatabase(options: OpenStoreOptions): BetterSqlite3.Database {
  const readonly = options.readonly ?? false;

  if (options.path !== ':memory:') {
    options.storage.mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new BetterSqlite3(options.path, { readonly });

  if (!readonly) {
    db.pragma('journal_mode = WAL');
  }

  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);

  if (options.readonly !== true) {
    applyStoreSchemas({
      db,
      storage: options.storage,
      schemasDir: options.schemasDir,
    });
  }

  try {
    assertSupportedStoreSchema(db);
  } catch (error) {
    if (options.path === ':memory:') {
      db.close();
      throw error;
    }

    db.close();
    throw new Error(
      `Store schema at ${options.path} is not readable by this Coral build. Reset local Coral store data and rebuild.`,
      { cause: error },
    );
  }

  return db;
}

type OpenBackendStoreOptions = {
  readonly path?: string;
};

export function openBackendStoreDb(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  options: OpenBackendStoreOptions = {},
): BetterSqlite3.Database {
  const storeDbPath = options.path ?? runtime.paths.coral.store.dbFile;

  if (storeDbPath !== ':memory:') {
    runtime.storage.mkdirSync(dirname(storeDbPath), { recursive: true });
  }

  return openStoreDatabase({
    path: storeDbPath === ':memory:' ? ':memory:' : existsSync(dirname(storeDbPath)) ? storeDbPath : ':memory:',
    storage: runtime.storage,
    schemasDir: ensureStoreSchemasDir(runtime.storage),
  });
}

export type Database = BetterSqlite3.Database;
