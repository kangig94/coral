import BetterSqlite3 from 'better-sqlite3';
import { dirname } from 'node:path';

import type { StoragePort } from '../runtime/ports.js';
import { applyMigrations } from './migrations.js';

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

export type Database = BetterSqlite3.Database;
