import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createBackendStoreResetAuthority, openOrResetBackendStoreDb } from '#src/store/backend-store-reset.js';
import { openStoreDatabase } from '#src/store/db.js';
import {
  formatLegacyGenerationIgnoredNotice,
  acquireGenerationAdoptionLock,
  generationMutationCoordinationSeam,
  inspectGenerationReadiness,
  resolveGenerationBoundaryPaths,
} from '#src/store/generation-mutation-coordination.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const STORE_FORMAT = currentCoralStoreFormat();
const roots: string[] = [];

function harness(flavor: BuildFlavor = 'prod'): { readonly runtime: Runtime } {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-generation-readiness-'));
  roots.push(baseDir);
  return { runtime: createRealRuntime(flavor, { baseDir }) };
}

async function openGeneratedStore(runtime: Runtime): Promise<void> {
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: true },
    {
      namespace: 'generation-readiness-test',
      build: {
        version: STORE_FORMAT.productVersion,
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        cliBundleHash: '123456789abcdef0',
        claudeAppserverBundleHash: '23456789abcdef01',
        flavor: runtime.flavor,
        storeFormatFingerprint: STORE_FORMAT.fingerprint,
      },
      storeFormat: STORE_FORMAT,
    },
  );
  const adoption = await acquireGenerationAdoptionLock(runtime);
  try {
    openOrResetBackendStoreDb(runtime, authority, adoption, { storeFormat: STORE_FORMAT }).close();
  } finally {
    adoption();
  }
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

/** A legacy tree this build can read — the case that used to refuse to boot. */
function createSameGenerationLegacyStore(runtime: Runtime): string {
  const paths = resolveGenerationBoundaryPaths(runtime);
  const dbFile = join(paths.legacyFlavorRoot, 'store', 'store.db');
  openStoreDatabase({ path: dbFile, storage: runtime.storage, storeFormat: STORE_FORMAT }).close();
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE legacy_boot_history (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO legacy_boot_history (value) VALUES ('not-imported');
    `);
  } finally {
    db.close();
  }
  const equipment = join(paths.legacyFlavorRoot, 'equipment', 'dormant.bin');
  mkdirSync(dirname(equipment), { recursive: true });
  writeFileSync(equipment, 'left-behind-equipment', 'utf-8');
  return paths.legacyFlavorRoot;
}

/** Reads the legacy sentinel row, or null when the table does not exist. */
function legacyHistoryValue(dbFile: string): string | null {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM legacy_boot_history LIMIT 1').get() as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A previous generation's tree is never a precondition for this one. These tests
 * pin that: startup reads the legacy path for a diagnostic only, and whether this
 * build could open that store makes no difference to whether it boots.
 */
describe('generation readiness', () => {
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

  it('permits coordinator initialization when both generation targets are absent', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
    expect(existsSync(paths.legacyFlavorRoot)).toBe(false);
    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toEqual({ kind: 'no-legacy' });

    await openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
  });

  it('boots beside readable legacy history without importing it', async () => {
    const { runtime } = harness();
    const legacyRoot = createSameGenerationLegacyStore(runtime);
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toMatchObject({
      kind: 'legacy-ignored',
      legacyPath: legacyRoot,
    });

    // Used to throw `legacy_adoption_required` here: a readable previous
    // generation made the whole daemon unbootable until an operator migrated it.
    await openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
    // The legacy rows stay where they are, and none of them appear in the new
    // generation. A byte hash of the tree would be the wrong assertion here:
    // classifying the legacy store opens it, and SQLite rewrites its sidecars.
    expect(legacyHistoryValue(join(legacyRoot, 'store', 'store.db'))).toBe('not-imported');
    expect(legacyHistoryValue(runtime.paths.coral.store.dbFile)).toBeNull();
    expect(readFileSync(join(legacyRoot, 'equipment', 'dormant.bin'), 'utf-8')).toBe('left-behind-equipment');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(legacyRoot));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('left untouched'));
  });

  it('boots beside a foreign legacy generation and reports its stored version', async () => {
    const { runtime } = harness();
    const legacyRoot = createForeignLegacyStore(runtime, '0.9.16');
    const before = hashTree(legacyRoot);
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toMatchObject({
      kind: 'legacy-ignored',
      legacyPath: legacyRoot,
      storedProductVersion: '0.9.16',
    });

    await openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
    expect(hashTree(legacyRoot)).toBe(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('0.9.16'));
  });

  it('boots beside an unreadable legacy store rather than diagnosing it', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    const dbFile = join(paths.legacyFlavorRoot, 'store', 'store.db');
    mkdirSync(dirname(dbFile), { recursive: true });
    writeFileSync(dbFile, 'not a database', 'utf-8');
    const before = hashTree(paths.legacyFlavorRoot);
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime, STORE_FORMAT)).toMatchObject({
      kind: 'legacy-ignored',
      legacyPath: paths.legacyFlavorRoot,
      // Unreadable is reported as unknown, never guessed.
      storedProductVersion: null,
    });

    await openGeneratedStore(runtime);

    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
    expect(hashTree(paths.legacyFlavorRoot)).toBe(before);
  });

  it('grants the generation coordination lease beside legacy history', async () => {
    // `acquireGenerationAdoptionLease` carries its own copy of the readiness
    // switch and gates `store-reset`, `kb-commit quarantine`, and `expansion
    // install` — not the daemon boot path the tests above cover. It used to reject
    // with `legacy_adoption_required` here too, so a regression in only this copy
    // would reproduce the same lockout for those three commands.
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    const completion = await generationMutationCoordinationSeam.completeReadiness(runtime, STORE_FORMAT, {
      kind: 'install',
      name: 'generation-readiness-test',
    });

    // Resolving at all is the assertion: this used to reject.
    expect(typeof completion.release).toBe('function');
    completion.release();
  });

  it('names both paths and the stored version in the notice', () => {
    const notice = formatLegacyGenerationIgnoredNotice({
      kind: 'legacy-ignored',
      legacyPath: '/home/u/.coral/data',
      generatedPath: '/home/u/.coral/gen2/data',
      storedProductVersion: '0.9.16',
    });

    expect(notice).toContain('/home/u/.coral/data');
    expect(notice).toContain('/home/u/.coral/gen2/data');
    expect(notice).toContain('0.9.16');
    expect(notice).toContain('left untouched');
  });
});
