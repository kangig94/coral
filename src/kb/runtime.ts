import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { errorMessage } from '../infra/error-format.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { readPendingRepairRows, type PendingRepairRetryCandidate } from './curate/retry.js';
import { deriveStableCorpusSnapshotId, type CorpusSnapshot } from './corpus/snapshot.js';
import type {
  KbInboundSyncOptions,
  KbCachedOramaIndex,
  KbCorpusLane,
  KbCorpusPublishCallbacks,
  KbCorpusPublication,
  KbCorpusSnapshot,
  KbIndexMutationLane,
  KbIndexState,
  KbRuntimeActivationSnapshot,
  KbRuntime,
  KbTextArtifactsSnapshot,
} from './contracts.js';
import {
  INBOUND_SYNC_ORAMA_DELTA_THRESHOLD,
  createKbMutationLock,
  type KbMutationLockContext,
  type KbMutationLockOptions,
} from './corpus/mutation-lock.js';
import {
  captureEntityGraphManifestDelta,
  createManifestAuthority,
  type ManifestAuthorityDelta,
  type ManifestAuthorityLane,
} from './corpus/manifest-authority.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex } from './corpus/index-records.js';
import { createOramaDb } from './orama-factory.js';
import type { KbOramaDb, KbOramaTokenizer } from './orama-schema.js';
import {
  communityPathFromName,
  communitiesDir as pathsCommunitiesDir,
  notePathFromName,
  notesDir as pathsNotesDir,
  oramaSnapshotDir,
  principlePathFromName,
  principlesDir as pathsPrinciplesDir,
  sourceImportStageDir as pathsSourceImportStageDir,
  sourcePathFromName,
  sourcesDir as pathsSourcesDir,
} from './paths.js';
import { detectTextArtifactRebuildInfo, rebuildTextArtifactsAndPersistRepairState } from './curate/text-artifacts.js';
import {
  type EntityGraph,
  type KbIndex,
} from './entry-types.js';
import { createOramaBaseProjection } from './search/orama-backend.js';
import {
  captureTextArtifactsSnapshot,
  textArtifactsSnapshotFromRebuildResult,
} from './search/text-artifacts-snapshot.js';
import { diffSearchVisibleEntryIds } from './search/visible-entry-diff.js';
import { createCorpusStateMirror } from './runtime-state.js';
import { loadKbNote, loadKbSource } from './read.js';
import { createStandaloneKbDb } from './runtime-db.js';
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

export const KB_ENTRYSEQ_MIGRATION_VERSION = 1;

type MutationLockContext = KbMutationLockContext<
  KbIndex,
  KbCorpusPublication,
  KbIndexMutationLane,
  ManifestAuthorityDelta
>;

export interface CreateKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
  db?: BetterSqlite3.Database;
  corpusPublishCallbacks?: KbCorpusPublishCallbacks;
  getEquipmentView?: () => KbRuntimeActivationSnapshot | null;
  readOnlyOrama?: boolean;
}

