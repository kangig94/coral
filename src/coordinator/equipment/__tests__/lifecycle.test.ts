import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EmbeddingModule from '../../../kb/search/embedding.js';

import { ConsumerDriver } from '../../consumer-driver.js';
import { EquipmentLifecycleService, type EquipmentLifecycleServiceOptions } from '../lifecycle.js';
import { applyMigrations } from '../../../store/migrations.js';
import { persistCorpusState } from '../../../store/corpus-state.js';
import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '../../../expansion/paths.js';
import { createKbRuntime } from '../../../kb/runtime.js';
import { reindex } from '../../../kb/ops/reindex.js';
import type { VectorRetrieval } from '../../../kb/search/contract.js';
import { closeNeedleBackend } from '../../../kb/search/needle-backend.js';
import { NeedleAddonLoadError } from '../../../kb/search/needle-store.js';
import { resolveVectorRoute } from '../../../kb/search/router.js';
import { createNeedleStoreFake } from '../../../testing/fixtures/needle-store-fake.js';
import { acquireDirectoryLockSync } from '../../../shared/fs-lock.js';
import { createEquipmentSlot, createSlotRegistry } from '../slots.js';

const FIXED_NOW = new Date('2026-04-22T00:00:00.000Z');
const tempRoots: string[] = [];

const embeddingMockState = vi.hoisted(() => ({
  createEmbeddingProvider: null as null | ((...args: any[]) => Promise<any>),
  resolveEmbeddingProviderConfig: null as null | ((...args: any[]) => any),
}));

vi.mock('../../../kb/search/embedding.js', async () => {
  const actual = await vi.importActual<typeof EmbeddingModule>('../../../kb/search/embedding.js');
  return {
    ...actual,
    createEmbeddingProvider: (...args: Parameters<typeof actual.createEmbeddingProvider>) =>
      embeddingMockState.createEmbeddingProvider === null
        ? actual.createEmbeddingProvider(...args)
        : embeddingMockState.createEmbeddingProvider(...args),
    resolveEmbeddingProviderConfig: (...args: Parameters<typeof actual.resolveEmbeddingProviderConfig>) =>
      embeddingMockState.resolveEmbeddingProviderConfig === null
        ? actual.resolveEmbeddingProviderConfig(...args)
        : embeddingMockState.resolveEmbeddingProviderConfig(...args),
  };
});

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
  activateNeedle?: EquipmentLifecycleServiceOptions['activateNeedle'];
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

function writeNeedleAddon(baseDir: string, content = 'fake-addon'): string {
  const addonPath = equipmentAddonPath('needle', { baseDir });
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
  slotRegistry: ReturnType<typeof createSlotRegistry>;
  setLifecycleResolver(resolver: () => ReturnType<EquipmentLifecycleService['getRuntimeActivation']>): void;
  currentBackendKind(): string;
  vectorRouteBackend(): 'orama' | 'needle';
} {
  const slotRegistry = createSlotRegistry();
  let resolveEquipmentView: (() => ReturnType<EquipmentLifecycleService['getRuntimeActivation']>) | null = null;
  const kb = createKbRuntime({
    markdownRoot,
    runtimeDir,
    db,
    getEquipmentView: () => resolveEquipmentView?.() ?? null,
  });
  const vectorSlot = createEquipmentSlot<VectorRetrieval>({
    id: 'kb.vector',
    defaultOwner: () => kb.getBaseRetrievalSurface(),
  });
  slotRegistry.declare(vectorSlot);

  return {
    kb,
    slotRegistry,
    setLifecycleResolver(resolver: () => ReturnType<EquipmentLifecycleService['getRuntimeActivation']>) {
      resolveEquipmentView = resolver;
    },
    currentBackendKind: () => (vectorSlot.currentOwner() as VectorRetrieval & { backendKind?: string }).backendKind ?? 'unknown',
    vectorRouteBackend: () => resolveVectorRoute(kb).backend,
  };
}

