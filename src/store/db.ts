import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { dirname } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import type { StoragePort } from '../infra/port-types.js';
import { compareProductVersions, validateProductVersion } from '../infra/product-version.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { ReadonlyDatabase, ReadonlyStatement } from './read-types.js';
import {
  isStoreFormatFingerprint,
  STORE_FORMAT_FINGERPRINT_META_KEY,
  STORE_PRODUCT_VERSION_META_KEY,
  type StoreFormatClassification,
  type StoreFormatDescription,
  type StoreFormatFingerprint,
} from './format-fingerprint.js';
import { observeStorePath } from './path-observation.js';

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
  readonly storage: Pick<StoragePort, 'lstatSync'>;
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
  readonly busyTimeoutDeadline?: Readonly<{
    expiresAt: bigint;
    monotonicNow: () => bigint;
  }>;
};

type AuthorizedWritableStoreOptions = WritableStoreOptions;

export type WritableStoreOpenDecision =
  | { readonly kind: 'opened'; readonly db: Database }
  | {
      readonly kind: 'incompatible';
      readonly classification: Extract<
        StoreFormatClassification,
        { readonly kind: 'older-incompatible' | 'newer-incompatible' | 'corrupt-or-unsupported' }
      >;
    };

export type OpenStoreOptions = ReadonlyStoreOptions | WritableStoreOptions;

export type StoreFormatClassificationTarget = Readonly<{
  fingerprint: string;
  productVersion: string;
}>;

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

function applyBusyTimeout(db: Database, busyTimeoutMs?: number): void {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs ?? 5000}`);
}

type BeforeDatabaseOperation = (() => void) | undefined;

export function applyJournalPragmas(
  db: Database,
  mode: JournalPragmaMode,
  beforeOperation?: BeforeDatabaseOperation,
): void {
  beforeOperation?.();
  db.exec('PRAGMA foreign_keys = ON');
  if (beforeOperation === undefined) applyBusyTimeout(db, mode.busyTimeoutMs);
  if (mode.kind === 'writable') {
    beforeOperation?.();
    db.exec('PRAGMA journal_mode = WAL');
    beforeOperation?.();
    db.exec('PRAGMA synchronous = FULL');
  } else if (mode.kind === 'rebuild') {
    beforeOperation?.();
    db.exec('PRAGMA journal_mode = WAL');
    beforeOperation?.();
    db.exec('PRAGMA synchronous = NORMAL');
  }
}

const USER_TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1";

function hasUserTable(db: Database, beforeOperation?: BeforeDatabaseOperation): boolean {
  beforeOperation?.();
  return db.prepare(USER_TABLE_EXISTS_SQL).get() !== undefined;
}

type StoredMetadataValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly value: unknown }
  | { readonly kind: 'unsupported' };

function readStoredMetadataValue(
  db: Database,
  key: string,
  beforeOperation?: BeforeDatabaseOperation,
): StoredMetadataValue {
  try {
    beforeOperation?.();
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
  currentFingerprint: StoreFormatFingerprint,
  currentProductVersion: string,
  storedFingerprint: string | null,
  storedProductVersion: string | null,
  storedProductVersionState: Extract<
    StoreFormatClassification,
    { kind: 'corrupt-or-unsupported' }
  >['storedProductVersionState'],
): StoreFormatClassification {
  return {
    kind: 'corrupt-or-unsupported',
    currentFingerprint,
    currentProductVersion,
    storedFingerprint,
    storedProductVersion,
    storedProductVersionState,
  };
}

function validatedStoreFormatTarget(current: StoreFormatClassificationTarget): {
  readonly fingerprint: StoreFormatFingerprint;
  readonly productVersion: string;
} {
  const currentFingerprint = current.fingerprint;
  if (!isStoreFormatFingerprint(currentFingerprint)) {
    throw new TypeError(`Invalid current store format fingerprint: ${currentFingerprint}`);
  }
  const currentProductVersion = validateProductVersion(current.productVersion);
  if (currentProductVersion === null) {
    throw new TypeError(`Invalid current Coral product version: ${current.productVersion}`);
  }
  return { fingerprint: currentFingerprint, productVersion: currentProductVersion };
}

export function classifyStoreFormat(
  db: Database,
  current: StoreFormatClassificationTarget,
  beforeOperation?: BeforeDatabaseOperation,
): StoreFormatClassification {
  const { fingerprint: currentFingerprint, productVersion: currentProductVersion } =
    validatedStoreFormatTarget(current);

  if (!hasUserTable(db, beforeOperation)) return { kind: 'fresh' };

  const fingerprintMetadata = readStoredMetadataValue(db, STORE_FORMAT_FINGERPRINT_META_KEY, beforeOperation);
  const versionMetadata = readStoredMetadataValue(db, STORE_PRODUCT_VERSION_META_KEY, beforeOperation);
  const storedFingerprint = stringMetadataValue(fingerprintMetadata);
  const rawStoredProductVersion = stringMetadataValue(versionMetadata);
  const storedProductVersion =
    rawStoredProductVersion === null ? null : validateProductVersion(rawStoredProductVersion);
  const storedProductVersionState =
    versionMetadata.kind === 'absent'
      ? ('absent' as const)
      : storedProductVersion === null
        ? ('invalid' as const)
        : ('valid' as const);

  if (!isStoreFormatFingerprint(storedFingerprint)) {
    return corruptOrUnsupported(
      currentFingerprint,
      currentProductVersion,
      storedFingerprint,
      storedProductVersion,
      storedProductVersionState,
    );
  }

  if (versionMetadata.kind === 'absent') {
    return corruptOrUnsupported(currentFingerprint, currentProductVersion, storedFingerprint, null, 'absent');
  }

  if (storedProductVersion === null) {
    return corruptOrUnsupported(currentFingerprint, currentProductVersion, storedFingerprint, null, 'invalid');
  }

  const precedence = compareProductVersions(storedProductVersion, currentProductVersion);
  const identity = {
    currentFingerprint,
    currentProductVersion,
    storedFingerprint,
    storedProductVersion,
  };
  if (precedence > 0) return { kind: 'newer-incompatible', ...identity };
  if (storedFingerprint === currentFingerprint) return { kind: 'compatible', ...identity };
  if (precedence < 0) return { kind: 'older-incompatible', ...identity };
  return { kind: 'corrupt-or-unsupported', storedProductVersionState: 'valid', ...identity };
}

export function classifyStoreFile(
  path: string,
  storage: Pick<StoragePort, 'lstatSync' | 'openSqliteDatabaseSync'>,
  current: StoreFormatClassificationTarget,
  acquireLock: (() => () => void) | null = null,
): StoreFormatClassification {
  if (path !== ':memory:' && observeStorePath(storage, path) === 'absent') return { kind: 'absent' };
  if (path !== ':memory:' && storage.lstatSync(path).isSymbolicLink()) {
    const target = validatedStoreFormatTarget(current);
    return corruptOrUnsupported(target.fingerprint, target.productVersion, null, null, 'unavailable');
  }
  const releaseLock = acquireLock?.();
  let db: ReturnType<typeof storage.openSqliteDatabaseSync> | undefined;
  try {
    db = storage.openSqliteDatabaseSync(path, { readOnly: path !== ':memory:' });
    return classifyStoreFormat(db as unknown as Database, current);
  } finally {
    try {
      db?.close();
    } finally {
      releaseLock?.();
    }
  }
}

function writeStoreFormatSidecar(options: AuthorizedWritableStoreOptions, db: Database): void {
  if (options.path === ':memory:') return;
  const sidecarPath = `${db.location() ?? options.path}${STORE_FORMAT_SIDECAR_SUFFIX}`;
  if (
    !options.storage.writeAtomicDurableSync(sidecarPath, `${options.storeFormat.fingerprint}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    throw new Error(`Failed to publish store format sidecar '${sidecarPath}'.`);
  }
}

