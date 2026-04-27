import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { createHostFactory } from '#src/coordinator/expansion/host-factory.js';
import { EquipmentLifecycleService, type EquipmentLifecycleServiceOptions } from '#src/coordinator/equipment/lifecycle.js';
import { loadExpansions } from '#src/expansion/loader.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { persistCorpusState } from '#src/kb/state/corpus-state.js';
import { equipmentPaths } from "#src/infra/path/equipment.js";
import { createKbRuntime } from '#src/kb/runtime.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/kb/search/orama/index.js';
import { createNeedleStoreFake } from '#tests/helpers/fixtures/needle-store-fake.js';
import { createFixtureRuntime } from '#tests/helpers/fixtures/runtime-paths.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';

const FIXED_NOW = new Date('2026-04-22T00:00:00.000Z');
const tempRoots: string[] = [];
const FAKE_EMBEDDER_ENTRY = {
  id: 'test-embedder',
  version: '0.0.0',
  specifier: '#tests/fakes/fake-embedder.js',
  metadata: {
    description: 'fake embedder',
    slot: 'kb.embedding',
  },
};

const nodeStorage = {
  readFileSync(path: string, encoding: BufferEncoding): string {
    return readFileSync(path, encoding);
  },
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[] {
    return readdirSync(path, options);
  },
};

type Harness = {
  root: string;
  coralBaseDir: string;
  markdownRoot: string;
  runtimeDir: string;
  db: InstanceType<typeof Database>;
  driver: ConsumerDriver;
  kb: ReturnType<typeof createKbRuntime>;
  lifecycle: EquipmentLifecycleService;
  currentBackendKind(): string;
  vectorRouteBackend(): 'orama' | 'needle';
  dispose(): Promise<void>;
};

