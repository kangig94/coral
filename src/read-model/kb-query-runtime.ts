import type { Database } from '../store/db.js';

import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { KbRuntime } from '../kb/contract.js';
import {
  communityPathFromName,
  kbRuntimeDir,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
  wikiPathFromName,
} from '../kb/paths.js';
import { createKbRuntime } from '../kb/runtime.js';
import { loadBundledEngine } from '../expansion/bundled.js';
import { createExpansionHost, disposeExpansionScope } from '../expansion/host.js';
import { createScope } from '../expansion/scope.js';
import type { ExpansionHost } from '../expansion/contract.js';
import { validateManifestCompleteness } from '../expansion/manifest/completeness.js';
import { createExpansionManifestCatalog } from '../expansion/manifest/catalog.js';
import { initializeCapabilityCatalog } from '../expansion/manifest/fills-validation.js';
import { serializeCoralSetupError } from '../runtime/errors.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
} from '../kb/capability/constants.js';
import type { ConsumerHandle, ConsumerHandleStatus, ConsumerRegistration } from '../store/consumer-contract.js';
import type { CurateAssistantPort } from '../kb/curate/assistant.js';
import type { KbReadPathResolver, KbReadStorage } from '../kb/read.js';
import type { KbQueryHost } from '../kb/queries.js';
import { openReadOnlyStoreDatabase, type ReadonlyDatabase } from '../store/read-port.js';

const MANIFEST_CATALOG_UNAVAILABLE_MESSAGE =
  /unable to open database file|no such table:\s*expansion_manifest_catalog/i;

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
  private bundledLoaded = new WeakSet<KbRuntime>();

  getRuntime(flavor: BuildFlavor): ReturnType<typeof createRealRuntime> {
    if (this.cachedRuntime?.flavor !== flavor) {
      this.cachedRuntime = { flavor, runtime: createRealRuntime(flavor) };
    }
    return this.cachedRuntime.runtime;
  }

  getDb(flavor: BuildFlavor): ReadonlyDatabase {
    if (this.cachedDb?.flavor !== flavor) {
      this.cachedDb?.db.close();
      this.cachedDb = { flavor, db: openReadOnlyStoreDatabase(this.getRuntime(flavor)) };
    }
    return this.cachedDb.db;
  }

  getRuntimeDb(runtime: KbQueryRuntime): ReadonlyDatabase {
    const cached = this.cachedRuntimeDbs.get(runtime);
    if (cached !== undefined) {
      return cached;
    }

    const db = openReadOnlyStoreDatabase(runtime);
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
    this.bundledLoaded = new WeakSet<KbRuntime>();
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

export function resolveQueryMarkdownRoot(context: KbQueryContext): string {
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

export function getDefaultKbQueryStorage(context: KbQueryContext): ReturnType<typeof createRealRuntime>['storage'] {
  return resolveQueryRuntime(context).storage;
}

export function getDefaultKbQueryDb(context: KbQueryContext): ReadonlyDatabase {
  if (context.readDb !== undefined) {
    return context.readDb;
  }
  if (context.runtime !== undefined) {
    return defaultRegistry.getRuntimeDb(context.runtime);
  }
  return defaultRegistry.getDb(resolveQueryFlavor(context));
}

export function createDefaultKbQueryRuntime(context: KbQueryContext): KbRuntime {
  const flavor = resolveQueryFlavor(context);
  const runtime = resolveQueryRuntime(context);
  return createKbRuntime({
    markdownRoot: resolveQueryMarkdownRoot(context),
    runtimeDir: kbRuntimeDir(flavor, runtime.paths.configSlot),
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

function isManifestCatalogUnavailableError(error: unknown): boolean {
  if (serializeCoralSetupError(error) !== null) {
    return false;
  }
  return error instanceof Error && MANIFEST_CATALOG_UNAVAILABLE_MESSAGE.test(error.message);
}

/**
 * Loads bundled read-side capabilities onto a read-only KB runtime once per
 * `kb` instance. Read-side CLI does not run the coordinator's bundled
 * fallback, so this is the dual; without it reading the kb.fts capability throws
 * `binding_empty` and the search degrades silently.
 */
export async function ensureBundledEnginesLoaded(kb: KbRuntime, context: KbQueryContext): Promise<void> {
  if (defaultRegistry.hasLoadedBundled(kb)) {
    return;
  }

  const runtime = resolveQueryRuntime(context);
  let manifestCatalog: ReturnType<typeof createExpansionManifestCatalog>;
  try {
    manifestCatalog = createExpansionManifestCatalog({ readDb: getDefaultKbQueryDb(context) });
  } catch (error) {
    if (!isManifestCatalogUnavailableError(error)) {
      throw error;
    }
    manifestCatalog = createExpansionManifestCatalog();
  }
  initializeCapabilityCatalog(kb.capabilityRegistry, manifestCatalog.listManifests(), [
    BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
    BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
    BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  ]);

  const noopDriver = {
    register(_reg: ConsumerRegistration): ConsumerHandle {
      return {
        id: _reg.id,
        registrationKind: _reg.kind === 'stateless' ? 'stateless' : 'base',
        lastApplyError: null,
        async stop() {},
        async unregister() {},
        status: () => noopConsumerStatus(_reg),
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

  for (const entry of manifestCatalog.listManifests()) {
    if (entry.tier !== 'bundled') {
      continue;
    }
    const scope = createScope();
    const host: ExpansionHost = createExpansionHost({
      runtime,
      kb,
      roleRegistry: kb.roleRegistry,
      scope,
      manifest: entry,
      consumerDriver: noopDriver,
    });
    try {
      await loadBundledEngine(entry, host);
      validateManifestCompleteness(entry, kb.roleRegistry, kb.capabilityRegistry);
    } catch (error) {
      await disposeExpansionScope(scope);
      throw error;
    }
  }

  defaultRegistry.markBundledLoaded(kb);
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

function noopConsumerStatus(reg: ConsumerRegistration): ConsumerHandleStatus {
  if (reg.kind === 'stateless') {
    return { kind: 'stateless', pending: false };
  }

  if (reg.authority === 'corpus') {
    return {
      authority: 'corpus',
      corpusInterest: reg.corpusInterest,
      snapshotId: null,
      contentSeq: 0,
      metadataSeq: 0,
      contentManifestHash: null,
      metadataManifestHash: null,
      pending: false,
      lastApplyError: null,
    };
  }

  return { authority: 'journal', cursor: 0, pending: false, lastApplyError: null };
}

/**
 * Compose a `KbQueryHost` for read-side KB queries. The host caches the
 * built `KbRuntime` so search and metadata reads in the same CLI process
 * share one runtime + bundled-engine load. Domain code receives the
 * composed host through `kb/queries.ts`'s `KbQueryHost` interface — KB
 * does not import composition itself.
 */
export function createKbQueryHost(context: KbQueryContext): KbQueryHost {
  let cachedKb: KbRuntime | undefined;
  let bundledLoadPromise: Promise<void> | undefined;

  const ensureKb = (): KbRuntime => (cachedKb ??= createDefaultKbQueryRuntime(context));

  return {
    async acquireKbRuntime(options) {
      const kb = ensureKb();
      if (options?.ensureBundledEngines === true) {
        bundledLoadPromise ??= ensureBundledEnginesLoaded(kb, context);
        await bundledLoadPromise;
      }
      return kb;
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
        readGeneratedCommunityDocument: (slug: string) => ensureKb().generatedCommunityProjectionStore.readCommunityDocument(slug),
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
