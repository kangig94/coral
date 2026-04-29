import type BetterSqlite3 from 'better-sqlite3';
import { createRuntimeBinding } from '../runtime/binding.js';
import type { EnvPort, IdPort, ProcessPort, StoragePort, TimePort } from '../runtime/ports.js';
import type { SpawnCliFn } from './curate/pipeline-types.js';
import type {
  Backed,
  EmbeddingService,
  EnsureCorpusFreshnessOptions,
  FtsRetrieval,
  KbInboundSyncOptions,
  KbCorpusPublishCallbacks,
  KbCorpusPublication,
  KbCorpusSnapshot,
  KbIndexMutationLane,
  KbIndexState,
  KbMutationEffects,
  KbRuntime,
  VectorRetrieval,
} from './contract.js';
import {
  createKbMutationLock,
  DEFAULT_MUTATION_LOCK_TIMEOUT_MS,
  type KbMutationLockContext,
  type KbMutationLockOptions,
} from './corpus/mutation-lock.js';
import { captureEntityGraphManifestDelta, createManifestAuthority } from './corpus/manifest-authority.js';
import type { ManifestAuthorityDelta } from './corpus/manifest-types.js';
import { cloneKbIndex } from './corpus/index-records.js';
import { detectRescanInfo } from './corpus/rescan/drift.js';
import { performRescan } from './corpus/rescan/index.js';
import { createCorpusStorage, type CorpusStorage } from './corpus/rescan/storage.js';
import { type EntityGraph, type KbIndex } from './entry-types.js';
import { createCorpusStateMirror } from './state/corpus-state.js';
import {
  applyMutationLane,
  captureIndexStateSnapshot,
  commitMutationState,
  indexStateMatchesSnapshot,
  mergeMutationLane,
  mutationLanesFromDiff,
  previewPendingMutationState,
  withoutTextStaleReason,
  type KbIndexStateSnapshot,
} from './corpus/lanes.js';
import { emptyIndex, isFreshTextSnapshot, KbIndexStore } from './corpus/index-store.js';
import { readEntityGraphFile, writeEntityGraphFile } from './corpus/entity-graph-store.js';
import { CorpusPublicationQueue, mergePublication } from './corpus/publication.js';
import {
  buildInboundSyncIndexDelta,
  captureCorpusFilesystemSnapshot,
  detectInboundSyncMutation,
  detectInboundSyncMutationFromFullCollectors,
  detectInboundSyncMutationFromStructuredDiff,
  isGitSyncResult,
  type InboundSyncMutationDiff,
} from './corpus/inbound-sync.js';
import { createKbRuntimePaths, type KbRuntimePaths } from './paths.js';
import { buildCorpusScanView } from './corpus/rescan/scan.js';
import { buildCurrentCorpusSnapshot as buildRuntimeCorpusSnapshot } from './state/corpus-snapshot-builder.js';

type MutationLockContext = KbMutationLockContext<
  KbIndex,
  KbCorpusPublication,
  KbIndexMutationLane,
  ManifestAuthorityDelta
>;

