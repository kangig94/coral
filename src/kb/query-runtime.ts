import type { Database } from 'better-sqlite3';

import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
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
import { BUNDLED_ENGINES, loadBundledEngine } from '../expansion/bundled.js';
import { createExpansionHost } from '../expansion/host.js';
import { createScope } from '../expansion/scope.js';
import type { ExpansionHost } from '../expansion/contract.js';
import type { ConsumerHandle, ConsumerRegistration } from '../store/consumer-contract.js';
import type { SpawnCliFn } from './curate/pipeline-types.js';
import type { KbReadPathResolver } from './read.js';
import { openReadOnlyStoreDatabase, type ReadonlyDatabase } from '../store/read-port.js';

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
  private bundledLoaded = new WeakSet<KbRuntime>();

  getRuntime(flavor: BuildFlavor): ReturnType<typeof createRealRuntime> {
    if (this.cachedRuntime?.flavor !== flavor) {
      this.cachedRuntime = { flavor, runtime: createRealRuntime(flavor) };
    }
    return this.cachedRuntime.runtime;
  }

  getDb(flavor: BuildFlavor): ReadonlyDatabase {
    if (this.cachedDb?.flavor !== flavor) {
      if (this.cachedDb?.db.open === true) {
        this.cachedDb.db.close();
      }
      this.cachedDb = { flavor, db: openReadOnlyStoreDatabase(this.getRuntime(flavor)) };
    }
    return this.cachedDb.db;
  }

  hasLoadedBundled(kb: KbRuntime): boolean {
    return this.bundledLoaded.has(kb);
  }

  markBundledLoaded(kb: KbRuntime): void {
    this.bundledLoaded.add(kb);
  }
}

const defaultRegistry = new KbQueryRegistry();

export function resolveQueryFlavor(context: KbQueryContext): BuildFlavor {
  return readBuildFlavor(context.pluginRoot);
}

function resolveQueryRuntime(context: KbQueryContext): KbQueryRuntime {
  return context.runtime ?? defaultRegistry.getRuntime(resolveQueryFlavor(context));
}

export function resolveQueryProjectRoot(context: KbQueryContext): string {
  if (!context.projectRoot) {
    throw new Error('KB query requires explicit projectRoot in context');
  }
  return context.projectRoot;
}

export function resolveQueryMarkdownRoot(context: KbQueryContext): string {
  return resolveQueryRuntime(context).paths.coral.corpus.kbRoot;
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

export function getDefaultKbQueryStorage(context: KbQueryContext): ReturnType<typeof createRealRuntime>['storage'] {
  return resolveQueryRuntime(context).storage;
}

export function getDefaultKbQueryDb(context: KbQueryContext): ReadonlyDatabase {
  if (context.readDb !== undefined) {
    return context.readDb;
  }
  if (context.runtime !== undefined) {
    return openReadOnlyStoreDatabase(context.runtime);
  }
  return defaultRegistry.getDb(resolveQueryFlavor(context));
}

export function createDefaultKbQueryRuntime(context: KbQueryContext): KbRuntime {
  const flavor = resolveQueryFlavor(context);
  const runtime = resolveQueryRuntime(context);
  return createKbRuntime({
    markdownRoot: resolveQueryMarkdownRoot(context),
    runtimeDir: kbRuntimeDir(flavor),
    db: getDefaultKbQueryDb(context) as Database,
    time: runtime.time,
    envPort: runtime.env,
    ids: runtime.ids,
    storage: runtime.storage,
    spawnCli: createReadOnlyKbSpawnCli(),
    processPort: runtime.process,
  });
}

/**
 * Loads bundled read-side capabilities onto a read-only KB runtime once per
 * `kb` instance. Read-side CLI does not run the coordinator's bundled
 * fallback, so this is the dual; without it `kb.fts.read()` throws
 * `binding_empty` and the search degrades silently.
 */
export async function ensureBundledEnginesLoaded(kb: KbRuntime, context: KbQueryContext): Promise<void> {
  if (defaultRegistry.hasLoadedBundled(kb)) {
    return;
  }

  const runtime = resolveQueryRuntime(context);

  const noopDriver = {
    register(_reg: ConsumerRegistration): ConsumerHandle {
      return {
        id: _reg.id,
        registrationKind: _reg.kind === 'stateless' ? 'stateless' : 'base',
        lastApplyError: null,
        async stop() {},
        async unregister() {},
        status: () =>
          _reg.kind === 'stateless'
            ? { kind: 'stateless', pending: false }
            : _reg.authority === 'corpus'
              ? {
                  authority: 'corpus',
                  corpusInterest: _reg.corpusInterest,
                  snapshotId: null,
                  contentSeq: 0,
                  metadataSeq: 0,
                  contentManifestHash: null,
                  metadataManifestHash: null,
                  pending: false,
                  lastApplyError: null,
                }
              : { authority: 'journal', cursor: 0, pending: false, lastApplyError: null },
      };
    },
    getJournalReader() {
      return {
        readCursor: () => 0,
      };
    },
    getCorpusStateReader() {
      return {
        readConsumerCursor: () => ({
          snapshotId: '',
          contentSeq: 0,
          metadataSeq: 0,
          contentManifestHash: '',
          metadataManifestHash: '',
        }),
        readCurrentSnapshot: () => kb.getCorpusStateSnapshot(),
      };
    },
  };

  for (const entry of BUNDLED_ENGINES) {
    if (entry.tier !== 'bundled') {
      continue;
    }
    const scope = createScope();
    const host: ExpansionHost = createExpansionHost({
      runtime,
      kb,
      scope,
      id: entry.id,
      tier: entry.tier,
      consumerDriver: noopDriver,
    });
    await loadBundledEngine(entry, host);
  }

  defaultRegistry.markBundledLoaded(kb);
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