type CreateHarnessOptions = {
  storeFactory?: () => ReturnType<typeof createNeedleStoreFake>;
  corruptAddon?: boolean;
  removeInstallArtifacts?: EquipmentLifecycleServiceOptions['removeInstallArtifacts'];
  bindEmbedder?: boolean;
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

function writeNeedleAddon(baseDir: string, content = 'fake-addon'): string {
  const addonPath = equipmentPaths('prod', { baseDir }).addonPath('needle');
  mkdirSync(dirname(addonPath), { recursive: true });
  writeFileSync(addonPath, content, 'utf8');
  return addonPath;
}

function writeNote(markdownRoot: string, slug: string, title: string, body: string): void {
  mkdirSync(join(markdownRoot, 'notes'), { recursive: true });
  writeFileSync(
    join(markdownRoot, 'notes', `${slug}.md`),
    `---
tags: [coral]
principles: []
source:
  - kangig94/coral
createdAt: 2026-04-22T00:00:00.000Z
updatedAt: 2026-04-22T00:00:00.000Z
entrySeq: 1
---
# ${title}

${body}
`,
    'utf8',
  );
}

function createRuntimeHarness(markdownRoot: string, runtimeDir: string, db: InstanceType<typeof Database>): {
  kb: ReturnType<typeof createKbRuntime>;
  currentBackendKind(): string;
  vectorRouteBackend(): 'orama' | 'needle';
} {
  const kb = createKbRuntime({
    markdownRoot,
    runtimeDir,
    db,
  });

  return {
    kb,
    currentBackendKind: () => (kb.vector.read().consumer.id === ORAMA_BASE_CONSUMER_ID ? 'orama' : 'needle'),
    vectorRouteBackend: () => (kb.vector.read().consumer.id === ORAMA_BASE_CONSUMER_ID ? 'orama' : 'needle'),
  };
}

function equipmentBackendKind(runtime: ReturnType<typeof createKbRuntime>): string {
  return runtime.vector.read().consumer.id === ORAMA_BASE_CONSUMER_ID ? 'orama' : 'needle';
}

async function createHarness(options: CreateHarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'coral-equipment-lifecycle-'));
  tempRoots.push(root);

  const coralBaseDir = join(root, '.coral');
  const markdownRoot = join(root, 'vault');
  const runtimeDir = join(root, 'runtime');
  mkdirSync(markdownRoot, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeNeedleAddon(coralBaseDir, options.corruptAddon ? 'not-a-native-addon' : 'fake-addon');
  writeNote(markdownRoot, 'coral-alpha', 'Coral Alpha', 'Lifecycle coverage for equipment activation.');

  const db = createDb();
  const runtimeHarness = createRuntimeHarness(markdownRoot, runtimeDir, db);
  const kb = runtimeHarness.kb;
  await reindex(kb);
  persistCorpusState(
    db,
    {
      snapshotId: 'snapshot-1',
      contentSeq: 1,
      metadataSeq: 1,
      contentManifestHash: 'content-hash-1',
      metadataManifestHash: 'metadata-hash-1',
    },
    { now: () => FIXED_NOW },
  );
  kb.invalidateCorpusStateSnapshot();

  const driver = new ConsumerDriver({
    db,
    now: () => FIXED_NOW,
  });
  const runtime = createFixtureRuntime(coralBaseDir);
  const expansionHostFactory = createHostFactory({
    runtime,
    kbRuntime: kb,
    consumerDriver: driver,
  });
  const embedderScopes =
    options.bindEmbedder === false
      ? []
      : await loadExpansions(expansionHostFactory, [FAKE_EMBEDDER_ENTRY]);

  const lifecycle = new EquipmentLifecycleService({
    db,
    consumerDriver: driver,
    resolveKbRuntime: () => kb,
    now: () => FIXED_NOW,
    runtime,
    ...(options.removeInstallArtifacts === undefined ? {} : { removeInstallArtifacts: options.removeInstallArtifacts }),
    ...(options.storeFactory === undefined ? {} : { needleBackendOptions: { storeFactory: () => options.storeFactory?.() ?? null } }),
  });

  return {
    root,
    coralBaseDir,
    markdownRoot,
    runtimeDir,
    db,
    driver,
    kb,
    lifecycle,
    currentBackendKind: runtimeHarness.currentBackendKind,
    vectorRouteBackend: runtimeHarness.vectorRouteBackend,
    async dispose() {
      await lifecycle.shutdownActiveEquipment().catch(() => {});
      for (const scope of [...embedderScopes].reverse()) {
        scope[Symbol.dispose]();
      }
      await driver.shutdown();
      db.close();
    },
  };
}

function readEquipmentStateRow(db: InstanceType<typeof Database>, name: string): {
  name: string;
  state: string;
  installed_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
} | null {
  return (
    db.prepare(
      'SELECT name, state, installed_at, last_error_code, last_error_message FROM equipment_state WHERE name = ?',
    ).get(name) as
      | {
          name: string;
          state: string;
          installed_at: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
        }
      | undefined
  ) ?? null;
}

async function waitForCondition(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for lifecycle condition.');
}