function equipmentBackendKind(runtime: ReturnType<typeof createKbRuntime>): string {
  return (runtime.getEquipmentView().retrieval as VectorRetrieval & { backendKind?: string }).backendKind ?? 'unknown';
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

  const lifecycle = new EquipmentLifecycleService({
    db,
    consumerDriver: driver,
    slotRegistry: runtimeHarness.slotRegistry,
    resolveKbRuntime: () => kb,
    now: () => FIXED_NOW,
    pathOptions: { baseDir: coralBaseDir },
    ...(options.removeInstallArtifacts === undefined ? {} : { removeInstallArtifacts: options.removeInstallArtifacts }),
    ...(options.activateNeedle === undefined ? {} : { activateNeedle: options.activateNeedle }),
    ...(options.storeFactory === undefined ? {} : { needleBackendOptions: { storeFactory: () => options.storeFactory?.() ?? null } }),
  });
  runtimeHarness.setLifecycleResolver(() => lifecycle.getRuntimeActivation());

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
      await closeNeedleBackend(kb).catch(() => {});
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
  embeddingMockState.createEmbeddingProvider = null;
  embeddingMockState.resolveEmbeddingProviderConfig = null;

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('EquipmentLifecycleService', () => {
  function mockEmbeddingProvider(
    overrides: Partial<EmbeddingModule.EmbeddingProviderConfig> & {
      delayMs?: number;
      embedDocuments?: EmbeddingModule.EmbeddingProvider['embedDocuments'];
    } = {},
  ): EmbeddingModule.EmbeddingProviderConfig {
    const { delayMs, embedDocuments, ...configOverrides } = overrides;
    const config: EmbeddingModule.EmbeddingProviderConfig = {
      kind: 'openai-compatible',
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      normalization: 'l2',
      specId: 'mock-small:3:l2',
      apiKey: 'test',
      baseUrl: 'http://localhost/mock',
      ...configOverrides,
    };
    const vectorFrom = (values: number[]): Float32Array =>
      Float32Array.from(Array.from({ length: config.dims }, (_, index) => values[index] ?? 0));
    const provider: EmbeddingModule.EmbeddingProvider = {
      name: config.name,
      model: config.model,
      dims: config.dims,
      embedDocuments:
        embedDocuments ??
        (async (texts: string[]) => {
          if (delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return texts.map((text, index) => vectorFrom([text.length, index + 1, 1]));
        }),
      embedQuery: async () => vectorFrom([1, 0, 0]),
    };

    embeddingMockState.resolveEmbeddingProviderConfig = vi.fn().mockReturnValue(config);
    embeddingMockState.createEmbeddingProvider = vi.fn().mockResolvedValue(provider);
    return config;
  }

  it('transitions needle from not_equipped to catching_up to equipped and reports already_equipped when active', async () => {
    mockEmbeddingProvider({ delayMs: 20 });

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
      const lockPath = equipmentInstallLockPath('needle', { baseDir: harness.coralBaseDir });
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
    mockEmbeddingProvider();
    let cleanupBaseDir = '';
    const removeInstallArtifacts = vi.fn(async (name: string) => {
      rmSync(equipmentDataDir(name, { baseDir: cleanupBaseDir }), {
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
      expect(existsSync(equipmentDataDir('needle', { baseDir: harness.coralBaseDir }))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('leaves local artifacts on disk when equip rollback handles a binary load failure', async () => {
    mockEmbeddingProvider();
    let cleanupBaseDir = '';
    const removeInstallArtifacts = vi.fn(async (name: string) => {
      rmSync(equipmentDataDir(name, { baseDir: cleanupBaseDir }), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    });
    const activateNeedle: NonNullable<EquipmentLifecycleServiceOptions['activateNeedle']> = () => {
      throw new NeedleAddonLoadError('simulated addon load failure', {
        addonPath: equipmentAddonPath('needle', { baseDir: cleanupBaseDir }),
      });
    };

    const harness = await createHarness({
      removeInstallArtifacts,
      activateNeedle,
    } satisfies CreateHarnessOptions);
    cleanupBaseDir = harness.coralBaseDir;

    try {
      await expect(harness.lifecycle.equip('needle')).rejects.toMatchObject({
        code: 'equipment_binary_corrupt',
      });
      expect(removeInstallArtifacts).not.toHaveBeenCalled();
      expect(readEquipmentStateRow(harness.db, 'needle')).toMatchObject({
        state: 'disabled_pending_reinstall',
        last_error_code: 'equipment_binary_corrupt',
      });
      expect(existsSync(equipmentDataDir('needle', { baseDir: harness.coralBaseDir }))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('uninstalls the active needle consumer, invokes artifact cleanup, and reverts kb.vector to the default owner', async () => {
    mockEmbeddingProvider();
    let cleanupBaseDir = '';
    const removeInstallArtifacts = vi.fn(async (name: string) => {
      rmSync(equipmentDataDir(name, { baseDir: cleanupBaseDir }), {
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
      expect(existsSync(equipmentDataDir('needle', { baseDir: harness.coralBaseDir }))).toBe(false);
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
    mockEmbeddingProvider();

    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });
    let restartedDriver: ConsumerDriver | null = null;

    try {
      await harness.lifecycle.equip('needle');
      await harness.driver.drainAll();
      expect((await harness.lifecycle.listEquipment())[0]?.status).toBe('equipped');

      await closeNeedleBackend(harness.kb);
      await harness.driver.shutdown();

      const restartedRuntimeHarness = createRuntimeHarness(harness.markdownRoot, harness.runtimeDir, harness.db);
      restartedDriver = new ConsumerDriver({
        db: harness.db,
        now: () => FIXED_NOW,
      });
      const restartedLifecycle = new EquipmentLifecycleService({
        db: harness.db,
        consumerDriver: restartedDriver,
        slotRegistry: restartedRuntimeHarness.slotRegistry,
        resolveKbRuntime: () => restartedRuntimeHarness.kb,
        now: () => FIXED_NOW,
        pathOptions: { baseDir: harness.coralBaseDir },
        needleBackendOptions: { storeFactory: () => createNeedleStoreFake() },
      });
      restartedRuntimeHarness.setLifecycleResolver(() => restartedLifecycle.getRuntimeActivation());

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
    mockEmbeddingProvider();

    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });
    let restartedDriver: ConsumerDriver | null = null;

    try {
      await harness.lifecycle.equip('needle');
      await harness.driver.drainAll();
      expect((await harness.lifecycle.listEquipment())[0]?.status).toBe('equipped');

      await closeNeedleBackend(harness.kb);
      await harness.driver.shutdown();
      rmSync(equipmentDataDir('needle', { baseDir: harness.coralBaseDir }), { recursive: true, force: true });

      const restartedRuntimeHarness = createRuntimeHarness(harness.markdownRoot, harness.runtimeDir, harness.db);
      restartedDriver = new ConsumerDriver({
        db: harness.db,
        now: () => FIXED_NOW,
      });
      const restartedLifecycle = new EquipmentLifecycleService({
        db: harness.db,
        consumerDriver: restartedDriver,
        slotRegistry: restartedRuntimeHarness.slotRegistry,
        resolveKbRuntime: () => restartedRuntimeHarness.kb,
        now: () => FIXED_NOW,
        pathOptions: { baseDir: harness.coralBaseDir },
        needleBackendOptions: { storeFactory: () => createNeedleStoreFake() },
      });
      restartedRuntimeHarness.setLifecycleResolver(() => restartedLifecycle.getRuntimeActivation());

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
