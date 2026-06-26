import { join } from 'node:path';

import type { Database } from '../store/db.js';
import { createRuntimeBinding } from '../runtime/binding.js';
import type { EnvPort, StoragePort, TimePort } from '../infra/port-types.js';
import { backendLog } from '../infra/backend-log.js';
import { acquireDirectoryLock } from '../infra/fs-lock.js';
import type { IdPort, ProcessPort } from '../runtime/ports.js';
import type { CurateAssistantPort } from './curate/assistant.js';
import type {
  Backed,
  EmbeddingService,
  EnsureCorpusFreshnessOptions,
  FtsRetrieval,
  KbCorpusPublication,
  KbCorpusPublishCallbacks,
  KbCorpusSnapshot,
  KbInboundSyncOptions,
  KbIndexMutationLane,
  KbIndexState,
  KbMutationEffects,
  KbProjectionArtifactPort,
  KbRuntime,
} from './contract.js';
import type { VectorRetrieval } from './search/contract.js';
import { createCapabilityRegistry } from './capability/registry.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  KB_EMBEDDING_CAPABILITY,
  KB_FTS_CAPABILITY,
  KB_VECTOR_CAPABILITY,
} from './capability/constants.js';
import { createBuiltinGraphRole } from './search/graph-retrieval.js';
import { createRoleRegistry } from './search/role-registry.js';
import { createBuiltinTextRole } from './search/text-retrieval.js';
import { createBuiltinVectorRole } from './search/vector-query.js';
import {
  createKbMutationLock,
  DEFAULT_MUTATION_LOCK_TIMEOUT_MS,
  type KbMutationLockController,
  type KbMutationLockDiagnostics,
  type KbMutationLockOptions,
} from './corpus/mutation-lock.js';
import { createManifestAuthority } from './corpus/manifest-authority.js';
import type { ManifestAuthorityDelta } from './corpus/manifest-types.js';
import { cloneKbIndex } from './corpus/index-records.js';
import {
  applyMutationLane,
  commitMutationState,
  indexStateMatchesSnapshot,
  mergeMutationLane,
  previewPendingMutationState,
  withoutTextStaleReason,
} from './corpus/lanes.js';
import { KbIndexStore, writeJsonAtomic } from './corpus/index-store.js';
import { writeFileAtomic } from './corpus/file-atomic.js';
import { readEntityGraphFile } from './corpus/entity-graph-store.js';
import { resolveCorpusStructuralKey, type CorpusStructuralKey } from './corpus/structural-key.js';
import { CorpusPublicationQueue } from './corpus/publication.js';
import { createCorpusStorage, type CorpusStorage } from './corpus/rescan/storage.js';
import { type EntityGraph, type KbIndex } from './entry-types.js';
import { createCorpusStateMirror } from './state/corpus-state.js';
import { createKbRuntimePaths, type KbRuntimePaths } from './paths.js';
import { createKbProjectionInput } from './projection-input.js';
import { EngineArtifactRegistry } from './corpus/artifact-registry.js';
import { createCorpusAuthorityBaselineStore } from './corpus/rescan/authority-baseline.js';
import type { CorpusAuthorityBaselineStore } from './corpus/authority-baseline-contract.js';
import { CorpusAuthorityBaselineRefresh } from './corpus/authority-baseline-refresh.js';
import { CorpusFreshnessService } from './corpus/freshness-service.js';
import { CorpusInboundSyncService } from './corpus/inbound-sync-service.js';
import { CorpusMutationFinalizer, type KbRuntimeMutationLockContext } from './corpus/mutation-finalizer.js';
import { CorpusPublicationService } from './corpus/publication-service.js';
import { buildCurrentCorpusSurface } from './corpus/surface.js';
import { readDeclaredKbAnalyzersFromEnv, type KbDeclaredAnalyzer } from './extra-langs.js';

export interface CreateKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
  /** Daemon build version, surfaced on the runtime for KB commit provenance. */
  version: string;
  db: Database;
  corpusPublishCallbacks?: KbCorpusPublishCallbacks;
  /**
   * Time port. `now()` drives the existing time fields; `setTimeout` /
   * `clearTimeout` back the mutation-lock deadline (§16 #50: ports only, no
   * ambient timers).
   */
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  ids: Pick<IdPort, 'uuid'>;
  envPort: EnvPort;
  storage: StoragePort;
  curateAssistant: CurateAssistantPort;
  processPort: ProcessPort;
  /** Defaults to {@link DEFAULT_MUTATION_LOCK_TIMEOUT_MS}; override for slow paths. */
  mutationLockTimeoutMs?: number;
  engineArtifactRegistry?: EngineArtifactRegistry;
}

