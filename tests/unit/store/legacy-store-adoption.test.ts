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
  formatLegacyAdoptableGenerationNotice,
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

function createForeignLegacyStore(runtime: Runtime, productVersion?: string): string {
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
    if (productVersion !== undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('store_product_version', ?)").run(productVersion);
    }
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

    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toEqual({ kind: 'generated-ready' });
  });

  it('permits coordinator initialization when both generation targets are absent', () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
    expect(existsSync(paths.legacyFlavorRoot)).toBe(false);
    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toEqual({ kind: 'no-legacy' });

    openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
  });

  it('renders the adoption-required guidance without raising it', () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const readiness = inspectGenerationReadiness(runtime, STORE_FORMAT);
    if (readiness.kind !== 'legacy-adoptable') {
      throw new Error(`Expected legacy-adoptable readiness, received ${readiness.kind}`);
    }

    const notice = formatLegacyAdoptableGenerationNotice(readiness, 'prod');

    // The same wording the boot failure would raise, so a status probe and a
    // failed start cannot disagree about what to do.
    expect(notice).toContain(paths.legacyFlavorRoot);
    expect(notice).toContain('must be adopted before this generation can initialize');
    expect(notice).toContain("Run 'coral-cli backend store-adopt --flavor prod'");
  });

  it('boots only after same-generation legacy history is explicitly adopted', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toEqual({
      kind: 'legacy-adoptable',
      legacyPath: paths.legacyFlavorRoot,
    });
    const legacyDb = storeDbPath(paths.legacyFlavorRoot);
    const history = new DatabaseSync(legacyDb);
    try {
      history.exec(`
        CREATE TABLE legacy_boot_history (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO legacy_boot_history (value) VALUES ('survives-adoption');
      `);
    } finally {
      history.close();
    }

    let refusal: unknown;
    try {
      openGeneratedStore(runtime);
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'legacy_adoption_required',
      context: { legacyPath: paths.legacyFlavorRoot, flavor: 'prod' },
      remediation: expect.stringContaining('coral-cli backend store-adopt --flavor prod'),
    });
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);

    await expect(
      adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() }),
    ).resolves.toMatchObject({ kind: 'adopted' });
    openGeneratedStore(runtime);

    const adopted = new DatabaseSync(runtime.paths.coral.store.dbFile, { readOnly: true });
    try {
      expect(adopted.prepare('SELECT value FROM legacy_boot_history').get()).toEqual({
        value: 'survives-adoption',
      });
    } finally {
      adopted.close();
    }
  });

  it('boots empty beside a byte-identical foreign generation, then refuses adoption as foreign', async () => {
    const { runtime } = harness();
    const legacyRoot = createForeignLegacyStore(runtime, '0.9.16');
    const before = hashTree(legacyRoot);
    const socket = vi.fn(fakeSocketGuard());
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toMatchObject({
      kind: 'legacy-foreign',
      legacyPath: legacyRoot,
      storedProductVersion: '0.9.16',
    });

    openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
    expect(hashTree(legacyRoot)).toBe(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(legacyRoot));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('stored Coral version is 0.9.16'));
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('0.9.x'));

    let refusal: unknown;
    try {
      await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: socket });
    } catch (error: unknown) {
      refusal = error;
    }

    captureSetupError(refusal, 'legacy_foreign_generation');
    expect(serializeCoralSetupError(refusal)).toMatchObject({
      context: { legacyPath: legacyRoot, version: '0.9.16' },
    });
    expect(socket).not.toHaveBeenCalled();
    expect(hashTree(legacyRoot)).toBe(before);
  });

  it('reports a missing legacy store database as observed instead of fabricating a foreign generation', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(paths.legacyFlavorRoot, { recursive: true });
    const socket = vi.fn(fakeSocketGuard());

    let refusal: unknown;
    try {
      await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: socket });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'legacy_adoption_source_unreadable',
      context: {
        legacyPath: paths.legacyFlavorRoot,
        observation: expect.stringContaining('is missing'),
      },
    });
    expect(serializeCoralSetupError(refusal)?.context).not.toHaveProperty('version');
    expect(socket).not.toHaveBeenCalled();
  });

  it('reports corrupt legacy store state as unreadable without inventing a legacy version', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    const dbFile = storeDbPath(paths.legacyFlavorRoot);
    mkdirSync(dirname(dbFile), { recursive: true });
    writeFileSync(dbFile, 'not a sqlite database', 'utf-8');
    const before = readFileSync(dbFile);

    let refusal: unknown;
    try {
      await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'legacy_adoption_source_unreadable',
      context: {
        legacyPath: paths.legacyFlavorRoot,
        observation: expect.stringMatching(/could not be (opened|read)/u),
        cause: expect.stringContaining('database'),
      },
    });
    expect(serializeCoralSetupError(refusal)?.context).not.toHaveProperty('version');
    expect(readFileSync(dbFile)).toEqual(before);
  });

  it.each(['already exists and is not a completed adoption', 'appeared during adoption'] as const)(
    'documents the generated target state when it %s',
    async (observation) => {
      const { runtime } = harness();
      createSameGenerationLegacyStore(runtime);
      const paths = resolveGenerationBoundaryPaths(runtime);
      const acquireSocketGuard = async (): Promise<AdoptionSocketGuard> => {
        if (observation === 'appeared during adoption') {
          mkdirSync(paths.generatedFlavorRoot, { recursive: true });
        }
        return { async release() {} };
      };
      if (observation === 'already exists and is not a completed adoption') {
        mkdirSync(paths.generatedFlavorRoot, { recursive: true });
      }

      let refusal: unknown;
      try {
        await adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard });
      } catch (error: unknown) {
        refusal = error;
      }

      expect(serializeCoralSetupError(refusal)).toMatchObject({
        code: 'legacy_adoption_state_changed',
        context: { observation: expect.stringContaining(observation) },
      });
    },
  );

  it('documents a legacy source that disappears after the guards are acquired', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const acquireSocketGuard = async (): Promise<AdoptionSocketGuard> => {
      rmSync(paths.legacyFlavorRoot, { recursive: true });
      return { async release() {} };
    };

    await expect(adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard })).rejects.toMatchObject({
      code: 'legacy_adoption_state_changed',
      context: { observation: expect.stringContaining('disappeared during adoption') },
    });
  });

  it.each(['baseDir', 'generationRoot'] as const)(
    'documents a failed post-rename directory sync for %s',
    async (pathKey) => {
      const { runtime } = harness();
      createSameGenerationLegacyStore(runtime);
      const paths = resolveGenerationBoundaryPaths(runtime);
      const failingPath = paths[pathKey];
      const sync = runtime.storage.syncDirectoryDurableSync.bind(runtime.storage);
      vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) =>
        path === failingPath ? false : sync(path),
      );

      await expect(
        adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() }),
      ).rejects.toMatchObject({
        code: 'legacy_adoption_durability_failed',
        context: { path: failingPath, flavor: runtime.flavor },
      });
      expect(existsSync(paths.generatedFlavorRoot)).toBe(true);
      expect(existsSync(paths.legacyFlavorRoot)).toBe(false);
    },
  );

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

  it('refuses generation mutation readiness while an adoptable legacy source exists', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);

    await expect(
      generationMutationCoordinationSeam.completeReadiness(runtime, STORE_FORMAT, {
        kind: 'install',
        name: 'kiwi',
      }),
    ).rejects.toMatchObject({ code: 'legacy_adoption_required' });
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
    expect(existsSync(paths.adoptionLock)).toBe(false);
  });

  it('refuses a legacy-adoptable database already placed at the generated target', () => {
    const { runtime } = harness();
    openGeneratedStore(runtime);
    const db = new DatabaseSync(runtime.paths.coral.store.dbFile);
    try {
      db.prepare("DELETE FROM meta WHERE key = 'store_product_version'").run();
    } finally {
      db.close();
    }

    let refusal: unknown;
    try {
      openGeneratedStore(runtime);
    } catch (error: unknown) {
      refusal = error;
    }

    captureSetupError(refusal, 'store_schema_outdated');
    expect(readMeta(runtime.paths.coral.store.dbFile, 'store_product_version')).toBeNull();
  });

  it('recovers a prepared adoption with a newer build and preserves the original timestamp', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const sourceDb = storeDbPath(paths.legacyFlavorRoot);
    const now = vi.spyOn(runtime.time, 'now').mockReturnValue(Date.parse('2026-08-01T01:02:03.004Z'));
    const stampingFormat = { ...STORE_FORMAT, productVersion: '0.0.0' };

    await expect(
      adoptLegacyStore({
        runtime,
        storeFormat: stampingFormat,
        acquireSocketGuard: fakeSocketGuard(),
        faults: {
          afterProvenanceCommitBeforeClose() {
            const observer = new DatabaseSync(sourceDb, { readOnly: true });
            try {
              expect(observer.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
              expect(existsSync(`${sourceDb}-wal`)).toBe(true);
              expect(
                observer
                  .prepare(
                    "SELECT key, value FROM meta WHERE key IN ('adopted_by_version', 'adopted_from_legacy_at', 'store_product_version') ORDER BY key",
                  )
                  .all(),
              ).toEqual([
                { key: 'adopted_by_version', value: stampingFormat.productVersion },
                { key: 'adopted_from_legacy_at', value: '2026-08-01T01:02:03.004Z' },
                { key: 'store_product_version', value: stampingFormat.productVersion },
              ]);
            } finally {
              observer.close();
            }
            throw new Error('post-commit fault');
          },
        },
      }),
    ).rejects.toThrow('post-commit fault');

    // `stampAdoptionProvenance` closes its DB in `finally`, which can checkpoint
    // the WAL. This case proves recovery from committed prepared metadata; it
    // deliberately does not claim to simulate process-crash WAL recovery.
    const originalTimestamp = readMeta(sourceDb, 'adopted_from_legacy_at');
    expect(originalTimestamp).toBe('2026-08-01T01:02:03.004Z');
    expect(readMeta(sourceDb, 'adopted_by_version')).toBe(stampingFormat.productVersion);
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
    expect(readMeta(storeDbPath(paths.generatedFlavorRoot), 'adopted_by_version')).toBe(stampingFormat.productVersion);
  });

  it('retries an adoption crash immediately before rename from the committed prepared state', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    const paths = resolveGenerationBoundaryPaths(runtime);
    const rename = vi.spyOn(runtime.storage, 'renameSync');

    await expect(
      adoptLegacyStore({
        runtime,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: fakeSocketGuard(),
        faults: {
          beforeRename() {
            throw new Error('before-rename fault');
          },
        },
      }),
    ).rejects.toThrow('before-rename fault');

    const sourceDb = storeDbPath(paths.legacyFlavorRoot);
    const adoptedAt = readMeta(sourceDb, 'adopted_from_legacy_at');
    expect(adoptedAt).not.toBeNull();
    expect(readMeta(sourceDb, 'adopted_by_version')).toBe(STORE_FORMAT.productVersion);
    expect(existsSync(paths.legacyFlavorRoot)).toBe(true);
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
    expect(rename).not.toHaveBeenCalled();

    await expect(
      adoptLegacyStore({ runtime, storeFormat: STORE_FORMAT, acquireSocketGuard: fakeSocketGuard() }),
    ).resolves.toMatchObject({ kind: 'adopted', sourceState: 'prepared-adoption', adoptedAt });
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
    const readiness = await generationMutationCoordinationSeam.completeReadiness(runtime, STORE_FORMAT, {
      kind: 'install',
      name: 'kiwi',
    });
    readiness.release();
    const writer = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
      kind: 'install',
      name: 'kiwi',
    });
    const source = createSameGenerationLegacyStore(runtime);

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
