import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BuildFlavor } from '../runtime/flavor.js';
import type { Runtime, StoragePort } from '../runtime/ports.js';
import { applyMigrations, ensureStoreMigrationsDir } from './migrations.js';
import { storePaths } from './paths.js';

type ReadonlyStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
  readonly readonly: true;
  readonly busyTimeoutMs?: number;
  readonly migrationsDir?: string;
};

type WritableStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
  readonly readonly?: false;
  readonly busyTimeoutMs?: number;
  readonly migrationsDir: string;
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
    applyMigrations({
      db,
      storage: options.storage,
      migrationsDir: options.migrationsDir,
    });
  }

  return db;
}

type OpenBackendStoreOptions = {
  readonly path?: string;
};

export function openBackendStoreDb(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  flavor: BuildFlavor,
  options: OpenBackendStoreOptions = {},
): BetterSqlite3.Database {
  let storeDbPath = options.path ?? storePaths(flavor).dbFile;
  if (options.path === undefined) {
    try {
      storeDbPath = runtime.paths.coral.store.dbFile;
    } catch {
      // Some tests intentionally bypass flavor-settled bootstrap.
    }
  }

  if (storeDbPath !== ':memory:') {
    runtime.storage.mkdirSync(dirname(storeDbPath), { recursive: true });
  }

  return openStoreDatabase({
    path: storeDbPath === ':memory:' ? ':memory:' : existsSync(dirname(storeDbPath)) ? storeDbPath : ':memory:',
    storage: runtime.storage,
    migrationsDir: ensureStoreMigrationsDir(runtime.storage),
  });
}

export type Database = BetterSqlite3.Database;
