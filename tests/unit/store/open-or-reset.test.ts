import { currentCoralStoreFormat } from '#src/store-format.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync as renameFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { BUNDLED_ENGINES } from '#src/expansion/bundled.js';
import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { readDefaultExpansionCatalog, readExpansionCatalog } from '#src/cli/expansion/catalog.js';
import { openReadCoralStore } from '#src/cli/read-store.js';
import { createDefaultKbQueryRuntime, KbQueryRegistry } from '#src/read-model/kb-query-runtime.js';
import { documentedCoralSetupError, serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  createBackendStoreResetAuthority,
  openOrResetBackendStoreDb,
  publishBackendStoreResetIncident,
  resumeInterruptedBackendStoreResetIncident,
  type BackendStoreResetAuthority,
} from '#src/store/backend-store-reset.js';
import { openStoreDatabase, openWritableStoreDbNoReset } from '#src/store/db.js';
import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';
import { MAX_RESET_MANIFEST_BYTES } from '#src/store/reset-incident.js';
import { pragmaSimple } from '#tests/helpers/test-db.js';

const REPO_ROOT = process.cwd();
const VERSION = '0.9.16';
const BUILD_SET_ID = '123e4567-e89b-42d3-a456-426614174000';
const BUNDLE_HASH = '0123456789abcdef';
const NAMESPACE = 'test-namespace';
const STORE_FORMAT = currentCoralStoreFormat();

function buildIdentity(bundleHash = BUNDLE_HASH) {
  return {
    version: VERSION,
    buildSetId: BUILD_SET_ID,
    bundleHash,
    cliBundleHash: '123456789abcdef0',
    claudeAppserverBundleHash: '23456789abcdef01',
    flavor: 'prod' as const,
    storeFormatFingerprint: STORE_FORMAT.fingerprint,
  };
}

const tempRoots: string[] = [];

function retainedIncidentNames(quarantineRoot: string): string[] {
  return readdirSync(quarantineRoot).filter((name) => name !== '.staging');
}

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map(Object.entries(updates).map(([key]) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createRuntime(home = makeTempRoot('coral-store-open-reset-home-')): Runtime {
  return withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => createRealRuntime('prod'));
}

function createCurrentStore(runtime: Runtime, path = runtime.paths.coral.store.dbFile): void {
  openStoreDatabase({ path, storage: runtime.storage, storeFormat: STORE_FORMAT }).close();
}

function tableExists(dbPath: string, name: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined;
  } finally {
    db.close();
  }
}

function readFormatFingerprint(dbPath: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint' LIMIT 1").get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function createMissingFingerprintStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('coordinator_id', 'old');
      CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
  } finally {
    db.close();
  }
}

function createMismatchStore(dbPath: string, fingerprint = `sha256:${'0'.repeat(64)}`): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    db.prepare("INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', ?)").run(fingerprint);
  } finally {
    db.close();
  }
}

function createVersionedStore(dbPath: string, fingerprint: string, productVersion: string): void {
  createMismatchStore(dbPath, fingerprint);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES ('store_product_version', ?)").run(productVersion);
  } finally {
    db.close();
  }
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function createCorruptStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a sqlite database', 'utf-8');
}

function authorityFor(runtime: Runtime, dbPath: string): BackendStoreResetAuthority {
  return createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: true },
    {
      path: dbPath,
      namespace: NAMESPACE,
      storeFormat: STORE_FORMAT,
      build: buildIdentity(),
    },
  );
}

function openReset(runtime: Runtime, dbPath: string) {
  return openOrResetBackendStoreDb(runtime, authorityFor(runtime, dbPath), {
    path: dbPath,
    storeFormat: STORE_FORMAT,
  });
}

function publishReset(runtime: Runtime, dbPath: string) {
  return publishBackendStoreResetIncident(runtime, authorityFor(runtime, dbPath), {
    path: dbPath,
    storeFormat: STORE_FORMAT,
  });
}