type KbRuntimeTimePort = Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'> & Partial<Pick<TimePort, 'sleep'>>;

const KB_MUTATION_DIRECTORY_LOCK_STALE_MIN_MS = 10 * 60 * 1000;
const KB_MUTATION_DIRECTORY_LOCK_STALE_PADDING_MS = 60_000;

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly version: string;
  readonly runtimeDir: string;
  readonly db: Database;
  readonly time: KbRuntimeTimePort;
  readonly ids: Pick<IdPort, 'uuid'>;
  readonly storagePort: StoragePort;
  readonly corpusStorage: CorpusStorage;
  readonly curateAssistant: CurateAssistantPort;
  readonly processPort: ProcessPort;
  readonly envPort: EnvPort;
  readonly declaredAnalyzers: readonly KbDeclaredAnalyzer[];
  readonly capabilityRegistry: KbRuntime['capabilityRegistry'];
  readonly capabilities: KbRuntime['capabilities'];
  readonly roleRegistry: KbRuntime['roleRegistry'];
  readonly roleCatalog: KbRuntime['roleCatalog'];
  readonly engineArtifactRegistry: EngineArtifactRegistry;
  readonly corpusAuthorityBaseline: CorpusAuthorityBaselineStore;
  readonly projectionArtifacts: KbProjectionArtifactPort;
  readonly corpusProjectionReader: KbRuntime['corpusProjectionReader'];
  private readonly paths: KbRuntimePaths;
  private readonly directoryMutationLockDir: string;
  private readonly manifestAuthority = createManifestAuthority();
  private readonly indexStore: KbIndexStore;
  private mutationLock: Promise<void> = Promise.resolve();
  private readonly corpusStateMirror: ReturnType<typeof createCorpusStateMirror>;
  private readonly publicationQueue: CorpusPublicationQueue;
  private activeMutationContext: KbRuntimeMutationLockContext | null = null;
  private readonly mutationLockController: KbMutationLockController<
    KbIndex,
    KbCorpusPublication,
    KbIndexMutationLane,
    ManifestAuthorityDelta
  >;
  private readonly publicationService: CorpusPublicationService;
  private readonly authorityBaselineRefresh: CorpusAuthorityBaselineRefresh;
  private readonly mutationFinalizer: CorpusMutationFinalizer;
  private readonly freshnessService: CorpusFreshnessService;
  private readonly inboundSyncService: CorpusInboundSyncService;

  constructor({
    markdownRoot,
    runtimeDir,
    version,
    db,
    corpusPublishCallbacks,
    time,
    ids,
    envPort,
    storage,
    curateAssistant,
    processPort,
    mutationLockTimeoutMs,
    engineArtifactRegistry,
  }: CreateKbRuntimeOptions) {
    this.markdownRoot = markdownRoot;
    this.version = version;
    this.runtimeDir = runtimeDir;
    this.db = db;
    this.time = time;
    this.directoryMutationLockDir = join(this.runtimeDir, 'mutation.lock');
    this.ids = ids;
    this.storagePort = storage;
    this.corpusStorage = createCorpusStorage(storage);
    this.curateAssistant = curateAssistant;
    this.processPort = processPort;
    this.envPort = envPort;
    this.declaredAnalyzers = readDeclaredKbAnalyzersFromEnv(envPort, (message) => {
      backendLog.warn(message);
    });
    this.paths = createKbRuntimePaths(this.markdownRoot, this.runtimeDir);
    const capabilityRegistry = createCapabilityRegistry();
    capabilityRegistry.registerBuiltin(
      BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
      createRuntimeBinding<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY),
    );
    capabilityRegistry.registerBuiltin(
      BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
      createRuntimeBinding<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY),
    );
    capabilityRegistry.registerBuiltin(
      BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
      createRuntimeBinding<Backed<EmbeddingService>>(KB_EMBEDDING_CAPABILITY),
    );
    this.capabilityRegistry = capabilityRegistry;
    this.capabilities = capabilityRegistry.catalogView();
    const roleRegistry = createRoleRegistry();
    this.roleRegistry = roleRegistry;
    this.roleCatalog = roleRegistry.catalogView();
    this.engineArtifactRegistry = engineArtifactRegistry ?? new EngineArtifactRegistry();
    this.corpusAuthorityBaseline = createCorpusAuthorityBaselineStore(this.db);
    this.projectionArtifacts = {
      runtimeDir: this.runtimeDir,
      files: {
        existsSync: (path) => this.storagePort.existsSync(path),
        readFileSync: (path, encoding) => this.storagePort.readFileSync(path, encoding),
        rmSync: (path, options) => this.storagePort.rmSync(path, options),
        mkdirSync: (path, options) => {
          this.storagePort.mkdirSync(path, options);
        },
        renameSync: (oldPath, newPath) => this.storagePort.renameSync(oldPath, newPath),
        writeTextAtomic: (path, content) => {
          writeFileAtomic(this, path, content);
        },
        writeJsonAtomic: (path, value) => {
          writeJsonAtomic(this, path, value);
        },
      },
    };
    this.corpusProjectionReader = {
      resolveCurrentIndex: () => this.readIndexOrEmpty(),
      prepareCurrentProjectionInput: async ({ signal, ...options } = {}) => {
        await this.ensureCorpusFreshness({ wait: true, signal });
        return createKbProjectionInput(this, options);
      },
    };
    this.corpusStateMirror = createCorpusStateMirror(this.db);
    this.indexStore = new KbIndexStore({
      runtimeDir: this.runtimeDir,
      storage,
      ids,
      onStateChange: (previous, next) => {
        this.mutationFinalizer.capturePublicationFromStateChange(previous, next);
      },
    });
    this.publicationQueue = new CorpusPublicationQueue({
      readCorpusStateSnapshot: () => this.getCorpusStateSnapshot(),
      invalidateCorpusStateSnapshot: () => {
        this.invalidateCorpusStateSnapshot();
      },
    });
    this.publicationService = new CorpusPublicationService({
      indexStore: this.indexStore,
      manifestAuthority: this.manifestAuthority,
      publicationQueue: this.publicationQueue,
      getActiveMutationContext: () => this.activeMutationContext,
      setActivePublication: (publication) => {
        if (this.activeMutationContext !== null) {
          this.activeMutationContext.publication = publication;
        }
      },
    });
    this.authorityBaselineRefresh = new CorpusAuthorityBaselineRefresh({
      corpusAuthorityBaseline: this.corpusAuthorityBaseline,
      storagePort: this.storagePort,
      getRuntime: () => this,
      notePath: (note) => this.notePath(note),
      wikiPath: (wiki) => this.wikiPath(wiki),
      sourcePath: (source) => this.sourcePath(source),
      communityPath: (community) => this.communityPath(community),
      principlePath: (principle) => this.principlePath(principle),
      entityGraphPath: () => this.entityGraphPath(),
    });
    this.mutationFinalizer = new CorpusMutationFinalizer({
      indexStore: this.indexStore,
      manifestAuthority: this.manifestAuthority,
      entityGraphHost: { storagePort: this.storagePort, ids: this.ids },
      entityGraphPath: () => this.entityGraphPath(),
      getActiveMutationContext: () => this.activeMutationContext,
      recordMutationCommitted: (lane, reason) => this.recordMutationCommitted(lane, reason),
      refreshAuthorityBaselineForPendingDeltas: (deltas) => {
        this.authorityBaselineRefresh.refreshAuthorityBaselineForPendingDeltas(deltas);
      },
      capturePublication: (previous, next, mutationContext) => {
        this.publicationService.capturePublicationFromStateChange(previous, next, mutationContext);
      },
    });
    this.mutationLockController = createKbMutationLock<
      KbIndex,
      KbCorpusPublication,
      KbIndexMutationLane,
      ManifestAuthorityDelta
    >(
      {
        cloneStartIndex: () => cloneKbIndex(this.readIndex()),
        getCurrentLock: () => this.mutationLock,
        setCurrentLock: (lock) => {
          this.mutationLock = lock;
        },
        setActiveContext: (context) => {
          this.activeMutationContext = context;
        },
        finalizePendingMutation: (context) => {
          this.mutationFinalizer.finalizePendingMutation(context);
        },
        enqueuePublication: (publication) => {
          this.publicationQueue.enqueue(publication);
        },
        hasQueuedPublications: () => this.publicationQueue.hasQueuedPublications(),
        processPublishQueue: () => this.publicationQueue.process(),
      },
      {
        defaultTimeoutMs: mutationLockTimeoutMs ?? DEFAULT_MUTATION_LOCK_TIMEOUT_MS,
        time: this.time,
      },
    );
    this.freshnessService = new CorpusFreshnessService({
      indexStore: this.indexStore,
      mutationLockController: this.mutationLockController,
      mutationEffects: this.mutationFinalizer.mutationEffects,
      getRuntime: () => this,
    });
    this.inboundSyncService = new CorpusInboundSyncService({
      indexStore: this.indexStore,
      manifestAuthority: this.manifestAuthority,
      mutationLockController: this.mutationLockController,
      mutationEffects: this.mutationFinalizer.mutationEffects,
      target: {
        markdownRoot: this.markdownRoot,
        corpusStorage: this.corpusStorage,
        storagePort: this.storagePort,
        entityGraphPath: () => this.entityGraphPath(),
        notePath: (note) => this.notePath(note),
        wikiPath: (slug) => this.wikiPath(slug),
        sourcePath: (source) => this.sourcePath(source),
        communityPath: (community) => this.communityPath(community),
        principlePath: (principle) => this.principlePath(principle),
      },
      recordMutationCommitted: (lane, reason) => {
        this.recordMutationCommitted(lane, reason);
      },
      invalidateKbCache: () => {
        this.invalidateKbCache();
      },
    });

    roleRegistry.registerBuiltin(createBuiltinTextRole(this), { criticality: 'core' });
    roleRegistry.registerBuiltin(createBuiltinVectorRole(this), { criticality: 'core' });
    roleRegistry.registerBuiltin(createBuiltinGraphRole());

    storage.mkdirSync(this.runtimeDir, { recursive: true });
    if (corpusPublishCallbacks !== undefined) {
      this.register(corpusPublishCallbacks);
    }
    this.manifestAuthority.replaceCurrentSurfaceHashes(buildCurrentCorpusSurface(this).manifest);
  }

  notesDir(): string {
    return this.paths.notesDir();
  }
  wikiDir(): string {
    return this.paths.wikiDir();
  }
  sourcesDir(): string {
    return this.paths.sourcesDir();
  }
  communitiesDir(): string {
    return this.paths.communitiesDir();
  }
  principlesDir(): string {
    return this.paths.principlesDir();
  }
  entityGraphPath(): string {
    return this.paths.entityGraphPath();
  }
  notePath(note: string): string {
    return this.paths.notePath(note);
  }
  wikiPath(slug: string): string {
    return this.paths.wikiPath(slug);
  }
  sourcePath(source: string): string {
    return this.paths.sourcePath(source);
  }
  communityPath(community: string): string {
    return this.paths.communityPath(community);
  }
  principlePath(principle: string): string {
    return this.paths.principlePath(principle);
  }
  sourceImportStageDir(): string {
    return this.paths.sourceImportStageDir();
  }

  readEntityGraph(): EntityGraph | null {
    return readEntityGraphFile(this.storagePort, this.entityGraphPath());
  }

  readCorpusStructuralKey(index: KbIndex, currentGraph?: EntityGraph | null): CorpusStructuralKey | null {
    return resolveCorpusStructuralKey({
      index,
      manifestAuthority: this.manifestAuthority,
      ...(currentGraph === undefined ? {} : { currentGraph }),
      readCurrentGraph: () => this.readEntityGraph(),
    });
  }

  async writeEntityGraph(graph: EntityGraph): Promise<void> {
    await this.withMutationLock((mutation) => {
      mutation.writeEntityGraph(graph);
    });
  }

  readIndex(): KbIndex | null {
    return this.indexStore.readIndex();
  }
  persistIndexToDisk(index: KbIndex): KbIndex {
    return this.indexStore.persistIndexToDisk(index);
  }
  writeIndex(index: KbIndex): KbIndex {
    return this.indexStore.writeIndex(index);
  }
  readIndexOrEmpty(): KbIndex {
    return this.indexStore.readIndexOrEmpty();
  }
  readIndexStateIfPresent(): KbIndexState | null {
    return this.indexStore.readIndexStateIfPresent();
  }
  readIndexState(): KbIndexState {
    return this.indexStore.readIndexState();
  }
  writeIndexState(state: KbIndexState): void {
    this.indexStore.writeIndexState(state);
  }
  register(corpusPublishCallbacks: KbCorpusPublishCallbacks): void {
    this.publicationService.register(corpusPublishCallbacks);
  }

  recordMutationCommitted(lane: KbIndexMutationLane = 'both', reason?: string): KbIndexState {
    if (this.activeMutationContext !== null) {
      this.activeMutationContext.pendingMutationLane = mergeMutationLane(
        this.activeMutationContext.pendingMutationLane,
        lane,
      );
      if (reason !== undefined) {
        this.activeMutationContext.pendingMutationReason = reason;
      }
      return previewPendingMutationState(this.readIndexState(), this.activeMutationContext);
    }

    const nextState = commitMutationState(this.readIndexState(), lane, reason);
    this.writeIndexState(nextState);
    this.mutationFinalizer.refreshIndexBaselineIfPresent();
    this.authorityBaselineRefresh.rebuildAuthorityBaselineFromDisk();
    return nextState;
  }

  recordIndexSyncSuccess(): KbIndexState {
    const state = this.readIndexState();
    const nextState = { contentSeq: state.contentSeq, metadataSeq: state.metadataSeq };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordIndexSyncFailure(reason: string): KbIndexState {
    const state = this.readIndexState();
    const nextState = { contentSeq: state.contentSeq, metadataSeq: state.metadataSeq, textStaleReason: reason };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordReindexSuccess(
    startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
    externalMutation?: KbIndexMutationLane,
    surface?: ReturnType<typeof buildCurrentCorpusSurface>,
  ): KbIndexState {
    const state = this.readIndexState();
    if (!indexStateMatchesSnapshot(state, startState)) {
      return state;
    }

    const finalSurface = surface ?? buildCurrentCorpusSurface(this);
    this.manifestAuthority.replaceCurrentSurfaceHashes(finalSurface.manifest);
    const nextState = applyMutationLane(withoutTextStaleReason(state), externalMutation ?? null);
    this.writeIndexState(nextState);
    this.corpusAuthorityBaseline.replace(finalSurface.baselineRecords);
    return nextState;
  }

  getCorpusStateSnapshot(): KbCorpusSnapshot {
    return this.corpusStateMirror.get();
  }
  captureCorpusSnapshot(): KbCorpusSnapshot {
    return this.publicationService.captureCorpusSnapshot();
  }
  invalidateCorpusStateSnapshot(): void {
    this.corpusStateMirror.invalidate();
  }
  invalidateKbCache(): void {
    this.indexStore.invalidateIndexCache();
  }
  invalidateTextSnapshot(reason: string): KbIndexState {
    return this.recordIndexSyncFailure(reason);
  }
  ensureCorpusFreshness(options: EnsureCorpusFreshnessOptions = {}): Promise<KbIndex> {
    return this.freshnessService.ensureCorpusFreshness(options);
  }

  async withMutationLock<T>(
    fn: (mutation: KbMutationEffects, args: { signal: AbortSignal }) => Promise<T> | T,
    options: KbMutationLockOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MUTATION_LOCK_TIMEOUT_MS;
    const releaseDirectoryLock = await acquireDirectoryLock(
      this.directoryMutationLockDir,
      {
        storage: this.storagePort,
        time: {
          now: this.time.now,
          sleep: this.sleep.bind(this),
        },
        staleMs: Math.max(KB_MUTATION_DIRECTORY_LOCK_STALE_MIN_MS, timeoutMs * 2 + KB_MUTATION_DIRECTORY_LOCK_STALE_PADDING_MS),
      },
      timeoutMs,
    );
    try {
      return await this.mutationLockController.withMutationLock(
        (_lockContext, args) => fn(this.mutationFinalizer.mutationEffects, args),
        options,
      );
    } finally {
      releaseDirectoryLock();
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.time.sleep !== undefined) {
      return this.time.sleep(ms);
    }
    return new Promise((resolve) => {
      const timer = this.time.setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  mutationLockDiagnostics(): KbMutationLockDiagnostics {
    return this.mutationLockController.diagnostics();
  }

  retryPendingCorpusPublication(): Promise<void> {
    return this.publicationService.retryPendingCorpusPublication();
  }

  runInboundSync<T>(fn: () => Promise<T> | T, options: KbInboundSyncOptions = {}): Promise<T> {
    return this.inboundSyncService.runInboundSync(fn, options);
  }
}

export function createKbRuntime(opts: CreateKbRuntimeOptions): KbRuntime {
  return new KbRuntimeImpl(opts);
}
