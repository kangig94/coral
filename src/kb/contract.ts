import type BetterSqlite3 from 'better-sqlite3';

import type { RuntimeBinding } from '../runtime/binding.js';
import type { CorpusConsumerRegistration } from '../store/consumer-contract.js';
import type { RuntimeEnvPort, RuntimeIdsPort, RuntimeTimePort } from '../runtime/ports.js';
import type { CorpusSnapshot } from './corpus/snapshot.js';
import type { KbMutationLockOptions } from './corpus/mutation-lock.js';
import type { ManifestAuthorityDelta } from './corpus/manifest-types.js';
import type { EntityGraph, KbIndex, KbSearchScope } from './entry-types.js';
import type { TextRetrievalResult, VectorRetrievalResult } from './search/contract.js';
import type { KbOramaDb, KbOramaTokenizer } from './search/orama/schema.js';
export type {
  ConsumerApplyError,
  ConsumerRegistrationKind,
  CorpusConsumerApplyContext,
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
} from '../store/consumer-contract.js';

export type KbIndexMutationLane = 'content' | 'metadata' | 'both';

export type KbCorpusSnapshot = CorpusSnapshot;

export type KbCorpusLane = 'content' | 'metadata';

export interface KbCorpusPublication {
  snapshot: KbCorpusSnapshot;
  changedLanes: KbCorpusLane[];
}

export interface KbPersistCorpusStateResult {
  snapshot: KbCorpusSnapshot;
  changedLanes: KbCorpusLane[];
}

export interface KbCorpusPublishFailure {
  stage: 'persist' | 'notify';
  snapshot: KbCorpusSnapshot;
  changedLanes: KbCorpusLane[];
  consecutivePublishFailureCount: number;
  error: unknown;
}

export interface KbCorpusPublishCallbacks {
  persistCorpusState(snapshot: KbCorpusSnapshot): Promise<KbPersistCorpusStateResult> | KbPersistCorpusStateResult;
  notifyCorpusMutation(publication: KbCorpusPublication): Promise<void> | void;
  onPublishFailure?(failure: KbCorpusPublishFailure): void;
  onPublishSuccess?(): void;
}

export interface KbIndexState {
  contentSeq: number;
  metadataSeq: number;
  textStaleReason?: string;
}

export interface KbCachedOramaIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
}

export type Consumer = CorpusConsumerRegistration;

export interface Backed<T> {
  read(): T;
  consumer: Consumer;
}

export interface VectorRetrieval {
  read(embedding: number[], topK: number, scope?: KbSearchScope): Promise<VectorRetrievalResult>;
}

export interface FtsRetrieval {
  read(query: string, topK: number, scope?: KbSearchScope): Promise<TextRetrievalResult>;
}

export interface EmbeddingService {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface KbInboundSyncOptions {
  structuredDiff?: boolean;
}

export interface KbMutationEffects {
  queueManifestAuthorityDelta(deltas: readonly ManifestAuthorityDelta[]): void;
  writeEntityGraph(graph: EntityGraph): void;
}

export interface KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: BetterSqlite3.Database;
  readonly time: Pick<RuntimeTimePort, 'now'>;
  readonly ids: Pick<RuntimeIdsPort, 'uuid'>;
  readonly env: Pick<RuntimeEnvPort, 'get'>;
  readonly vector: RuntimeBinding<Backed<VectorRetrieval>>;
  readonly embedding: RuntimeBinding<Backed<EmbeddingService>>;
  readonly fts: RuntimeBinding<Backed<FtsRetrieval>>;
  readIndex(): KbIndex | null;
  persistIndexToDisk(index: KbIndex): KbIndex;
  writeIndex(index: KbIndex): KbIndex;
  readIndexOrEmpty(): KbIndex;
  readIndexStateIfPresent(): KbIndexState | null;
  readIndexState(): KbIndexState;
  writeIndexState(state: KbIndexState): void;
  register(corpusPublishCallbacks: KbCorpusPublishCallbacks): void;
  recordMutationCommitted(lane?: KbIndexMutationLane, reason?: string): KbIndexState;
  recordIndexSyncSuccess(): KbIndexState;
  recordIndexSyncFailure(reason: string): KbIndexState;
  recordReindexSuccess(
    startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
    externalMutation?: KbIndexMutationLane | null,
  ): KbIndexState;
  getCorpusStateSnapshot(): KbCorpusSnapshot;
  captureCorpusSnapshot(): KbCorpusSnapshot;
  invalidateCorpusStateSnapshot(): void;
  ensureCorpusFreshness(): Promise<KbIndex>;
  ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }>;
  loadOramaSnapshotIfPresent(): Promise<KbCachedOramaIndex | null>;
  withMutationLock<T>(fn: (mutation: KbMutationEffects) => Promise<T> | T, options?: KbMutationLockOptions): Promise<T>;
  retryPendingCorpusPublication(): Promise<void>;
  runInboundSync<T>(fn: () => Promise<T> | T, options?: KbInboundSyncOptions): Promise<T>;
  invalidateKbCache(): void;
  invalidateTextSnapshot(reason: string): KbIndexState;
  installRebuiltArtifacts(index: KbIndex, orama: KbCachedOramaIndex): KbIndex;
  persistOramaSnapshot(db: KbOramaDb): void;
  notesDir(): string;
  sourcesDir(): string;
  communitiesDir(): string;
  principlesDir(): string;
  entityGraphPath(): string;
  notePath(note: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  sourceImportStageDir(): string;
  readEntityGraph(): EntityGraph | null;
  writeEntityGraph(graph: EntityGraph): Promise<void>;
}
