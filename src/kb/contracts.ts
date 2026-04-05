import type { KbOramaDb, KbOramaTokenizer } from './orama-factory.js';
import type { KbIndex, NoteEntry, SourceEntry } from './types.js';
import type { VectorStore } from './vector-store.js';

export interface KbVectorSpecState {
  indexedSeq: number;
  staleReason?: string;
  activeSnapshotId?: string;
}

export interface KbVectorLease {
  store: VectorStore;
  specId: string;
  snapshotId: string;
  generation: number;
  vectorStatus: KbVectorSpecState | null;
  release(): Promise<void>;
}

export interface KbVectorTextSnapshot {
  index: KbIndex;
  notes: Array<{ entry: NoteEntry; body: string }>;
  sources: Array<{ entry: SourceEntry; body: string }>;
}

export interface KbIndexState {
  mutationSeq: number;
  textIndexedSeq: number;
  textStaleReason?: string;
  vector: {
    bySpec: Record<string, KbVectorSpecState>;
  };
}

export interface KbCachedOramaIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
}

export interface KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  vectorStore: VectorStore | null;
  initVectorStore(pluginRoot: string): Promise<void>;
  openVectorStore(
    dbPath: string,
    handleToken: string,
  ): Promise<{
    store: VectorStore;
    close(): Promise<void>;
  } | null>;
  activateVectorSnapshot(specId: string, snapshotId: string): Promise<void>;
  acquireVectorLease(): Promise<KbVectorLease | null>;
  closeVectorStores(): Promise<void>;
  getActiveVectorHandleInfo(): { specId: string; snapshotId: string; generation: number } | null;
  readIndex(): KbIndex | null;
  persistIndexToDisk(index: KbIndex): KbIndex;
  writeIndex(index: KbIndex): KbIndex;
  readIndexOrEmpty(): KbIndex;
  readIndexStateIfPresent(): KbIndexState | null;
  readIndexState(): KbIndexState;
  writeIndexState(state: KbIndexState): void;
  recordMutationCommitted(): KbIndexState;
  recordIndexSyncSuccess(): KbIndexState;
  recordIndexSyncFailure(reason: string): KbIndexState;
  recordReindexSuccess(startSeq: number): KbIndexState;
  recordVectorSyncSuccess(specId: string, startSeq: number, snapshotId: string): KbIndexState;
  recordVectorSyncFailure(specId: string, reason: string, activeSnapshotId?: string): KbIndexState;
  getVectorStatus(specId: string): KbVectorSpecState | null;
  ensureIndex(): Promise<KbIndex>;
  ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
  }>;
  ensureTextArtifactsFreshUnderLock(startSeq: number): Promise<KbVectorTextSnapshot>;
  withMutationLock<T>(fn: () => Promise<T> | T): Promise<T>;
  invalidateKbCache(): void;
  invalidateTextSnapshot(reason: string): KbIndexState;
  installRebuiltArtifacts(index: KbIndex, orama: KbCachedOramaIndex): KbIndex;
  persistOramaSnapshot(db: KbOramaDb): void;
  notesDir(): string;
  sourcesDir(): string;
  communitiesDir(): string;
  principlesDir(): string;
  notePath(note: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  sourceImportStageDir(): string;
  curateStatePath(): string;
}