export interface CreateKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
  db: BetterSqlite3.Database;
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
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: BetterSqlite3.Database;
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
  private readonly paths: KbRuntimePaths;
  private readonly manifestAuthority = createManifestAuthority();
  private readonly indexStore: KbIndexStore;

  private mutationLock: Promise<void> = Promise.resolve();
  private readonly corpusStateMirror: ReturnType<typeof createCorpusStateMirror>;
  private readonly publicationQueue: CorpusPublicationQueue;
  private activeMutationContext: MutationLockContext | null = null;
  /**
   * Single shared rebuild promise. `wait: true` callers await it; `wait: false`
   * callers fire-and-forget. Cleared in `.finally()` so the next staleness
   * detection can dispatch a fresh rebuild.
   */
  private rebuildInFlight: Promise<void> | null = null;
  private readonly mutationEffects: KbMutationEffects = {
    queueManifestAuthorityDelta: (deltas) => {
      this.queueManifestAuthorityDelta(deltas);
    },
    writeEntityGraph: (graph) => {
      this.writeEntityGraphLocked(graph);
    },
  };
  private readonly mutationLockController: ReturnType<
    typeof createKbMutationLock<KbIndex, KbCorpusPublication, KbIndexMutationLane, ManifestAuthorityDelta>
  >;

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
    this.corpusStateMirror = createCorpusStateMirror(this.db);
    this.indexStore = new KbIndexStore({
      runtimeDir: this.runtimeDir,
      storage,
      ids,
      onStateChange: (previous, next) => {
        this.capturePublicationFromStateChange(previous, next);
      },
    });
    this.publicationQueue = new CorpusPublicationQueue({
      readCorpusStateSnapshot: () => this.getCorpusStateSnapshot(),
      invalidateCorpusStateSnapshot: () => {
        this.invalidateCorpusStateSnapshot();
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
          this.finalizePendingMutation(context);
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

    storage.mkdirSync(this.runtimeDir, { recursive: true });

    if (corpusPublishCallbacks !== undefined) {
      this.register(corpusPublishCallbacks);
    }

    this.manifestAuthority.seedFromFullCollectors(this);
  }

  notesDir(): string {
    return this.paths.notesDir();
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

  async writeEntityGraph(graph: EntityGraph): Promise<void> {
    await this.withMutationLock((mutation) => {
      mutation.writeEntityGraph(graph);
    });
  }

  private writeEntityGraphLocked(graph: EntityGraph): void {
    const { normalized, raw } = writeEntityGraphFile(this, this.entityGraphPath(), graph);
    this.queueManifestAuthorityDelta(captureEntityGraphManifestDelta(raw));
    this.recordMutationCommitted('metadata', 'KB entity graph changed.');

    const currentIndex = this.readIndex();
    if (currentIndex !== null) {
      const nextIndex = cloneKbIndex(currentIndex);
      nextIndex.entityMeta = normalized.entityMeta;
      nextIndex.relationships = normalized.relationships;
      this.writeIndex(nextIndex);
    }
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
    this.publicationQueue.register(corpusPublishCallbacks);
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
    this.refreshIndexBaselineIfPresent();
    return nextState;
  }

  recordIndexSyncSuccess(): KbIndexState {
    const state = this.readIndexState();
    const nextState = {
      contentSeq: state.contentSeq,
      metadataSeq: state.metadataSeq,
    };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordIndexSyncFailure(reason: string): KbIndexState {
    const state = this.readIndexState();
    const nextState = {
      contentSeq: state.contentSeq,
      metadataSeq: state.metadataSeq,
      textStaleReason: reason,
    };
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
    return nextState;
  }

  getCorpusStateSnapshot(): KbCorpusSnapshot {
    return this.corpusStateMirror.get();
  }

  invalidateCorpusStateSnapshot(): void {
    this.corpusStateMirror.invalidate();
  }

  async ensureCorpusFreshness(options: EnsureCorpusFreshnessOptions = {}): Promise<KbIndex> {
    const wait = options.wait ?? false;
    const signal = options.signal;

    if (this.textArtifactsNeedRebuild()) {
      // Shutdown drained the runtime — do not kick a fresh background rebuild
      // and do not block readiness callers. Boot's `wait: true` on the next
      // coordinator picks up the staleness.
      if (signal?.aborted !== true) {
        this.rebuildInFlight ??= this.runRebuildOnce().finally(() => {
          this.rebuildInFlight = null;
        });

        if (wait) {
          await this.rebuildInFlight;
        }
      } else if (wait) {
        throw new Error('ensureCorpusFreshness aborted before rebuild started.');
      }
    }

    return this.readIndex() ?? emptyIndex();
  }

  private async runRebuildOnce(): Promise<void> {
    await this.withMutationLock(async (mutation) => {
      const state = this.readIndexStateIfPresent();
      if (!this.textArtifactsNeedRebuild(state)) {
        return;
      }

      await performRescan(this, mutation, captureIndexStateSnapshot(state));
    });
  }

  async withMutationLock<T>(
    fn: (mutation: KbMutationEffects) => Promise<T> | T,
    options: KbMutationLockOptions = {},
  ): Promise<T> {
    return this.mutationLockController.withMutationLock(() => fn(this.mutationEffects), options);
  }

  async retryPendingCorpusPublication(): Promise<void> {
    this.publishCurrentSnapshot();
    if (!this.publicationQueue.hasQueuedPublications()) {
      return;
    }

    await this.publicationQueue.process();
  }

  async runInboundSync<T>(fn: () => Promise<T> | T, options: KbInboundSyncOptions = {}): Promise<T> {
    let mutationDiff: InboundSyncMutationDiff | null = null;

    return this.withMutationLock(async () => {
      const beforeSnapshot = options.structuredDiff === true ? null : captureCorpusFilesystemSnapshot(this);
      const result = await fn();

      if (options.structuredDiff === true && isGitSyncResult(result)) {
        if (result.kind === 'ambiguous') {
          mutationDiff = detectInboundSyncMutationFromFullCollectors(this, this.manifestAuthority, true);
        } else if (result.kind === 'paths') {
          mutationDiff = detectInboundSyncMutationFromStructuredDiff(result.changes, this, this.manifestAuthority);
        } else {
          mutationDiff = {
            lane: null,
            changedEntryIds: [],
            requiresFullInstall: false,
            manifestDeltas: [],
          };
        }
      } else {
        mutationDiff = detectInboundSyncMutation(
          beforeSnapshot ?? captureCorpusFilesystemSnapshot(this),
          captureCorpusFilesystemSnapshot(this),
        );
        if (mutationDiff.lane !== null) {
          // Full manifest refresh for inbound sync callers that cannot provide structured path changes.
          this.manifestAuthority.seedFromFullCollectors(this);
        }
      }

      if (mutationDiff.lane !== null) {
        if (mutationDiff.manifestDeltas.length > 0) {
          this.mutationEffects.queueManifestAuthorityDelta(mutationDiff.manifestDeltas);
        }
        if (!mutationDiff.requiresFullInstall && mutationDiff.changedEntryIds.length > 0) {
          this.writeIndex(this.buildInboundSyncIndexDelta(mutationDiff.changedEntryIds));
        } else if (mutationDiff.requiresFullInstall) {
          this.invalidateKbCache();
        }
        this.recordMutationCommitted(mutationDiff.lane, 'KB text snapshot is stale after inbound git sync.');
      }
      return result;
    });
  }

  captureCorpusSnapshot(): KbCorpusPublication['snapshot'] {
    return this.buildCurrentCorpusSnapshot(captureIndexStateSnapshot(this.readIndexState()));
  }

  private buildInboundSyncIndexDelta(changedEntryIds: readonly string[]): KbIndex {
    return buildInboundSyncIndexDelta(
      this.activeMutationContext?.startIndex ?? this.readIndex(),
      changedEntryIds,
      this,
    );
  }

  private buildCurrentCorpusSnapshot(state: KbIndexStateSnapshot): KbCorpusSnapshot {
    return buildRuntimeCorpusSnapshot(state, this.manifestAuthority);
  }

  private queueManifestAuthorityDelta(deltas: readonly ManifestAuthorityDelta[]): void {
    if (this.activeMutationContext === null) {
      throw new Error('KB manifest authority deltas can only be queued while the mutation lock is held.');
    }

    this.activeMutationContext.pendingOpaqueDeltas.push(...deltas);
  }

  private applyPendingManifestAuthorityDeltas(lockContext: MutationLockContext): void {
    if (lockContext.pendingOpaqueDeltas.length === 0) {
      return;
    }

    this.manifestAuthority.updateFromDelta(lockContext.pendingOpaqueDeltas);
  }

  invalidateKbCache(): void {
    this.indexStore.invalidateIndexCache();
  }

  invalidateTextSnapshot(reason: string): KbIndexState {
    return this.recordIndexSyncFailure(reason);
  }

  private publishCurrentSnapshot(): void {
    const stateSnapshot = captureIndexStateSnapshot(this.readIndexStateIfPresent());
    if (stateSnapshot.contentSeq === 0 && stateSnapshot.metadataSeq === 0) {
      return;
    }

    this.publicationQueue.enqueue({
      snapshot: this.buildCurrentCorpusSnapshot(stateSnapshot),
      changedLanes: ['content', 'metadata'],
    });
  }

  private refreshIndexBaselineIfPresent(): void {
    const currentIndex = this.readIndex();
    if (currentIndex === null) {
      return;
    }

    this.persistIndexToDisk(currentIndex);
  }

  private finalizePendingMutation(lockContext: MutationLockContext): void {
    this.applyPendingManifestAuthorityDeltas(lockContext);
    if (lockContext.pendingMutationLane === null) {
      return;
    }

    const nextState = previewPendingMutationState(this.readIndexState(), lockContext);
    this.writeIndexState(nextState);
    this.refreshIndexBaselineIfPresent();
  }

  private capturePublicationFromStateChange(previous: KbIndexStateSnapshot, next: KbIndexStateSnapshot): void {
    if (this.activeMutationContext === null) {
      return;
    }

    const changedLanes = mutationLanesFromDiff(previous, next);
    if (changedLanes.length === 0) {
      return;
    }

    this.activeMutationContext.publication = mergePublication(this.activeMutationContext.publication, {
      snapshot: this.buildCurrentCorpusSnapshot(next),
      changedLanes,
    });
  }

  private indexNeedsRebuild(): boolean {
    return detectRescanInfo(this, buildCorpusScanView(this)).needsRebuild;
  }

  private textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? this.readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || this.indexNeedsRebuild();
  }
}

export function createKbRuntime(opts: CreateKbRuntimeOptions): KbRuntime {
  return new KbRuntimeImpl(opts);
}
