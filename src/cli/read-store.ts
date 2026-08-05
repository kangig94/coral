import { createRealRuntime } from '../runtime/real.js';
import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { CoralStore } from '../read-model/coral-store.js';
import { openStoreDatabase, type Database } from '../store/db.js';
import { openReadOnlyStoreDatabase } from '../store/read-port.js';
import { createDefaultStoreReadContext } from '../read-model/read-context.js';
import { resolvePluginRoot } from './plugin-root.js';
import { currentCoralStoreFormat } from '../store-format.js';

export type ReadCoralStoreHandle = {
  store: CoralStore;
  note?: string;
  close(): void;
};

type CachedReadStore = {
  key: string;
  handle: ReadCoralStoreHandle;
};

type SharedReadStoreOptions = {
  announceMissing?: boolean;
};

/**
 * Per-process registry for the shared read-only Coral store. CLI runs as a
 * one-shot process; reopening the SQLite handle for sequential reads is
 * wasted work, so this caches at most one open handle per (pluginRoot,
 * projectRoot, flavor) tuple. Accumulates a single "missing store" note
 * that the CLI flushes at the end of text output.
 */
class ReadCoralStoreRegistry {
  private cached: CachedReadStore | null = null;
  private cleanupRegistered = false;
  private pendingNote: string | null = null;

  getShared(projectRoot: string, options: SharedReadStoreOptions = {}): CoralStore {
    const key = readStoreCacheKey(projectRoot);
    const announceMissing = options.announceMissing !== false;

    if (this.cached?.key !== key) {
      this.closeCached();
      this.cached = { key, handle: openReadCoralStore(projectRoot) };
      this.registerCleanup();
    }

    if (announceMissing && this.cached.handle.note) {
      this.pendingNote = this.cached.handle.note;
    }
    return this.cached.handle.store;
  }

  clearPendingNote(): void {
    this.pendingNote = null;
  }

  flushPendingNote(outputFormat: 'text' | 'json'): void {
    const note = this.pendingNote;
    this.pendingNote = null;
    if (outputFormat === 'text' && note) {
      process.stdout.write(note + '\n');
    }
  }

  private closeCached(): void {
    if (!this.cached) {
      return;
    }
    this.cached.handle.close();
    this.cached = null;
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) {
      return;
    }
    this.cleanupRegistered = true;
    process.once('exit', () => this.closeCached());
    process.once('beforeExit', () => this.closeCached());
  }
}

const defaultRegistry = new ReadCoralStoreRegistry();

function readStoreCacheKey(projectRoot: string): string {
  const pluginRoot = resolvePluginRoot();
  return JSON.stringify({
    pluginRoot: pluginRoot ?? null,
    projectRoot,
    flavor: readBuildFlavor(pluginRoot ?? projectRoot),
  });
}

export function getSharedReadCoralStore(projectRoot: string, options: SharedReadStoreOptions = {}): CoralStore {
  return defaultRegistry.getShared(projectRoot, options);
}

export function clearPendingReadStoreNote(): void {
  defaultRegistry.clearPendingNote();
}

export function flushPendingReadStoreNote(outputFormat: 'text' | 'json'): void {
  defaultRegistry.flushPendingNote(outputFormat);
}

export function openReadCoralStore(projectRoot: string): ReadCoralStoreHandle {
  const pluginRoot = resolvePluginRoot();
  const flavor = readBuildFlavor(pluginRoot ?? projectRoot);
  const runtime = createRealRuntime(flavor);
  const dbPath = runtime.paths.coral.store.dbFile;
  const hasStore = runtime.storage.existsSync(dbPath);

  const db = hasStore
    ? (openReadOnlyStoreDatabase(runtime, {
        storeFormat: currentCoralStoreFormat(),
      }) as unknown as Database)
    : openStoreDatabase({
        path: ':memory:',
        storage: runtime.storage,
        storeFormat: currentCoralStoreFormat(),
        flavor: runtime.flavor,
      });

  return {
    store: new CoralStore(db, createDefaultStoreReadContext(), {
      runtime,
      projectRoot,
      ...(pluginRoot ? { pluginRoot } : {}),
    }),
    ...(hasStore ? {} : { note: `(no store at ${dbPath} — showing empty results)` }),
    close: () => db.close(),
  };
}
