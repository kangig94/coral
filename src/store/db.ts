import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import type { StoragePort } from '../infra/port-types.js';
import { compareProductVersions, validateProductVersion } from '../infra/product-version.js';
import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { ReadonlyDatabase, ReadonlyStatement } from './read-port.js';
import {
  isStoreFormatFingerprint,
  type StoreFormatClassification,
  type StoreFormatDescription,
} from './format-fingerprint.js';

const STORE_FORMAT_FINGERPRINT_KEY = 'store_format_fingerprint';
const STORE_PRODUCT_VERSION_KEY = 'store_product_version';
const STORE_FORMAT_SIDECAR_SUFFIX = '.format';

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
export interface Statement<TParams extends unknown[] = unknown[], TRow = unknown> extends Omit<
  StatementSync,
  'get' | 'all' | 'iterate' | 'run'
> {
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
  readonly storeFormat: StoreFormatDescription;
  readonly flavor?: BuildFlavor;
  readonly readonly: true;
  readonly busyTimeoutMs?: number;
};

type WritableStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
  readonly storeFormat: StoreFormatDescription;
  readonly flavor?: BuildFlavor;
  readonly readonly?: false;
  readonly busyTimeoutMs?: number;
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

const USER_TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1";

function hasUserTable(db: Database): boolean {
  return db.prepare(USER_TABLE_EXISTS_SQL).get() !== undefined;
}

type StoredMetadataValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly value: unknown }
  | { readonly kind: 'unsupported' };

function readStoredMetadataValue(db: Database, key: string): StoredMetadataValue {
  try {
    const row = db.prepare<[string], { value?: unknown }>('SELECT value FROM meta WHERE key = ? LIMIT 1').get(key);
    return row === undefined ? { kind: 'absent' } : { kind: 'present', value: row.value };
  } catch (error: unknown) {
    if (error instanceof Error && /no such table: meta/i.test(error.message)) {
      return { kind: 'absent' };
    }
    if (error instanceof Error && /no such column/i.test(error.message)) {
      return { kind: 'unsupported' };
    }
    throw error;
  }
}

function stringMetadataValue(metadata: StoredMetadataValue): string | null {
  return metadata.kind === 'present' && typeof metadata.value === 'string' ? metadata.value : null;
}

function corruptOrUnsupported(
  current: StoreFormatDescription,
  storedFingerprint: string | null,
  storedProductVersion: string | null,
): StoreFormatClassification {
  return {
    kind: 'corrupt-or-unsupported',
    currentFingerprint: current.fingerprint,
    currentProductVersion: current.productVersion,
    storedFingerprint,
    storedProductVersion,
  };
}

export function classifyStoreFormat(db: Database, current: StoreFormatDescription): StoreFormatClassification {
  if (!isStoreFormatFingerprint(current.fingerprint)) {
    throw new TypeError(`Invalid current store format fingerprint: ${current.fingerprint}`);
  }
  const currentProductVersion = validateProductVersion(current.productVersion);
  if (currentProductVersion === null) {
    throw new TypeError(`Invalid current Coral product version: ${current.productVersion}`);
  }

  if (!hasUserTable(db)) return { kind: 'fresh' };

  const fingerprintMetadata = readStoredMetadataValue(db, STORE_FORMAT_FINGERPRINT_KEY);
  const versionMetadata = readStoredMetadataValue(db, STORE_PRODUCT_VERSION_KEY);
  const storedFingerprint = stringMetadataValue(fingerprintMetadata);
  const storedProductVersion = stringMetadataValue(versionMetadata);

  if (!isStoreFormatFingerprint(storedFingerprint)) {
    return corruptOrUnsupported(current, storedFingerprint, storedProductVersion);
  }

  if (versionMetadata.kind === 'absent') {
    return storedFingerprint === current.fingerprint
      ? {
          kind: 'legacy-adoptable',
          currentFingerprint: current.fingerprint,
          currentProductVersion,
          storedFingerprint,
        }
      : corruptOrUnsupported(current, storedFingerprint, null);
  }

  if (storedProductVersion === null) {
    return corruptOrUnsupported(current, storedFingerprint, null);
  }
  const validStoredProductVersion = validateProductVersion(storedProductVersion);
  if (validStoredProductVersion === null) {
    return corruptOrUnsupported(current, storedFingerprint, storedProductVersion);
  }

  const precedence = compareProductVersions(validStoredProductVersion, currentProductVersion);
  const identity = {
    currentFingerprint: current.fingerprint,
    currentProductVersion,
    storedFingerprint,
    storedProductVersion,
  };
  if (precedence > 0) return { kind: 'newer-incompatible', ...identity };
  if (storedFingerprint === current.fingerprint) return { kind: 'compatible', ...identity };
  if (precedence < 0) return { kind: 'older-incompatible', ...identity };
  return { kind: 'corrupt-or-unsupported', ...identity };
}

export function classifyStoreFile(
  path: string,
  storage: Pick<StoragePort, 'existsSync'>,
  current: StoreFormatDescription,
): StoreFormatClassification {
  if (path !== ':memory:' && !storage.existsSync(path)) return { kind: 'absent' };
  const db = new DatabaseSync(path, { readOnly: path !== ':memory:' }) as unknown as Database;
  try {
    return classifyStoreFormat(db, current);
  } finally {
    db.close();
  }
}

