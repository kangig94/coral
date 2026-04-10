import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { KbVectorLease, KbVectorSpecState } from '../contracts.js';
import type { VectorStore } from './contracts.js';
import { createDuckDBVectorStore, vectorAddonPath, vectorSnapshotDbPath } from './store.js';

export type OpenedVectorStore = {
  store: VectorStore;
  close(): Promise<void>;
};

export type ActiveVectorHandleInfo = {
  specId: string;
  snapshotId: string;
  generation: number;
};

type RuntimeVectorHandle = OpenedVectorStore & {
  specId: string;
  snapshotId: string;
  generation: number;
  leaseCount: number;
  retired: boolean;
  closeTimer: NodeJS.Timeout | null;
  closed: boolean;
};

type VectorHandleLifecycleOptions = {
  runtimeDir: string;
  getVectorStatus(specId: string): KbVectorSpecState | null;
  syncVectorStore(store: VectorStore | null): void;
};

function readVectorDrainTimeoutMs(): number {
  const raw = process.env.CORAL_VECTOR_DRAIN_TIMEOUT_MS;
  if (raw === undefined) {
    return 30_000;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30_000;
}

export class VectorHandleLifecycle {
  private vectorPluginRoot: string | null = null;
  private activeVectorHandle: RuntimeVectorHandle | null = null;
  private nextVectorGeneration = 1;
  private readonly retiredVectorHandles = new Set<RuntimeVectorHandle>();
  private readonly vectorDrainTimeoutMs = readVectorDrainTimeoutMs();

  constructor(private readonly options: VectorHandleLifecycleOptions) {}

  setPluginRoot(pluginRoot: string | null): void {
    this.vectorPluginRoot = pluginRoot;
  }

  async open(dbPath: string, handleToken: string): Promise<OpenedVectorStore | null> {
    if (this.vectorPluginRoot === null) {
      return null;
    }

    const sourceAddonPath = vectorAddonPath(this.options.runtimeDir);
    if (!existsSync(sourceAddonPath)) {
      return null;
    }

    const addonDir = this.vectorHandleDir(handleToken);
    const addonPath = this.vectorHandleAddonPath(handleToken);
    mkdirSync(addonDir, { recursive: true });
    copyFileSync(sourceAddonPath, addonPath);

    const store = createDuckDBVectorStore({
      pluginRoot: this.vectorPluginRoot,
      runtimeDir: this.options.runtimeDir,
      addonPath,
    });
    if (store === null) {
      rmSync(addonDir, { recursive: true, force: true });
      return null;
    }

    try {
      await store.init(dbPath);
    } catch (error: unknown) {
      await store.close().catch(() => {});
      rmSync(addonDir, { recursive: true, force: true });
      throw error;
    }

    return {
      store,
      async close() {
        await store.close().catch(() => {});
        rmSync(addonDir, { recursive: true, force: true });
      },
    };
  }

  async activate(specId: string, snapshotId: string): Promise<void> {
    const opened = await this.open(
      vectorSnapshotDbPath(this.options.runtimeDir, specId, snapshotId),
      this.makeHandleToken(`active-${specId}-${snapshotId}`),
    );
    if (opened === null) {
      throw new Error('KB vector store is unavailable.');
    }

    this.publishVectorHandle({
      ...opened,
      specId,
      snapshotId,
      generation: this.nextVectorGeneration,
      leaseCount: 0,
      retired: false,
      closeTimer: null,
      closed: false,
    });
    this.nextVectorGeneration += 1;
  }

  async acquireLease(): Promise<KbVectorLease | null> {
    const handle = this.activeVectorHandle;
    if (handle === null || handle.closed) {
      return null;
    }

    handle.leaseCount += 1;
    const vectorStatus = this.options.getVectorStatus(handle.specId);
    let released = false;

    return {
      store: handle.store,
      specId: handle.specId,
      snapshotId: handle.snapshotId,
      generation: handle.generation,
      vectorStatus,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        handle.leaseCount = Math.max(0, handle.leaseCount - 1);
        await this.maybeCloseRetiredVectorHandle(handle);
      },
    };
  }

  async closeAll(): Promise<void> {
    const handles = [
      ...(this.activeVectorHandle === null ? [] : [this.activeVectorHandle]),
      ...this.retiredVectorHandles,
    ];

    this.activeVectorHandle = null;
    this.retiredVectorHandles.clear();
    this.options.syncVectorStore(null);

    for (const handle of handles) {
      await this.forceCloseRuntimeVectorHandle(handle).catch(() => {});
    }
  }

  getActiveInfo(): ActiveVectorHandleInfo | null {
    const handle = this.activeVectorHandle;
    if (handle === null || handle.closed) {
      return null;
    }

    return {
      specId: handle.specId,
      snapshotId: handle.snapshotId,
      generation: handle.generation,
    };
  }

  private publishVectorHandle(handle: RuntimeVectorHandle): void {
    const previous = this.activeVectorHandle;
    this.activeVectorHandle = handle;
    this.options.syncVectorStore(handle.store);
    if (previous !== null && previous.generation !== handle.generation) {
      this.retireActiveVectorHandle(previous);
    }
  }

  private retireActiveVectorHandle(handle: RuntimeVectorHandle): void {
    handle.retired = true;
    this.retiredVectorHandles.add(handle);
    this.scheduleRetiredHandleClose(handle);
    void this.maybeCloseRetiredVectorHandle(handle);
  }

  private async maybeCloseRetiredVectorHandle(handle: RuntimeVectorHandle): Promise<void> {
    if (!handle.retired || handle.leaseCount !== 0) {
      return;
    }

    await this.forceCloseRuntimeVectorHandle(handle);
  }

  private async forceCloseRuntimeVectorHandle(handle: RuntimeVectorHandle): Promise<void> {
    if (handle.closed) {
      return;
    }

    handle.closed = true;
    if (handle.closeTimer !== null) {
      clearTimeout(handle.closeTimer);
      handle.closeTimer = null;
    }

    if (this.activeVectorHandle?.generation === handle.generation) {
      this.activeVectorHandle = null;
      this.options.syncVectorStore(null);
    }

    this.retiredVectorHandles.delete(handle);
    await handle.close();
  }

  private vectorHandleDir(handleToken: string): string {
    return join(this.options.runtimeDir, 'vec', 'handles', handleToken);
  }

  private vectorHandleAddonPath(handleToken: string): string {
    return join(this.vectorHandleDir(handleToken), 'coral-needle.node');
  }

  private makeHandleToken(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private scheduleRetiredHandleClose(handle: RuntimeVectorHandle): void {
    if (handle.closeTimer !== null || handle.closed) {
      return;
    }

    handle.closeTimer = setTimeout(() => {
      if (handle.closed || handle.leaseCount === 0) {
        void this.maybeCloseRetiredVectorHandle(handle);
        return;
      }

      process.stderr.write(
        `Warning: forcing close of retired KB vector handle after ${this.vectorDrainTimeoutMs}ms drain timeout.\n`,
      );
      void this.forceCloseRuntimeVectorHandle(handle);
    }, this.vectorDrainTimeoutMs);
    handle.closeTimer.unref?.();
  }
}