function emptySnapshot(retrieval: VectorRetrieval): KbRuntimeActivationSnapshot {
  return {
    retrieval,
    snapshotId: null,
    contentSeq: 0,
    contentManifestHash: null,
  };
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: BetterSqlite3.Database;
  private readonly readOnlyOrama: boolean;
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
    installPendingBaseProjectionBeforeRelease: (snapshot, context) =>
      this.installPendingBaseProjectionBeforeRelease(snapshot, context),
    recordIndexSyncSuccess: () => {
      this.recordIndexSyncSuccess();
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
    this.db = db ?? createStandaloneKbDb(runtimeDir);
    this.readOnlyOrama = readOnlyOrama === true;
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
    this.emptyEquipmentView = Object.freeze(emptySnapshot(this.baseProjection));

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

  getBaseRetrievalSurface(): TextRetrieval & VectorRetrieval {
    return this.baseProjection;
  }

  notesDir(): string {
    return pathsNotesDir(this.markdownRoot);
  }

  sourcesDir(): string {
    return pathsSourcesDir(this.markdownRoot);
  }

  communitiesDir(): string {
    return pathsCommunitiesDir(this.markdownRoot);
  }

  principlesDir(): string {
    return pathsPrinciplesDir(this.markdownRoot);
  }

  entityGraphPath(): string {
    return join(this.markdownRoot, '.entity-graph.json');
  }

  notePath(note: string): string {
    return notePathFromName(note, this.markdownRoot);
  }

  sourcePath(source: string): string {
    return sourcePathFromName(source, this.markdownRoot);
  }

  communityPath(community: string): string {
    return communityPathFromName(community, this.markdownRoot);
  }

  principlePath(principle: string): string {
    return principlePathFromName(principle, this.markdownRoot);
  }

  sourceImportStageDir(): string {
    return pathsSourceImportStageDir(this.runtimeDir);
  }

  readEntityGraph(): EntityGraph | null {
    return readEntityGraphFile(this.entityGraphPath());
  }

  async writeEntityGraph(graph: EntityGraph): Promise<void> {
    await this.withMutationLock(() => {
      this.writeEntityGraphLocked(graph);
    });
  }

  writeEntityGraphLocked(graph: EntityGraph): void {
    const { normalized, raw } = writeEntityGraphFile(this.entityGraphPath(), graph);
    this.queueManifestAuthorityDelta(captureEntityGraphManifestDelta(raw));
    this.setMutationLockProjectionDispatchMode('full');
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

      const state = this.readIndexState();
      return {
        ...applyMutationLane(state, this.activeMutationContext.pendingMutationLane),
        ...(this.activeMutationContext.pendingMutationReason === undefined
          ? state.textStaleReason === undefined
            ? {}
            : { textStaleReason: state.textStaleReason }
          : { textStaleReason: this.activeMutationContext.pendingMutationReason }),
      };
    }

    const state = this.readIndexState();
    const nextState = {
      ...applyMutationLane(state, lane),
      ...(reason === undefined ? {} : { textStaleReason: reason }),
    };
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
      await this.withMutationLock(async () => {
        const state = this.readIndexStateIfPresent();
        if (!this.textArtifactsNeedRebuild(state)) {
          return;
        }

        await rebuildTextArtifactsAndPersistRepairState(this, captureIndexStateSnapshot(state));
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

    if (this.readOnlyOrama) {
      return this.ensureOramaIndexReadOnly();
    }

    if (this.activeMutationContext !== null) {
      return this.ensureOramaIndexInMutationLock();
    }

    return this.withMutationLock(async () => this.ensureOramaIndexInMutationLock());
  }

  async loadOramaSnapshotIfPresent(): Promise<KbCachedOramaIndex | null> {
    return this.oramaSnapshotStore.loadIfPresent();
  }

  async ensureTextArtifactsFreshUnderLock(): Promise<KbTextArtifactsSnapshot> {
    let rebuilt: Awaited<ReturnType<typeof rebuildTextArtifactsAndPersistRepairState>> | null = null;
    if (this.textArtifactsNeedRebuild()) {
      rebuilt = await rebuildTextArtifactsAndPersistRepairState(
        this,
        captureIndexStateSnapshot(this.readIndexState()),
      );
    } else if (!this.oramaSnapshotStore.hasCache()) {
      try {
        this.oramaSnapshotStore.install(await this.oramaSnapshotStore.load());
      } catch {
        rebuilt = await rebuildTextArtifactsAndPersistRepairState(
          this,
          captureIndexStateSnapshot(this.readIndexState()),
        );
      }
    }

    if (rebuilt !== null) {
      return textArtifactsSnapshotFromRebuildResult(this, rebuilt);
    }

    const stateAfterArtifacts = this.readIndexStateIfPresent();
    if (!this.oramaSnapshotStore.hasCache() || this.textArtifactsNeedRebuild(stateAfterArtifacts)) {
      throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
    }

    return captureTextArtifactsSnapshot(this);
  }

  async withMutationLock<T>(fn: () => Promise<T> | T, options: KbMutationLockOptions = {}): Promise<T> {
    return this.mutationLockController.withMutationLock(fn, options);
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
          // Generic fallback for inbound sync callers that cannot provide structured path changes.
          this.manifestAuthority.seedFromFullCollectors(this);
        }
      }

      if (mutationDiff.lane !== null) {
        if (mutationDiff.manifestDeltas.length > 0) {
          this.queueManifestAuthorityDelta(mutationDiff.manifestDeltas);
        }
        if (!mutationDiff.requiresFullInstall && mutationDiff.changedEntryIds.length > 0) {
          this.writeIndex(this.buildInboundSyncIndexDelta(mutationDiff.changedEntryIds));
        } else if (mutationDiff.requiresFullInstall) {
          this.invalidateKbCache();
        }
        this.recordMutationCommitted(mutationDiff.lane, 'KB text snapshot is stale after inbound git sync.');
      }
      return result;
    }, {
      preReleaseInstallProjection: async (snapshot) => {
        if (mutationDiff === null || mutationDiff.lane === null) {
          return false;
        }

        if (mutationDiff.requiresFullInstall) {
          const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus();
          await this.baseProjection.installFullSnapshotInWriteLock(snapshot, preparedProjection);
          return true;
        }

        const shouldInstallDelta =
          mutationDiff.changedEntryIds.length <= INBOUND_SYNC_ORAMA_DELTA_THRESHOLD;
        if (!shouldInstallDelta) {
          const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus();
          await this.baseProjection.installFullSnapshotInWriteLock(snapshot, preparedProjection);
          return true;
        }

        const preparedDelta = await this.baseProjection.prepareDeltaForCurrentCorpusEntries(
          this.readIndexOrEmpty(),
          mutationDiff.changedEntryIds,
          [],
        );
        await this.baseProjection.applyDeltaInWriteLock(snapshot, preparedDelta);
        return true;
      },
    });
  }

  setMutationLockProjectionDispatchMode(mode: 'delta' | 'full'): void {
    if (this.activeMutationContext === null) {
      throw new Error('KB mutation-lock projection mode can only change while the mutation lock is held.');
    }
    if (mode === 'full') {
      this.activeMutationContext.projectionDispatchMode = 'full';
    }
  }

  captureCurrentCorpusSnapshot(): KbCorpusPublication['snapshot'] {
    return this.buildCurrentCorpusSnapshot(captureIndexStateSnapshot(this.readIndexState()));
  }

  getCurrentManifestAuthorityHash(lane: ManifestAuthorityLane): string {
    return this.manifestAuthority.getCurrentManifestHash(lane);
  }

  private buildInboundSyncIndexDelta(changedEntryIds: readonly string[]): KbIndex {
    const nextIndex = cloneKbIndex(this.activeMutationContext?.startIndex ?? this.readIndex());

    for (const entryId of changedEntryIds) {
      if (entryId.startsWith('note:')) {
        const slug = entryId.slice('note:'.length);
        const notePath = this.notePath(slug);

        try {
          const { frontmatter, title } = loadKbNote(notePath);
          nextIndex.entries[entryId] = buildNoteIndexEntry({
            slug,
            title,
            ...frontmatter,
          });
        } catch (error: unknown) {
          if (!isNoEntryError(error)) {
            throw error;
          }
          delete nextIndex.entries[entryId];
        }
        continue;
      }

      if (entryId.startsWith('source:')) {
        const slug = entryId.slice('source:'.length);
        const sourcePath = this.sourcePath(slug);

        try {
          const { frontmatter } = loadKbSource(sourcePath);
          nextIndex.entries[entryId] = buildSourceIndexEntry({
            slug,
            ...frontmatter,
          });
        } catch (error: unknown) {
          if (!isNoEntryError(error)) {
            throw error;
          }
          delete nextIndex.entries[entryId];
        }
      }
    }

    return nextIndex;
  }

  private buildCurrentCorpusSnapshot(state: KbIndexStateSnapshot): CorpusSnapshot {
    const snapshotWithoutId = {
      contentSeq: state.contentSeq,
      metadataSeq: state.metadataSeq,
      contentManifestHash: this.manifestAuthority.getCurrentManifestHash('content'),
      metadataManifestHash: this.manifestAuthority.getCurrentManifestHash('metadata'),
    };

    return {
      ...snapshotWithoutId,
      snapshotId: deriveStableCorpusSnapshotId(snapshotWithoutId),
    };
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

  private async installPendingBaseProjectionBeforeRelease(
    snapshot: CorpusSnapshot,
    lockContext: MutationLockContext,
  ): Promise<boolean> {
    const currentIndex = this.readIndexOrEmpty();
    const delta = diffSearchVisibleEntryIds(lockContext.startIndex, currentIndex);

    if (lockContext.projectionDispatchMode === 'full') {
      const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus(currentIndex);
      await this.baseProjection.installFullSnapshotInWriteLock(snapshot, preparedProjection);
      return true;
    }

    if (delta.changedEntryIds.length === 0 && delta.deletedEntryIds.length === 0) {
      return false;
    }

    const preparedDelta = await this.baseProjection.prepareDeltaForCurrentCorpusEntries(
      currentIndex,
      delta.changedEntryIds,
      delta.deletedEntryIds,
    );
    await this.baseProjection.applyDeltaInWriteLock(snapshot, preparedDelta);
    return true;
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

    const state = this.readIndexState();
    const nextState = {
      ...applyMutationLane(state, lockContext.pendingMutationLane),
      ...(lockContext.pendingMutationReason === undefined
        ? state.textStaleReason === undefined
          ? {}
          : { textStaleReason: state.textStaleReason }
        : { textStaleReason: lockContext.pendingMutationReason }),
    };
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

  private async ensureOramaIndexInMutationLock(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }> {
    const state = this.readIndexStateIfPresent();
    const startState = captureIndexStateSnapshot(state);

    if (this.textArtifactsNeedRebuild(state)) {
      try {
        await rebuildTextArtifactsAndPersistRepairState(this, startState);
      } catch (error: unknown) {
        throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
      }
    } else if (!this.oramaSnapshotStore.hasCache()) {
      try {
        this.oramaSnapshotStore.install(await this.oramaSnapshotStore.load());
      } catch {
        await this.installCurrentOramaProjectionInWriteLock(startState);
      }
    }

    const stateAfterArtifacts = this.readIndexStateIfPresent();
    const cachedOramaIndex = this.oramaSnapshotStore.getCache();
    if (cachedOramaIndex === null || this.textArtifactsNeedRebuild(stateAfterArtifacts)) {
      throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
    }

    return {
      ...cachedOramaIndex,
      index: this.readIndex() ?? emptyIndex(),
    };
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

  private async installCurrentOramaProjectionInWriteLock(startState: KbIndexStateSnapshot): Promise<void> {
    this.oramaSnapshotStore.clear();
    this.oramaSnapshotStore.removeSnapshot();

    const currentIndex = this.readIndex();
    if (currentIndex === null) {
      try {
        await rebuildTextArtifactsAndPersistRepairState(this, startState);
        return;
      } catch (error: unknown) {
        throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
      }
    }

    try {
      const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus(currentIndex);
      await this.baseProjection.installFullSnapshotInWriteLock(this.captureCurrentCorpusSnapshot(), preparedProjection);
    } catch (error: unknown) {
      throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
    }
  }

  private pendingRepairPath(entry: PendingRepairRetryCandidate): string | null {
    if (entry.entryId.startsWith('note:')) {
      return this.notePath(entry.entryId.slice('note:'.length));
    }
    if (entry.entryId.startsWith('source:')) {
      return this.sourcePath(entry.entryId.slice('source:'.length));
    }

    return null;
  }

  private readPendingRepairContentHash(path: string): string | null {
    try {
      return createHash('sha256').update(readFileSync(path, 'utf-8'), 'utf8').digest('hex');
    } catch {
      return null;
    }
  }

  private pendingRepairNeedsRetry(): boolean {
    const pendingRepair = readPendingRepairRows(this);
    if (pendingRepair.length === 0) {
      return false;
    }

    const result = pendingRepair.some((entry) => {
      const path = this.pendingRepairPath(entry);
      if (path === null) {
        return false;
      }
      if (entry.observedContentHash === undefined) {
        return (entry.reason ?? 'pending-repair') === 'pending-repair';
      }

      const currentHash = this.readPendingRepairContentHash(path);
      return currentHash === null || currentHash !== entry.observedContentHash;
    });
    return result;
  }

  private indexNeedsRebuild(): boolean {
    return detectTextArtifactRebuildInfo(this).needsRebuild;
  }

  private textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? this.readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || this.indexNeedsRebuild() || this.pendingRepairNeedsRetry();
  }

}

export function createKbRuntime(opts: CreateKbRuntimeOptions): KbRuntime {
  return new KbRuntimeImpl(opts);
}

// KbRuntime exposes only the coordinator-facing surface; this bridge reaches the concrete
// write method without widening the public interface.
export function captureKbCorpusSnapshot(kb: KbRuntime): KbCorpusPublication['snapshot'] {
  const runtime = kb as KbRuntime & {
    captureCurrentCorpusSnapshot?: () => KbCorpusPublication['snapshot'];
  };
  if (typeof runtime.captureCurrentCorpusSnapshot !== 'function') {
    throw new Error('KB runtime does not expose corpus snapshot capture.');
  }
  return runtime.captureCurrentCorpusSnapshot();
}

// KbRuntime exposes only the coordinator-facing surface; this bridge reaches the concrete
// write method without widening the public interface.
export function setMutationLockProjectionDispatchMode(kb: KbRuntime, mode: 'delta' | 'full'): void {
  const runtime = kb as KbRuntime & {
    setMutationLockProjectionDispatchMode?: (nextMode: 'delta' | 'full') => void;
  };
  if (typeof runtime.setMutationLockProjectionDispatchMode !== 'function') {
    throw new Error('KB runtime does not expose mutation-lock projection dispatch control.');
  }
  runtime.setMutationLockProjectionDispatchMode(mode);
}

export {
  getManifestAuthorityHash,
  queueManifestAuthorityDelta,
  writeEntityGraphLocked,
} from './runtime-effects.js';
