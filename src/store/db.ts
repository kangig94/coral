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
import {
  compareStoreFormatFingerprint,
  type StoreFormatDescription,
  type StoreFormatFingerprint,
  type StoreFormatFingerprintComparison,
} from './format-fingerprint.js';

const STORE_FORMAT_FINGERPRINT_KEY = 'store_format_fingerprint';
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
  readonly readonly: true;
  readonly busyTimeoutMs?: number;
};

type WritableStoreOptions = {
  readonly path: string;
  readonly storage: StoragePort;
  readonly storeFormat: StoreFormatDescription;
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

/**
 * Steady-state `busy_timeout` restored after the startup open/reset contention
 * window. Matches {@link applyJournalPragmas}'s default; kept distinct from the
 * short startup timeout the caller passes into {@link openOrResetBackendStoreDb}.
 */
const STEADY_STATE_BUSY_TIMEOUT_MS = 5000;

type StoreFormatClassification = StoreFormatFingerprintComparison | { readonly kind: 'fresh' };

const USER_TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1";

function hasUserTable(db: Database): boolean {
  return db.prepare(USER_TABLE_EXISTS_SQL).get() !== undefined;
}

function readStoredFormatFingerprint(db: Database): string | null {
  try {
    const row = db
      .prepare<[string], { value?: unknown }>('SELECT value FROM meta WHERE key = ? LIMIT 1')
      .get(STORE_FORMAT_FINGERPRINT_KEY);
    if (typeof row?.value !== 'string') {
      return null;
    }
    return row.value;
  } catch (error: unknown) {
    if (error instanceof Error && /no such table: meta/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function classifyStoreFormat(db: Database, current: StoreFormatFingerprint): StoreFormatClassification {
  if (!hasUserTable(db)) return { kind: 'fresh' };
  return compareStoreFormatFingerprint(readStoredFormatFingerprint(db), current);
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
  current: StoreFormatFingerprint,
): Error {
  return documentedCoralSetupError({
    code: 'store_schema_outdated',
    path,
    storedFingerprint:
      classification.kind === 'current' || classification.kind === 'mismatch' ? classification.stored : null,
    currentFingerprint: current,
    classification: classification.kind,
  });
}

export function applyBundledStoreSchema(db: Database, storeFormat: StoreFormatDescription): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(storeFormat.manifest.ddl);
    const existing = readStoredFormatFingerprint(db);
    if (existing !== null && existing !== storeFormat.fingerprint) {
      throw new Error(`Refusing to apply schema over store format '${existing}'.`);
    }
    db.prepare<[string, string]>(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(
      STORE_FORMAT_FINGERPRINT_KEY,
      storeFormat.fingerprint,
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

    const classification = classifyStoreFormat(db, options.storeFormat.fingerprint);
    if (classification.kind === 'current') {
      if (!readonly) {
        applyJournalPragmas(db, {
          kind: 'writable',
          busyTimeoutMs: options.busyTimeoutMs,
        });
      }
      if (options.readonly !== true) writeStoreFormatSidecar(options);
      return db;
    }

    if (readonly) {
      throw storeSchemaOutdatedError(options.path, classification, options.storeFormat.fingerprint);
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

    throw storeSchemaOutdatedError(options.path, classification, options.storeFormat.fingerprint);
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
  storeFormatFingerprint: StoreFormatFingerprint;
  acquiredViaHandoff: boolean;
  issuedAt: number;
  [BACKEND_STORE_RESET_AUTHORITY_BRAND]: true;
}>;

type BackendStorePathOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
  readonly storeFormat: StoreFormatDescription;
};

type BackendStoreIdentityOptions = {
  readonly bundleHash: string;
  readonly namespace: string;
};

type BackendStoreResetAuthorityOptions = BackendStorePathOptions & BackendStoreIdentityOptions;

type OpenOrResetBackendStoreOptions = BackendStorePathOptions &
  Partial<BackendStoreIdentityOptions> & {
    readonly startupBusyTimeoutMs?: number;
    readonly steadyStateBusyTimeoutMs?: number;
  };

type StoreFileSet = {
  readonly dbDir: string;
  readonly dbFile: string;
  readonly walFile: string;
  readonly shmFile: string;
  readonly formatFile: string;
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
  readonly reason: Exclude<StoreFormatClassification['kind'], 'fresh' | 'current'>;
  readonly storedFingerprint: string | null;
  readonly expectedFingerprint: StoreFormatFingerprint;
  readonly dbFile: string;
  readonly quarantineDir: string;
  readonly files: StoreResetQuarantineFile[];
};

const STORE_RESET_QUARANTINE_MANIFEST = 'reset-manifest.json';
const QUARANTINE_RENAME_BACKOFF_MS = [0, 10, 25, 50, 100] as const;
const quarantineRenameWaitState = new Int32Array(new SharedArrayBuffer(4));

function resolveStoreDbPath(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions): string {
  if (options.path === ':memory:') {
    return ':memory:';
  }
  return resolve(options.path ?? runtime.paths.coral.store.dbFile);
}

function resolveStoreFileSet(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions): StoreFileSet {
  if (options.path === undefined) {
    const store = runtime.paths.coral.store;
    return {
      dbDir: store.dbDir,
      dbFile: store.dbFile,
      walFile: store.walFile,
      shmFile: store.shmFile,
      formatFile: `${store.dbFile}${STORE_FORMAT_SIDECAR_SUFFIX}`,
    };
  }

  const dbFile = resolveStoreDbPath(runtime, options);
  return {
    dbDir: dirname(dbFile),
    dbFile,
    walFile: `${dbFile}-wal`,
    shmFile: `${dbFile}-shm`,
    formatFile: `${dbFile}${STORE_FORMAT_SIDECAR_SUFFIX}`,
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
    storeFormatFingerprint: options.storeFormat.fingerprint,
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
    storeFormatFingerprint: options.storeFormat.fingerprint,
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
  if (authority.storeFormatFingerprint !== expected.storeFormatFingerprint) {
    mismatches.push('storeFormatFingerprint');
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
        storeFormatFingerprint: authority.storeFormatFingerprint,
        acquiredViaHandoff: authority.acquiredViaHandoff,
        issuedAt: authority.issuedAt,
      },
    });
  }
}

function storedFingerprint(
  classification: Exclude<StoreFormatClassification, { kind: 'fresh' | 'current' }>,
): string | null {
  return classification.kind === 'missing' ? null : classification.stored;
}

function warnBackendStoreReset(
  classification: Exclude<StoreFormatClassification, { kind: 'fresh' | 'current' }>,
  quarantineDir: string | undefined,
): void {
  backendLog.warn(
    `Backend store format mismatch (stored fingerprint ${storedFingerprint(classification) ?? 'missing'}, ` +
      `expected ${classification.current}); ` +
      'resetting backend store. ' +
      (quarantineDir === undefined ? '' : `Previous store files were quarantined at ${quarantineDir}. `) +
      'All Coral job, discussion, and workflow history/state will be unavailable in the new store ' +
      '(KB markdown corpus is unaffected). Recover old Journal data only from the quarantine copy.',
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

function isBusyRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

function waitForQuarantineRenameRetry(ms: number): void {
  if (ms > 0) {
    Atomics.wait(quarantineRenameWaitState, 0, 0, ms);
  }
}

function renameStoreFileForQuarantine(storage: StoragePort, source: string, destination: string): void {
  for (let attempt = 0; attempt <= QUARANTINE_RENAME_BACKOFF_MS.length; attempt++) {
    try {
      storage.renameSync(source, destination);
      return;
    } catch (error: unknown) {
      if (!isBusyRenameError(error) || attempt === QUARANTINE_RENAME_BACKOFF_MS.length) {
        throw error;
      }
      // POSIX lets rename succeed while a predecessor still has the old file
      // open; that handle keeps an orphaned inode. Windows can report a short
      // EPERM/EBUSY residual while the draining predecessor closes its handle.
      waitForQuarantineRenameRetry(QUARANTINE_RENAME_BACKOFF_MS[attempt]);
    }
  }
}

function quarantineStoreFiles(
  storage: StoragePort,
  files: StoreFileSet,
  classification: Exclude<StoreFormatClassification, { kind: 'fresh' | 'current' }>,
  identity: { nowMs: number; pid: number },
): string | undefined {
  const candidates = [
    { source: files.dbFile, name: basename(files.dbFile) },
    { source: files.walFile, name: basename(files.walFile) },
    { source: files.shmFile, name: basename(files.shmFile) },
    { source: files.formatFile, name: basename(files.formatFile) },
  ].filter((entry) => storage.existsSync(entry.source));

  if (candidates.length === 0) {
    return undefined;
  }

  const resetAt = new Date(identity.nowMs).toISOString();
  const stamp = resetAt.replace(/[:.]/g, '-');
  const quarantineDir = join(
    files.dbDir,
    'store-reset-quarantine',
    `${stamp}-pid-${identity.pid}-format-${classification.kind}`,
  );

  try {
    const manifestFiles = candidates.map((entry) =>
      describeQuarantineFile(storage, entry.source, entry.name, join(quarantineDir, entry.name)),
    );
    storage.mkdirSync(quarantineDir, { recursive: true });
    for (const entry of candidates) {
      renameStoreFileForQuarantine(storage, entry.source, join(quarantineDir, entry.name));
    }
    writeStoreResetManifest(storage, join(quarantineDir, STORE_RESET_QUARANTINE_MANIFEST), {
      schemaVersion: 1,
      resetAt,
      pid: identity.pid,
      reason: classification.kind,
      storedFingerprint: storedFingerprint(classification),
      expectedFingerprint: classification.current,
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
        storedFingerprint: storedFingerprint(classification),
        expectedFingerprint: classification.current,
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

function classifyStoreFile(
  path: string,
  storage: Pick<StoragePort, 'existsSync'>,
  storeFormat: StoreFormatDescription,
): StoreFormatClassification {
  // Fresh case: file doesn't exist. Skip the open entirely — opening
  // readonly would error, and opening writable would create the file as a
  // side effect of classification.
  if (path !== ':memory:' && !storage.existsSync(path)) {
    return { kind: 'fresh' };
  }
  const db = new DatabaseSync(path, { readOnly: true }) as unknown as Database;
  try {
    return classifyStoreFormat(db, storeFormat.fingerprint);
  } finally {
    db.close();
  }
}

export function openOrResetBackendStoreDb(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  options: OpenOrResetBackendStoreOptions,
): Database {
  const files = resolveStoreFileSet(runtime, options);
  const startupBusyTimeoutMs = options.startupBusyTimeoutMs ?? options.busyTimeoutMs;
  const steadyStateBusyTimeoutMs = options.steadyStateBusyTimeoutMs ?? STEADY_STATE_BUSY_TIMEOUT_MS;
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

    const classification = classifyStoreFile(files.dbFile, runtime.storage, options.storeFormat);
    if (classification.kind === 'missing' || classification.kind === 'mismatch') {
      const quarantineDir = quarantineStoreFiles(runtime.storage, files, classification, {
        nowMs: runtime.time.now(),
        pid: runtime.env.pid(),
      });
      warnBackendStoreReset(classification, quarantineDir);
    }

    const db = openStoreDatabase({
      path: files.dbFile,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      busyTimeoutMs: startupBusyTimeoutMs,
    });
    // Startup and steady-state contention are separate budgets. The general
    // busyTimeoutMs option supplies the startup budget, then the long-lived
    // handle to its steady-state budget after the reset window closes.
    db.exec(`PRAGMA busy_timeout = ${steadyStateBusyTimeoutMs}`);
    return db;
  } finally {
    releaseLock?.();
  }
}

export function openWritableStoreDbNoReset(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  options: BackendStorePathOptions,
): Database {
  const storeDbPath = resolveStoreDbPath(runtime, options);
  if (storeDbPath === ':memory:') {
    return openStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      busyTimeoutMs: options.busyTimeoutMs,
    });
  }

  runtime.storage.mkdirSync(dirname(storeDbPath), { recursive: true });
  return openStoreDatabase({
    path: storeDbPath,
    storage: runtime.storage,
    storeFormat: options.storeFormat,
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
