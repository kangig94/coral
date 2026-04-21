import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EmbeddingModule from '../../../kb/search/embedding.js';

import { ConsumerDriver } from '../../consumer-driver.js';
import { EquipmentLifecycleService } from '../lifecycle.js';
import { applyMigrations } from '../../../store/migrations.js';
import { persistCorpusState } from '../../../store/corpus-state.js';
import { equipmentAddonPath, equipmentInstallLockPath } from '../../../infra/equipment-paths.js';
import { createOramaBaseProjection } from '../../../kb/api.js';
import { createKbRuntime } from '../../../kb/runtime.js';
import { reindex } from '../../../kb/ops/reindex.js';
import type { VectorRetrieval } from '../../../kb/search/contract.js';
import { closeNeedleBackend } from '../../../kb/search/needle-backend.js';
import { createNeedleStoreFake } from '../../../testing/fixtures/needle-store-fake.js';
import { acquireDirectoryLockSync } from '../../../shared/fs-lock.js';
import { runtimeActivationFromHandle } from '../runtime-activation.js';
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
  dispose(): Promise<void>;
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
  currentBackendKind(): string;
} {
  const slotRegistry = createSlotRegistry();
  // eslint-disable-next-line prefer-const -- forward-self-reference in getEquipmentView closure
  let vectorSlot!: ReturnType<typeof createEquipmentSlot<VectorRetrieval>>;
  const kb = createKbRuntime({
    markdownRoot,
    runtimeDir,
    db,
    getEquipmentView: () => {
      const slotView = slotRegistry.list().find((entry) => entry.id === 'kb.vector');
      return slotView?.handle ? runtimeActivationFromHandle(vectorSlot.currentOwner(), slotView.handle) : null;
    },
  });
  vectorSlot = createEquipmentSlot<VectorRetrieval>({
    id: 'kb.vector',
    defaultOwner: () => createOramaBaseProjection(kb),
  });
  slotRegistry.declare(vectorSlot);

  return {
    kb,
    slotRegistry,
    currentBackendKind: () => (vectorSlot.currentOwner() as VectorRetrieval & { backendKind?: string }).backendKind ?? 'unknown',
  };
}

function equipmentBackendKind(runtime: ReturnType<typeof createKbRuntime>): string {
  return (runtime.getEquipmentView().retrieval as VectorRetrieval & { backendKind?: string }).backendKind ?? 'unknown';
}

async function createHarness(options: { storeFactory?: () => ReturnType<typeof createNeedleStoreFake>; corruptAddon?: boolean } = {}): Promise<Harness> {
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
  it('transitions needle from inactive to catching_up to equipped and reports already_equipped when active', async () => {
    embeddingMockState.resolveEmbeddingProviderConfig = vi.fn().mockReturnValue({
      kind: 'openai-compatible',
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      normalization: 'l2',
      specId: 'mock-small:3:l2',
      apiKey: 'test',
      baseUrl: 'http://localhost/mock',
    });
    embeddingMockState.createEmbeddingProvider = vi.fn().mockResolvedValue({
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      embedDocuments: async (texts: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return texts.map((text, index) => Float32Array.from([text.length, index + 1, 1]));
      },
      embedQuery: async () => Float32Array.from([1, 0, 0]),
    });

    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });

    try {
      expect(await harness.lifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'inactive',
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
        status: 'inactive',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('demotes corrupt binaries to disabled_pending_reinstall after apply failure', async () => {
    embeddingMockState.resolveEmbeddingProviderConfig = vi.fn().mockReturnValue({
      kind: 'openai-compatible',
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      normalization: 'l2',
      specId: 'mock-small:3:l2',
      apiKey: 'test',
      baseUrl: 'http://localhost/mock',
    });

    const harness = await createHarness({ corruptAddon: true });

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
    } finally {
      await harness.dispose();
    }
  });

  it('uninstalls the active needle consumer and reverts kb.vector to the default owner', async () => {
    embeddingMockState.resolveEmbeddingProviderConfig = vi.fn().mockReturnValue({
      kind: 'openai-compatible',
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      normalization: 'l2',
      specId: 'mock-small:3:l2',
      apiKey: 'test',
      baseUrl: 'http://localhost/mock',
    });
    embeddingMockState.createEmbeddingProvider = vi.fn().mockResolvedValue({
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      embedDocuments: async (texts: string[]) => texts.map((text, index) => Float32Array.from([text.length, index + 1, 1])),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
    });

    const harness = await createHarness({
      storeFactory: () => createNeedleStoreFake(),
    });

    try {
      await harness.lifecycle.equip('needle');
      await harness.driver.drainAll();
      expect(harness.currentBackendKind()).toBe('needle');

      await expect(harness.lifecycle.uninstall('needle')).resolves.toEqual({ status: 'uninstalled' });

      expect(harness.currentBackendKind()).toBe('orama');
      expect(await harness.lifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'inactive',
        },
      ]);
      expect(readEquipmentStateRow(harness.db, 'needle')).toBeNull();
      expect(equipmentBackendKind(harness.kb)).toBe('orama');
    } finally {
      await harness.dispose();
    }
  });

  it('reports previously equipped needle as unavailable on restart until it is reactivated explicitly', async () => {
    embeddingMockState.resolveEmbeddingProviderConfig = vi.fn().mockReturnValue({
      kind: 'openai-compatible',
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      normalization: 'l2',
      specId: 'mock-small:3:l2',
      apiKey: 'test',
      baseUrl: 'http://localhost/mock',
    });
    embeddingMockState.createEmbeddingProvider = vi.fn().mockResolvedValue({
      name: 'mock-embeddings',
      model: 'mock-small',
      dims: 3,
      embedDocuments: async (texts: string[]) => texts.map((text, index) => Float32Array.from([text.length, index + 1, 1])),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
    });

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

      expect(await restartedLifecycle.listEquipment()).toEqual([
        {
          slot: 'kb.vector',
          name: 'needle',
          status: 'unavailable',
        },
      ]);
      expect(equipmentBackendKind(restartedRuntimeHarness.kb)).toBe('orama');
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
