import { join } from 'node:path';

import type { Database } from '../store/db.js';
import { createRuntimeBinding } from '../runtime/binding.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { isRecord } from '../infra/json.js';
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
  KbGeneratedCommunityProjectionCallbacks,
  KbGeneratedCommunityPublication,
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
import { cloneKbIndex } from './corpus/index/records.js';
import {
  applyMutationLane,
  commitMutationState,
  captureIndexStateSnapshot,
  indexStateMatchesSnapshot,
  mergeMutationLane,
  previewPendingMutationState,
  withoutTextStaleReason,
} from './corpus/lanes.js';
import { INDEX_STATE_FILE, KbIndexStore, writeJsonAtomic, type StagedKbIndexArtifact } from './corpus/index/store.js';
import { writeFileAtomic } from './corpus/file-atomic.js';
import { readEntityGraphFile } from './corpus/entity-graph-store.js';
import { resolveCorpusStructuralKey, type CorpusStructuralKey } from './corpus/structural-key.js';
import { CorpusPublicationQueue } from './corpus/publication.js';
import { createCorpusStorage, type CorpusStorage } from './corpus/rescan/storage.js';
import { type EntityGraph, type KbIndex } from './entry-types.js';
import { createCorpusStateMirror } from './state/corpus-state.js';
import { createKbRuntimePaths, type KbRuntimePaths } from './paths.js';
import { KB_RUNTIME_AUTHORITY } from '../runtime/kb-runtime-authority.js';
import { createKbProjectionInput } from './projection-input.js';
import { EngineArtifactRegistry } from './corpus/artifact-registry.js';
import { createCorpusAuthorityBaselineStore } from './corpus/rescan/authority-baseline.js';
import type {
  CorpusAuthorityBaselineGeneration,
  CorpusAuthorityBaselineStore,
} from './corpus/authority-baseline-contract.js';
import { CorpusAuthorityBaselineRefresh } from './corpus/authority-baseline-refresh.js';
import { CorpusFreshnessService } from './corpus/freshness-service.js';
import { CorpusInboundSyncService } from './corpus/inbound-sync-service.js';
import { CorpusMutationFinalizer, type KbRuntimeMutationLockContext } from './corpus/mutation-finalizer.js';
import { CorpusPublicationService } from './corpus/publication-service.js';
import { buildCurrentCorpusSurface } from './corpus/surface.js';
import { readDeclaredKbAnalyzersFromEnv, type KbDeclaredAnalyzer } from './extra-langs.js';
import { GeneratedCommunityProjectionStore } from './curate/community/generated-projection-store.js';
import type {
  CorpusProjectionCandidate,
  CorpusProjectionCommitFaultPhase,
  CorpusProjectionCommitRecord,
  CorpusProjectionCommitResult,
  CorpusProjectionFaultInjection,
  StagedCorpusProjection,
} from './corpus/projection-lifecycle.js';

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
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
  ids: Pick<IdPort, 'uuid'>;
  envPort: EnvPort;
  storage: StoragePort;
  curateAssistant: CurateAssistantPort;
  processPort: ProcessPort;
  /** Defaults to {@link DEFAULT_MUTATION_LOCK_TIMEOUT_MS}; override for slow paths. */
  mutationLockTimeoutMs?: number;
  engineArtifactRegistry?: EngineArtifactRegistry;
  generatedCommunityProjectionCallbacks?: KbGeneratedCommunityProjectionCallbacks;
}

type KbRuntimeTimePort = Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'> &
  Partial<Pick<TimePort, 'sleep'>>;

