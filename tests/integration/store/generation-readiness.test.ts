import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { ACTIVE_STORE_SELECTION_VERSION } from '#src/store/active-store-selection.js';
import { coordinateActiveStoreSelection } from '#src/store/active-store-selection-coordination.js';
import { authorizeFixtureStoreMint, openTestStoreDatabase } from '#tests/helpers/store-db.js';
import {
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
    authorizeMint: authorizeFixtureStoreMint,
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
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

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
  });
});
