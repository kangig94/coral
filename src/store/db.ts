import BetterSqlite3 from 'better-sqlite3';
import { readFileSync as readNodeFileSync, readdirSync as readNodeDirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { StoragePort } from '../runtime/ports.js';
import { applyMigrations } from './migrations.js';

export interface OpenStoreOptions {
  readonly path: string;
  readonly storage: StoragePort;
  readonly readonly?: boolean;
  readonly busyTimeoutMs?: number;
  readonly migrationsDir?: string;
}

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

  if (!readonly) {
    const migrationStorage =
      options.migrationsDir === undefined
        ? {
            readdirSync: (dirPath: string, dirOptions: { withFileTypes: true }) => readNodeDirSync(dirPath, dirOptions),
            readFileSync: (filePath: string, encoding: 'utf-8') => readNodeFileSync(filePath, encoding),
          }
        : {
            readdirSync: options.storage.readdirSync.bind(options.storage),
            readFileSync: options.storage.readFileSync.bind(options.storage),
          };
    applyMigrations({
      db,
      storage: migrationStorage,
      migrationsDir: options.migrationsDir,
    });
  }

  return db;
}

export type Database = BetterSqlite3.Database;
