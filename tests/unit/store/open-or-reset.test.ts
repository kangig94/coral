import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { createExpansionManifestCatalog } from '#src/expansion/manifest-catalog.js';
import { readDefaultExpansionCatalog, readExpansionCatalog } from '#src/cli/expansion/catalog.js';
import { openReadCoralStore } from '#src/cli/read-store.js';
import {
  ensureBundledEnginesLoaded,
  createDefaultKbQueryRuntime,
  KbQueryRegistry,
} from '#src/read-model/kb-query-runtime.js';
import { documentedCoralSetupError, serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { KbRuntime } from '#src/kb/contract.js';
import {
  createBackendStoreResetAuthority,
  openOrResetBackendStoreDb,
  openWritableStoreDbNoReset,
  type BackendStoreResetAuthority,
} from '#src/store/db.js';
import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';

const REPO_ROOT = process.cwd();
const BUNDLE_HASH = 'test-bundle';
const NAMESPACE = 'test-namespace';

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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

function readUserVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return row?.user_version ?? 0;
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, name: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined;
  } finally {
    db.close();
  }
}

function legacySchemaVersionRow(dbPath: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1").get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function createLegacyStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL);
      PRAGMA user_version = 0;
    `);
  } finally {
    db.close();
  }
}

function createMismatchStore(dbPath: string, marker = 1): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
      PRAGMA user_version = ${marker};
    `);
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
      bundleHash: BUNDLE_HASH,
      namespace: NAMESPACE,
    },
  );
}