function resumeReset(runtime: Runtime, dbPath: string) {
  return resumeInterruptedBackendStoreResetIncident(runtime, authorityFor(runtime, dbPath), {
    path: dbPath,
    storeFormat: STORE_FORMAT,
  });
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function createInterruptedReset(
  runtime: Runtime,
  dbPath: string,
): {
  readonly quarantineRoot: string;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
} {
  createMismatchStore(dbPath);
  writeFileSync(`${dbPath}-wal`, 'durable wal evidence', 'utf-8');
  const unlinkSync = runtime.storage.unlinkSync;
  let interrupted = false;
  const unlinkSpy = vi.spyOn(runtime.storage, 'unlinkSync').mockImplementation((path) => {
    if (path === `${dbPath}-wal` && !interrupted) {
      interrupted = true;
      throw errno('EIO');
    }
    unlinkSync(path);
  });
  const error = captureError(() => publishReset(runtime, dbPath));
  unlinkSpy.mockRestore();
  expectSetupCode(error, 'store_reset_quarantine_failed');
  expect(interrupted).toBe(true);

  const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
  const stagingRoot = join(quarantineRoot, '.staging');
  const stagingNames = readdirSync(stagingRoot);
  expect(stagingNames).toHaveLength(1);
  return {
    quarantineRoot,
    stagingRoot,
    stagingDirectory: join(stagingRoot, stagingNames[0]),
  };
}

function expectSetupCode(error: unknown, code: string): void {
  expect(serializeCoralSetupError(error)).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('openOrResetBackendStoreDb', () => {
  it('initializes a missing store with the bundled schema marker', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-fresh-'), 'store.db');

    const db = openReset(runtime, dbPath);
    db.close();

    expect(existsSync(dbPath)).toBe(true);
    expect(readFormatFingerprint(dbPath)).toBe(STORE_FORMAT.fingerprint);
    expect(readFileSync(`${dbPath}.format`, 'utf8')).toBe(`${STORE_FORMAT.fingerprint}\n`);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('creates a missing dbDir before reaching the sync reset lock path', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-fresh-lock-parent-');
    const dbDir = join(root, 'missing', 'nested');
    const dbPath = join(dbDir, 'store.db');

    const db = openReset(runtime, dbPath);
    db.close();

    expect(existsSync(dbDir)).toBe(true);
    expect(readFormatFingerprint(dbPath)).toBe(STORE_FORMAT.fingerprint);
    expect(existsSync(join(dbDir, 'store.db.reset.lock'))).toBe(false);
  });

  it('restores the steady-state busy timeout after the startup reset window', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-steady-busy-timeout-'), 'store.db');

    const db = openOrResetBackendStoreDb(runtime, authorityFor(runtime, dbPath), {
      path: dbPath,
      storeFormat: STORE_FORMAT,
      startupBusyTimeoutMs: 1,
      steadyStateBusyTimeoutMs: 12_345,
    });
    try {
      expect(pragmaSimple(db, 'busy_timeout')).toBe(12_345);
    } finally {
      db.close();
    }
  });

  it('refuses a store with no format fingerprint without mutating it', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-missing-fingerprint-'), 'store.db');
    createMissingFingerprintStore(dbPath);
    const before = readFileSync(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_corrupt_or_unsupported');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('leaves an already-current store in place without warning', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-current-'), 'store.db');
    const first = openReset(runtime, dbPath);
    first.close();
    const marker = readFormatFingerprint(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const second = openReset(runtime, dbPath);
    second.close();

    expect(readFormatFingerprint(dbPath)).toBe(marker);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses a mismatched marker without mutating the store', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-mismatch-'), 'store.db');
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_corrupt_or_unsupported');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
  });

  it.each([
    {
      label: 'older incompatible',
      fingerprint: `sha256:${'0'.repeat(64)}`,
      version: '0.0.0-rc.1',
      code: 'store_older_incompatible',
    },
    {
      label: 'newer incompatible',
      fingerprint: STORE_FORMAT.fingerprint,
      version: '99.0.0',
      code: 'store_newer_incompatible',
    },
  ])('returns the documented $label refusal without mutating bytes', ({ fingerprint, version, code }) => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-directional-refusal-'), 'store.db');
    createVersionedStore(dbPath, fingerprint, version);
    const before = readFileSync(dbPath);

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, code);
    expect(serializeCoralSetupError(error)).toMatchObject({ context: { version } });
    expect(readFileSync(dbPath)).toEqual(before);
    expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
  });

  it('keeps crash-safe quarantine available to the explicit operator boundary', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-mismatch-quarantine-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const originalDbBytes = readFileSync(dbPath);
    writeFileSync(`${dbPath}-wal`, 'dummy wal', 'utf-8');
    writeFileSync(`${dbPath}-shm`, 'dummy shm', 'utf-8');
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    const events: string[] = [];
    const openSync = runtime.storage.openSync;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags, mode) => {
      events.push(`open:${path}:${flags}`);
      return openSync(path, flags, mode);
    });
    const unlinkSync = runtime.storage.unlinkSync;
    vi.spyOn(runtime.storage, 'unlinkSync').mockImplementation((path) => {
      events.push(`unlink:${path}`);
      unlinkSync(path);
    });
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      events.push(`sync:${path}`);
      return syncDirectoryDurableSync(path);
    });
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, data, options) => {
      events.push(`write:${path}`);
      return writeAtomicDurableSync(path, data, options);
    });
    const renameSync = runtime.storage.renameSync;
    let finalPublicationObserved = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((oldPath, newPath) => {
      events.push(`rename:${oldPath}->${newPath}`);
      if (dirname(oldPath) === join(dbDir, 'store-reset-quarantine', '.staging')) {
        finalPublicationObserved = true;
        expect(existsSync(dbPath)).toBe(false);
        expect(existsSync(join(oldPath, 'reset-manifest.json'))).toBe(true);
        expect(existsSync(join(oldPath, 'store.db'))).toBe(true);
      }
      renameSync(oldPath, newPath);
    });

    const incident = publishReset(runtime, dbPath);
    expect(incident).toBeDefined();
    expect(finalPublicationObserved).toBe(true);

    const quarantineRoot = join(dbDir, 'store-reset-quarantine');
    const quarantineEntries = retainedIncidentNames(quarantineRoot);
    expect(quarantineEntries).toHaveLength(1);
    const quarantineDir = join(quarantineRoot, quarantineEntries[0]);
    const stagingDirectory = join(quarantineRoot, '.staging', quarantineEntries[0]);
    const dbCopy = events.indexOf(`open:${join(stagingDirectory, 'store.db')}:wx`);
    const manifestWrite = events.indexOf(`write:${join(stagingDirectory, 'reset-manifest.json')}`);
    const manifestSync = events.findIndex(
      (event, index) => index > manifestWrite && event === `sync:${stagingDirectory}`,
    );
    const dbRemoval = events.indexOf(`unlink:${dbPath}`);
    const sourceSync = events.findIndex((event, index) => index > dbRemoval && event === `sync:${dbDir}`);
    const finalRename = events.indexOf(`rename:${stagingDirectory}->${quarantineDir}`);
    const finalRootSync = events.findIndex((event, index) => index > finalRename && event === `sync:${quarantineRoot}`);
    expect(dbCopy).toBeGreaterThanOrEqual(0);
    expect(dbCopy).toBeLessThan(manifestWrite);
    expect(manifestWrite).toBeLessThan(manifestSync);
    expect(manifestSync).toBeLessThan(dbRemoval);
    expect(dbRemoval).toBeLessThan(sourceSync);
    expect(sourceSync).toBeLessThan(finalRename);
    expect(finalRename).toBeLessThan(finalRootSync);
    expect(readFileSync(join(quarantineDir, 'store.db-wal'), 'utf-8')).toBe('dummy wal');
    expect(existsSync(join(quarantineDir, 'store.db-shm'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(quarantineDir, 'reset-manifest.json'), 'utf-8')) as {
      schemaVersion?: unknown;
      reason?: unknown;
      storedFingerprint?: unknown;
      expectedFingerprint?: unknown;
      incidentId?: unknown;
      build?: unknown;
      runtime?: unknown;
      handoff?: unknown;
      files?: Array<{
        name?: unknown;
        sizeBytes?: unknown;
        sha256?: unknown;
      }>;
    };
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      incidentId: quarantineEntries[0],
      reason: 'mismatch',
      storedFingerprint: `sha256:${'0'.repeat(64)}`,
      expectedFingerprint: STORE_FORMAT.fingerprint,
      build: {
        version: VERSION,
        buildSetId: BUILD_SET_ID,
        backendBundleHash: BUNDLE_HASH,
        flavor: 'prod',
      },
      handoff: { acquiredViaHandoff: true },
    });
    expect(manifest).not.toHaveProperty('dbFile');
    expect(manifest).not.toHaveProperty('quarantineDir');
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'store.db',
          sizeBytes: originalDbBytes.length,
          sha256: sha256(originalDbBytes),
        }),
        expect.objectContaining({
          name: 'store.db-wal',
          sizeBytes: 'dummy wal'.length,
          sha256: sha256('dummy wal'),
        }),
      ]),
    );
    rmSync(join(quarantineDir, 'store.db-wal'), { force: true });
    rmSync(join(quarantineDir, 'store.db-shm'), { force: true });
    expect(tableExists(join(quarantineDir, 'store.db'), 'sentinel_before_reset')).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('refuses an interrupted durable quarantine without resuming or mutating it', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-interrupted-quarantine-');
    const dbPath = join(dbDir, 'store.db');
    const { quarantineRoot, stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    expect(existsSync(dbPath)).toBe(false);
    const stagingNames = readdirSync(stagingRoot);
    const stagedDb = readFileSync(join(stagingDirectory, 'store.db'));
    const stagedManifest = readFileSync(join(stagingDirectory, 'reset-manifest.json'));
    const activeWal = readFileSync(`${dbPath}-wal`);

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(serializeCoralSetupError(error)).toMatchObject({
      context: { reason: 'interrupted', flavor: 'prod', incidentId: stagingNames[0] },
      remediation: expect.stringContaining('coral-cli backend store-reset discard --target gen2 --flavor prod'),
    });
    expect(readdirSync(stagingRoot)).toEqual(stagingNames);
    expect(readFileSync(join(stagingDirectory, 'store.db'))).toEqual(stagedDb);
    expect(readFileSync(join(stagingDirectory, 'reset-manifest.json'))).toEqual(stagedManifest);
    expect(readFileSync(`${dbPath}-wal`)).toEqual(activeWal);
    expect(existsSync(dbPath)).toBe(false);
    expect(retainedIncidentNames(quarantineRoot)).toEqual([]);

    expect(resumeReset(runtime, dbPath)?.incidentId).toBe(stagingNames[0]);
    const entries = retainedIncidentNames(quarantineRoot);
    expect(entries).toHaveLength(1);
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(readFileSync(join(quarantineRoot, entries[0], 'store.db-wal'), 'utf-8')).toBe('durable wal evidence');
    const db = openReset(runtime, dbPath);
    db.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
  });

  it('refuses matching active and staged incident evidence until the operator resumes it', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-duplicate-'), 'store.db');
    const { quarantineRoot, stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    copyFileSync(join(stagingDirectory, 'store.db'), dbPath);
    const activeBefore = readFileSync(dbPath);
    const stagedBefore = readFileSync(join(stagingDirectory, 'store.db'));

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(activeBefore);
    expect(readFileSync(join(stagingDirectory, 'store.db'))).toEqual(stagedBefore);
    expect(readdirSync(stagingRoot)).toHaveLength(1);
    expect(resumeReset(runtime, dbPath)).not.toBeNull();
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);
    const db = openReset(runtime, dbPath);
    db.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
  });

  it('refuses pre-manifest writer-owned residue without deleting it', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-pre-manifest-resume-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const interruptedId = '323e4567-e89b-42d3-a456-426614174000';
    const stagingRoot = join(root, 'store-reset-quarantine', '.staging');
    const stagingDirectory = join(stagingRoot, interruptedId);
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(dbPath, join(stagingDirectory, 'store.db'));
    writeFileSync(join(stagingDirectory, 'reset-manifest.json.tmp'), 'partial manifest', 'utf-8');

    const activeBefore = readFileSync(dbPath);
    const stagedBefore = readFileSync(join(stagingDirectory, 'store.db'));
    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(activeBefore);
    expect(readFileSync(join(stagingDirectory, 'store.db'))).toEqual(stagedBefore);
    expect(readFileSync(join(stagingDirectory, 'reset-manifest.json.tmp'), 'utf8')).toBe('partial manifest');
    expect(resumeReset(runtime, dbPath)).toBeNull();
    expect(existsSync(stagingDirectory)).toBe(false);
    expect(readFileSync(dbPath)).toEqual(activeBefore);
  });

  it('rejects a symlinked interrupted staging directory before touching active evidence', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-interrupted-symlink-');
    const dbPath = join(root, 'store.db');
    const { stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const outside = join(root, 'outside-staging');
    renameFileSync(stagingDirectory, outside);
    symlinkSync(outside, stagingDirectory, 'dir');

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(tableExists(join(outside, 'store.db'), 'sentinel_before_reset')).toBe(true);
  });

  it('rejects an oversized interrupted manifest before opening it', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-oversized-manifest-'), 'store.db');
    const { stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const manifestPath = join(stagingDirectory, 'reset-manifest.json');
    writeFileSync(manifestPath, Buffer.alloc(MAX_RESET_MANIFEST_BYTES + 1));
    const openSync = runtime.storage.openSync;
    let manifestOpenCount = 0;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags) => {
      if (path === manifestPath) manifestOpenCount += 1;
      return openSync(path, flags);
    });

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(manifestOpenCount).toBe(0);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects unexpected content in a manifest-bearing staging transaction', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-unexpected-content-'), 'store.db');
    const { stagingDirectory } = createInterruptedReset(runtime, dbPath);
    writeFileSync(join(stagingDirectory, 'unexpected.bin'), 'not retained evidence', 'utf-8');

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(existsSync(join(stagingDirectory, 'unexpected.bin'))).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('bounds interrupted-publication enumeration to one staging transaction', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-multiple-'), 'store.db');
    const { stagingRoot } = createInterruptedReset(runtime, dbPath);
    mkdirSync(join(stagingRoot, '323e4567-e89b-42d3-a456-426614174000'), { mode: 0o700 });
    const readDirectoryBoundedSync = runtime.storage.readDirectoryBoundedSync;
    const reads: Array<{ path: string; limit: number }> = [];
    vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockImplementation((path, limit) => {
      reads.push({ path, limit });
      return readDirectoryBoundedSync(path, limit);
    });

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(reads).toContainEqual({ path: stagingRoot, limit: 1 });
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('does not remove active evidence when durable manifest publication fails', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-manifest-publication-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(original);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(readdirSync(join(dbDir, 'store-reset-quarantine', '.staging'))).toEqual([]);
  });

  it('does not remove active evidence when the durable manifest directory sync fails', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-manifest-directory-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    const stagingRoot = join(dbDir, 'store-reset-quarantine', '.staging');
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) =>
      dirname(path) === stagingRoot ? false : syncDirectoryDurableSync(path),
    );

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(original);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  it('resumes after active evidence removal whose source directory sync failed', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-remove-source-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    const syncSpy = vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      if (path === dbDir && !existsSync(dbPath)) return false;
      return syncDirectoryDurableSync(path);
    });

    const firstError = captureError(() => publishReset(runtime, dbPath));
    expectSetupCode(firstError, 'store_reset_quarantine_failed');
    expect(existsSync(dbPath)).toBe(false);
    const stagingRoot = join(dbDir, 'store-reset-quarantine', '.staging');
    expect(existsSync(join(stagingRoot, readdirSync(stagingRoot)[0], 'store.db'))).toBe(true);

    syncSpy.mockRestore();
    expect(resumeReset(runtime, dbPath)).not.toBeNull();
    const db = openReset(runtime, dbPath);
    db.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('reopens safely after final publication succeeds but its parent sync reports failure', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-final-publication-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const quarantineRoot = join(dbDir, 'store-reset-quarantine');
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    let quarantineRootSyncs = 0;
    const syncSpy = vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      if (path === quarantineRoot && ++quarantineRootSyncs === 2) return false;
      return syncDirectoryDurableSync(path);
    });

    const firstError = captureError(() => publishReset(runtime, dbPath));
    expectSetupCode(firstError, 'store_reset_quarantine_failed');
    expect(existsSync(dbPath)).toBe(false);
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);

    syncSpy.mockRestore();
    const db = openReset(runtime, dbPath);
    db.close();
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('does not remove active evidence when quarantine directory metadata cannot be synchronized', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-directory-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockReturnValue(false);

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(original);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
  });

  it('rejects symlinked active evidence without removing its target', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-active-symlink-');
    const dbPath = join(root, 'store.db');
    const target = join(root, 'external-store.db');
    createMismatchStore(target);
    symlinkSync(target, dbPath);

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(tableExists(target, 'sentinel_before_reset')).toBe(true);
    expect(retainedIncidentNames(join(root, 'store-reset-quarantine'))).toEqual([]);
  });

  it('fails closed when active evidence is replaced between path stat and descriptor open', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-active-replacement-');
    const dbPath = join(root, 'store.db');
    const replacement = join(root, 'replacement.db');
    createMismatchStore(dbPath);
    createMismatchStore(replacement);
    const openSync = runtime.storage.openSync;
    let replaced = false;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags) => {
      if (path === dbPath && !replaced) {
        replaced = true;
        rmSync(dbPath);
        renameFileSync(replacement, dbPath);
      }
      return openSync(path, flags);
    });

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(replaced).toBe(true);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(retainedIncidentNames(join(root, 'store-reset-quarantine'))).toEqual([]);
  });

  it('retains the verified copy when active evidence mutates during its final removal', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-active-mutation-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    const unlinkSync = runtime.storage.unlinkSync;
    let mutated = false;
    vi.spyOn(runtime.storage, 'unlinkSync').mockImplementation((path) => {
      if (path === dbPath && !mutated) {
        mutated = true;
        appendFileSync(dbPath, 'post-hash mutation');
      }
      unlinkSync(path);
    });

    const incident = publishReset(runtime, dbPath);

    expect(incident).toBeDefined();
    expect(mutated).toBe(true);
    const quarantineRoot = join(root, 'store-reset-quarantine');
    const entries = retainedIncidentNames(quarantineRoot);
    expect(entries).toHaveLength(1);
    const incidentId = entries[0];
    expect(readFileSync(join(quarantineRoot, incidentId, 'store.db'))).toEqual(original);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('refuses a missing-fingerprint store on cold start without handoff authority', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-cold-missing-fingerprint-'), 'store.db');
    createMissingFingerprintStore(dbPath);
    const authority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: false },
      {
        path: dbPath,
        namespace: NAMESPACE,
        storeFormat: STORE_FORMAT,
        build: buildIdentity(),
      },
    );

    const before = readFileSync(dbPath);
    const error = captureError(() =>
      openOrResetBackendStoreDb(runtime, authority, {
        path: dbPath,
        storeFormat: STORE_FORMAT,
      }),
    );

    expectSetupCode(error, 'store_corrupt_or_unsupported');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
  });

  it('refuses mismatched stores without a reset warning or incident', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-mismatch-warning-'), 'store.db');
    createMismatchStore(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const before = readFileSync(dbPath);
    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_corrupt_or_unsupported');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
  });

  it('does not delete WAL or SHM siblings when refusing a mismatched store', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-wal-shm-'), 'store.db');
    createMismatchStore(dbPath);
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    writeFileSync(walPath, 'dummy wal', 'utf-8');
    writeFileSync(shmPath, 'dummy shm', 'utf-8');

    const dbBefore = readFileSync(dbPath);
    const unlinkSpy = vi.spyOn(runtime.storage, 'unlinkSync');
    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_corrupt_or_unsupported');
    expect(readFileSync(dbPath)).toEqual(dbBefore);
    expect(readFileSync(walPath, 'utf-8')).toBe('dummy wal');
    expect(existsSync(shmPath)).toBe(true);
    expect(unlinkSpy.mock.calls.some(([path]) => path === walPath || path === shmPath)).toBe(false);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
  });

  it('fails fast on fresh reset lock contention and leaves a fresh lock in place', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-lock-contention-');
    const dbPath = join(dbDir, 'store.db');
    const lockDir = join(dbDir, 'store.db.reset.lock');
    mkdirSync(lockDir);

    const started = Date.now();
    const error = captureError(() => openReset(runtime, dbPath));
    const elapsed = Date.now() - started;

    expectSetupCode(error, 'store_reset_lock_contended');
    expect(elapsed).toBeLessThan(1_000);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('removes a stale reset lock and acquires the reset lock successfully', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-stale-lock-');
    const dbPath = join(dbDir, 'store.db');
    const lockDir = join(dbDir, 'store.db.reset.lock');
    mkdirSync(lockDir);
    const oldDate = new Date(Date.now() - 31_000);
    utimesSync(lockDir, oldDate, oldDate);

    const db = openReset(runtime, dbPath);
    db.close();

    expect(readFormatFingerprint(dbPath)).toBe(STORE_FORMAT.fingerprint);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('does not reset a corrupt store file', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-corrupt-reset-'), 'store.db');
    createCorruptStore(dbPath);
    const before = readFileSync(dbPath, 'utf-8');
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const error = captureError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_corrupt_or_unsupported');
    expect(readFileSync(dbPath, 'utf-8')).toBe(before);
    expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects mismatched authority and does not unlink the existing DB', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-authority-mismatch-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);

    const differentPath = join(dbDir, 'different-store.db');
    const staleAuthority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: true },
      {
        path: differentPath,
        namespace: NAMESPACE,
        storeFormat: STORE_FORMAT,
        build: buildIdentity(),
      },
    );

    const error = captureError(() =>
      openOrResetBackendStoreDb(runtime, staleAuthority, {
        path: dbPath,
        storeFormat: STORE_FORMAT,
      }),
    );

    expectSetupCode(error, 'store_schema_outdated');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('rejects reset authority minted for a different store fingerprint without touching DB siblings', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-authority-format-mismatch-'), 'store.db');
    createMismatchStore(dbPath);
    writeFileSync(`${dbPath}-wal`, 'authority wal', 'utf-8');
    writeFileSync(`${dbPath}-shm`, 'authority shm', 'utf-8');
    writeFileSync(`${dbPath}.format`, 'sha256:authority-sidecar\n', 'utf-8');
    const before = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.format`].map((path) => readFileSync(path));
    const otherFormat = {
      ...STORE_FORMAT,
      fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
    };
    const authority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: true },
      {
        path: dbPath,
        namespace: NAMESPACE,
        storeFormat: STORE_FORMAT,
        build: buildIdentity(),
      },
    );

    const error = captureError(() =>
      openOrResetBackendStoreDb(runtime, authority, {
        path: dbPath,
        storeFormat: otherFormat,
      }),
    );

    expectSetupCode(error, 'store_schema_outdated');
    const serialized = serializeCoralSetupError(error);
    expect(serialized?.context).toMatchObject({ mismatches: ['storeFormatFingerprint'] });
    for (const [index, path] of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.format`].entries()) {
      expect(readFileSync(path)).toEqual(before[index]);
    }
  });
});