const KB_MUTATION_DIRECTORY_LOCK_STALE_MIN_MS = 10 * 60 * 1000;
const KB_MUTATION_DIRECTORY_LOCK_STALE_PADDING_MS = 60_000;
const CORPUS_PROJECTION_DIR = KB_RUNTIME_AUTHORITY.corpusProjection;
const CORPUS_PROJECTION_COMMITS_DIR = 'commits';
const CORPUS_PROJECTION_COMMIT_FILE = 'commit.json';
const CORPUS_PROJECTION_COMMIT_SCHEMA_VERSION = 1;

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
  readonly generatedCommunityProjectionStore: GeneratedCommunityProjectionStore;
  readonly projectionArtifacts: KbProjectionArtifactPort;
  readonly corpusProjectionReader: KbRuntime['corpusProjectionReader'];
  private readonly paths: KbRuntimePaths;
  private readonly directoryMutationLockDir: string;
  private readonly mutationLockDefaultTimeoutMs: number;
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
  private readonly generatedCommunityProjectionCallbacks?: KbGeneratedCommunityProjectionCallbacks;

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
    generatedCommunityProjectionCallbacks,
  }: CreateKbRuntimeOptions) {
    this.markdownRoot = markdownRoot;
    this.version = version;
    this.runtimeDir = runtimeDir;
    this.db = db;
    this.time = time;
    this.directoryMutationLockDir = join(this.runtimeDir, KB_RUNTIME_AUTHORITY.mutationLock);
    this.mutationLockDefaultTimeoutMs = mutationLockTimeoutMs ?? DEFAULT_MUTATION_LOCK_TIMEOUT_MS;
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
    this.corpusAuthorityBaseline = createCorpusAuthorityBaselineStore(this.db, () => this.ids.uuid());
    this.generatedCommunityProjectionCallbacks = generatedCommunityProjectionCallbacks;
    this.generatedCommunityProjectionStore = new GeneratedCommunityProjectionStore({
      runtimeDir: this.runtimeDir,
      storage: this.storagePort,
      ids: this.ids,
      time: this.time,
    });
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
      prepareCurrentProjectionInput: async ({ signal, ensureFreshness = true, ...options } = {}) => {
        if (ensureFreshness) {
          await this.ensureCorpusFreshness({ wait: true, signal });
        }
        const activeGenerated = this.generatedCommunityProjectionStore.readActiveGeneration();
        return createKbProjectionInput(this, {
          ...options,
          generatedCommunityDocs: options.generatedCommunityDocs ?? activeGenerated.records,
          generatedCommunityGeneration:
            options.generatedCommunityGeneration ?? activeGenerated.generatedCommunityGeneration,
          generatedCommunityDocsHash: options.generatedCommunityDocsHash ?? activeGenerated.generatedCommunityDocsHash,
        });
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
      readGeneratedCommunityFreshness: () => this.generatedCommunityProjectionStore.readActiveFreshness(),
      readGeneratedCommunitySlugs: () => this.generatedCommunityProjectionStore.readActiveGeneratedSlugs(),
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
        defaultTimeoutMs: this.mutationLockDefaultTimeoutMs,
        time: this.time,
      },
    );
    this.freshnessService = new CorpusFreshnessService({
      indexStore: this.indexStore,
      getRuntime: () => this,
    });
    this.inboundSyncService = new CorpusInboundSyncService({
      indexStore: this.indexStore,
      manifestAuthority: this.manifestAuthority,
      mutationLockController: this.mutationLockController,
      withDirectoryMutationLock: (fn, options = {}) =>
        this.withDirectoryMutationLock(this.mutationLockDefaultTimeoutMs, fn, options),
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
        generatedCommunitySlugs: () => this.generatedCommunityProjectionStore.readActiveGeneratedSlugs(),
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
    this.manifestAuthority.adoptStagedSurfaceHashes(
      this.manifestAuthority.stageCurrentSurfaceHashes(buildCurrentCorpusSurface(this).manifest, 'boot'),
    );
    this.reconcileCorpusProjectionCommits();
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
      generatedCommunityFreshness: this.generatedCommunityProjectionStore.readActiveFreshness(),
      generatedCommunitySlugs: this.generatedCommunityProjectionStore.readActiveGeneratedSlugs(),
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

  publishGeneratedCommunityProjection(publication: KbGeneratedCommunityPublication): void {
    void Promise.resolve(
      this.generatedCommunityProjectionCallbacks?.notifyGeneratedCommunityProjection(publication),
    ).catch((error: unknown) => {
      backendLog.error('Generated community projection publication failed', error);
    });
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
    if (this.activeMutationContext !== null) {
      throw new Error('recordReindexSuccess cannot run while the mutation lock is held; stage and commit instead.');
    }
    const commitId = this.ids.uuid();
    const finalSurface = surface ?? buildCurrentCorpusSurface(this);
    const stagedManifestSurface = this.manifestAuthority.stageCurrentSurfaceHashes(finalSurface.manifest, commitId);
    const stagedBaseline = this.corpusAuthorityBaseline.stageReplacement(
      finalSurface.baselineRecords,
      `baseline-${commitId}`,
    );
    const state = this.readIndexState();
    if (!indexStateMatchesSnapshot(state, startState)) {
      this.corpusAuthorityBaseline.discardStagedGeneration(stagedBaseline.generationId);
      return state;
    }

    this.manifestAuthority.adoptStagedSurfaceHashes(stagedManifestSurface);
    this.corpusAuthorityBaseline.adoptStagedGeneration(stagedBaseline.generationId);
    const nextState = applyMutationLane(withoutTextStaleReason(state), externalMutation ?? null);
    this.writeIndexState(nextState);
    this.corpusAuthorityBaseline.cleanupInactiveGenerations();
    return nextState;
  }

  stageCorpusProjectionArtifacts(candidate: CorpusProjectionCandidate): StagedCorpusProjection {
    const commitId = this.ids.uuid();
    let stagedIndex: StagedKbIndexArtifact | null = null;
    let stagedBaseline: CorpusAuthorityBaselineGeneration | null = null;
    try {
      stagedIndex = this.indexStore.stageIndexArtifact(candidate.index, commitId);
      const stagedManifestSurface = this.manifestAuthority.stageCurrentSurfaceHashes(
        candidate.finalSurface.manifest,
        commitId,
      );
      stagedBaseline = this.corpusAuthorityBaseline.stageReplacement(
        candidate.finalSurface.baselineRecords,
        `baseline-${commitId}`,
      );
      return {
        commitId,
        candidate,
        stagedIndex,
        stagedManifestSurface,
        stagedBaseline,
      };
    } catch (error: unknown) {
      if (stagedIndex !== null) {
        this.indexStore.discardStagedIndexArtifact(stagedIndex);
      }
      if (stagedBaseline !== null) {
        this.corpusAuthorityBaseline.discardStagedGeneration(stagedBaseline.generationId);
      }
      throw error;
    }
  }

  async commitCorpusProjection(
    staged: StagedCorpusProjection,
    options: { faultInjection?: CorpusProjectionFaultInjection } = {},
  ): Promise<CorpusProjectionCommitResult> {
    const result = await this.withMutationLock(async () => {
      const state = this.readIndexState();
      const currentSeq = captureIndexStateSnapshot(state);
      if (!indexStateMatchesSnapshot(state, staged.candidate.startSeq)) {
        return {
          status: 'discarded' as const,
          commitId: staged.commitId,
          reason: 'stale_seq' as const,
          startSeq: staged.candidate.startSeq,
          currentSeq,
          priorGeneratedGeneration: staged.candidate.priorGeneratedGeneration,
          currentGeneratedGeneration:
            this.generatedCommunityProjectionStore.readActiveGeneration().generatedCommunityGeneration,
        };
      }

      const currentGeneratedGeneration =
        this.generatedCommunityProjectionStore.readActiveGeneration().generatedCommunityGeneration;
      if (currentGeneratedGeneration !== staged.candidate.priorGeneratedGeneration) {
        return {
          status: 'discarded' as const,
          commitId: staged.commitId,
          reason: 'stale_generated_generation' as const,
          startSeq: staged.candidate.startSeq,
          currentSeq,
          priorGeneratedGeneration: staged.candidate.priorGeneratedGeneration,
          currentGeneratedGeneration,
        };
      }

      const previousState = this.indexStore.readIndexStateIfPresent();
      const previousBaselineGenerationId = this.corpusAuthorityBaseline.readActiveGenerationId();
      const previousManifestCommitId = this.manifestAuthority.getCurrentSurfaceCommitId();
      const adoptedIndex = this.indexStore.prepareStagedIndexAdoption(staged.stagedIndex);
      const nextState = applyMutationLane(withoutTextStaleReason(state), staged.candidate.externalMutation ?? null);
      let record: CorpusProjectionCommitRecord = {
        schemaVersion: CORPUS_PROJECTION_COMMIT_SCHEMA_VERSION,
        commitId: staged.commitId,
        startSeq: staged.candidate.startSeq,
        previousState,
        nextState,
        stagedIndex: {
          stagingDir: staged.stagedIndex.stagingDir,
          indexPath: staged.stagedIndex.indexPath,
          previousIndexPath: adoptedIndex.previousIndexPath,
          hadPreviousIndex: adoptedIndex.hadPreviousIndex,
        },
        stagedBaselineGenerationId: staged.stagedBaseline.generationId,
        previousBaselineGenerationId,
        stagedManifestCommitId: staged.stagedManifestSurface.commitId,
        previousManifestCommitId,
        phase: 'pending',
      };
      this.writeCorpusProjectionCommitRecord(record);
      this.throwCorpusProjectionFault(options.faultInjection, 'pending');

      this.indexStore.adoptStagedIndexArtifact(staged.stagedIndex, adoptedIndex);
      this.throwCorpusProjectionFault(options.faultInjection, 'index_renamed');
      record = { ...record, phase: 'index_adopted' };
      this.writeCorpusProjectionCommitRecord(record);
      this.throwCorpusProjectionFault(options.faultInjection, 'index_adopted');

      this.corpusAuthorityBaseline.adoptStagedGeneration(staged.stagedBaseline.generationId);
      record = { ...record, phase: 'baseline_adopted' };
      this.writeCorpusProjectionCommitRecord(record);
      this.throwCorpusProjectionFault(options.faultInjection, 'baseline_adopted');

      this.manifestAuthority.adoptStagedSurfaceHashes(staged.stagedManifestSurface);
      record = { ...record, phase: 'manifest_adopted' };
      this.writeCorpusProjectionCommitRecord(record);
      this.throwCorpusProjectionFault(options.faultInjection, 'manifest_adopted');

      this.writeIndexState(nextState);
      this.throwCorpusProjectionFault(options.faultInjection, 'state_persisted');
      record = { ...record, phase: 'state_written' };
      this.writeCorpusProjectionCommitRecord(record);
      this.throwCorpusProjectionFault(options.faultInjection, 'state_written');

      this.assertCorpusProjectionSurfacesAgree(staged);
      record = { ...record, phase: 'committed' };
      this.writeCorpusProjectionCommitRecord(record);
      this.throwCorpusProjectionFault(options.faultInjection, 'committed');

      const snapshot = this.captureCorpusSnapshot();
      return {
        status: 'committed' as const,
        commitId: staged.commitId,
        counts: staged.candidate.counts,
        snapshot,
        state: nextState,
      };
    });

    if (result.status === 'discarded') {
      this.discardStagedCorpusProjection(staged);
      return result;
    }

    this.indexStore.cleanupIndexCommit(staged.commitId);
    this.storagePort.rmSync(this.corpusProjectionCommitDir(staged.commitId), { recursive: true, force: true });
    this.corpusAuthorityBaseline.cleanupInactiveGenerations();
    return result;
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
    const timeoutMs = options.timeoutMs ?? this.mutationLockDefaultTimeoutMs;
    return this.withDirectoryMutationLock(
      timeoutMs,
      () =>
        this.mutationLockController.withMutationLock(
          (_lockContext, args) => fn(this.mutationFinalizer.mutationEffects, args),
          options,
        ),
      { signal: options.signal },
    );
  }

  private async withDirectoryMutationLock<T>(
    timeoutMs: number,
    fn: () => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const releaseDirectoryLock = await acquireDirectoryLock(
      this.directoryMutationLockDir,
      {
        storage: this.storagePort,
        time: {
          now: () => this.time.now(),
          sleep: this.sleep.bind(this),
          ['setInterval']: this.time.setInterval.bind(this.time),
          ['clearInterval']: this.time.clearInterval.bind(this.time),
        },
        signal: options.signal,
        staleMs: Math.max(
          KB_MUTATION_DIRECTORY_LOCK_STALE_MIN_MS,
          timeoutMs * 2 + KB_MUTATION_DIRECTORY_LOCK_STALE_PADDING_MS,
        ),
      },
      timeoutMs,
    );
    try {
      return await fn();
    } finally {
      releaseDirectoryLock();
    }
  }

  private reconcileCorpusProjectionCommits(): void {
    let commitIds: string[];
    try {
      commitIds = this.storagePort.readdirSync(this.corpusProjectionCommitRoot());
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        this.indexStore.cleanupIndexStaging();
        return;
      }
      throw error;
    }

    for (const commitId of commitIds) {
      const record = this.readCorpusProjectionCommitRecord(commitId);
      if (record === null) {
        this.storagePort.rmSync(this.corpusProjectionCommitDir(commitId), { recursive: true, force: true });
        this.indexStore.cleanupIndexCommit(commitId);
        this.corpusAuthorityBaseline.cleanupInactiveGenerations();
        continue;
      }

      if (this.corpusProjectionStateReachedCommitPoint(record)) {
        this.finishCommittedCorpusProjectionRecord(record);
      } else {
        this.rollbackPendingCorpusProjectionRecord(record);
      }
    }

    this.indexStore.cleanupIndexStaging();
  }

  private finishCommittedCorpusProjectionRecord(record: CorpusProjectionCommitRecord): void {
    if (this.corpusAuthorityBaseline.readActiveGenerationId() !== record.stagedBaselineGenerationId) {
      this.corpusAuthorityBaseline.adoptStagedGeneration(record.stagedBaselineGenerationId);
    }
    this.adoptCorpusProjectionManifestCommit(record.commitId);
    this.writeCorpusProjectionCommitRecord({ ...record, phase: 'committed' });
    this.indexStore.cleanupIndexCommit(record.commitId);
    this.storagePort.rmSync(this.corpusProjectionCommitDir(record.commitId), { recursive: true, force: true });
    this.corpusAuthorityBaseline.cleanupInactiveGenerations();
  }

  private rollbackPendingCorpusProjectionRecord(record: CorpusProjectionCommitRecord): void {
    this.indexStore.rollbackAdoptedIndexArtifact({
      previousIndexPath: record.stagedIndex.previousIndexPath,
      hadPreviousIndex: record.stagedIndex.hadPreviousIndex,
    });
    this.storagePort.rmSync(record.stagedIndex.stagingDir, { recursive: true, force: true });

    if (this.corpusAuthorityBaseline.readActiveGenerationId() !== record.previousBaselineGenerationId) {
      this.corpusAuthorityBaseline.adoptStagedGeneration(record.previousBaselineGenerationId);
    }
    this.restoreCorpusProjectionManifestCommit(record.previousManifestCommitId);
    this.restoreCorpusProjectionIndexState(record.previousState);
    this.corpusAuthorityBaseline.discardStagedGeneration(record.stagedBaselineGenerationId);
    this.writeCorpusProjectionCommitRecord({ ...record, phase: 'rolled_back' });
    this.indexStore.cleanupIndexCommit(record.commitId);
    this.storagePort.rmSync(this.corpusProjectionCommitDir(record.commitId), { recursive: true, force: true });
  }

  private discardStagedCorpusProjection(staged: StagedCorpusProjection): void {
    this.indexStore.discardStagedIndexArtifact(staged.stagedIndex);
    this.corpusAuthorityBaseline.discardStagedGeneration(staged.stagedBaseline.generationId);
  }

  private assertCorpusProjectionSurfacesAgree(staged: StagedCorpusProjection): void {
    if (this.corpusAuthorityBaseline.readActiveGenerationId() !== staged.stagedBaseline.generationId) {
      throw new Error('Corpus projection commit baseline generation did not adopt.');
    }
    if (this.manifestAuthority.getCurrentSurfaceCommitId() !== staged.commitId) {
      throw new Error('Corpus projection commit manifest surface did not adopt.');
    }
  }

  private writeCorpusProjectionCommitRecord(record: CorpusProjectionCommitRecord): void {
    writeJsonAtomic(this, this.corpusProjectionCommitRecordPath(record.commitId), record);
  }

  private readCorpusProjectionCommitRecord(commitId: string): CorpusProjectionCommitRecord | null {
    try {
      const parsed = JSON.parse(
        this.storagePort.readFileSync(this.corpusProjectionCommitRecordPath(commitId), 'utf-8'),
      ) as unknown;
      return isCorpusProjectionCommitRecord(parsed) ? parsed : null;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      throw error;
    }
  }

  private corpusProjectionCommitRoot(): string {
    return join(this.runtimeDir, CORPUS_PROJECTION_DIR, CORPUS_PROJECTION_COMMITS_DIR);
  }

  private corpusProjectionCommitDir(commitId: string): string {
    return join(this.corpusProjectionCommitRoot(), commitId);
  }

  private corpusProjectionCommitRecordPath(commitId: string): string {
    return join(this.corpusProjectionCommitDir(commitId), CORPUS_PROJECTION_COMMIT_FILE);
  }

  private corpusProjectionStateReachedCommitPoint(record: CorpusProjectionCommitRecord): boolean {
    return record.phase === 'state_written' || record.phase === 'committed';
  }

  private adoptCorpusProjectionManifestCommit(commitId: string): void {
    if (this.manifestAuthority.getCurrentSurfaceCommitId() === commitId) {
      return;
    }
    const stagedManifest = this.manifestAuthority.stageCurrentSurfaceHashes(
      buildCurrentCorpusSurface(this).manifest,
      commitId,
    );
    this.manifestAuthority.adoptStagedSurfaceHashes(stagedManifest);
  }

  private restoreCorpusProjectionManifestCommit(commitId: string | null): void {
    if (this.manifestAuthority.getCurrentSurfaceCommitId() === commitId) {
      return;
    }
    const surface = buildCurrentCorpusSurface(this).manifest;
    if (commitId === null) {
      this.manifestAuthority.replaceCurrentSurfaceHashes(surface);
      return;
    }
    const stagedManifest = this.manifestAuthority.stageCurrentSurfaceHashes(surface, commitId);
    this.manifestAuthority.adoptStagedSurfaceHashes(stagedManifest);
  }

  private restoreCorpusProjectionIndexState(previousState: KbIndexState | null): void {
    const currentState = this.indexStore.readIndexStateIfPresent();
    if (corpusProjectionIndexStatesEqual(currentState, previousState)) {
      return;
    }
    if (previousState === null) {
      this.storagePort.rmSync(join(this.runtimeDir, INDEX_STATE_FILE), { force: true });
      return;
    }
    this.writeIndexState(previousState);
  }

  private throwCorpusProjectionFault(
    faultInjection: CorpusProjectionFaultInjection | undefined,
    phase: CorpusProjectionCommitFaultPhase,
  ): void {
    if (faultInjection?.failAfterPhase === phase) {
      throw new Error(`Injected corpus projection commit fault after ${phase}.`);
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

function isCorpusProjectionSeq(value: unknown): value is Pick<KbIndexState, 'contentSeq' | 'metadataSeq'> {
  return (
    isRecord(value) &&
    typeof value.contentSeq === 'number' &&
    Number.isInteger(value.contentSeq) &&
    value.contentSeq >= 0 &&
    typeof value.metadataSeq === 'number' &&
    Number.isInteger(value.metadataSeq) &&
    value.metadataSeq >= 0
  );
}

function isCorpusProjectionIndexState(value: unknown): value is KbIndexState {
  if (!isCorpusProjectionSeq(value)) {
    return false;
  }
  const textStaleReason = (value as { textStaleReason?: unknown }).textStaleReason;
  return textStaleReason === undefined || typeof textStaleReason === 'string';
}

function isCorpusProjectionCommitPhase(value: unknown): value is CorpusProjectionCommitRecord['phase'] {
  return (
    value === 'pending' ||
    value === 'index_adopted' ||
    value === 'baseline_adopted' ||
    value === 'manifest_adopted' ||
    value === 'state_written' ||
    value === 'committed' ||
    value === 'rolled_back'
  );
}

function isCorpusProjectionCommitRecord(value: unknown): value is CorpusProjectionCommitRecord {
  if (!isRecord(value) || value.schemaVersion !== CORPUS_PROJECTION_COMMIT_SCHEMA_VERSION) {
    return false;
  }
  if (
    typeof value.commitId !== 'string' ||
    !isCorpusProjectionSeq(value.startSeq) ||
    !(value.previousState === null || isCorpusProjectionIndexState(value.previousState)) ||
    !(value.nextState === null || isCorpusProjectionIndexState(value.nextState)) ||
    typeof value.stagedBaselineGenerationId !== 'string' ||
    typeof value.previousBaselineGenerationId !== 'string' ||
    typeof value.stagedManifestCommitId !== 'string' ||
    !(value.previousManifestCommitId === null || typeof value.previousManifestCommitId === 'string') ||
    !isCorpusProjectionCommitPhase(value.phase) ||
    !isRecord(value.stagedIndex)
  ) {
    return false;
  }
  return (
    typeof value.stagedIndex.stagingDir === 'string' &&
    typeof value.stagedIndex.indexPath === 'string' &&
    typeof value.stagedIndex.previousIndexPath === 'string' &&
    typeof value.stagedIndex.hadPreviousIndex === 'boolean'
  );
}

function corpusProjectionIndexStatesEqual(left: KbIndexState | null, right: KbIndexState | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    (left.textStaleReason ?? null) === (right.textStaleReason ?? null)
  );
}

export function createKbRuntime(opts: CreateKbRuntimeOptions): KbRuntime {
  return new KbRuntimeImpl(opts);
}
