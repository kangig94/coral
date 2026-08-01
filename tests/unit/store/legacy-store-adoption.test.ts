import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { acquireDirectoryLock } from '#src/infra/fs-lock.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createBackendStoreResetAuthority, openOrResetBackendStoreDb } from '#src/store/backend-store-reset.js';
import { openStoreDatabase } from '#src/store/db.js';
import {
  generationMutationCoordinationSeam,
  inspectGenerationReadiness,
  resolveGenerationBoundaryPaths,
} from '#src/store/generation-mutation-coordination.js';
import { adoptLegacyStore, type AdoptionSocketGuard } from '#src/store/legacy-store-adoption.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const STORE_FORMAT = currentCoralStoreFormat();
const roots: string[] = [];

function harness(flavor: BuildFlavor = 'prod'): { readonly baseDir: string; readonly runtime: Runtime } {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-legacy-store-adoption-'));
  roots.push(baseDir);
  return { baseDir, runtime: createRealRuntime(flavor, { baseDir }) };
}

function buildIdentity(flavor: BuildFlavor) {
  return {
    version: STORE_FORMAT.productVersion,
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    bundleHash: '0123456789abcdef',
    cliBundleHash: '123456789abcdef0',
    claudeAppserverBundleHash: '23456789abcdef01',
    flavor,
    storeFormatFingerprint: STORE_FORMAT.fingerprint,
  };
}

function openGeneratedStore(runtime: Runtime): void {
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: true },
    { namespace: 'adoption-test', build: buildIdentity(runtime.flavor), storeFormat: STORE_FORMAT },
  );
  openOrResetBackendStoreDb(runtime, authority, { storeFormat: STORE_FORMAT }).close();
}

