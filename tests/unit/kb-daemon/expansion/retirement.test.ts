import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { installExpansion } from '#src/cli/expansion/install.js';
import { kiwiInstaller } from '#src/engines/kiwi/install.js';
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

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  databases.push(db);
  return db;
}

function createFixture(flavor: 'prod' | 'dev' = 'prod') {
  const root = mkdtempSync(join(tmpdir(), 'coral-retired-expansion-'));
  roots.push(root);
  const runtime = createRealRuntime(flavor, { baseDir: root });
  const kbRuntimeDir = join(root, flavor === 'prod' ? 'kb-runtime' : 'kb-runtime-dev');
  const db = createDb();
  const state = new ExpansionStateStore(db);
  const manifestCatalog = createExpansionManifestCatalog({ db, staticManifests: [] });
  const consumerDriver = new ConsumerDriver({
    db,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    time: runtime.time,
  });
  return { root, runtime, kbRuntimeDir, db, state, manifestCatalog, consumerDriver };
}

function writeSentinel(path: string, value: string): string {
  mkdirSync(path, { recursive: true });
  const target = join(path, 'sentinel');
  writeFileSync(target, value);
  return target;
}

function insertCursor(db: Database, id: string, registrationKind: 'base' | 'expansion'): void {
  db.prepare(
    `INSERT INTO consumer_cursors
       (consumer_id, authority, cursor, registered_at, registration_kind)
     VALUES (?, 'journal', 0, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, registrationKind);
}

async function cleanup(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  runtime: Runtime = fixture.runtime,
  finalizeState: () => void = () => fixture.state.delete(id),
) {
  return cleanupRetiredExpansion(id, {
    runtime,
    kbRuntimeDir: fixture.kbRuntimeDir,
    manifestCatalog: fixture.manifestCatalog,
    consumerDriver: fixture.consumerDriver,
    finalizeState,
  });
}

describe('retired expansion cleanup', () => {
  it.each(['prod', 'dev'] as const)(
    'removes only the selected %s flavor residue and deletes state last',
    async (flavor) => {
      const fixture = createFixture(flavor);
      const otherFlavor = flavor === 'prod' ? 'dev' : 'prod';
      const otherRuntime = createRealRuntime(otherFlavor, { baseDir: fixture.root });
      const id = 'vector-fixture';
      const engineSentinel = writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), flavor);
      const projectionSentinel = writeSentinel(join(fixture.kbRuntimeDir, id), flavor);
      const stagingSentinel = writeSentinel(join(fixture.kbRuntimeDir, `${id}-staging`), flavor);
      const otherEngineSentinel = writeSentinel(otherRuntime.paths.coral.engine.dataDir(id), otherFlavor);
      fixture.state.insert({
        id,
        version: '1.0.0',
        installed_at: '2026-01-01T00:00:00.000Z',
      });
      insertCursor(fixture.db, id, 'expansion');

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
    },
  );

  it('fails before filesystem mutation for base-owned cursors', async () => {
    const fixture = createFixture();
    const id = 'vector-fixture';
    const engineSentinel = writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), 'engine');
    const projectionSentinel = writeSentinel(join(fixture.kbRuntimeDir, id), 'projection');
    fixture.state.insert({
      id,
      version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
    });
    insertCursor(fixture.db, id, 'base');

    await expect(cleanup(fixture, id)).rejects.toThrow();
    expect(readFileSync(engineSentinel, 'utf8')).toBe('engine');
    expect(readFileSync(projectionSentinel, 'utf8')).toBe('projection');
    expect(fixture.state.get(id)).toBeDefined();
  });

  it('leaves filesystem, cursor, and state untouched for an invalid id', async () => {
    const fixture = createFixture();
    const id = '../escape';
    const engineSentinel = writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), 'engine');
    const projectionSentinel = writeSentinel(join(fixture.kbRuntimeDir, id), 'projection');
    const stagingSentinel = writeSentinel(join(fixture.kbRuntimeDir, `${id}-staging`), 'staging');
    fixture.state.insert({ id, version: '0.1.0', installed_at: '2026-01-01T00:00:00.000Z' });
    insertCursor(fixture.db, id, 'expansion');

    await expect(cleanup(fixture, id)).rejects.toMatchObject({ code: 'retired_expansion_id_invalid' });

    expect(readFileSync(engineSentinel, 'utf8')).toBe('engine');
    expect(readFileSync(projectionSentinel, 'utf8')).toBe('projection');
    expect(readFileSync(stagingSentinel, 'utf8')).toBe('staging');
    expect(fixture.state.get(id)).toBeDefined();
    expect(fixture.db.prepare('SELECT 1 FROM consumer_cursors WHERE consumer_id = ?').get(id)).toBeDefined();
  });

  it('shares one exclusion fence with a supported package install through finalization', async () => {
    const fixture = createFixture();
    let enteredInstall!: () => void;
    const installEntered = new Promise<void>((resolve) => {
      enteredInstall = resolve;
    });
    let finishInstall!: () => void;
    const installFinished = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    vi.spyOn(kiwiInstaller, 'install').mockImplementation(async (options) => {
      expect(options.operationLockHeld).toBe(true);
      enteredInstall();
      await installFinished;
      return { status: 'already_installed', method: 'fixture', version: '1.0.0' };
    });

    const installing = installExpansion('kiwi', { runtime: fixture.runtime, lockTimeoutMs: 50 });
    await installEntered;
    expect(existsSync(fixture.runtime.paths.coral.engine.installLockPath('kiwi'))).toBe(true);

    await expect(cleanup(fixture, 'kiwi')).rejects.toMatchObject({
      code: 'expansion_install_lock_contended',
    });
    expect(existsSync(fixture.runtime.paths.coral.engine.installLockPath('kiwi'))).toBe(true);

    finishInstall();
    await expect(installing).resolves.toMatchObject({ status: 'already_installed' });
    expect(existsSync(fixture.runtime.paths.coral.engine.installLockPath('kiwi'))).toBe(false);
  });

  it('keeps the state row as the final retry marker and completes on retry', async () => {
    const fixture = createFixture();
    const id = 'vector-fixture';
    writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), 'engine');
    writeSentinel(join(fixture.kbRuntimeDir, id), 'projection');
    fixture.state.insert({
      id,
      version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
    });
    insertCursor(fixture.db, id, 'expansion');

    await expect(
      cleanup(fixture, id, fixture.runtime, () => {
        throw new Error('state delete interrupted');
      }),
    ).rejects.toThrow(/state delete interrupted/u);
    expect(fixture.state.get(id)).toBeDefined();

    await expect(cleanup(fixture, id)).resolves.toBe('removed');
    expect(fixture.state.get(id)).toBeUndefined();
  });

  it('finishes a rowless partial cleanup on an idempotent retry', async () => {
    const fixture = createFixture();
    const id = 'vector-fixture';
    writeSentinel(fixture.runtime.paths.coral.engine.dataDir(id), 'engine');
    const projectionPath = join(fixture.kbRuntimeDir, id);
    writeSentinel(projectionPath, 'projection');
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

    await expect(cleanup(fixture, id)).resolves.toBe('removed');
    expect(existsSync(projectionPath)).toBe(false);
  });

  it('refuses cleanup when a fresh current catalog entry exists', async () => {
    const fixture = createFixture();
    fixture.manifestCatalog.upsertInstalledEntry({
      id: 'vector-fixture',
      version: '1.0.0',
      specifier: 'data:text/javascript,export default function fixture(){}',
      tier: 'installed',
      description: 'current fixture',
    });
    const sentinel = writeSentinel(fixture.runtime.paths.coral.engine.dataDir('vector-fixture'), 'current');

    await expect(cleanup(fixture, 'vector-fixture')).resolves.toBe('current');
    expect(readFileSync(sentinel, 'utf8')).toBe('current');
  });
});
