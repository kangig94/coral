import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { ACTIVE_STORE_SELECTION_VERSION } from '#src/store/active-store-selection.js';
import { coordinateActiveStoreSelection } from '#src/store/active-store-selection-coordination.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import {
  formatLegacyGenerationIgnoredNotice,
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

function generatedStorePath(runtime: Runtime): string {
  return join(runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db');
}

async function openGeneratedStore(runtime: Runtime): Promise<void> {
  const build = {
    version: STORE_FORMAT.productVersion,
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    bundleHash: '0123456789abcdef',
    cliBundleHash: '123456789abcdef0',
    claudeAppserverBundleHash: '23456789abcdef01',
    durableWrapperBundleHash: '3456789abcdef012',
    flavor: runtime.flavor,
    storeFormatFingerprint: STORE_FORMAT.fingerprint,
  };
  const bundleDir = mkdtempSync(join(tmpdir(), 'coral-generation-readiness-bundle-'));
  roots.push(bundleDir);
  const result = await coordinateActiveStoreSelection(runtime, {
    storeFormat: STORE_FORMAT,
    currentSelection: {
      version: ACTIVE_STORE_SELECTION_VERSION,
      manifest: build,
      bundleDir,
      activeStoreFingerprint: build.storeFormatFingerprint,
    },
    dependencies: {
      kind: 'startup',
      validateSelectedTarget: () => {
        throw new Error('Generation-readiness fixture never selects a foreign target.');
      },
    },
  });
  if (result.kind !== 'opened') throw new Error('Generation-readiness fixture unexpectedly handed off.');
  result.db.close();
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
  openTestStoreDatabase({ path: dbFile, storage: runtime.storage, storeFormat: STORE_FORMAT }).close();
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

function storeFileSnapshot(storeDir: string): readonly Readonly<{
  name: string;
  bytes: number;
  mtimeNs: string;
  sha256: string;
}>[] {
  return readdirSync(storeDir)
    .sort()
    .map((name) => {
      const path = join(storeDir, name);
      const stat = statSync(path, { bigint: true });
      return {
        name,
        bytes: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      };
    });
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

    expect(inspectGenerationReadiness(runtime)).toEqual({ kind: 'generated-ready' });
  });

  it('permits coordinator initialization when both generation targets are absent', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
    expect(existsSync(paths.legacyFlavorRoot)).toBe(false);
    expect(inspectGenerationReadiness(runtime)).toEqual({ kind: 'no-legacy' });

    await openGeneratedStore(runtime);

    expect(existsSync(generatedStorePath(runtime))).toBe(true);
  });

  it('boots beside readable legacy history without importing it', async () => {
    const { runtime } = harness();
    const legacyRoot = createSameGenerationLegacyStore(runtime);
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime)).toMatchObject({
      kind: 'legacy-ignored',
      legacyPath: legacyRoot,
    });

    // Used to throw `legacy_adoption_required` here: a readable previous
    // generation made the whole daemon unbootable until an operator migrated it.
    await openGeneratedStore(runtime);

    expect(existsSync(generatedStorePath(runtime))).toBe(true);
    expect(legacyHistoryValue(join(legacyRoot, 'store', 'store.db'))).toBe('not-imported');
    expect(legacyHistoryValue(generatedStorePath(runtime))).toBeNull();
    expect(readFileSync(join(legacyRoot, 'equipment', 'dormant.bin'), 'utf-8')).toBe('left-behind-equipment');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(legacyRoot));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('not inspected or changed'));
  });

  it('boots beside a crashed legacy WAL store without changing any legacy file', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    const storeDir = join(paths.legacyFlavorRoot, 'store');
    const dbFile = join(storeDir, 'store.db');
    mkdirSync(storeDir, { recursive: true });
    const crashed = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec(\"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('store_product_version', '0.9.16'); CREATE TABLE history (value TEXT NOT NULL); INSERT INTO history VALUES ('crashed-wal');\"); process.kill(process.pid, 'SIGKILL');",
        dbFile,
      ],
      { encoding: 'utf-8' },
    );
    expect(crashed.signal).toBe('SIGKILL');
    rmSync(`${dbFile}-shm`, { force: true });
    expect(readdirSync(storeDir).sort()).toEqual(['store.db', 'store.db-wal']);
    const before = storeFileSnapshot(storeDir);
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    await openGeneratedStore(runtime);

    const after = storeFileSnapshot(storeDir);
    expect(after).toEqual(before);
  });

  it('boots beside a foreign legacy generation without inspecting its stored version', async () => {
    const { runtime } = harness();
    const legacyRoot = createForeignLegacyStore(runtime, '0.9.16');
    const before = hashTree(legacyRoot);
    const warning = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime)).toMatchObject({
      kind: 'legacy-ignored',
      legacyPath: legacyRoot,
    });

    await openGeneratedStore(runtime);

    expect(existsSync(generatedStorePath(runtime))).toBe(true);
    expect(hashTree(legacyRoot)).toBe(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('contents were not inspected or changed'));
  });

  it('boots beside an unreadable legacy store rather than diagnosing it', async () => {
    const { runtime } = harness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    const dbFile = join(paths.legacyFlavorRoot, 'store', 'store.db');
    mkdirSync(dirname(dbFile), { recursive: true });
    writeFileSync(dbFile, 'not a database', 'utf-8');
    const before = hashTree(paths.legacyFlavorRoot);
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    expect(inspectGenerationReadiness(runtime)).toMatchObject({
      kind: 'legacy-ignored',
      legacyPath: paths.legacyFlavorRoot,
    });

    await openGeneratedStore(runtime);

    expect(existsSync(generatedStorePath(runtime))).toBe(true);
    expect(hashTree(paths.legacyFlavorRoot)).toBe(before);
  });

  it('grants the generation coordination lease beside legacy history', async () => {
    const { runtime } = harness();
    createSameGenerationLegacyStore(runtime);
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    const completion = await generationMutationCoordinationSeam.completeReadiness(runtime, {
      kind: 'install',
      name: 'generation-readiness-test',
    });

    // Resolving at all is the assertion: this used to reject.
    expect(typeof completion.release).toBe('function');
    completion.release();
  });

  it('names both paths and the observation boundary in the notice', () => {
    const notice = formatLegacyGenerationIgnoredNotice({
      kind: 'legacy-ignored',
      legacyPath: '/home/u/.coral/data',
      generatedPath: '/home/u/.coral/gen2/data',
    });

    expect(notice).toContain('/home/u/.coral/data');
    expect(notice).toContain('/home/u/.coral/gen2/data');
    expect(notice).toContain('contents were not inspected or changed');
  });
});