describe('read-only store access', () => {
  it('surfaces a typed absent-store error without creating the parent or database', () => {
    const runtime = createRuntime();
    const parent = join(makeTempRoot('coral-store-readonly-absent-'), 'missing-parent');
    const dbPath = join(parent, 'store.db');

    const portError = captureError(() =>
      openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: dbPath }),
    );
    const sharedError = captureError(() =>
      openStoreDatabase({
        path: dbPath,
        storage: runtime.storage,
        storeFormat: STORE_FORMAT,
        readonly: true,
      }),
    );

    expectSetupCode(portError, 'store_not_initialized');
    expectSetupCode(sharedError, 'store_not_initialized');
    expect(serializeCoralSetupError(portError)?.context).toMatchObject({ path: dbPath });
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('throws store_schema_outdated for missing-fingerprint and mismatched stores without changing the file', () => {
    const runtime = createRuntime();
    const missingPath = join(makeTempRoot('coral-store-readonly-missing-fingerprint-'), 'store.db');
    const mismatchPath = join(makeTempRoot('coral-store-readonly-mismatch-'), 'store.db');
    createMissingFingerprintStore(missingPath);
    createMismatchStore(mismatchPath);
    const missingBefore = readFileSync(missingPath);
    const mismatchBefore = readFileSync(mismatchPath);

    const missingError = captureError(() =>
      openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: missingPath }),
    );
    const mismatchError = captureError(() =>
      openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: mismatchPath }),
    );

    expectSetupCode(missingError, 'store_schema_outdated');
    expectSetupCode(mismatchError, 'store_schema_outdated');
    expect(readFileSync(missingPath)).toEqual(missingBefore);
    expect(readFileSync(mismatchPath)).toEqual(mismatchBefore);
  });

  it('uses the bundled expansion catalog for an empty home', () => {
    const home = makeTempRoot('coral-expansion-catalog-empty-home-');

    expect(withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => readDefaultExpansionCatalog())).toEqual(
      BUNDLED_ENGINES,
    );
  });

  it('constructs a query runtime without consulting an incompatible store', () => {
    const runtime = createRuntime();
    createMismatchStore(runtime.paths.coral.store.dbFile);
    const before = readFileSync(runtime.paths.coral.store.dbFile);

    expect(() => createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime })).not.toThrow();
    expect(readFileSync(runtime.paths.coral.store.dbFile)).toEqual(before);
  });

  describe('does not mask store_schema_outdated in store-backed read-only callers', () => {
    function makeMismatchHome() {
      const home = makeTempRoot('coral-store-readonly-callers-home-');
      const runtime = createRuntime(home);
      createMismatchStore(runtime.paths.coral.store.dbFile);
      return { home, runtime };
    }

    it('openReadCoralStore', () => {
      const { home, runtime } = makeMismatchHome();
      expectSetupCode(
        withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () =>
          captureError(() => openReadCoralStore(runtime.paths.projectSource('/tmp/project'))),
        ),
        'store_schema_outdated',
      );
    });

    it('readExpansionCatalog', () => {
      const { runtime } = makeMismatchHome();
      expectSetupCode(
        captureError(() => readExpansionCatalog(runtime)),
        'store_schema_outdated',
      );
    });

    it('readDefaultExpansionCatalog', () => {
      const { home } = makeMismatchHome();
      expectSetupCode(
        withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => captureError(() => readDefaultExpansionCatalog())),
        'store_schema_outdated',
      );
    });

    it('createExpansionManifestCatalog (manifest catalog read)', () => {
      expectSetupCode(
        captureError(() =>
          createExpansionManifestCatalog({
            readDb: {
              prepare() {
                throw documentedCoralSetupError('store_schema_outdated');
              },
            },
          }),
        ),
        'store_schema_outdated',
      );
    });
  });
});

