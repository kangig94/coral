import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { cleanupRetiredExpansion } from '#src/kb-daemon/expansion/retirement.js';
import { ExpansionStateStore } from '#src/kb-daemon/expansion/state.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const roots: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    db.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(flavor: 'prod' | 'dev' = 'prod') {
  const root = mkdtempSync(join(tmpdir(), 'coral-retired-expansion-'));
  roots.push(root);
  const runtime = createRealRuntime(flavor, { baseDir: root });
  const runtimeDir = join(root, flavor === 'prod' ? 'kb-runtime' : 'kb-runtime-dev');
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  databases.push(db);
  const state = new ExpansionStateStore(db);
  const manifestCatalog = createExpansionManifestCatalog({ db, staticManifests: [] });
  const consumerDriver = new ConsumerDriver({
    db,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    time: runtime.time,
  });
  return { root, runtime, runtimeDir, db, state, manifestCatalog, consumerDriver };
}

function writeSentinel(path: string, value: string): string {
  mkdirSync(path, { recursive: true });
  const target = join(path, 'sentinel');
  writeFileSync(target, value);
  return target;
}

async function cleanup(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  runtime: Runtime = fixture.runtime,
  finalizeState: () => void = () => fixture.state.delete(id),
) {
  return cleanupRetiredExpansion(id, {
    runtime,
    kbRuntimeDir: fixture.runtimeDir,
    manifestCatalog: fixture.manifestCatalog,
    consumerDriver: fixture.consumerDriver,
    finalizeState,
  });
}

describe('retired expansion cleanup', () => {
  it('removes only the selected flavor residue and deletes state last', async () => {
    const flavor = 'dev' as const;
    const fixture = createFixture(flavor);
    const otherFlavor = 'prod';
    const otherRuntime = createRealRuntime(otherFlavor, { baseDir: fixture.root });
    const id = 'vector-fixture';
    const engineSentinel = writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), flavor);
    const projectionSentinel = writeSentinel(join(fixture.runtimeDir, id), flavor);
    const stagingSentinel = writeSentinel(join(fixture.runtimeDir, `${id}-staging`), flavor);
    const otherEngineSentinel = writeSentinel(otherRuntime.paths.coral.engine.dataDir(id), otherFlavor);
    fixture.state.insert({
      id,
      version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
    });
    fixture.db
      .prepare(
        `INSERT INTO consumer_cursors (consumer_id, authority, cursor, registered_at, registration_kind)
       VALUES (?, 'journal', 0, '2026-01-01T00:00:00.000Z', 'expansion')`,
      )
      .run(id);

    let observedFinalBoundary = false;
    const result = await cleanup(fixture, id, fixture.runtime, () => {
      observedFinalBoundary = true;
      expect(fixture.state.get(id)).toBeDefined();
      expect(existsSync(engineSentinel)).toBe(false);
      expect(existsSync(projectionSentinel)).toBe(false);
      expect(existsSync(stagingSentinel)).toBe(false);
      expect(fixture.db.prepare('SELECT 1 FROM consumer_cursors WHERE consumer_id = ?').get(id)).toBeUndefined();
      expect(existsSync(fixture.runtime.paths.coral.engine.installLockPath(id))).toBe(true);
      fixture.state.delete(id);
    });

    expect(result).toBe('removed');
    expect(observedFinalBoundary).toBe(true);
    expect(fixture.state.get(id)).toBeUndefined();
    expect(readFileSync(otherEngineSentinel, 'utf8')).toBe(otherFlavor);
  });

  it('keeps the state retry marker after partial cleanup and finishes on retry', async () => {
    const fixture = createFixture();
    const id = 'vector-fixture';
    writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), 'engine');
    const projectionPath = join(fixture.runtimeDir, id);
    writeSentinel(projectionPath, 'projection');
    fixture.state.insert({ id, version: '1.0.0', installed_at: '2026-01-01T00:00:00.000Z' });
    let injected = false;
    const failingRuntime: Runtime = {
      ...fixture.runtime,
      storage: {
        ...fixture.runtime.storage,
        rmSync: (path, options) => {
          if (!injected && path === projectionPath) {
            injected = true;
            throw new Error('projection cleanup interrupted');
          }
          fixture.runtime.storage.rmSync(path, options);
        },
      },
    };

    await expect(cleanup(fixture, id, failingRuntime)).rejects.toThrow(/projection cleanup interrupted/u);
    expect(existsSync(fixture.runtime.paths.coral.engine.dataDir(id))).toBe(false);
    expect(existsSync(projectionPath)).toBe(true);
    expect(fixture.state.get(id)).toBeDefined();

    await expect(cleanup(fixture, id)).resolves.toBe('removed');
    expect(existsSync(projectionPath)).toBe(false);
    expect(fixture.state.get(id)).toBeUndefined();
  });
});
