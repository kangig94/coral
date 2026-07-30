import type { Database } from '../store/db.js';

import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { KbRuntime } from '../kb/contract.js';
import {
  communityPathFromName,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
  wikiPathFromName,
} from '../kb/paths.js';
import { createKbRuntime } from '../kb/runtime.js';
import type { CurateAssistantPort } from '../kb/curate/assistant.js';
import type { KbReadPathResolver, KbReadStorage } from '../kb/read.js';
import type { KbQueryHost } from '../kb/queries.js';
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

export function createDefaultKbQueryRuntime(context: KbQueryContext): KbRuntime {
  const runtime = resolveQueryRuntime(context);
  return createKbRuntime({
    markdownRoot: resolveQueryMarkdownRoot(context),
    runtimeDir: runtime.paths.coral.kbRuntime.root,
    // Read-only query runtime: it never runs git-sync, so the version is inert
    // (only the daemon's curate path stamps commits with a real identity.version).
    version: '0.0.0',
    db: getDefaultKbQueryDb(context) as Database,
    time: runtime.time,
    envPort: runtime.env,
    ids: runtime.ids,
    storage: runtime.storage,
    curateAssistant: createReadOnlyCurateAssistant(),
    processPort: runtime.process,
  });
}

/**
 * KB query runtime is read-only: it answers `kb` CLI subcommands without touching
 * `gitSync.scheduleDeferredCommit()` or the auto-fix dispatcher. The curate assistant
 * surface is therefore unreachable from the read path; rejecting any invocation here makes
 * accidental future writes fail loudly instead of silently spawning a real provider.
 */
function createReadOnlyCurateAssistant(): CurateAssistantPort {
  return {
    async complete() {
      throw new Error('KB query runtime is read-only and cannot run curate assistant requests.');
    },
  };
}

/**
 * Compose a `KbQueryHost` for read-side KB queries. The host caches the
 * built `KbRuntime` so metadata reads in the same CLI process share one
 * runtime. Domain code receives the
 * composed host through `kb/queries.ts`'s `KbQueryHost` interface — KB
 * does not import composition itself.
 */
export function createKbQueryHost(context: KbQueryContext): KbQueryHost {
  let cachedKb: KbRuntime | undefined;

  const ensureKb = (): KbRuntime => (cachedKb ??= createDefaultKbQueryRuntime(context));

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