function createForeignLegacyStore(runtime: Runtime): string {
  const paths = resolveGenerationBoundaryPaths(runtime);
  const dbFile = join(paths.legacyFlavorRoot, 'store', 'store.db');
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('coordinator_id', 'legacy');
      CREATE TABLE history (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO history (value) VALUES ('legacy-byte-sentinel');
    `);
  } finally {
    db.close();
  }
  writeFileSync(join(paths.legacyFlavorRoot, 'legacy-extra.bin'), Buffer.from([0, 1, 2, 3, 255]));
  return paths.legacyFlavorRoot;
}

function createSameGenerationLegacyStore(runtime: Runtime, removeProductVersion = true): string {
  const paths = resolveGenerationBoundaryPaths(runtime);
  const dbFile = join(paths.legacyFlavorRoot, 'store', 'store.db');
  openStoreDatabase({ path: dbFile, storage: runtime.storage, storeFormat: STORE_FORMAT }).close();
  if (removeProductVersion) {
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare("DELETE FROM meta WHERE key = 'store_product_version'").run();
    } finally {
      db.close();
    }
  }
  const equipment = join(paths.legacyFlavorRoot, 'equipment', 'dormant.bin');
  mkdirSync(dirname(equipment), { recursive: true });
  writeFileSync(equipment, 'rename-carried-equipment', 'utf-8');
  return paths.legacyFlavorRoot;
}

function hashTree(root: string): string {
  const hash = createHash('sha256');
  const visit = (path: string): void => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const child = join(path, entry.name);
      hash.update(relative(root, child));
      hash.update(entry.isDirectory() ? 'dir' : 'file');
      if (entry.isDirectory()) visit(child);
      else hash.update(readFileSync(child));
    }
  };
  visit(root);
  return hash.digest('hex');
}

function readMeta(dbFile: string, key: string): string | null {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ? LIMIT 1').get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } finally {
    db.close();
  }
}

function fakeSocketGuard(events?: string[]): () => Promise<AdoptionSocketGuard> {
  return async () => {
    events?.push('socket-acquire');
    return {
      async release() {
        events?.push('socket-release');
      },
    };
  };
}

function captureSetupError(error: unknown, code: string): void {
  expect(serializeCoralSetupError(error)).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy store generation adoption', () => {
  it('checks the generated target first and never consults legacy state when generated state exists', () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(paths.generatedFlavorRoot, { recursive: true });
    const exists = runtime.storage.existsSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'existsSync').mockImplementation((path) => {
      if (path === paths.legacyFlavorRoot || path.startsWith(`${paths.legacyFlavorRoot}/`)) {
        throw new Error('legacy path consulted despite generated state');
      }
      return exists(path);
    });

    expect(inspectGenerationReadiness(runtime)).toEqual({ kind: 'generated-ready' });
  });

  it('permits coordinator initialization when both generation targets are absent', () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
    expect(existsSync(paths.legacyFlavorRoot)).toBe(false);

    openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
  });

  it('refuses a foreign generation byte-for-byte, then ordinary startup initializes empty generated state', async () => {
    const { runtime } = harness();
    const legacyRoot = createForeignLegacyStore(runtime);
    const before = hashTree(legacyRoot);
    const socket = vi.fn(fakeSocketGuard());

    let refusal: unknown;
    try {
      await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: socket });
    } catch (error: unknown) {
      refusal = error;
    }

    captureSetupError(refusal, 'legacy_foreign_generation');
    expect(serializeCoralSetupError(refusal)).toMatchObject({
      context: { legacyPath: legacyRoot, version: '0.9.x' },
    });
    expect(socket).not.toHaveBeenCalled();
    expect(hashTree(legacyRoot)).toBe(before);

    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
    expect(hashTree(legacyRoot)).toBe(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(legacyRoot));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Coral 0.9.x'));
  });

  it.each(['prod', 'dev'] as const)(
    'moves the complete %s flavor tree with one root rename under external guards',
    async (flavor) => {
      const { runtime } = harness(flavor);
      const source = createSameGenerationLegacyStore(runtime);
      const paths = resolveGenerationBoundaryPaths(runtime);
      const events: string[] = [];
      let socketHeld = false;
      const acquireSocketGuard = async (): Promise<AdoptionSocketGuard> => {
        socketHeld = true;
        events.push('socket-acquire');
        return {
          async release() {
            expect(socketHeld).toBe(true);
            socketHeld = false;
            events.push('socket-release');
          },
        };
      };
      const rename = runtime.storage.renameSync.bind(runtime.storage);
      const renameSpy = vi.spyOn(runtime.storage, 'renameSync').mockImplementation((from, to) => {
        events.push(`rename:${from}->${to}`);
        rename(from, to);
      });
      const sync = runtime.storage.syncDirectoryDurableSync.bind(runtime.storage);
      vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
        expect(socketHeld).toBe(true);
        expect(existsSync(paths.adoptionLock)).toBe(true);
        expect(existsSync(paths.maintenanceLock)).toBe(true);
        events.push(`sync:${path}`);
        return sync(path);
      });

      const result = await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard });

      expect(result).toMatchObject({
        kind: 'adopted',
        flavor,
        source,
        destination: paths.generatedFlavorRoot,
        sourceState: 'adoptable',
      });
      expect(renameSpy).toHaveBeenCalledExactlyOnceWith(source, paths.generatedFlavorRoot);
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(join(paths.generatedFlavorRoot, 'equipment', 'dormant.bin'), 'utf-8')).toBe(
        'rename-carried-equipment',
      );
      expect(readMeta(storeDbPath(paths.generatedFlavorRoot), 'adopted_by_version')).toBe(STORE_FORMAT.productVersion);
      expect(events).toEqual([
        'socket-acquire',
        `rename:${source}->${paths.generatedFlavorRoot}`,
        `sync:${paths.baseDir}`,
        `sync:${paths.generationRoot}`,
        'socket-release',
      ]);
      expect(paths.adoptionLock.startsWith(`${paths.generatedFlavorRoot}/`)).toBe(false);
    },
  );

  it('adopts a matching-fingerprint source that already has the current product-version row', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime, false);

    await expect(
      adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() }),
    ).resolves.toMatchObject({ kind: 'adopted', sourceState: 'adoptable' });
  });

  it('recovers the prepared-adoption state after the post-COMMIT/pre-close fault and preserves its timestamp', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const now = vi.spyOn(runtime.time, 'now').mockReturnValue(Date.parse('2026-08-01T01:02:03.004Z'));

    await expect(
      adoptLegacyStore({
        runtime,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: fakeSocketGuard(),
        faults: {
          afterProvenanceCommitBeforeClose() {
            throw new Error('post-commit fault');
          },
        },
      }),
    ).rejects.toThrow('post-commit fault');

    const sourceDb = storeDbPath(paths.legacyFlavorRoot);
    const originalTimestamp = readMeta(sourceDb, 'adopted_from_legacy_at');
    expect(originalTimestamp).toBe('2026-08-01T01:02:03.004Z');
    expect(readMeta(sourceDb, 'adopted_by_version')).toBe(STORE_FORMAT.productVersion);
    now.mockReturnValue(Date.parse('2026-08-01T05:06:07.008Z'));

    const result = await adoptLegacyStore({
      runtime,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: fakeSocketGuard(),
    });

    expect(result).toMatchObject({
      kind: 'adopted',
      sourceState: 'prepared-adoption',
      adoptedAt: originalTimestamp,
    });
    expect(readMeta(storeDbPath(paths.generatedFlavorRoot), 'adopted_from_legacy_at')).toBe(originalTimestamp);
  });

  it('recovers after the rename from the complete generated target without consulting the legacy path', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const acquireSocketGuard = vi.fn(fakeSocketGuard());

    await expect(
      adoptLegacyStore({
        runtime,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard,
        faults: {
          afterRename() {
            throw new Error('post-rename fault');
          },
        },
      }),
    ).rejects.toThrow('post-rename fault');
    expect(existsSync(paths.legacyFlavorRoot)).toBe(false);
    expect(existsSync(paths.generatedFlavorRoot)).toBe(true);

    const exists = runtime.storage.existsSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'existsSync').mockImplementation((path) => {
      if (path === paths.legacyFlavorRoot || path.startsWith(`${paths.legacyFlavorRoot}/`)) {
        throw new Error('legacy path consulted after rename');
      }
      return exists(path);
    });

    const result = await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard });

    expect(result).toMatchObject({ kind: 'already-adopted', destination: paths.generatedFlavorRoot });
    expect(acquireSocketGuard).toHaveBeenCalledTimes(1);
  });

  it('refuses with the typed quiescence error while a generation writer lease is live', async () => {
    const { runtime } = harness();
    const source = createSameGenerationLegacyStore(runtime);
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const readiness = await generationMutationCoordinationSeam.completeReadiness(runtime, {
      kind: 'install',
      name: 'kiwi',
    });
    readiness.release();
    const writer = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
      kind: 'install',
      name: 'kiwi',
    });

    try {
      let refusal: unknown;
      try {
        await adoptLegacyStore({
          runtime,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: fakeSocketGuard(),
          maintenanceTimeoutMs: 30,
        });
      } catch (error: unknown) {
        refusal = error;
      }
      captureSetupError(refusal, 'legacy_source_not_quiescent');
      expect(serializeCoralSetupError(refusal)).toMatchObject({ context: { holder: expect.stringContaining('kiwi') } });
      expect(existsSync(source)).toBe(true);
    } finally {
      writer.release();
    }
  });

  it('removes a verifiably dead install lock before stamping and does not carry it across the rename', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const lockPath = join(paths.legacyFlavorRoot, 'engines', '.locks', 'kiwi.lock');
    const marker = join(lockPath, 'owner-dead.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(marker, 'dead', 'utf-8');
    const staleAt = new Date(runtime.time.now() - 11 * 60 * 1_000);
    utimesSync(marker, staleAt, staleAt);

    await expect(
      adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() }),
    ).resolves.toMatchObject({ kind: 'adopted' });

    expect(existsSync(join(paths.generatedFlavorRoot, 'engines', '.locks', 'kiwi.lock'))).toBe(false);
  });

  it('refuses a live install lock without stamping or moving the source tree', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const lockPath = join(paths.legacyFlavorRoot, 'engines', '.locks', 'kiwi.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    const release = await acquireDirectoryLock(lockPath);

    try {
      let refusal: unknown;
      try {
        await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() });
      } catch (error: unknown) {
        refusal = error;
      }
      captureSetupError(refusal, 'legacy_source_not_quiescent');
      expect(existsSync(paths.legacyFlavorRoot)).toBe(true);
      expect(readMeta(storeDbPath(paths.legacyFlavorRoot), 'adopted_from_legacy_at')).toBeNull();
    } finally {
      release();
    }
  });
});

function storeDbPath(flavorRoot: string): string {
  return join(flavorRoot, 'store', 'store.db');
}