afterEach(async () => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('EquipmentLifecycleService', () => {
  it('transitions needle from not_equipped to catching_up to equipped and reports already_equipped when active', async () => {
    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });

    try {
      expect(await harness.lifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'not_equipped',
        },
      ]);
      expect(equipmentBackendKind(harness.kb)).toBe('orama');

      const first = await harness.lifecycle.equip('needle');
      expect(first).toMatchObject({
        status: 'catching_up',
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'catching_up',
        },
      });
      expect(harness.currentBackendKind()).toBe('needle');
      expect(readEquipmentStateRow(harness.db, 'needle')).toMatchObject({
        state: 'equipped',
        last_error_code: null,
        last_error_message: null,
      });

      await harness.driver.drainAll();

      expect(await harness.lifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'equipped',
        },
      ]);
      expect(equipmentBackendKind(harness.kb)).toBe('needle');

      const again = await harness.lifecycle.equip('needle');
      expect(again).toMatchObject({
        status: 'already_equipped',
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'equipped',
        },
      });
    } finally {
      await harness.dispose();
    }
  });

  it('derives installing from the shared install lock path', async () => {
    const harness = await createHarness();

    try {
      const lockPath = equipmentPaths("prod", { baseDir: harness.coralBaseDir }).installLockPath('needle');
      mkdirSync(dirname(lockPath), { recursive: true });
      const release = acquireDirectoryLockSync(lockPath);

      expect((await harness.lifecycle.listEquipment())[0]).toMatchObject({
        slot: 'kb.vector',
        name: 'needle',
        status: 'installing',
      });

      release();

      expect((await harness.lifecycle.listEquipment())[0]).toMatchObject({
        status: 'not_equipped',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('demotes corrupt binaries to disabled_pending_reinstall after apply failure without removing local artifacts', async () => {
    let cleanupBaseDir = '';
    const removeInstallArtifacts = vi.fn(async (name: string) => {
      rmSync(equipmentPaths('prod', { baseDir: cleanupBaseDir }).dataDir(name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    });

    const harness = await createHarness({ corruptAddon: true, removeInstallArtifacts });
    cleanupBaseDir = harness.coralBaseDir;

    try {
      const first = await harness.lifecycle.equip('needle');
      expect(first.status).toBe('catching_up');

      await harness.driver.drainAll();
      await waitForCondition(async () => (await harness.lifecycle.listEquipment())[0]?.status === 'disabled_pending_reinstall');

      expect((await harness.lifecycle.listEquipment())[0]).toMatchObject({
        slot: 'kb.vector',
        name: 'needle',
        status: 'disabled_pending_reinstall',
      });
      expect(readEquipmentStateRow(harness.db, 'needle')).toMatchObject({
        state: 'disabled_pending_reinstall',
        last_error_code: 'equipment_binary_corrupt',
      });
      expect(removeInstallArtifacts).not.toHaveBeenCalled();
      expect(existsSync(equipmentPaths("prod", { baseDir: harness.coralBaseDir }).dataDir('needle'))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('surfaces binding-required when needle is equipped without an embedder expansion bound first', async () => {
    const harness = await createHarness({
      bindEmbedder: false,
    });

    try {
      await expect(harness.lifecycle.equip('needle')).rejects.toMatchObject({
        code: 'binding-required',
        binding: 'kb.embedding',
        requiredBy: 'needle',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('uninstalls the active needle consumer, invokes artifact cleanup, and reverts kb.vector to the default owner', async () => {
    let cleanupBaseDir = '';
    const removeInstallArtifacts = vi.fn(async (name: string) => {
      rmSync(equipmentPaths('prod', { baseDir: cleanupBaseDir }).dataDir(name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    });

    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
      removeInstallArtifacts,
    });
    cleanupBaseDir = harness.coralBaseDir;

    try {
      await harness.lifecycle.equip('needle');
      await harness.driver.drainAll();
      expect(harness.currentBackendKind()).toBe('needle');
      expect(harness.vectorRouteBackend()).toBe('needle');

      await expect(harness.lifecycle.uninstall('needle')).resolves.toEqual({ status: 'uninstalled' });

      expect(removeInstallArtifacts).toHaveBeenCalledTimes(1);
      expect(removeInstallArtifacts).toHaveBeenCalledWith('needle');
      expect(harness.currentBackendKind()).toBe('orama');
      expect(harness.vectorRouteBackend()).toBe('orama');
      expect(await harness.lifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'not_equipped',
        },
      ]);
      expect(readEquipmentStateRow(harness.db, 'needle')).toBeNull();
      expect(existsSync(equipmentPaths("prod", { baseDir: harness.coralBaseDir }).dataDir('needle'))).toBe(false);
      expect(equipmentBackendKind(harness.kb)).toBe('orama');

      writeNeedleAddon(harness.coralBaseDir, 'fresh-addon');
      await expect(harness.lifecycle.equip('needle')).resolves.toMatchObject({
        status: 'catching_up',
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'catching_up',
        },
      });
      await harness.driver.drainAll();
      expect(harness.vectorRouteBackend()).toBe('needle');
    } finally {
      await harness.dispose();
    }
  });

  it('reports previously equipped needle as inactive on restart while the binary is still present', async () => {
    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });
    let restartedDriver: ConsumerDriver | null = null;

    try {
      await harness.lifecycle.equip('needle');
      await harness.driver.drainAll();
      expect((await harness.lifecycle.listEquipment())[0]?.status).toBe('equipped');

      await harness.lifecycle.shutdownActiveEquipment();
      await harness.driver.shutdown();

      const restartedRuntimeHarness = createRuntimeHarness(harness.markdownRoot, harness.runtimeDir, harness.db);
      restartedDriver = new ConsumerDriver({
        db: harness.db,
        now: () => FIXED_NOW,
      });
      const restartedLifecycle = new EquipmentLifecycleService({
        db: harness.db,
        consumerDriver: restartedDriver,
        resolveKbRuntime: () => restartedRuntimeHarness.kb,
        now: () => FIXED_NOW,
        runtime: createFixtureRuntime(harness.coralBaseDir),
        needleBackendOptions: { storeFactory: () => createNeedleStoreFake() },
      });
      expect(await restartedLifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'inactive',
        },
      ]);
      expect(equipmentBackendKind(restartedRuntimeHarness.kb)).toBe('orama');
      expect(restartedRuntimeHarness.vectorRouteBackend()).toBe('orama');
    } finally {
      await restartedDriver?.shutdown();
      await harness.dispose();
    }
  });

  it('reports previously equipped needle as unavailable on restart when the binary was deleted externally', async () => {
    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });
    let restartedDriver: ConsumerDriver | null = null;

    try {
      await harness.lifecycle.equip('needle');
      await harness.driver.drainAll();
      expect((await harness.lifecycle.listEquipment())[0]?.status).toBe('equipped');

      await harness.lifecycle.shutdownActiveEquipment();
      await harness.driver.shutdown();
      rmSync(equipmentPaths("prod", { baseDir: harness.coralBaseDir }).dataDir('needle'), { recursive: true, force: true });

      const restartedRuntimeHarness = createRuntimeHarness(harness.markdownRoot, harness.runtimeDir, harness.db);
      restartedDriver = new ConsumerDriver({
        db: harness.db,
        now: () => FIXED_NOW,
      });
      const restartedLifecycle = new EquipmentLifecycleService({
        db: harness.db,
        consumerDriver: restartedDriver,
        resolveKbRuntime: () => restartedRuntimeHarness.kb,
        now: () => FIXED_NOW,
        runtime: createFixtureRuntime(harness.coralBaseDir),
        needleBackendOptions: { storeFactory: () => createNeedleStoreFake() },
      });
      expect(await restartedLifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'unavailable',
        },
      ]);
      expect(restartedRuntimeHarness.vectorRouteBackend()).toBe('orama');
    } finally {
      await restartedDriver?.shutdown();
      await harness.dispose();
    }
  });

  it('acquires per-slot guards in FIFO order', async () => {
    const harness = await createHarness();

    try {
      const order: string[] = [];
      const releaseFirst = await harness.lifecycle.acquireSlotGuard('needle');
      order.push('first');

      const second = harness.lifecycle.acquireSlotGuard('needle').then((release) => {
        order.push('second');
        release();
      });
      const third = harness.lifecycle.acquireSlotGuard('needle').then((release) => {
        order.push('third');
        release();
      });

      await Promise.resolve();
      expect(order).toEqual(['first']);

      releaseFirst();
      await Promise.all([second, third]);

      expect(order).toEqual(['first', 'second', 'third']);
    } finally {
      await harness.dispose();
    }
  });
});
