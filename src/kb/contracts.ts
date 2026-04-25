import type BetterSqlite3 from 'better-sqlite3';

import type { KbOramaDb, KbOramaTokenizer } from './orama-schema.js';
import type { EntityGraph, KbIndex } from './entry-types.js';
import type { CorpusSnapshot } from './corpus/snapshot.js';
import type { KbMutationLockOptions } from './corpus/mutation-lock.js';
import type { ManifestAuthorityDelta } from './corpus/manifest-types.js';
import type { TextRetrieval, VectorRetrieval } from './search/contract.js';
import type { CorpusConsumerRegistration } from './corpus/consumer-contract.js';
import type { RuntimeEnvPort, RuntimeIdsPort, RuntimeTimePort } from '../runtime/ports.js';
export type {
  ConsumerApplyError,
  ConsumerRegistrationKind,
  CorpusConsumerApplyContext,
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
} from './corpus/consumer-contract.js';

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

export interface KbRuntimeActivationSnapshot {
  retrieval: VectorRetrieval;
  snapshotId: string | null;
  contentSeq: number;
  contentManifestHash: string | null;
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
  getEquipmentView(): KbRuntimeActivationSnapshot;
  getActiveVectorSurface(): VectorRetrieval;
  getBaseRetrievalSurface(): TextRetrieval & VectorRetrieval & CorpusConsumerRegistration;
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
  ensureIndex(): Promise<KbIndex>;
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
