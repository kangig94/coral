import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import type { StoragePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { ReadonlyDatabase, ReadonlyStatement } from './read-port.js';
import schemaSource from './schema.sql';

// Signed 32-bit djb2-style hash of the bundled schema, stored as
// `PRAGMA user_version` after schema application. Any meaningful edit to
// `schema.sql` is overwhelmingly likely to produce a different marker on
// disk (32-bit collisions are theoretically possible but irrelevant at
// real-world schema-iteration counts). Boot-time mismatch detection is a
// single integer compare; the value itself has no meaning beyond "this DB
// matches this build's schema". SQLite's `user_version` is a signed 32-bit
// field — the hash is kept signed (no `>>> 0`) so the value round-trips
// through the PRAGMA without truncation.
function schemaMarkerHash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return h;
}
const EXPECTED_SCHEMA_MARKER = schemaMarkerHash(schemaSource);

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
  readonly readonly: true;
  readonly busyTimeoutMs?: number;
};

type WritableStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
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

type StoreSchemaClassification =
  | { kind: 'fresh'; userVersion: 0; storedVersion: 0 }
  | { kind: 'legacy'; userVersion: 0; storedVersion: number }
  | { kind: 'current'; userVersion: number; storedVersion: number }
  | { kind: 'mismatch'; userVersion: number; storedVersion: number };

const USER_TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1";

const CORAL_LEGACY_TABLES = [
  'events',
  'projection_jobs',
  'projection_sessions',
  'projection_discuss',
  'projection_workflows',
  'meta',
  'kb_corpus_state',
  'kb_corpus_authority_baseline',
  'consumer_cursors',
  'expansion_state',
  'kb_curate_scheduler',
  'kb_curate_active_claim',
  'kb_curate_retry_queue',
  'kb_curate_conflict_quarantine',
  'kb_curate_discovery_backlog',
  'kb_curate_discovery_backlog_notes',
  'expansion_manifest_catalog',
] as const;

