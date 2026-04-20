declare const __PLUGIN_ROOT__: string;

import { existsSync } from 'node:fs';

import { pluginRootNamespace } from '../infra/paths.js';
import { createRealRuntime } from '../runtime/real.js';
import { readBuildFlavor } from '../shared/utils.js';
import { CoralStore, openStoreDatabase } from '../store/index.js';
import { ensureStoreMigrationsDir } from '../store/migrations.js';
import { storePaths } from '../store/paths.js';
import { createDefaultStoreReadContext } from '../store/read-context.js';

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

const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : (process.env.CLAUDE_PLUGIN_ROOT ?? '');

let cachedReadStore: CachedReadStore | null = null;
let readStoreCleanupRegistered = false;
let pendingReadStoreNote: string | null = null;

function closeCachedReadStore(): void {
  if (!cachedReadStore) {
    return;
  }

  cachedReadStore.handle.close();
  cachedReadStore = null;
}

function registerReadStoreCleanup(): void {
  if (readStoreCleanupRegistered) {
    return;
  }

  readStoreCleanupRegistered = true;
  process.once('exit', closeCachedReadStore);
  process.once('beforeExit', closeCachedReadStore);
}

function readStoreCacheKey(projectRoot: string): string {
  return JSON.stringify({
    pluginRoot,
    projectRoot,
    flavor: readBuildFlavor(pluginRoot || projectRoot),
  });
}

function noteMissingStore(handle: ReadCoralStoreHandle, announceMissing: boolean): void {
  if (announceMissing && handle.note) {
    pendingReadStoreNote = handle.note;
  }
}

export function clearPendingReadStoreNote(): void {
  pendingReadStoreNote = null;
}

export function flushPendingReadStoreNote(outputFormat: 'text' | 'json'): void {
  const note = pendingReadStoreNote;
  pendingReadStoreNote = null;
  if (outputFormat === 'text' && note) {
    process.stdout.write(note + '\n');
  }
}

export function getSharedReadCoralStore(
  projectRoot: string,
  options: SharedReadStoreOptions = {},
): CoralStore {
  const key = readStoreCacheKey(projectRoot);
  const announceMissing = options.announceMissing !== false;

  if (cachedReadStore?.key !== key) {
    closeCachedReadStore();
    cachedReadStore = {
      key,
      handle: openReadCoralStore(projectRoot),
    };
    registerReadStoreCleanup();
  }

  noteMissingStore(cachedReadStore.handle, announceMissing);
  return cachedReadStore.handle.store;
}

export function openReadCoralStore(projectRoot: string): ReadCoralStoreHandle {
  const runtime = createRealRuntime();
  const flavor = readBuildFlavor(pluginRoot || projectRoot);
  const dbPath = storePaths(flavor).dbFile;
  const hasStore = existsSync(dbPath);
  const namespace = pluginRoot
    ? (() => {
        try {
          return pluginRootNamespace(pluginRoot);
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const db = hasStore
    ? openStoreDatabase({
        path: dbPath,
        storage: runtime.storage,
        readonly: true,
      })
    : openStoreDatabase({
        path: ':memory:',
        storage: runtime.storage,
        migrationsDir: ensureStoreMigrationsDir(runtime.storage),
      });

  return {
    store: new CoralStore(db, createDefaultStoreReadContext(), {
      namespace,
      projectRoot,
      ...(pluginRoot ? { pluginRoot } : {}),
    }),
    ...(hasStore ? {} : { note: `(no store at ${dbPath} — showing empty results)` }),
    close: () => db.close(),
  };
}

export async function withReadCoralStore<T>(
  projectRoot: string,
  read: (store: CoralStore) => Promise<T> | T,
): Promise<T> {
  const handle = openReadCoralStore(projectRoot);

  noteMissingStore(handle, true);
  try {
    return await read(handle.store);
  } finally {
    handle.close();
  }
}