export function storeSchemaOutdatedError(
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

export function applyBundledStoreSchema(
  db: Database,
  storeFormat: StoreFormatDescription,
  beforeOperation?: BeforeDatabaseOperation,
): void {
  beforeOperation?.();
  db.exec('BEGIN IMMEDIATE');
  try {
    beforeOperation?.();
    db.exec(storeFormat.manifest.ddl);
    const existing = stringMetadataValue(
      readStoredMetadataValue(db, STORE_FORMAT_FINGERPRINT_META_KEY, beforeOperation),
    );
    if (existing !== null && existing !== storeFormat.fingerprint) {
      throw new StoreFormatChangedDuringAdoptionError(existing);
    }
    beforeOperation?.();
    db.prepare<[string, string]>(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(
      STORE_FORMAT_FINGERPRINT_META_KEY,
      storeFormat.fingerprint,
    );
    beforeOperation?.();
    db.prepare<[string, string]>(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(
      STORE_PRODUCT_VERSION_META_KEY,
      storeFormat.productVersion,
    );
    beforeOperation?.();
    db.exec('COMMIT');
  } catch (error) {
    try {
      beforeOperation?.();
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original schema-application failure.
    }
    throw error;
  }
}

export class StoreFormatChangedDuringAdoptionError extends Error {
  readonly storedFingerprint: string;

  constructor(storedFingerprint: string) {
    super(`Store format changed during adoption to '${storedFingerprint}'.`);
    this.name = 'StoreFormatChangedDuringAdoptionError';
    this.storedFingerprint = storedFingerprint;
    Object.setPrototypeOf(this, StoreFormatChangedDuringAdoptionError.prototype);
  }
}

function raiseStoredProductVersion(
  db: Database,
  currentProductVersion: string,
  beforeOperation?: BeforeDatabaseOperation,
): void {
  withImmediate(
    db,
    () => {
      const storedProductVersion = stringMetadataValue(
        readStoredMetadataValue(db, STORE_PRODUCT_VERSION_META_KEY, beforeOperation),
      );
      if (storedProductVersion === null || validateProductVersion(storedProductVersion) === null) return;
      if (compareProductVersions(storedProductVersion, currentProductVersion) >= 0) return;

      beforeOperation?.();
      db.prepare<[string, string]>('UPDATE meta SET value = ? WHERE key = ?').run(
        currentProductVersion,
        STORE_PRODUCT_VERSION_META_KEY,
      );
    },
    beforeOperation,
  );
}

function deadlineBusyTimeoutRefresher(db: Database, options: AuthorizedWritableStoreOptions): BeforeDatabaseOperation {
  const deadline = options.busyTimeoutDeadline;
  if (deadline === undefined) return undefined;
  return () => {
    const remainingMs = Math.max(1, Number(deadline.expiresAt - deadline.monotonicNow()));
    applyBusyTimeout(db, Math.min(options.busyTimeoutMs ?? remainingMs, remainingMs));
  };
}

export function openWritableStoreDatabase(options: AuthorizedWritableStoreOptions): WritableStoreOpenDecision {
  if (options.path !== ':memory:') {
    options.storage.mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new DatabaseSync(options.path) as unknown as Database;
  try {
    const beforeOperation = deadlineBusyTimeoutRefresher(db, options);
    if (beforeOperation === undefined && options.busyTimeoutMs !== undefined) {
      applyBusyTimeout(db, options.busyTimeoutMs);
    }
    const classification = classifyStoreFormat(db, options.storeFormat, beforeOperation);
    if (classification.kind === 'compatible') {
      applyJournalPragmas(
        db,
        {
          kind: 'writable',
          busyTimeoutMs: options.busyTimeoutMs,
        },
        beforeOperation,
      );
      raiseStoredProductVersion(db, options.storeFormat.productVersion, beforeOperation);
      writeStoreFormatSidecar(options, db);
      return { kind: 'opened', db };
    }
    if (classification.kind === 'fresh' || classification.kind === 'absent') {
      applyJournalPragmas(
        db,
        {
          kind: 'writable',
          busyTimeoutMs: options.busyTimeoutMs,
        },
        beforeOperation,
      );
      applyBundledStoreSchema(db, options.storeFormat, beforeOperation);
      writeStoreFormatSidecar(options, db);
      return { kind: 'opened', db };
    }
    db.close();
    return { kind: 'incompatible', classification };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Revocation may already have closed the authority-owned handle.
    }
    throw error;
  }
}

export function openStoreDatabase(options: OpenStoreOptions): Database {
  const readonly = options.readonly ?? false;

  if (!readonly) {
    const writable = options as WritableStoreOptions;
    const decision = openWritableStoreDatabase(writable);
    if (decision.kind === 'opened') return decision.db;
    throw storeSchemaOutdatedError(options.path, decision.classification, options.storeFormat, options.flavor);
  }

  if (options.path !== ':memory:' && observeStorePath(options.storage, options.path) === 'absent') {
    throw documentedCoralSetupError('store_not_initialized', { path: options.path });
  }

  const db = new DatabaseSync(options.path, { readOnly: true }) as unknown as Database;

  try {
    applyJournalPragmas(db, {
      kind: 'readonly',
      busyTimeoutMs: options.busyTimeoutMs,
    });

    const classification = classifyStoreFormat(db, options.storeFormat);
    if (classification.kind === 'compatible') {
      return db;
    }

    throw storeSchemaOutdatedError(options.path, classification, options.storeFormat, options.flavor);
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openMemoryStoreDatabase(storeFormat: StoreFormatDescription, busyTimeoutMs?: number): Database {
  const db = new DatabaseSync(':memory:') as unknown as Database;
  try {
    applyJournalPragmas(db, { kind: 'writable', busyTimeoutMs });
    applyBundledStoreSchema(db, storeFormat);
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

/**
 * Per-database cache of prepared statements keyed by SQL source. Re-preparing
 * the same statement is wasted work — node:sqlite plans on each `prepare`.
 * The cache keeps statement reuse cheap without requiring every call site to
 * thread a class instance.
 *
 * The overloads narrow the return type by the handle's read/write
 * capability — preventing accidental writes through a read-only handle.
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
 * Every commit path locks for write up front, so no read-then-upgrade race
 * exists. If a future call site needs DEFERRED or savepoint nesting, add the
 * helper at that moment.
 */
export function withImmediate<T>(db: Database, fn: () => T, beforeOperation?: BeforeDatabaseOperation): T {
  beforeOperation?.();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    beforeOperation?.();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    beforeOperation?.();
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
