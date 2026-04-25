import { mkdirSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import type { CorpusSnapshot } from './corpus/snapshot.js';
import type {
  CorpusConsumerRegistration,
  KbInboundSyncOptions,
  KbCachedOramaIndex,
  KbCorpusPublishCallbacks,
  KbCorpusPublication,
  KbCorpusSnapshot,
  KbIndexMutationLane,
  KbIndexState,
  KbMutationEffects,
  KbRuntimeActivationSnapshot,
  KbRuntime,
} from './contracts.js';
import {
  createKbMutationLock,
  type KbMutationLockContext,
  type KbMutationLockOptions,
} from './corpus/mutation-lock.js';
import {
  captureEntityGraphManifestDelta,
  createManifestAuthority,
} from './corpus/manifest-authority.js';
import type { ManifestAuthorityDelta } from './corpus/manifest-types.js';
import { cloneKbIndex } from './corpus/index-records.js';
import { createOramaDb } from './orama-factory.js';
import type { KbOramaDb, KbOramaTokenizer } from './orama-schema.js';
import { detectTextArtifactRebuildInfo, rebuildTextArtifactsAndPersistRepairState } from './curate/text-artifacts.js';
import {
  type EntityGraph,
  type KbIndex,
} from './entry-types.js';
import { createOramaBaseProjection } from './search/orama-backend.js';
import { createCorpusStateMirror } from './runtime-state.js';
import type { TextRetrieval, VectorRetrieval } from './search/contract.js';
import {
  applyMutationLane,
  captureIndexStateSnapshot,
  indexStateMatchesSnapshot,
  mergeMutationLane,
  mutationLanesFromDiff,
  withoutTextStaleReason,
  type KbIndexStateSnapshot,
} from './corpus/lanes.js';
import {
  emptyIndex,
  isFreshTextSnapshot,
  KbIndexStore,
} from './corpus/index-store.js';
import { readEntityGraphFile, writeEntityGraphFile } from './corpus/entity-graph-store.js';
import { CorpusPublicationQueue, mergePublication } from './corpus/publication.js';
import { OramaSnapshotStore } from './search/orama-snapshot.js';
import {
  captureCorpusFilesystemSnapshot,
  detectInboundSyncMutation,
  detectInboundSyncMutationFromFullCollectors,
  detectInboundSyncMutationFromStructuredDiff,
  isGitSyncResult,
  type InboundSyncMutationDiff,
} from './corpus/inbound-sync.js';
import { createKbRuntimePaths, type KbRuntimePaths } from './runtime-paths.js';
import { pendingRepairNeedsRetry } from './runtime-pending-repair.js';
import { buildInboundSyncIndexDelta } from './runtime-inbound-index.js';
import {
  buildCurrentCorpusSnapshot as buildRuntimeCorpusSnapshot,
  emptyRuntimeActivationSnapshot,
} from './runtime-snapshot.js';
import { commitMutationState, previewPendingMutationState } from './runtime-mutation-state.js';

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
  getEquipmentView?: () => KbRuntimeActivationSnapshot | null;
  readOnlyOrama?: boolean;
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: BetterSqlite3.Database;
  private readonly readOnlyOrama: boolean;
  private readonly paths: KbRuntimePaths;
  private readonly manifestAuthority = createManifestAuthority();
  private readonly indexStore: KbIndexStore;
  private readonly oramaSnapshotStore: OramaSnapshotStore;

  private mutationLock: Promise<void> = Promise.resolve();
  private readonly baseProjection = createOramaBaseProjection(this);
  private readonly corpusStateMirror: ReturnType<typeof createCorpusStateMirror>;
  private readonly publicationQueue: CorpusPublicationQueue;
  private readonly equipmentViewResolver?: () => KbRuntimeActivationSnapshot | null;
  private readonly emptyEquipmentView: KbRuntimeActivationSnapshot;
  private activeMutationContext: MutationLockContext | null = null;
  private readonly mutationEffects: KbMutationEffects = {
    queueManifestAuthorityDelta: (deltas) => {
      this.queueManifestAuthorityDelta(deltas);
    },
    writeEntityGraph: (graph) => {
      this.writeEntityGraphLocked(graph);
    },
  };
  private readonly mutationLockController = createKbMutationLock<
    KbIndex,
    KbCorpusPublication,
    KbIndexMutationLane,
    ManifestAuthorityDelta
  >({
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
  });

  constructor({ markdownRoot, runtimeDir, db, corpusPublishCallbacks, getEquipmentView, readOnlyOrama }: CreateKbRuntimeOptions) {
    this.markdownRoot = markdownRoot;
    this.runtimeDir = runtimeDir;
    this.db = db;
    this.readOnlyOrama = readOnlyOrama === true;
    this.paths = createKbRuntimePaths(this.markdownRoot, this.runtimeDir);
    this.corpusStateMirror = createCorpusStateMirror(this.db);
    this.oramaSnapshotStore = new OramaSnapshotStore(this.runtimeDir);
    this.indexStore = new KbIndexStore({
      runtimeDir: this.runtimeDir,
      onStateChange: (previous, next) => {
        this.capturePublicationFromStateChange(previous, next);
      },
      onIndexCorruption: () => {
        this.oramaSnapshotStore.clear();
      },
    });
    this.publicationQueue = new CorpusPublicationQueue({
      readCorpusStateSnapshot: () => this.getCorpusStateSnapshot(),
      invalidateCorpusStateSnapshot: () => {
        this.invalidateCorpusStateSnapshot();
      },
    });
    this.equipmentViewResolver = getEquipmentView;
    this.emptyEquipmentView = Object.freeze(emptyRuntimeActivationSnapshot(this.baseProjection));

    mkdirSync(this.runtimeDir, { recursive: true });

    if (corpusPublishCallbacks !== undefined) {
      this.register(corpusPublishCallbacks);
    }

    this.manifestAuthority.seedFromFullCollectors(this);
  }

  getEquipmentView(): KbRuntimeActivationSnapshot {
    return this.equipmentViewResolver?.() ?? this.emptyEquipmentView;
  }

  getActiveVectorSurface(): VectorRetrieval {
    return this.getEquipmentView().retrieval;
  }

  getBaseRetrievalSurface(): TextRetrieval & VectorRetrieval & CorpusConsumerRegistration {
    return this.baseProjection;
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
    return readEntityGraphFile(this.entityGraphPath());
  }

  async writeEntityGraph(graph: EntityGraph): Promise<void> {
    await this.withMutationLock((mutation) => {
      mutation.writeEntityGraph(graph);
    });
  }

  private writeEntityGraphLocked(graph: EntityGraph): void {
    const { normalized, raw } = writeEntityGraphFile(this.entityGraphPath(), graph);
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
      this.activeMutationContext.pendingMutationLane = mergeMutationLane(this.activeMutationContext.pendingMutationLane, lane);
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

  async ensureIndex(): Promise<KbIndex> {
    if (this.textArtifactsNeedRebuild()) {
      await this.withMutationLock(async (mutation) => {
        const state = this.readIndexStateIfPresent();
        if (!this.textArtifactsNeedRebuild(state)) {
          return;
        }

        await rebuildTextArtifactsAndPersistRepairState(this, mutation, captureIndexStateSnapshot(state));
      });
    }

    return this.readIndex() ?? emptyIndex();
  }

  async ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }> {
    const state = this.readIndexStateIfPresent();
    const cachedOramaIndex = this.oramaSnapshotStore.getCache();
    if (!this.textArtifactsNeedRebuild(state) && cachedOramaIndex !== null && this.indexStore.hasIndexCache()) {
      return {
        ...cachedOramaIndex,
        index: this.readIndex() ?? emptyIndex(),
      };
    }

    const loaded = await this.ensureOramaIndexReadOnly();
    if (this.textArtifactsNeedRebuild(state)) {
      return {
        ...loaded,
        index: emptyIndex(),
        warnings: ['orama_snapshot_stale'],
      };
    }

    return loaded;
  }

  async loadOramaSnapshotIfPresent(): Promise<KbCachedOramaIndex | null> {
    return this.oramaSnapshotStore.loadIfPresent();
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

  async runInboundSync<T>(
    fn: () => Promise<T> | T,
    options: KbInboundSyncOptions = {},
  ): Promise<T> {
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
    return buildInboundSyncIndexDelta(this.activeMutationContext?.startIndex ?? this.readIndex(), changedEntryIds, this);
  }

  private buildCurrentCorpusSnapshot(state: KbIndexStateSnapshot): CorpusSnapshot {
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
    this.oramaSnapshotStore.clear();
  }

  invalidateTextSnapshot(reason: string): KbIndexState {
    const nextState = this.recordIndexSyncFailure(reason);
    this.oramaSnapshotStore.clear();
    this.oramaSnapshotStore.removeSnapshot();
    return nextState;
  }

  installRebuiltArtifacts(index: KbIndex, orama: KbCachedOramaIndex): KbIndex {
    const normalized = this.indexStore.installIndexCache(index);
    this.oramaSnapshotStore.install(orama);
    return normalized;
  }

  persistOramaSnapshot(db: KbOramaDb): void {
    this.oramaSnapshotStore.persist(db);
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

  private async ensureOramaIndexReadOnly(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }> {
    const cachedOramaIndex = this.oramaSnapshotStore.getCache();
    if (cachedOramaIndex !== null) {
      return {
        ...cachedOramaIndex,
        index: this.readIndex() ?? emptyIndex(),
      };
    }

    try {
      const loaded = await this.oramaSnapshotStore.load();
      this.oramaSnapshotStore.install(loaded);
      return {
        ...loaded,
        index: this.readIndex() ?? emptyIndex(),
      };
    } catch {
      const { db, tokenizer } = await createOramaDb();
      return {
        db,
        tokenizer,
        index: emptyIndex(),
        warnings: ['orama_snapshot_absent'],
      };
    }
  }

  private indexNeedsRebuild(): boolean {
    return detectTextArtifactRebuildInfo(this).needsRebuild;
  }

  private textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? this.readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || this.indexNeedsRebuild() || pendingRepairNeedsRetry(this);
  }

}

export function createKbRuntime(opts: CreateKbRuntimeOptions): KbRuntime {
  return new KbRuntimeImpl(opts);
}
