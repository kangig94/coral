import type BetterSqlite3 from 'better-sqlite3';

import type { RuntimeBinding } from '../runtime/binding.js';
import type { ConsumerRegistration } from '../store/consumer-contract.js';
import type { EnvPort, IdPort, ProcessPort, StoragePort, TimePort } from '../runtime/ports.js';
import type { SpawnCliFn } from './curate/spawn-cli.js';
import type { CorpusStorage } from './corpus/rescan/storage.js';
import type { CorpusSnapshot } from './corpus/snapshot.js';
import type { KbMutationLockDiagnostics, KbMutationLockOptions } from './corpus/mutation-lock.js';
import type { ManifestAuthorityDelta } from './corpus/manifest-types.js';
import type { EntityGraph, KbIndex, KbSearchScope } from './entry-types.js';
import type { FtsSearchResult, VectorRetrievalResult } from './search/contract.js';
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

export type Consumer = ConsumerRegistration;

export interface Backed<T> {
  read(): T;
  consumer: Consumer;
}

/**
 * Pinned engine-blind FTS capability surface (commit 4 — AC4.7).
 * The widening loop lives in KB-tier; the engine signals `exhausted` in the result
 * so the loop can stop without re-querying for shape information.
 */
export interface FtsRetrieval {
  search(query: string, topK: number, scope?: KbSearchScope): Promise<FtsSearchResult>;
  tokenize(text: string): readonly string[];
  warnings(): readonly string[];
}

export interface VectorRetrieval {
  search(embedding: number[], topK: number, scope?: KbSearchScope): Promise<VectorRetrievalResult>;
}

export interface EmbeddingService {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface KbInboundSyncOptions {
  structuredDiff?: boolean;
}

/**
 * Read paths (`wait: false`, the default) return the current index immediately
 * — possibly stale — and dispatch a single shared rebuild in the background;
 * concurrent callers join the same in-flight promise (spec §12.3 lazy
 * non-blocking rescan). Readiness/boot/curate paths pass `wait: true` to
 * block until the rebuild completes. The optional `signal` aborts a pending
 * rebuild kick — used by coordinator shutdown so a draining instance does
 * not start fresh background work.
 */
export interface EnsureCorpusFreshnessOptions {
  wait?: boolean;
  signal?: AbortSignal;
}

export interface KbMutationEffects {
  queueManifestAuthorityDelta(deltas: readonly ManifestAuthorityDelta[]): void;
  writeEntityGraph(graph: EntityGraph): void;
}

/**
 * kb-domain port aggregator. Carries the ports that domain orchestrators
 * (performRescan, gitSync) construct from; cross-domain consumers should
 * compose at the subsystem level instead.
 */
export interface KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: BetterSqlite3.Database;
  readonly time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  readonly ids: Pick<IdPort, 'uuid'>;
  /**
   * general-purpose I/O surface used by gitSync; do NOT use for corpus
   * markdown reads — use corpusStorage instead.
   */
  readonly storagePort: StoragePort;
  /**
   * typed iterator narrowed for the rescan SRW boundary; do not use for
   * writes — use storagePort instead. Forbidden in auto-fix.ts.
   */
  readonly corpusStorage: CorpusStorage;
  readonly spawnCli: SpawnCliFn;
  readonly processPort: ProcessPort;
  readonly envPort: EnvPort;
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
  ensureCorpusFreshness(options?: EnsureCorpusFreshnessOptions): Promise<KbIndex>;
  withMutationLock<T>(
    fn: (mutation: KbMutationEffects, args: { signal: AbortSignal }) => Promise<T> | T,
    options?: KbMutationLockOptions,
  ): Promise<T>;
  /**
   * Mutation-lock diagnostics for `/health.subsystems.kb.mutationBlocked`.
   * Returns `{ blocked: false }` while no mutation has aborted past the
   * cooperative grace window, otherwise the stuck owner snapshot. Owner is
   * `'unknown'` when the deadline fires before the mutation has called
   * `recordMutationCommitted` (documented signal that the operation is
   * stuck before the write phase).
   */
  mutationLockDiagnostics(): KbMutationLockDiagnostics;
  retryPendingCorpusPublication(): Promise<void>;
  runInboundSync<T>(fn: () => Promise<T> | T, options?: KbInboundSyncOptions): Promise<T>;
  invalidateKbCache(): void;
  invalidateTextSnapshot(reason: string): KbIndexState;
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
