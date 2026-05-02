import type { Database } from '../store/db.js';
import { createRuntimeBinding } from '../runtime/binding.js';
import type { EnvPort, StoragePort, TimePort } from '../infra/port-types.js';
import type { IdPort, ProcessPort } from '../runtime/ports.js';
import type { SpawnCliFn } from './curate/spawn-cli.js';
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

export interface CreateKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
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
  spawnCli: SpawnCliFn;
  processPort: ProcessPort;
  /** Defaults to {@link DEFAULT_MUTATION_LOCK_TIMEOUT_MS}; override for slow paths. */
  mutationLockTimeoutMs?: number;
  engineArtifactRegistry?: EngineArtifactRegistry;
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: Database;
  readonly time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  readonly ids: Pick<IdPort, 'uuid'>;
  readonly storagePort: StoragePort;
  readonly corpusStorage: CorpusStorage;
  readonly spawnCli: SpawnCliFn;
  readonly processPort: ProcessPort;
  readonly envPort: EnvPort;
  readonly vector: KbRuntime['vector'];
  readonly embedding: KbRuntime['embedding'];
  readonly fts: KbRuntime['fts'];
  readonly engineArtifactRegistry: EngineArtifactRegistry;
  readonly corpusAuthorityBaseline: CorpusAuthorityBaselineStore;
  readonly projectionArtifacts: KbProjectionArtifactPort;
  readonly corpusProjectionReader: KbRuntime['corpusProjectionReader'];
  private readonly paths: KbRuntimePaths;
  private readonly manifestAuthority = createManifestAuthority();
  private readonly indexStore: KbIndexStore;
  private mutationLock: Promise<void> = Promise.resolve();
  private readonly corpusStateMirror: ReturnType<typeof createCorpusStateMirror>;
  private readonly publicationQueue: CorpusPublicationQueue;
  private activeMutationContext: KbRuntimeMutationLockContext | null = null;
  private readonly mutationLockController: KbMutationLockController<KbIndex, KbCorpusPublication, KbIndexMutationLane, ManifestAuthorityDelta>;
  private readonly publicationService: CorpusPublicationService;
  private readonly authorityBaselineRefresh: CorpusAuthorityBaselineRefresh;
  private readonly mutationFinalizer: CorpusMutationFinalizer;
  private readonly freshnessService: CorpusFreshnessService;
  private readonly inboundSyncService: CorpusInboundSyncService;

  constructor({
    markdownRoot,
    runtimeDir,
    db,
    corpusPublishCallbacks,
    time,
    ids,
    envPort,
    storage,
    spawnCli,
    processPort,
    mutationLockTimeoutMs,
    engineArtifactRegistry,
  }: CreateKbRuntimeOptions) {
    this.markdownRoot = markdownRoot;
    this.runtimeDir = runtimeDir;
    this.db = db;
    this.time = time;
    this.ids = ids;
    this.storagePort = storage;
    this.corpusStorage = createCorpusStorage(storage);
    this.spawnCli = spawnCli;
    this.processPort = processPort;
    this.envPort = envPort;
    this.paths = createKbRuntimePaths(this.markdownRoot, this.runtimeDir);
    this.vector = createRuntimeBinding<Backed<VectorRetrieval>>('kb.vector');
    this.embedding = createRuntimeBinding<Backed<EmbeddingService>>('kb.embedding');
    this.fts = createRuntimeBinding<Backed<FtsRetrieval>>('kb.fts');
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
        storagePort: this.storagePort,
        notesDir: () => this.notesDir(),
        sourcesDir: () => this.sourcesDir(),
        communitiesDir: () => this.communitiesDir(),
        principlesDir: () => this.principlesDir(),
        entityGraphPath: () => this.entityGraphPath(),
        notePath: (note) => this.notePath(note),
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

    storage.mkdirSync(this.runtimeDir, { recursive: true });
    if (corpusPublishCallbacks !== undefined) {
      this.register(corpusPublishCallbacks);
    }
    this.manifestAuthority.seedFromFullCollectors(this);
  }

  notesDir(): string { return this.paths.notesDir(); }
  sourcesDir(): string { return this.paths.sourcesDir(); }
  communitiesDir(): string { return this.paths.communitiesDir(); }
  principlesDir(): string { return this.paths.principlesDir(); }
  entityGraphPath(): string { return this.paths.entityGraphPath(); }
  notePath(note: string): string { return this.paths.notePath(note); }
  sourcePath(source: string): string { return this.paths.sourcePath(source); }
  communityPath(community: string): string { return this.paths.communityPath(community); }
  principlePath(principle: string): string { return this.paths.principlePath(principle); }
  sourceImportStageDir(): string { return this.paths.sourceImportStageDir(); }

  readEntityGraph(): EntityGraph | null {
    return readEntityGraphFile(this.storagePort, this.entityGraphPath());
  }

  async writeEntityGraph(graph: EntityGraph): Promise<void> {
    await this.withMutationLock((mutation) => {
      mutation.writeEntityGraph(graph);
    });
  }

  readIndex(): KbIndex | null { return this.indexStore.readIndex(); }
  persistIndexToDisk(index: KbIndex): KbIndex { return this.indexStore.persistIndexToDisk(index); }
  writeIndex(index: KbIndex): KbIndex { return this.indexStore.writeIndex(index); }
  readIndexOrEmpty(): KbIndex { return this.indexStore.readIndexOrEmpty(); }
  readIndexStateIfPresent(): KbIndexState | null { return this.indexStore.readIndexStateIfPresent(); }
  readIndexState(): KbIndexState { return this.indexStore.readIndexState(); }
  writeIndexState(state: KbIndexState): void { this.indexStore.writeIndexState(state); }
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
    externalMutation: KbIndexMutationLane | null = null,
  ): KbIndexState {
    const state = this.readIndexState();
    if (!indexStateMatchesSnapshot(state, startState)) {
      return state;
    }

    this.manifestAuthority.seedFromFullCollectors(this);
    const nextState = applyMutationLane(withoutTextStaleReason(state), externalMutation);
    this.writeIndexState(nextState);
    this.authorityBaselineRefresh.rebuildAuthorityBaselineFromDisk();
    return nextState;
  }

  getCorpusStateSnapshot(): KbCorpusSnapshot { return this.corpusStateMirror.get(); }
  captureCorpusSnapshot(): KbCorpusSnapshot { return this.publicationService.captureCorpusSnapshot(); }
  invalidateCorpusStateSnapshot(): void { this.corpusStateMirror.invalidate(); }
  invalidateKbCache(): void { this.indexStore.invalidateIndexCache(); }
  invalidateTextSnapshot(reason: string): KbIndexState { return this.recordIndexSyncFailure(reason); }
  ensureCorpusFreshness(options: EnsureCorpusFreshnessOptions = {}): Promise<KbIndex> {
    return this.freshnessService.ensureCorpusFreshness(options);
  }

  async withMutationLock<T>(
    fn: (mutation: KbMutationEffects, args: { signal: AbortSignal }) => Promise<T> | T,
    options: KbMutationLockOptions = {},
  ): Promise<T> {
    return this.mutationLockController.withMutationLock(
      (_lockContext, args) => fn(this.mutationFinalizer.mutationEffects, args),
      options,
    );
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
