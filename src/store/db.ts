import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { StoragePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ReadonlyDatabase, ReadonlyStatement } from './read-port.js';
import { applyStoreSchemas, assertSupportedStoreSchema, ensureStoreSchemasDir } from './schema-loader.js';

/**
 * Result of a `Statement.run(...)` invocation.
 *
 * `changes` and `lastInsertRowid` are widened to `number | bigint` because
 * node:sqlite returns `bigint` when `setReadBigInts(true)` is in effect or when
 * a value exceeds `Number.MAX_SAFE_INTEGER`. Coral never opts into bigints, so
 * call sites can treat both fields as `number` in practice.
 */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * Typed prepared statement. Wraps `node:sqlite`'s `StatementSync` with bind-
 * parameter and result generics so call sites can express their row shape
 * once at `prepare(...)` instead of casting on every `.get/.all`.
 */
export interface Statement<TParams extends unknown[] = unknown[], TRow = unknown>
  extends Omit<StatementSync, 'get' | 'all' | 'iterate' | 'run'> {
  get(...params: TParams): TRow | undefined;
  all(...params: TParams): TRow[];
  iterate(...params: TParams): IterableIterator<TRow>;
  run(...params: TParams): RunResult;
}

/**
 * Typed SQLite database handle. Wraps `node:sqlite`'s `DatabaseSync` with a
 * generic `prepare(...)` so call sites can carry bind-param + row types.
 */
export interface Database extends Omit<DatabaseSync, 'prepare'> {
  prepare<TParams extends unknown[] = unknown[], TRow = unknown>(sql: string): Statement<TParams, TRow>;
}

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
 * no other site issues these pragmas.
 */
export function applyJournalPragmas(db: Database, mode: JournalPragmaMode): void {
  const busyTimeoutMs = mode.busyTimeoutMs ?? 5000;
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  if (mode.kind === 'writable') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  } else if (mode.kind === 'rebuild') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
}

export function openStoreDatabase(options: OpenStoreOptions): Database {
  const readonly = options.readonly ?? false;

  if (options.path !== ':memory:') {
    options.storage.mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new DatabaseSync(options.path, { readOnly: readonly }) as unknown as Database;

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
): Database {
  const storeDbPath = options.path ?? runtime.paths.coral.store.dbFile;

  if (storeDbPath !== ':memory:') {
    runtime.storage.mkdirSync(dirname(storeDbPath), { recursive: true });
  }

  // existsSync intentionally queries the real fs: node:sqlite itself opens
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

/**
 * Per-database cache of prepared statements keyed by SQL source. Re-preparing
 * the same statement is wasted work — node:sqlite plans on each `prepare`,
 * and better-sqlite3's contract was the same. The cache keeps statement reuse
 * cheap without requiring every call site to thread a class instance.
 *
 * The overloads narrow the return type by the handle's read/write capability:
 * passing a `Database` returns a full `Statement` (run/get/all/iterate),
 * passing a `ReadonlyDatabase` returns a `ReadonlyStatement` (get/all/iterate
 * only) — preventing accidental writes through a read-only handle.
 */
type AnySqliteHandle = Database | ReadonlyDatabase;
const statementCache = new WeakMap<AnySqliteHandle, Map<string, unknown>>();

export function prepareCached<TParams extends unknown[] = unknown[], TRow = unknown>(
  db: Database,
  sql: string,
): Statement<TParams, TRow>;
export function prepareCached<TParams extends unknown[] = unknown[], TRow = unknown>(
  db: ReadonlyDatabase,
  sql: string,
): ReadonlyStatement<TParams, TRow>;
export function prepareCached<TParams extends unknown[] = unknown[], TRow = unknown>(
  db: AnySqliteHandle,
  sql: string,
): Statement<TParams, TRow> | ReadonlyStatement<TParams, TRow> {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  const cached = cache.get(sql);
  if (cached) {
    return cached as Statement<TParams, TRow>;
  }
  const statement = db.prepare<TParams, TRow>(sql);
  cache.set(sql, statement);
  return statement as Statement<TParams, TRow>;
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` ... `COMMIT` transaction. On any thrown
 * error the transaction is rolled back and the error re-thrown.
 *
 * IMMEDIATE is the only transaction mode coral uses: every commit path locks
 * for write up front, so no read-then-upgrade race exists. If a future call
 * site needs DEFERRED or savepoint nesting, add the helper at that moment.
 */
export function withImmediate<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