describe('openWritableStoreDbNoReset', () => {
  it('requires an existing store and opens a current store for catalog writers', () => {
    const runtime = createRuntime();
    const parent = join(makeTempRoot('coral-store-no-reset-current-'), 'missing-parent');
    const dbPath = join(parent, 'store.db');

    const absentError = captureError(() =>
      openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: dbPath }),
    );
    // An absent store is not an outdated one — store_schema_outdated's remediation
    // offers to discard history, which is meaningless and misleading here.
    expectSetupCode(absentError, 'store_not_initialized');
    expect(serializeCoralSetupError(absentError)?.context).toMatchObject({ path: dbPath });
    expect(existsSync(parent)).toBe(false);

    createCurrentStore(runtime, dbPath);
    const marker = readFormatFingerprint(dbPath);
    const current = openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: dbPath });
    current.close();

    expect(marker).toBe(STORE_FORMAT.fingerprint);
    expect(readFormatFingerprint(dbPath)).toBe(marker);
  });

  it('never unlinks missing-fingerprint or mismatched stores and surfaces store_schema_outdated', () => {
    const runtime = createRuntime();
    const missingPath = join(makeTempRoot('coral-store-no-reset-missing-fingerprint-'), 'store.db');
    const mismatchPath = join(makeTempRoot('coral-store-no-reset-mismatch-'), 'store.db');
    createMissingFingerprintStore(missingPath);
    createMismatchStore(mismatchPath);

    expectSetupCode(
      captureError(() => openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: missingPath })),
      'store_schema_outdated',
    );
    expectSetupCode(
      captureError(() => openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: mismatchPath })),
      'store_schema_outdated',
    );

    expect(readFormatFingerprint(missingPath)).toBeNull();
    expect(tableExists(mismatchPath, 'sentinel_before_reset')).toBe(true);
  });

  it('never unlinks corrupt stores and surfaces the original setup failure', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-no-reset-corrupt-'), 'store.db');
    createCorruptStore(dbPath);
    const before = readFileSync(dbPath, 'utf-8');

    const error = captureError(() => openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: dbPath }));

    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(dbPath, 'utf-8')).toBe(before);
  });
});

