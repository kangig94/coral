import type { Database } from 'better-sqlite3';

import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { createRealRuntime } from '../runtime/real.js';
import { openBackendStoreDb } from '../store/db.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { KbRuntime } from './contract.js';
import {
  communityPathFromName,
  kbRuntimeDir,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
} from './paths.js';
import { createKbRuntime } from './runtime.js';
import type { SpawnCliFn } from './curate/pipeline-types.js';
import type { KbReadPathResolver } from './read.js';

export type KbQueryContext = {
  pluginRoot: string;
  projectRoot?: string;
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
  private cachedDb: { flavor: BuildFlavor; db: Database } | undefined;

  getRuntime(flavor: BuildFlavor): ReturnType<typeof createRealRuntime> {
    if (this.cachedRuntime?.flavor !== flavor) {
      this.cachedRuntime = { flavor, runtime: createRealRuntime(flavor) };
    }
    return this.cachedRuntime.runtime;
  }

  getDb(flavor: BuildFlavor): Database {
    if (this.cachedDb?.flavor !== flavor) {
      this.cachedDb = { flavor, db: openBackendStoreDb(this.getRuntime(flavor)) };
    }
    return this.cachedDb.db;
  }
}

const defaultRegistry = new KbQueryRegistry();

export function resolveQueryFlavor(context: KbQueryContext): BuildFlavor {
  return readBuildFlavor(context.pluginRoot);
}

export function resolveQueryProjectRoot(context: KbQueryContext): string {
  if (!context.projectRoot) {
    throw new Error('KB query requires explicit projectRoot in context');
  }
  return context.projectRoot;
}

export function resolveQueryMarkdownRoot(context: KbQueryContext): string {
  return defaultRegistry.getRuntime(resolveQueryFlavor(context)).paths.coral.corpus.kbRoot;
}

export function createDefaultKbReadPaths(context: KbQueryContext): KbReadPathResolver {
  const root = resolveQueryMarkdownRoot(context);
  return {
    notePath: (note) => notePathFromName(note, root),
    sourcePath: (source) => sourcePathFromName(source, root),
    communityPath: (community) => communityPathFromName(community, root),
    principlePath: (principle) => principlePathFromName(principle, root),
  };
}

export function getDefaultKbQueryDb(context: KbQueryContext): Database {
  return defaultRegistry.getDb(resolveQueryFlavor(context));
}

export function createDefaultKbQueryRuntime(context: KbQueryContext): KbRuntime {
  const flavor = resolveQueryFlavor(context);
  const runtime = defaultRegistry.getRuntime(flavor);
  return createKbRuntime({
    markdownRoot: resolveQueryMarkdownRoot(context),
    runtimeDir: kbRuntimeDir(flavor),
    db: getDefaultKbQueryDb(context),
    readOnlyOrama: true,
    envPort: runtime.env,
    storage: runtime.storage,
    spawnCli: createReadOnlyKbSpawnCli(),
    processPort: runtime.process,
  });
}

/**
 * KB query runtime is read-only: it answers `kb` CLI subcommands without touching
 * `gitSync.scheduleDeferredCommit()` or the auto-fix dispatcher. The spawnCli surface
 * is therefore unreachable from the read path; rejecting any invocation here makes
 * accidental future writes fail loudly instead of silently spawning a real provider.
 */
function createReadOnlyKbSpawnCli(): SpawnCliFn {
  return async () => {
    throw new Error('KB query runtime is read-only and cannot spawn provider CLIs.');
  };
}