function readUserVersion(db: Database): number {
  const row = db.prepare<[], { user_version?: unknown }>('PRAGMA user_version').get();
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

function hasUserTable(db: Database): boolean {
  return db.prepare(USER_TABLE_EXISTS_SQL).get() !== undefined;
}

function readLegacyMetaSchemaVersion(db: Database): number | null {
  try {
    const row = db
      .prepare<[], { value?: unknown }>("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1")
      .get();
    if (typeof row?.value !== 'string') {
      return null;
    }
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error: unknown) {
    if (error instanceof Error && /no such table: meta/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function hasCoralLegacyTable(db: Database): boolean {
  const quotedNames = CORAL_LEGACY_TABLES.map((name) => `'${name}'`).join(', ');
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name IN (${quotedNames}) LIMIT 1`).get() !==
    undefined
  );
}

function classifyStoreSchema(db: Database): StoreSchemaClassification {
  const userVersion = readUserVersion(db);
  if (userVersion === EXPECTED_SCHEMA_MARKER) {
    return {
      kind: 'current',
      userVersion: EXPECTED_SCHEMA_MARKER,
      storedVersion: EXPECTED_SCHEMA_MARKER,
    };
  }

  if (userVersion === 0) {
    if (!hasUserTable(db)) {
      return { kind: 'fresh', userVersion: 0, storedVersion: 0 };
    }
    const legacyMetaVersion = readLegacyMetaSchemaVersion(db);
    if (legacyMetaVersion !== null || hasCoralLegacyTable(db)) {
      return { kind: 'legacy', userVersion: 0, storedVersion: legacyMetaVersion ?? 0 };
    }
  }

  return { kind: 'mismatch', userVersion, storedVersion: userVersion };
}

function storeSchemaOutdatedError(path: string, classification: StoreSchemaClassification): Error {
  return documentedCoralSetupError({
    code: 'store_schema_outdated',
    path,
    storedVersion: classification.storedVersion,
    currentVersion: EXPECTED_SCHEMA_MARKER,
    classification: classification.kind,
  });
}

export function applyBundledStoreSchema(db: Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schemaSource);
    db.exec(`PRAGMA user_version = ${EXPECTED_SCHEMA_MARKER}`);
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

export function openStoreDatabase(options: OpenStoreOptions): Database {
  const readonly = options.readonly ?? false;

  if (options.path !== ':memory:') {
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

    const classification = classifyStoreSchema(db);
    if (classification.kind === 'current') {
      if (!readonly) {
        applyJournalPragmas(db, {
          kind: 'writable',
          busyTimeoutMs: options.busyTimeoutMs,
        });
      }
      return db;
    }

    if (readonly) {
      throw storeSchemaOutdatedError(options.path, classification);
    }

    if (classification.kind === 'fresh') {
      applyJournalPragmas(db, {
        kind: 'writable',
        busyTimeoutMs: options.busyTimeoutMs,
      });
      applyBundledStoreSchema(db);
      return db;
    }

    throw storeSchemaOutdatedError(options.path, classification);
  } catch (error) {
    db.close();
    throw error;
  }
}

const BACKEND_STORE_RESET_AUTHORITY_BRAND: unique symbol = Symbol('BackendStoreResetAuthority');

export type BackendStoreResetAuthority = Readonly<{
  socketPath: string;
  storeDbPath: string;
  bundleHash: string;
  flavor: Runtime['flavor'];
  namespace: string;
  acquiredViaHandoff: boolean;
  issuedAt: number;
  [BACKEND_STORE_RESET_AUTHORITY_BRAND]: true;
}>;

type BackendStorePathOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
};

type BackendStoreIdentityOptions = {
  readonly bundleHash: string;
  readonly namespace: string;
};

type BackendStoreResetAuthorityOptions = BackendStorePathOptions & BackendStoreIdentityOptions;

type OpenOrResetBackendStoreOptions = BackendStorePathOptions & Partial<BackendStoreIdentityOptions>;

type StoreFileSet = {
  readonly dbDir: string;
  readonly dbFile: string;
  readonly walFile: string;
  readonly shmFile: string;
};

type StoreResetQuarantineFile = {
  readonly name: string;
  readonly source: string;
  readonly quarantinedPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly sha256: string;
};

type StoreResetQuarantineManifest = {
  readonly schemaVersion: 1;
  readonly resetAt: string;
  readonly pid: number;
  readonly reason: StoreSchemaClassification['kind'];
  readonly userVersion: number;
  readonly storedVersion: number;
  readonly expectedVersion: number;
  readonly dbFile: string;
  readonly quarantineDir: string;
  readonly files: StoreResetQuarantineFile[];
};

const STORE_RESET_QUARANTINE_MANIFEST = 'reset-manifest.json';

function resolveStoreDbPath(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions = {}): string {
  if (options.path === ':memory:') {
    return ':memory:';
  }
  return resolve(options.path ?? runtime.paths.coral.store.dbFile);
}

function resolveStoreFileSet(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions = {}): StoreFileSet {
  if (options.path === undefined) {
    const store = runtime.paths.coral.store;
    return {
      dbDir: store.dbDir,
      dbFile: store.dbFile,
      walFile: store.walFile,
      shmFile: store.shmFile,
    };
  }

  const dbFile = resolveStoreDbPath(runtime, options);
  return {
    dbDir: dirname(dbFile),
    dbFile,
    walFile: `${dbFile}-wal`,
    shmFile: `${dbFile}-shm`,
  };
}

export function createBackendStoreResetAuthority(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'time'>,
  handoff: { readonly acquiredViaHandoff: boolean },
  options: BackendStoreResetAuthorityOptions,
): BackendStoreResetAuthority {
  return {
    socketPath: runtime.paths.coral.coordinator.socketPath,
    storeDbPath: resolveStoreDbPath(runtime, options),
    bundleHash: options.bundleHash,
    flavor: runtime.flavor,
    namespace: options.namespace,
    acquiredViaHandoff: handoff.acquiredViaHandoff,
    issuedAt: runtime.time.now(),
    [BACKEND_STORE_RESET_AUTHORITY_BRAND]: true,
  };
}

function assertResetAuthority(
  runtime: Pick<Runtime, 'flavor' | 'paths'>,
  authority: BackendStoreResetAuthority,
  options: OpenOrResetBackendStoreOptions,
): void {
  const expectedStoreDbPath = resolveStoreDbPath(runtime, options);
  const expectedBundleHash = options.bundleHash ?? authority.bundleHash;
  const expectedNamespace = options.namespace ?? authority.namespace;
  const expected = {
    socketPath: runtime.paths.coral.coordinator.socketPath,
    storeDbPath: expectedStoreDbPath,
    bundleHash: expectedBundleHash,
    flavor: runtime.flavor,
    namespace: expectedNamespace,
  };

  const mismatches: string[] = [];
  if (authority.socketPath !== expected.socketPath) {
    mismatches.push('socketPath');
  }
  if (authority.storeDbPath !== expected.storeDbPath) {
    mismatches.push('storeDbPath');
  }
  if (authority.bundleHash !== expected.bundleHash) {
    mismatches.push('bundleHash');
  }
  if (authority.flavor !== expected.flavor) {
    mismatches.push('flavor');
  }
  if (authority.namespace !== expected.namespace) {
    mismatches.push('namespace');
  }

  if (mismatches.length > 0) {
    throw documentedCoralSetupError({
      code: 'store_schema_outdated',
      reason: 'reset_authority_mismatch',
      mismatches,
      expected,
      authority: {
        socketPath: authority.socketPath,
        storeDbPath: authority.storeDbPath,
        bundleHash: authority.bundleHash,
        flavor: authority.flavor,
        namespace: authority.namespace,
        acquiredViaHandoff: authority.acquiredViaHandoff,
        issuedAt: authority.issuedAt,
      },
    });
  }
}

function warnBackendStoreReset(classification: StoreSchemaClassification, quarantineDir: string | undefined): void {
  backendLog.warn(
    `Backend store schema mismatch (stored marker ${classification.storedVersion}, expected ${EXPECTED_SCHEMA_MARKER}); ` +
      'resetting backend store. ' +
      (quarantineDir === undefined ? '' : `Previous store files were quarantined at ${quarantineDir}. `) +
      'In-flight job, discuss, and workflow state will be ' +
      'lost (KB markdown corpus is unaffected).',
  );
}

function fileDigestSha256(storage: StoragePort, path: string): string {
  const fd = storage.openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = storage.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    storage.closeSync(fd);
  }
}

function describeQuarantineFile(
  storage: StoragePort,
  source: string,
  name: string,
  quarantinedPath: string,
): StoreResetQuarantineFile {
  const stat = storage.statSync(source);
  return {
    name,
    source,
    quarantinedPath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: fileDigestSha256(storage, source),
  };
}

function writeStoreResetManifest(
  storage: StoragePort,
  manifestPath: string,
  manifest: StoreResetQuarantineManifest,
): void {
  storage.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function quarantineStoreFiles(
  storage: StoragePort,
  files: StoreFileSet,
  classification: StoreSchemaClassification,
  identity: { nowMs: number; pid: number },
): string | undefined {
  const candidates = [
    { source: files.dbFile, name: basename(files.dbFile) },
    { source: files.walFile, name: basename(files.walFile) },
    { source: files.shmFile, name: basename(files.shmFile) },
  ].filter((entry) => storage.existsSync(entry.source));

  if (candidates.length === 0) {
    return undefined;
  }

  const resetAt = new Date(identity.nowMs).toISOString();
  const stamp = resetAt.replace(/[:.]/g, '-');
  const quarantineDir = join(
    files.dbDir,
    'store-reset-quarantine',
    `${stamp}-pid-${identity.pid}-stored-${classification.storedVersion}-expected-${EXPECTED_SCHEMA_MARKER}`,
  );

  try {
    const manifestFiles = candidates.map((entry) =>
      describeQuarantineFile(storage, entry.source, entry.name, join(quarantineDir, entry.name)),
    );
    storage.mkdirSync(quarantineDir, { recursive: true });
    for (const entry of candidates) {
      storage.renameSync(entry.source, join(quarantineDir, entry.name));
    }
    writeStoreResetManifest(storage, join(quarantineDir, STORE_RESET_QUARANTINE_MANIFEST), {
      schemaVersion: 1,
      resetAt,
      pid: identity.pid,
      reason: classification.kind,
      userVersion: classification.userVersion,
      storedVersion: classification.storedVersion,
      expectedVersion: EXPECTED_SCHEMA_MARKER,
      dbFile: files.dbFile,
      quarantineDir,
      files: manifestFiles,
    });
    writeAuditEvent(
      'store_reset_quarantine',
      {
        resetAt,
        pid: identity.pid,
        reason: classification.kind,
        userVersion: classification.userVersion,
        storedVersion: classification.storedVersion,
        expectedVersion: EXPECTED_SCHEMA_MARKER,
        dbFile: files.dbFile,
        quarantineDir,
        fileCount: manifestFiles.length,
        files: manifestFiles,
      },
      'warn',
    );
  } catch (error: unknown) {
    throw documentedCoralSetupError({
      code: 'store_reset_quarantine_failed',
      quarantineDir,
      dbFile: files.dbFile,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  return quarantineDir;
}

function classifyStoreFile(path: string, storage: Pick<StoragePort, 'existsSync'>): StoreSchemaClassification {
  // Fresh case: file doesn't exist. Skip the open entirely — opening
  // readonly would error, and opening writable would create the file as a
  // side effect of classification.
  if (path !== ':memory:' && !storage.existsSync(path)) {
    return { kind: 'fresh', userVersion: 0, storedVersion: 0 };
  }
  const db = new DatabaseSync(path, { readOnly: true }) as unknown as Database;
  try {
    return classifyStoreSchema(db);
  } finally {
    db.close();
  }
}

export function openOrResetBackendStoreDb(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  options: OpenOrResetBackendStoreOptions = {},
): Database {
  const files = resolveStoreFileSet(runtime, options);
  if (files.dbFile === ':memory:') {
    throw new Error('openOrResetBackendStoreDb requires a real filesystem store path.');
  }

  assertResetAuthority(runtime, authority, options);
  runtime.storage.mkdirSync(files.dbDir, { recursive: true });

  let releaseLock: (() => void) | null = null;
  try {
    const lockPath = join(files.dbDir, 'store.db.reset.lock');
    try {
      releaseLock = acquireDirectoryLockSync(lockPath, 250);
    } catch (error: unknown) {
      if (isDirectoryLockTimeoutError(error)) {
        throw documentedCoralSetupError({
          code: 'store_reset_lock_contended',
          lockPath,
          dbDir: files.dbDir,
        });
      }
      throw error;
    }

    const classification = classifyStoreFile(files.dbFile, runtime.storage);
    if (classification.kind === 'legacy' || classification.kind === 'mismatch') {
      const quarantineDir = quarantineStoreFiles(runtime.storage, files, classification, {
        nowMs: runtime.time.now(),
        pid: runtime.env.pid(),
      });
      warnBackendStoreReset(classification, quarantineDir);
    }

    return openStoreDatabase({
      path: files.dbFile,
      storage: runtime.storage,
      busyTimeoutMs: options.busyTimeoutMs,
    });
  } finally {
    releaseLock?.();
  }
}

export function openWritableStoreDbNoReset(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  options: BackendStorePathOptions = {},
): Database {
  const storeDbPath = resolveStoreDbPath(runtime, options);
  if (storeDbPath === ':memory:') {
    return openStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
      busyTimeoutMs: options.busyTimeoutMs,
    });
  }

  runtime.storage.mkdirSync(dirname(storeDbPath), { recursive: true });
  return openStoreDatabase({
    path: storeDbPath,
    storage: runtime.storage,
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