describe('KbQueryRegistry', () => {
  it('reuses runtime-owned read-only DB handles until the registry is closed', () => {
    const runtime = createRuntime();
    createCurrentStore(runtime);

    const registry = new KbQueryRegistry();
    try {
      const first = registry.getRuntimeDb(runtime);
      const second = registry.getRuntimeDb(runtime);

      expect(second).toBe(first);
    } finally {
      registry.close();
    }
  });

  it('constructs a query-only runtime without creating the KB runtime target', () => {
    const runtime = createRuntime();
    createCurrentStore(runtime);
    const kbRuntimeRoot = runtime.paths.coral.kbRuntime.root;
    expect(existsSync(kbRuntimeRoot)).toBe(false);

    const mkdir = vi.spyOn(runtime.storage, 'mkdirSync');
    const remove = vi.spyOn(runtime.storage, 'rmSync');
    const rename = vi.spyOn(runtime.storage, 'renameSync');
    const write = vi.spyOn(runtime.storage, 'writeFileSync');

    createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime });

    expect(mkdir).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(kbRuntimeRoot)).toBe(false);
  });

  it('leaves malformed staged projection evidence byte-identical during query construction', () => {
    const runtime = createRuntime();
    createCurrentStore(runtime);
    const commitRecord = join(
      runtime.paths.coral.kbRuntime.root,
      'corpus-projection',
      'commits',
      'malformed',
      'commit.json',
    );
    mkdirSync(dirname(commitRecord), { recursive: true });
    writeFileSync(commitRecord, '{malformed', 'utf-8');
    const before = readFileSync(commitRecord);

    createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime });

    expect(readFileSync(commitRecord)).toEqual(before);
  });
});
