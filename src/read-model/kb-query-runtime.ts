import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { KbReadQueryRuntime } from '../kb/contract.js';
import {
  communityPathFromName,
  createKbRuntimePaths,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
  wikiPathFromName,
} from '../kb/paths.js';
import type { KbReadPathResolver, KbReadStorage } from '../kb/read.js';
import type { KbQueryHost } from '../kb/queries.js';
import { readKnowledgeBaseListIndex } from '../kb/direct-read-index.js';
import { createCorpusStorage } from '../kb/corpus/rescan/storage.js';
import { readKbIndexSnapshot } from '../kb/corpus/index/store.js';
import { GeneratedCommunityProjectionStore } from '../kb/curate/community/generated-projection-store.js';
import type { KbIndex } from '../kb/entry-types.js';
import { openReadOnlyStoreDatabase, type ReadonlyDatabase } from '../store/read-port.js';
import { currentCoralStoreFormat } from '../store-format.js';

export type KbQueryRuntime = Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'process' | 'storage' | 'time'>;

export type KbQueryContext = {
  pluginRoot: string;
  projectRoot?: string;
  runtime?: KbQueryRuntime;
  readDb?: ReadonlyDatabase;
};

/**
 * Per-process registry for KB read-side runtime + DB handles. CLI runs as a
 * one-shot process, so reopening the SQLite handle for sequential KB queries
 * is wasted work; this caches at most one open pair per flavor. Mirrors the
 * `ReadCoralStoreRegistry` pattern in cli/read-store.ts so module-level
 * mutables stay encapsulated and testable.
 */
export class KbQueryRegistry {
  private cachedRuntime: { flavor: BuildFlavor; runtime: ReturnType<typeof createRealRuntime> } | undefined;
  private cachedDb: { flavor: BuildFlavor; db: ReadonlyDatabase } | undefined;
  private readonly cachedRuntimeDbs = new Map<KbQueryRuntime, ReadonlyDatabase>();

  getRuntime(flavor: BuildFlavor): ReturnType<typeof createRealRuntime> {
    if (this.cachedRuntime?.flavor !== flavor) {
      this.cachedRuntime = { flavor, runtime: createRealRuntime(flavor) };
    }
    return this.cachedRuntime.runtime;
  }

  getDb(flavor: BuildFlavor): ReadonlyDatabase {
    if (this.cachedDb?.flavor !== flavor) {
      this.cachedDb?.db.close();
      this.cachedDb = {
        flavor,
        db: openReadOnlyStoreDatabase(this.getRuntime(flavor), {
          storeFormat: currentCoralStoreFormat(),
        }),
      };
    }
    return this.cachedDb.db;
  }

  getRuntimeDb(runtime: KbQueryRuntime): ReadonlyDatabase {
    const cached = this.cachedRuntimeDbs.get(runtime);
    if (cached !== undefined) {
      return cached;
    }

    const db = openReadOnlyStoreDatabase(runtime, { storeFormat: currentCoralStoreFormat() });
    this.cachedRuntimeDbs.set(runtime, db);
    return db;
  }

  close(): void {
    this.cachedDb?.db.close();
    this.cachedDb = undefined;
    for (const db of this.cachedRuntimeDbs.values()) {
      db.close();
    }
    this.cachedRuntimeDbs.clear();
  }
}

const defaultRegistry = new KbQueryRegistry();

function resolveQueryFlavor(context: KbQueryContext): BuildFlavor {
  return readBuildFlavor(context.pluginRoot);
}

function resolveQueryRuntime(context: KbQueryContext): KbQueryRuntime {
  return context.runtime ?? defaultRegistry.getRuntime(resolveQueryFlavor(context));
}

function resolveQueryMarkdownRoot(context: KbQueryContext): string {
  return resolveQueryRuntime(context).paths.coral.corpus.kbRoot;
}

export function createDefaultKbReadPaths(context: KbQueryContext): KbReadPathResolver {
  const root = resolveQueryMarkdownRoot(context);
  return {
    notePath: (note) => notePathFromName(note, root),
    wikiPath: (slug) => wikiPathFromName(slug, root),
    sourcePath: (source) => sourcePathFromName(source, root),
    communityPath: (community) => communityPathFromName(community, root),
    principlePath: (principle) => principlePathFromName(principle, root),
  };
}

function getDefaultKbQueryStorage(context: KbQueryContext): ReturnType<typeof createRealRuntime>['storage'] {
  return resolveQueryRuntime(context).storage;
}

function getDefaultKbQueryDb(context: KbQueryContext): ReadonlyDatabase {
  if (context.readDb !== undefined) {
    return context.readDb;
  }
  if (context.runtime !== undefined) {
    return defaultRegistry.getRuntimeDb(context.runtime);
  }
  return defaultRegistry.getDb(resolveQueryFlavor(context));
}

export function createDefaultKbQueryRuntime(context: KbQueryContext): KbReadQueryRuntime {
  const runtime = resolveQueryRuntime(context);

  const markdownRoot = resolveQueryMarkdownRoot(context);
  const runtimeDir = runtime.paths.coral.kbRuntime.root;
  const paths = createKbRuntimePaths(markdownRoot, runtimeDir);
  const generatedCommunityProjectionStore = new GeneratedCommunityProjectionStore({
    runtimeDir,
    storage: runtime.storage,
    ids: runtime.ids,
    time: runtime.time,
  });
  let cachedIndex: KbIndex | null | undefined;

  const queryRuntime: KbReadQueryRuntime = {
    markdownRoot,
    storagePort: runtime.storage,
    corpusStorage: createCorpusStorage(runtime.storage),
    envPort: runtime.env,
    generatedCommunityProjectionStore,
    readIndex() {
      if (cachedIndex === undefined) {
        cachedIndex = readKbIndexSnapshot(runtimeDir, runtime.storage);
      }
      return cachedIndex;
    },
    readIndexOrEmpty() {
      return readKnowledgeBaseListIndex(queryRuntime);
    },
    entityGraphPath: paths.entityGraphPath,
    notePath: paths.notePath,
    wikiPath: paths.wikiPath,
    sourcePath: paths.sourcePath,
    communityPath: paths.communityPath,
  };

  return queryRuntime;
}

/**
 * Compose a `KbQueryHost` for read-side KB queries. The host caches the
 * built query runtime so metadata reads in the same CLI process share one
 * runtime. Domain code receives the
 * composed host through `kb/queries.ts`'s `KbQueryHost` interface — KB
 * does not import composition itself.
 */
export function createKbQueryHost(context: KbQueryContext): KbQueryHost {
  let cachedKb: KbReadQueryRuntime | undefined;

  const ensureKb = (): KbReadQueryRuntime => (cachedKb ??= createDefaultKbQueryRuntime(context));

  return {
    async acquireKbRuntime() {
      return ensureKb();
    },
    get readDb(): ReadonlyDatabase {
      return getDefaultKbQueryDb(context);
    },
    get storage(): KbReadStorage {
      return getDefaultKbQueryStorage(context);
    },
    get readPaths(): KbReadPathResolver {
      return createDefaultKbReadPaths(context);
    },
    get communityDocumentProvider() {
      return {
        readGeneratedCommunityDocument: (slug: string) =>
          ensureKb().generatedCommunityProjectionStore.readCommunityDocument(slug),
      };
    },
    requireProjectDataDir(operation: string): string {
      if (!context.projectRoot) {
        throw new Error(`KB ${operation} requires an explicit projectRoot in context`);
      }
      return resolveQueryRuntime(context).paths.projectData(context.projectRoot);
    },
  };
}