function openReset(runtime: Runtime, dbPath: string) {
  return openOrResetBackendStoreDb(runtime, authorityFor(runtime, dbPath), {
    path: dbPath,
    bundleHash: BUNDLE_HASH,
    namespace: NAMESPACE,
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

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
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
    expect(readUserVersion(dbPath)).not.toBe(0);
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
    expect(readUserVersion(dbPath)).not.toBe(0);
    expect(existsSync(join(dbDir, 'store.db.reset.lock'))).toBe(false);
  });

  it('resets a legacy v0.6.2 store, warns, and removes the old meta schema marker', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-legacy-'), 'store.db');
    createLegacyStore(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = openReset(runtime, dbPath);
    db.close();

    expect(readUserVersion(dbPath)).not.toBe(0);
    expect(legacySchemaVersionRow(dbPath)).toBeNull();
    const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(messages.some((message) => message.includes('will be lost'))).toBe(true);
    expect(
      messages.some((message) => message.startsWith('audit ') && message.includes('"event":"store_reset_quarantine"')),
    ).toBe(true);
  });

  it('leaves an already-current store in place without warning', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-current-'), 'store.db');
    const first = openReset(runtime, dbPath);
    first.close();
    const marker = readUserVersion(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const second = openReset(runtime, dbPath);
    second.close();

    expect(readUserVersion(dbPath)).toBe(marker);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resets a mismatched marker and removes the old store contents', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-mismatch-'), 'store.db');
    createMismatchStore(dbPath);

    const db = openReset(runtime, dbPath);
    db.close();

    expect(readUserVersion(dbPath)).not.toBe(1);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('quarantines mismatched store files before creating the replacement store', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-mismatch-quarantine-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const originalDbBytes = readFileSync(dbPath);
    writeFileSync(`${dbPath}-wal`, 'dummy wal', 'utf-8');
    writeFileSync(`${dbPath}-shm`, 'dummy shm', 'utf-8');

    const db = openReset(runtime, dbPath);
    db.close();

    const quarantineRoot = join(dbDir, 'store-reset-quarantine');
    const quarantineEntries = readdirSync(quarantineRoot);
    expect(quarantineEntries).toHaveLength(1);
    const quarantineDir = join(quarantineRoot, quarantineEntries[0]);
    expect(readFileSync(join(quarantineDir, 'store.db-wal'), 'utf-8')).toBe('dummy wal');
    expect(existsSync(join(quarantineDir, 'store.db-shm'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(quarantineDir, 'reset-manifest.json'), 'utf-8')) as {
      schemaVersion?: unknown;
      reason?: unknown;
      userVersion?: unknown;
      storedVersion?: unknown;
      expectedVersion?: unknown;
      dbFile?: unknown;
      quarantineDir?: unknown;
      files?: Array<{
        name?: unknown;
        source?: unknown;
        quarantinedPath?: unknown;
        sizeBytes?: unknown;
        sha256?: unknown;
      }>;
    };
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      reason: 'mismatch',
      userVersion: 1,
      storedVersion: 1,
      dbFile: dbPath,
      quarantineDir,
    });
    expect(typeof manifest.expectedVersion).toBe('number');
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'store.db',
          source: dbPath,
          quarantinedPath: join(quarantineDir, 'store.db'),
          sizeBytes: originalDbBytes.length,
          sha256: sha256(originalDbBytes),
        }),
        expect.objectContaining({
          name: 'store.db-wal',
          source: `${dbPath}-wal`,
          quarantinedPath: join(quarantineDir, 'store.db-wal'),
          sizeBytes: 'dummy wal'.length,
          sha256: sha256('dummy wal'),
        }),
      ]),
    );
    rmSync(join(quarantineDir, 'store.db-wal'), { force: true });
    rmSync(join(quarantineDir, 'store.db-shm'), { force: true });
    expect(tableExists(join(quarantineDir, 'store.db'), 'sentinel_before_reset')).toBe(true);
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
  });

  it('logs the live-work-loss warning for mismatched stores', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-mismatch-warning-'), 'store.db');
    createMismatchStore(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = openReset(runtime, dbPath);
    db.close();

    const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(
      messages.some((message) => message.includes('resetting backend store') && message.includes('will be lost')),
    ).toBe(true);
    expect(
      messages.some((message) => message.startsWith('audit ') && message.includes('"event":"store_reset_quarantine"')),
    ).toBe(true);
  });

  it('cleans up stale WAL and SHM siblings during mismatch reset', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-wal-shm-'), 'store.db');
    createMismatchStore(dbPath);
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    writeFileSync(walPath, 'dummy wal', 'utf-8');
    writeFileSync(shmPath, 'dummy shm', 'utf-8');

    const db = openReset(runtime, dbPath);
    db.close();

    // unlink runs unconditionally during mismatch reset; if the new opener
    // re-creates WAL/SHM (WAL mode), they must not contain the dummy bytes.
    expect(existsSync(walPath) ? readFileSync(walPath, 'utf-8') : '').not.toBe('dummy wal');
    expect(existsSync(shmPath) ? readFileSync(shmPath, 'utf-8') : '').not.toBe('dummy shm');
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
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

    expect(readUserVersion(dbPath)).not.toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('does not reset a corrupt store file', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-corrupt-reset-'), 'store.db');
    createCorruptStore(dbPath);
    const before = readFileSync(dbPath, 'utf-8');
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const error = captureError(() => openReset(runtime, dbPath));

    expect(error).toBeInstanceOf(Error);
    // Reset is forbidden on corrupt files: the bytes must be byte-identical,
    // and the error must NOT be one of the documented reset codes — those
    // would imply the path attempted reset.
    expect(readFileSync(dbPath, 'utf-8')).toBe(before);
    const errorMessage = error instanceof Error ? error.message : '';
    expect(errorMessage).not.toMatch(/store_reset_lock_contended|store_schema_outdated/);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects mismatched authority and does not unlink the existing DB', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-authority-mismatch-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);

    // Build an authority with a wrong bundleHash — represents a stale
    // authority captured before a runtime/bundle change.
    const staleAuthority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: true },
      {
        path: dbPath,
        bundleHash: 'stale-bundle-hash',
        namespace: NAMESPACE,
      },
    );

    const error = captureError(() =>
      openOrResetBackendStoreDb(runtime, staleAuthority, {
        path: dbPath,
        bundleHash: BUNDLE_HASH,
        namespace: NAMESPACE,
      }),
    );

    expectSetupCode(error, 'store_schema_outdated');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe('read-only store access', () => {
  it('throws store_schema_outdated for legacy and mismatched stores without changing the file', () => {
    const runtime = createRuntime();
    const legacyPath = join(makeTempRoot('coral-store-readonly-legacy-'), 'store.db');
    const mismatchPath = join(makeTempRoot('coral-store-readonly-mismatch-'), 'store.db');
    createLegacyStore(legacyPath);
    createMismatchStore(mismatchPath);
    const legacyBefore = readFileSync(legacyPath);
    const mismatchBefore = readFileSync(mismatchPath);

    const legacyError = captureError(() => openReadOnlyStoreDatabase(runtime, { path: legacyPath }));
    const mismatchError = captureError(() => openReadOnlyStoreDatabase(runtime, { path: mismatchPath }));

    expectSetupCode(legacyError, 'store_schema_outdated');
    expectSetupCode(mismatchError, 'store_schema_outdated');
    expect(readFileSync(legacyPath)).toEqual(legacyBefore);
    expect(readFileSync(mismatchPath)).toEqual(mismatchBefore);
  });

  describe('does not mask store_schema_outdated in read-only callers', () => {
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

    it('createDefaultKbQueryRuntime', () => {
      const { runtime } = makeMismatchHome();
      expectSetupCode(
        captureError(() => createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime })),
        'store_schema_outdated',
      );
    });

    it('ensureBundledEnginesLoaded', async () => {
      const { runtime } = makeMismatchHome();
      expectSetupCode(
        await captureAsyncError(() => ensureBundledEnginesLoaded({} as KbRuntime, { pluginRoot: REPO_ROOT, runtime })),
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
  it('opens fresh and current stores for catalog writers', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-no-reset-current-'), 'store.db');

    const fresh = openWritableStoreDbNoReset(runtime, { path: dbPath });
    fresh.close();
    const marker = readUserVersion(dbPath);
    const current = openWritableStoreDbNoReset(runtime, { path: dbPath });
    current.close();

    expect(marker).not.toBe(0);
    expect(readUserVersion(dbPath)).toBe(marker);
  });

  it('never unlinks legacy or mismatched stores and surfaces store_schema_outdated', () => {
    const runtime = createRuntime();
    const legacyPath = join(makeTempRoot('coral-store-no-reset-legacy-'), 'store.db');
    const mismatchPath = join(makeTempRoot('coral-store-no-reset-mismatch-'), 'store.db');
    createLegacyStore(legacyPath);
    createMismatchStore(mismatchPath);

    expectSetupCode(
      captureError(() => openWritableStoreDbNoReset(runtime, { path: legacyPath })),
      'store_schema_outdated',
    );
    expectSetupCode(
      captureError(() => openWritableStoreDbNoReset(runtime, { path: mismatchPath })),
      'store_schema_outdated',
    );

    expect(legacySchemaVersionRow(legacyPath)).toBe('1');
    expect(tableExists(mismatchPath, 'sentinel_before_reset')).toBe(true);
  });

  it('never unlinks corrupt stores and surfaces the original setup failure', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-no-reset-corrupt-'), 'store.db');
    createCorruptStore(dbPath);
    const before = readFileSync(dbPath, 'utf-8');

    const error = captureError(() => openWritableStoreDbNoReset(runtime, { path: dbPath }));

    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(dbPath, 'utf-8')).toBe(before);
  });
});

describe('KbQueryRegistry', () => {
  it('reuses runtime-owned read-only DB handles until the registry is closed', () => {
    const runtime = createRuntime();
    const writable = openWritableStoreDbNoReset(runtime);
    writable.close();

    const registry = new KbQueryRegistry();
    try {
      const first = registry.getRuntimeDb(runtime);
      const second = registry.getRuntimeDb(runtime);

      expect(second).toBe(first);
    } finally {
      registry.close();
    }
  });
});
