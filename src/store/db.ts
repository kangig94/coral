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

/**
 * Journal pragma configuration mode.
 *
 * - `writable`: WAL + `synchronous=FULL` (power-loss durable per spec §3).
 * - `readonly`: only `foreign_keys` + `busy_timeout` (readonly handles cannot
 *   issue WAL/synchronous pragmas).
 * - `rebuild`: WAL + `synchronous=NORMAL` for test/regression bulk-replay
 *   utilities that rebuild from a survived source. Production never uses this
 *   mode — the durability contract is FULL.
 */
export type JournalPragmaMode =
  | { kind: 'writable'; busyTimeoutMs?: number }
  | { kind: 'readonly'; busyTimeoutMs?: number }
  | { kind: 'rebuild'; busyTimeoutMs?: number };

/**
 * Apply the canonical journal pragma surface to a SQLite handle.
 *
 * This is the single configuration site for `journal_mode`, `synchronous`,
 * `foreign_keys`, and `busy_timeout`. `openStoreDatabase` calls this helper;
 * no other site in `src/store/db.ts` issues these pragmas.
 */
export function applyJournalPragmas(db: BetterSqlite3.Database, mode: JournalPragmaMode): void {
  const busyTimeoutMs = mode.busyTimeoutMs ?? 5000;
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  if (mode.kind === 'writable') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  } else if (mode.kind === 'rebuild') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}

export function openStoreDatabase(options: OpenStoreOptions): BetterSqlite3.Database {
  const readonly = options.readonly ?? false;

  if (options.path !== ':memory:') {
    options.storage.mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new BetterSqlite3(options.path, { readonly });

  applyJournalPragmas(db, {
    kind: readonly ? 'readonly' : 'writable',
    busyTimeoutMs: options.busyTimeoutMs,
  });

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

  // existsSync intentionally queries the real fs: better-sqlite3 itself opens
  // through ambient `node:fs`, so the directory's existence on disk is what
  // determines whether the disk path or the in-memory fallback is viable.
  // Tests with a virtual StoragePort rely on this real-fs check to fall back
  // to `:memory:` when their virtual mkdir never landed on disk.
  return openStoreDatabase({
    path: storeDbPath === ':memory:' ? ':memory:' : existsSync(dirname(storeDbPath)) ? storeDbPath : ':memory:',
    storage: runtime.storage,
    schemasDir: ensureStoreSchemasDir(runtime.storage),
  });
}

export type Database = BetterSqlite3.Database;