function writeStoreFormatSidecar(options: WritableStoreOptions): void {
  if (options.path === ':memory:') return;
  const sidecarPath = `${options.path}${STORE_FORMAT_SIDECAR_SUFFIX}`;
  if (
    !options.storage.writeAtomicDurableSync(sidecarPath, `${options.storeFormat.fingerprint}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    throw new Error(`Failed to publish store format sidecar '${sidecarPath}'.`);
  }
}

function storeSchemaOutdatedError(
  path: string,
  classification: StoreFormatClassification,
  current: StoreFormatDescription,
  flavor: BuildFlavor | undefined,
): Error {
  const version = 'storedProductVersion' in classification ? classification.storedProductVersion : null;
  return documentedCoralSetupError({
    code: 'store_schema_outdated',
    path,
    storedFingerprint: 'storedFingerprint' in classification ? classification.storedFingerprint : null,
    version,
    ...(flavor === undefined ? {} : { flavor }),
    currentFingerprint: current.fingerprint,
    currentProductVersion: current.productVersion,
    classification: classification.kind,
  });
}

export function applyBundledStoreSchema(db: Database, storeFormat: StoreFormatDescription): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(storeFormat.manifest.ddl);
    const existing = stringMetadataValue(readStoredMetadataValue(db, STORE_FORMAT_FINGERPRINT_KEY));
    if (existing !== null && existing !== storeFormat.fingerprint) {
      throw new Error(`Refusing to apply schema over store format '${existing}'.`);
    }
    db.prepare<[string, string]>(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(
      STORE_FORMAT_FINGERPRINT_KEY,
      storeFormat.fingerprint,
    );
    db.prepare<[string, string]>(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(
      STORE_PRODUCT_VERSION_KEY,
      storeFormat.productVersion,
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original schema-application failure.
    }
    throw error;
  }
}

function raiseStoredProductVersion(db: Database, currentProductVersion: string): void {
  withImmediate(db, () => {
    const storedProductVersion = stringMetadataValue(readStoredMetadataValue(db, STORE_PRODUCT_VERSION_KEY));
    if (storedProductVersion === null || validateProductVersion(storedProductVersion) === null) return;
    if (compareProductVersions(storedProductVersion, currentProductVersion) >= 0) return;

    db.prepare<[string, string]>('UPDATE meta SET value = ? WHERE key = ?').run(
      currentProductVersion,
      STORE_PRODUCT_VERSION_KEY,
    );
  });
}

export function openStoreDatabase(options: OpenStoreOptions): Database {
  const readonly = options.readonly ?? false;

  if (readonly && options.path !== ':memory:' && !options.storage.existsSync(options.path)) {
    throw documentedCoralSetupError('store_not_initialized', { path: options.path });
  }

  if (!readonly && options.path !== ':memory:') {
    options.storage.mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new DatabaseSync(options.path, { readOnly: readonly }) as unknown as Database;

  try {
    if (readonly) {
      applyJournalPragmas(db, {
        kind: 'readonly',
        busyTimeoutMs: options.busyTimeoutMs,
      });
    }

    const classification = classifyStoreFormat(db, options.storeFormat);
    if (classification.kind === 'legacy-adoptable') {
      // Only explicit adoption may stamp this state, and it does so in the legacy
      // tree before the atomic flavor-root rename. Ordinary opens never write it.
      throw storeSchemaOutdatedError(options.path, classification, options.storeFormat, options.flavor);
    }
    if (classification.kind === 'compatible') {
      if (!readonly) {
        applyJournalPragmas(db, {
          kind: 'writable',
          busyTimeoutMs: options.busyTimeoutMs,
        });
        raiseStoredProductVersion(db, options.storeFormat.productVersion);
      }
      if (options.readonly !== true) writeStoreFormatSidecar(options);
      return db;
    }

    if (readonly) {
      throw storeSchemaOutdatedError(options.path, classification, options.storeFormat, options.flavor);
    }

    if (classification.kind === 'fresh') {
      applyJournalPragmas(db, {
        kind: 'writable',
        busyTimeoutMs: options.busyTimeoutMs,
      });
      applyBundledStoreSchema(db, options.storeFormat);
      writeStoreFormatSidecar(options as WritableStoreOptions);
      return db;
    }

    throw storeSchemaOutdatedError(options.path, classification, options.storeFormat, options.flavor);
  } catch (error) {
    db.close();
    throw error;
  }
}

type BackendStorePathOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
  readonly storeFormat: StoreFormatDescription;
};

function resolveStoreDbPath(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions): string {
  if (options.path === ':memory:') {
    return ':memory:';
  }
  return resolve(options.path ?? runtime.paths.coral.store.dbFile);
}

export function openWritableStoreDbNoReset(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage'>,
  options: BackendStorePathOptions,
): Database {
  const storeDbPath = resolveStoreDbPath(runtime, options);
  // An absent store is not an outdated one: only the coordinator creates it, so
  // a non-daemon opener that creates it here would satisfy adoption's
  // "generation tree has no store" guard and strand the legacy tree forever.
  if (storeDbPath === ':memory:' || !runtime.storage.existsSync(storeDbPath)) {
    throw documentedCoralSetupError('store_not_initialized', { path: storeDbPath });
  }

  return openStoreDatabase({
    path: storeDbPath,
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    flavor: runtime.flavor,
    busyTimeoutMs: options.busyTimeoutMs,
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

/**
 * Render `count` comma-separated `?` bind placeholders for an `IN (...)` clause
 * or multi-row `VALUES`. Empty string when `count <= 0` (callers must guard
 * against emitting `IN ()`, which is not valid SQL).
 */
export function sqlPlaceholders(count: number): string {
  const placeholders: string[] = [];
  for (let index = 0; index < count; index += 1) {
    placeholders.push('?');
  }
  return placeholders.join(', ');
}
