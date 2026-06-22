import { insert, insertMultiple, remove, search as oramaSearch } from '@orama/orama';

import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { FtsRetrieval, KbEngineRuntimeBase, KbCorpusSnapshot } from '../../kb/contract.js';
import type {
  ConsumerApplyError,
  CorpusConsumerApplyContext,
  CorpusConsumerRegistration,
} from '../../store/consumer-contract.js';
import type { KbProjectionInput, KbProjectionRecord } from '../../kb/projection-input-contract.js';
import { computeContentSurfaceHash, computeMetadataSurfaceHash } from '../../kb/corpus/snapshot.js';
import { isSnapshotFresherForInterest } from '../../kb/state/corpus-state.js';
import { noteMetadataHash, sourceMetadataHash, wikiMetadataHash } from '../../kb/metadata-hash.js';
import type { KbDeclaredAnalyzer } from '../../kb/extra-langs.js';
import {
  createOramaDb,
  createIntlOramaTokenizer,
  createOramaTokenizer,
  normalizeOramaTerm,
  toOramaDocument,
  tokenizeQuery,
  type OramaTokenizerAnalyzer,
  type KbOramaDocument,
} from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';
import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  classifyProjectionMismatch,
  createOramaProjectionIdentityInput,
  oramaProjectionTokenizerTier,
  type OramaEntryManifest,
  type OramaEntryManifestEntry,
  type OramaProjectionMismatchClassification,
  type OramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from './artifact-port.js';
import { OramaSnapshotStore, type KbCachedOramaIndex } from './snapshot.js';
import type { FtsHit, FtsSearchResult, RetrievedDocument, RetrievalScope } from '../../kb/search/contract.js';
import type { Runtime } from '../../runtime/ports.js';

const ORAMA_SEARCH_PROPERTIES: Array<'slug' | 'title' | 'body' | 'tags' | 'principles'> = [
  'slug',
  'title',
  'body',
  'tags',
  'principles',
];
const ORAMA_SEARCH_BOOST = {
  slug: 3,
  title: 2,
  tags: 1.5,
  principles: 1.5,
  body: 1,
} as const;

export const ORAMA_BASE_CONSUMER_ID = 'orama-base';
const FTS_INDEX_UNINITIALIZED_WARNING = 'fts_index_uninitialized';
const FTS_INDEX_STALE_TIER_WARNING = 'fts_index_stale_tier';

export type OramaReconcileReason = 'stale-tier' | 'incompatible' | 'terminal-analyzer-failure';

export interface PreparedOramaProjection {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
  documents: KbOramaDocument[];
}

type CurrentOramaDocumentMap = ReadonlyMap<string, KbOramaDocument>;

export interface OramaLoadedIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
}

type OramaServedIndex = {
  readonly db: KbOramaDb;
  readonly metadata?: OramaProjectionMetadata;
  readonly servedTokenizerIdentity: string;
  readonly dbTokenizer: KbOramaTokenizer;
  readonly snippetTokenizer: KbOramaTokenizer;
  readonly fallback?: true;
};

export type OramaAnalyzerLeaseContext = {
  readonly analyzer: OramaTokenizerAnalyzer | null;
  readonly activeAnalyzers: readonly KbDeclaredAnalyzer[];
};

export type OramaAnalyzerManager = {
  withAnalyzerLease<T>(
    runtime: Runtime | undefined,
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    run: (lease: OramaAnalyzerLeaseContext) => T | Promise<T>,
  ): Promise<T>;
  effectiveDeclaredAnalyzers(
    declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    runtime?: Runtime,
  ): readonly KbDeclaredAnalyzer[];
  currentAnalyzer(): OramaTokenizerAnalyzer | null;
  isTerminalLoadError?(error: unknown): boolean;
};

export type OramaBaseProjectionOptions = {
  readonly kiwiRuntime?: Runtime;
  readonly analyzerManager?: OramaAnalyzerManager;
  readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;
  readonly onApplyFailure?: (error: ConsumerApplyError) => void;
};

type OramaSearchPortOptions = {
  readonly runtime?: KbEngineRuntimeBase;
  readonly kiwiRuntime?: Runtime;
  readonly analyzerManager?: OramaAnalyzerManager;
  readonly projectionIdentityInput?: () => OramaProjectionIdentityInput;
  readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;
};

const NOOP_ANALYZER_MANAGER: OramaAnalyzerManager = {
  async withAnalyzerLease(_runtime, declaredAnalyzers, run) {
    return run({ analyzer: null, activeAnalyzers: declaredAnalyzers });
  },
  effectiveDeclaredAnalyzers(declaredAnalyzers) {
    return declaredAnalyzers;
  },
  currentAnalyzer() {
    return null;
  },
};

function readDeclaredAnalyzers(runtime: Pick<KbEngineRuntimeBase, 'declaredAnalyzers'>): readonly KbDeclaredAnalyzer[] {
  return Array.isArray(runtime.declaredAnalyzers) ? runtime.declaredAnalyzers : [];
}

function scopeAllowsKind(scope: RetrievalScope | undefined, kind: KbOramaDocument['kind']): boolean {
  if (scope === undefined || scope === 'all') {
    return true;
  }
  if (scope === 'notes') {
    return kind === 'note';
  }
  if (scope === 'sources') {
    return kind === 'source';
  }
  if (scope === 'wiki') {
    return kind === 'wiki';
  }
  return kind === 'community';
}

function compareScoreAndEntryId(
  left: { score: number; entryId: string },
  right: { score: number; entryId: string },
): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }
  return left.entryId.localeCompare(right.entryId);
}

function communityMetadataHash(rawContent: string): string {
  return computeMetadataSurfaceHash({
    rawBytes: rawContent,
  });
}

function toRetrievedDocument(document: KbOramaDocument): RetrievedDocument {
  return {
    entryId: document.entryId,
    slug: document.entryId.slice(document.entryId.indexOf(':') + 1),
    kind: document.kind,
    freshness: document.freshness,
    title: document.title,
    body: document.body,
    tags: document.tags,
    principles: document.principles,
  };
}

export class OramaSearchPort implements FtsRetrieval {
  private readonly warningSet = new Set<string>();
  private readonly requestedReconcileReasons = new Set<OramaReconcileReason>();
  private fallbackCacheActive = false;
  private servedIndex: OramaServedIndex | null = null;

  private readonly snapshotStore: OramaSnapshotStore;
  private readonly options: OramaSearchPortOptions;
  constructor(snapshotStore: OramaSnapshotStore, options: OramaSearchPortOptions = {}) {
    this.snapshotStore = snapshotStore;
    this.options = options;
  }

  private indexIdentityClassification(cached: KbCachedOramaIndex): OramaProjectionMismatchClassification {
    const input = this.options.projectionIdentityInput?.();
    if (input === undefined || cached.fallback === true) {
      return 'match';
    }
    return classifyProjectionMismatch(cached.metadata, input);
  }

  private clearServedIndex(): void {
    this.servedIndex = null;
  }

  private requestProjectionReconcile(reason: OramaReconcileReason): void {
    const request = this.options.requestProjectionReconcile;
    if (request === undefined || this.requestedReconcileReasons.has(reason)) {
      return;
    }

    this.requestedReconcileReasons.add(reason);
    try {
      const result = request(reason) as unknown;
      void Promise.resolve(result).catch((error: unknown) => {
        this.requestedReconcileReasons.delete(reason);
        backendLog.warn(`[orama] projection reconcile request failed: ${errorMessage(error)}`);
      });
    } catch (error: unknown) {
      this.requestedReconcileReasons.delete(reason);
      backendLog.warn(`[orama] projection reconcile request failed: ${errorMessage(error)}`);
    }
  }

  private markMatchedServedIndex(): void {
    this.warningSet.delete(FTS_INDEX_UNINITIALIZED_WARNING);
    this.warningSet.delete(FTS_INDEX_STALE_TIER_WARNING);
    this.requestedReconcileReasons.clear();
  }

  private createServedIndex(cached: KbCachedOramaIndex, lease: OramaAnalyzerLeaseContext): OramaServedIndex | null {
    if (cached.fallback === true) {
      const tokenizer = createOramaTokenizer({
        currentKiwiAnalyzer: () => lease.analyzer,
      });
      cached.db.tokenizer = tokenizer;
      return {
        db: cached.db,
        dbTokenizer: tokenizer,
        snippetTokenizer: tokenizer,
        servedTokenizerIdentity: this.options.projectionIdentityInput?.().tokenizerIdentity ?? 'fallback-current',
        fallback: true,
      };
    }

    if (cached.metadata === undefined) {
      return null;
    }

    const tier = oramaProjectionTokenizerTier(cached.metadata);
    if (tier === 'intl') {
      const tokenizer = createIntlOramaTokenizer();
      cached.db.tokenizer = tokenizer;
      return {
        db: cached.db,
        metadata: cached.metadata,
        dbTokenizer: tokenizer,
        snippetTokenizer: tokenizer,
        servedTokenizerIdentity: cached.metadata.tokenizerIdentity ?? 'intl-baseline',
      };
    }

    if (tier === 'kiwi') {
      if (lease.analyzer === null) {
        return null;
      }
      const tokenizer = createOramaTokenizer({
        currentKiwiAnalyzer: () => lease.analyzer,
      });
      cached.db.tokenizer = tokenizer;
      return {
        db: cached.db,
        metadata: cached.metadata,
        dbTokenizer: tokenizer,
        snippetTokenizer: tokenizer,
        servedTokenizerIdentity: cached.metadata.tokenizerIdentity ?? 'kiwi',
      };
    }

    return null;
  }

  private activateServedIndex(cached: KbCachedOramaIndex, lease: OramaAnalyzerLeaseContext): OramaServedIndex | null {
    const served = this.createServedIndex(cached, lease);
    if (served === null) {
      this.clearServedIndex();
      return null;
    }
    this.servedIndex = served;
    this.snapshotStore.install({ ...cached, tokenizer: served.dbTokenizer });
    return served;
  }

  private serveClassifiedIndex(
    cached: KbCachedOramaIndex,
    classification: OramaProjectionMismatchClassification,
    lease: OramaAnalyzerLeaseContext,
  ): OramaServedIndex | null {
    const served = this.activateServedIndex(cached, lease);
    if (served === null) {
      return null;
    }

    if (cached.fallback === true) {
      return served;
    }

    this.fallbackCacheActive = false;
    if (classification === 'tier-only-upgrade') {
      this.warningSet.delete(FTS_INDEX_UNINITIALIZED_WARNING);
      this.warningSet.add(FTS_INDEX_STALE_TIER_WARNING);
      this.requestProjectionReconcile('stale-tier');
      return served;
    }

    this.markMatchedServedIndex();
    return served;
  }

  async ensureLoaded(): Promise<OramaLoadedIndex> {
    return this.withAnalyzerLease(async (lease) => {
      const served = await this.ensureServedIndex(lease);
      return {
        db: served.db,
        tokenizer: served.snippetTokenizer,
      };
    });
  }

  private async ensureServedIndex(lease: OramaAnalyzerLeaseContext): Promise<OramaServedIndex> {
    const cached = this.snapshotStore.getCache();
    if (this.fallbackCacheActive && this.snapshotStore.hasPersistedSnapshot()) {
      this.snapshotStore.clear();
      this.clearServedIndex();
    } else if (cached !== null) {
      const classification = this.indexIdentityClassification(cached);
      if (classification === 'match' || classification === 'tier-only-upgrade') {
        const served = this.serveClassifiedIndex(cached, classification, lease);
        if (served !== null) {
          return served;
        }
      }

      this.snapshotStore.clear();
      this.clearServedIndex();
      this.fallbackCacheActive = false;
      this.requestProjectionReconcile('incompatible');
    }

    const loaded = await this.snapshotStore.loadReadOnly({
      currentKiwiAnalyzer: () => lease.analyzer,
    });
    if (loaded !== null) {
      const classification = this.indexIdentityClassification(loaded);
      if (classification === 'match' || classification === 'tier-only-upgrade') {
        const served = this.serveClassifiedIndex(loaded, classification, lease);
        if (served !== null) {
          return served;
        }
      }

      this.snapshotStore.clear();
      this.clearServedIndex();
      this.fallbackCacheActive = false;
      this.requestProjectionReconcile('incompatible');
    }

    this.warningSet.add(FTS_INDEX_UNINITIALIZED_WARNING);
    this.warningSet.delete(FTS_INDEX_STALE_TIER_WARNING);
    this.requestProjectionReconcile('incompatible');
    const created = await createOramaDb({
      currentKiwiAnalyzer: () => lease.analyzer,
    });
    this.snapshotStore.install({ ...created, fallback: true });
    const served = this.activateServedIndex({ ...created, fallback: true }, lease);
    this.fallbackCacheActive = true;
    if (served === null) {
      throw new Error('fallback Orama index activation failed');
    }
    return served;
  }

  probeFreshness(): void {
    const cached = this.snapshotStore.getCache();
    if (cached !== null && cached.fallback !== true && this.indexIdentityClassification(cached) === 'match') {
      this.markMatchedServedIndex();
      this.fallbackCacheActive = false;
      return;
    }
    if (this.fallbackCacheActive) {
      this.warningSet.add(FTS_INDEX_UNINITIALIZED_WARNING);
      this.warningSet.delete(FTS_INDEX_STALE_TIER_WARNING);
      return;
    }
    if (this.snapshotStore.hasPersistedSnapshot()) {
      this.warningSet.delete(FTS_INDEX_UNINITIALIZED_WARNING);
      this.fallbackCacheActive = false;
      return;
    }
    if (this.snapshotStore.hasCache() && !this.fallbackCacheActive) {
      this.warningSet.delete(FTS_INDEX_UNINITIALIZED_WARNING);
      return;
    }
    this.warningSet.add(FTS_INDEX_UNINITIALIZED_WARNING);
    this.warningSet.delete(FTS_INDEX_STALE_TIER_WARNING);
  }

  async search(query: string, topK: number, scope?: RetrievalScope): Promise<FtsSearchResult> {
    const safeTopK = topK > 0 ? topK : 1;
    const term = normalizeOramaTerm(query);
    if (!term) {
      return { hits: [], exhausted: true };
    }

    return this.withAnalyzerLease(async (lease) => {
      const { db } = await this.ensureServedIndex(lease);
      const limit = Math.max(safeTopK * 5, safeTopK);

      const response = await oramaSearch(db, {
        term,
        properties: ORAMA_SEARCH_PROPERTIES,
        boost: ORAMA_SEARCH_BOOST,
        limit,
      });

      const filtered: Array<{ document: KbOramaDocument; score: number }> = [];
      for (const hit of response.hits) {
        const document = hit.document as KbOramaDocument;
        if (scopeAllowsKind(scope, document.kind)) {
          filtered.push({ document, score: hit.score });
        }
      }
      filtered.sort((left, right) =>
        compareScoreAndEntryId(
          { score: left.score, entryId: left.document.entryId },
          { score: right.score, entryId: right.document.entryId },
        ),
      );

      const exhausted = response.hits.length < limit;
      const hits: FtsHit[] = [];
      for (let index = 0; index < filtered.length && index < safeTopK; index += 1) {
        const hit = filtered[index];
        if (hit !== undefined) {
          hits.push({
            documentId: hit.document.entryId,
            score: hit.score,
            fields: toRetrievedDocument(hit.document),
          });
        }
      }

      return { hits, exhausted };
    });
  }

  async tokenize(text: string): Promise<readonly string[]> {
    const [tokens] = await this.tokenizeBatch([text]);
    return tokens ?? [];
  }

  async tokenizeBatch(texts: readonly string[]): Promise<readonly (readonly string[])[]> {
    if (texts.length === 0) {
      return [];
    }
    return this.withAnalyzerLease(async (lease) => {
      const tokenizer = await this.tokenizerProbe(lease);
      return texts.map((text) => tokenizeQuery(normalizeOramaTerm(text), tokenizer));
    });
  }

  warnings(): readonly string[] {
    this.probeFreshness();
    return [...this.warningSet];
  }

  private async tokenizerProbe(lease: OramaAnalyzerLeaseContext): Promise<KbOramaTokenizer> {
    const cached = this.snapshotStore.getCache();
    const classification = cached === null ? 'incompatible' : this.indexIdentityClassification(cached);
    if (
      cached !== null &&
      this.servedIndex !== null &&
      (classification === 'match' || classification === 'tier-only-upgrade') &&
      cached.db === this.servedIndex.db
    ) {
      return this.servedIndex.snippetTokenizer;
    }
    return (await this.ensureServedIndex(lease)).snippetTokenizer;
  }

  private async withAnalyzerLease<T>(run: (lease: OramaAnalyzerLeaseContext) => T | Promise<T>): Promise<T> {
    const manager = this.options.analyzerManager;
    const runtime = this.options.runtime;
    if (manager === undefined || runtime === undefined) {
      return run({ analyzer: null, activeAnalyzers: [] });
    }

    const execute = () =>
      manager.withAnalyzerLease(this.options.kiwiRuntime, readDeclaredAnalyzers(runtime), (lease) => run(lease));
    try {
      return await execute();
    } catch (error: unknown) {
      if (manager.isTerminalLoadError?.(error) !== true) {
        throw error;
      }
      this.requestProjectionReconcile('terminal-analyzer-failure');
      return execute();
    }
  }
}

/**
 * Coordinator-facing Orama projection that serves lexical search through the
 * engine-blind FTS contract. Owns its own snapshot store (Expansion-internal
 * state) so the KB runtime stays engine-blind.
 */
export class OramaBaseProjection implements CorpusConsumerRegistration {
  readonly id = ORAMA_BASE_CONSUMER_ID;
  readonly authority = 'corpus';
  readonly corpusInterest = 'both';
  readonly kind = 'apply';
  readonly projectionSync = 'text-index';
  registrationKind: 'base' | 'expansion' = 'base';
  onApplyFailure?: (error: ConsumerApplyError) => void;
  private readonly searchPort: OramaSearchPort;
  private readonly kiwiRuntime?: Runtime;
  private readonly analyzerManager: OramaAnalyzerManager;
  private readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;

  private readonly runtime: KbEngineRuntimeBase;
  private readonly snapshotStore: OramaSnapshotStore;
  constructor(
    runtime: KbEngineRuntimeBase,
    snapshotStore: OramaSnapshotStore,
    options: OramaBaseProjectionOptions = {},
  ) {
    this.runtime = runtime;
    this.snapshotStore = snapshotStore;
    this.kiwiRuntime = options.kiwiRuntime;
    this.analyzerManager = options.analyzerManager ?? NOOP_ANALYZER_MANAGER;
    this.requestProjectionReconcile = options.requestProjectionReconcile;
    // Apply-time failures are supplemental; primary tier reconciliation is requested by the coordinator callback.
    this.onApplyFailure =
      options.onApplyFailure ??
      (options.requestProjectionReconcile === undefined
        ? undefined
        : () => options.requestProjectionReconcile?.('terminal-analyzer-failure'));
    this.snapshotStore.setCurrentKiwiAnalyzer(() => this.analyzerManager.currentAnalyzer());
    this.searchPort = this.createSearchPort();
  }

  async apply(ctx: CorpusConsumerApplyContext): Promise<void> {
    await this.withAnalyzerLease((lease) => this.installLatestCoalescedSnapshot(ctx, lease));
  }

  async ensureLoaded(): Promise<OramaLoadedIndex> {
    return this.searchPort.ensureLoaded();
  }

  /**
   * Eager freshness probe. Search reads never rebuild or persist Orama
   * artifacts; a missing persisted snapshot surfaces degraded search until the
   * next corpus apply materializes it.
   */
  probeFreshness(): void {
    this.searchPort.probeFreshness();
  }

  /** Single-shot ranked lexical search; KB-tier owns the widening loop. */
  async search(query: string, topK: number, scope?: RetrievalScope): Promise<FtsSearchResult> {
    return this.searchPort.search(query, topK, scope);
  }

  /** Engine tokenizer pipeline; used for snippet anchoring. */
  tokenize(text: string): Promise<readonly string[]> {
    return this.searchPort.tokenize(text);
  }

  tokenizeBatch(texts: readonly string[]): Promise<readonly (readonly string[])[]> {
    return this.searchPort.tokenizeBatch(texts);
  }

  warnings(): readonly string[] {
    return this.searchPort.warnings();
  }

  getSearchPort(): OramaSearchPort {
    return this.searchPort;
  }

  createSearchPort(): OramaSearchPort {
    return new OramaSearchPort(this.snapshotStore, {
      runtime: this.runtime,
      kiwiRuntime: this.kiwiRuntime,
      analyzerManager: this.analyzerManager,
      projectionIdentityInput: () => this.projectionIdentityInput(),
      requestProjectionReconcile: this.requestProjectionReconcile,
    });
  }

  private projectionIdentityInput(): OramaProjectionIdentityInput {
    const declaredAnalyzers = readDeclaredAnalyzers(this.runtime);
    return createOramaProjectionIdentityInput(
      declaredAnalyzers,
      this.analyzerManager.effectiveDeclaredAnalyzers(declaredAnalyzers, this.kiwiRuntime),
    );
  }

  private projectionIdentityHash(): string {
    return ORAMA_PROJECTION_IDENTITY_HASH(this.projectionIdentityInput());
  }

  /** Builds a complete projection from KB-materialized corpus input. */
  async prepareFullSnapshot(input: KbProjectionInput): Promise<PreparedOramaProjection> {
    return this.prepareFullSnapshotFromDocuments(this.prepareCurrentDocumentMap(input));
  }

  private async prepareFullSnapshotFromDocuments(
    currentByEntryId: CurrentOramaDocumentMap,
    lease?: OramaAnalyzerLeaseContext,
  ): Promise<PreparedOramaProjection> {
    const { db, tokenizer } = await createOramaDb({
      currentKiwiAnalyzer: () => lease?.analyzer ?? this.analyzerManager.currentAnalyzer(),
    });

    return {
      db,
      tokenizer,
      documents: [...currentByEntryId.values()],
    };
  }

  async installFullSnapshot(snapshot: KbCorpusSnapshot, preparedProjection: PreparedOramaProjection): Promise<void> {
    await this.withAnalyzerLease(() => this.installFullSnapshotUnlocked(snapshot, preparedProjection));
  }

  private async installFullSnapshotUnlocked(
    snapshot: KbCorpusSnapshot,
    preparedProjection: PreparedOramaProjection,
  ): Promise<void> {
    if (preparedProjection.documents.length > 0) {
      await insertMultiple(preparedProjection.db, preparedProjection.documents);
    }
    const identityInput = this.projectionIdentityInput();
    if (await this.shouldSkipStaleProjectionWrite(snapshot, ORAMA_PROJECTION_IDENTITY_HASH(identityInput))) {
      this.searchPort.probeFreshness();
      return;
    }
    const metadata = this.snapshotStore.persist(snapshot, preparedProjection.db, identityInput);
    this.snapshotStore.install({
      db: preparedProjection.db,
      tokenizer: preparedProjection.tokenizer,
      metadata,
    });
    this.searchPort.probeFreshness();
  }

  /**
   * Metadata-lane bursts can publish newer snapshots while Orama rebuilds.
   * Keep apply awaited until the installed artifact catches up; the driver
   * advances the consumer cursor only after this method returns.
   */
  private async installLatestCoalescedSnapshot(
    ctx: CorpusConsumerApplyContext,
    lease: OramaAnalyzerLeaseContext,
  ): Promise<void> {
    const { snapshot, projectionInput } = await this.resolveLatestSettledProjectionInput(ctx);
    const currentByEntryId = this.prepareCurrentDocumentMap(projectionInput);
    const loaded = await this.loadPersistedDeltaBase(lease);
    if (loaded === null) {
      await this.installFullSnapshot(snapshot, await this.prepareFullSnapshotFromDocuments(currentByEntryId, lease));
      return;
    }

    const persistedSnapshot = this.snapshotFromMetadata(loaded.metadata);
    if (!isSnapshotFresherForInterest(snapshot, persistedSnapshot, this.corpusInterest)) {
      this.snapshotStore.install(loaded);
      this.searchPort.probeFreshness();
      return;
    }

    if (this.requiresFullInstallFromManifest(loaded.metadata.entryManifest, currentByEntryId)) {
      await this.installFullSnapshot(snapshot, await this.prepareFullSnapshotFromDocuments(currentByEntryId, lease));
      return;
    }

    try {
      await this.applyDeltaFromManifest(loaded.db, loaded.metadata.entryManifest, currentByEntryId);
    } catch {
      await this.installFullSnapshot(snapshot, await this.prepareFullSnapshotFromDocuments(currentByEntryId, lease));
      return;
    }

    const identityInput = this.projectionIdentityInput();
    if (await this.shouldSkipStaleProjectionWrite(snapshot, ORAMA_PROJECTION_IDENTITY_HASH(identityInput))) {
      this.searchPort.probeFreshness();
      return;
    }
    const metadata = this.snapshotStore.persist(snapshot, loaded.db, identityInput);
    this.snapshotStore.install({
      db: loaded.db,
      tokenizer: loaded.tokenizer,
      metadata,
    });
    this.searchPort.probeFreshness();
  }

  private latestSnapshot(left: KbCorpusSnapshot, right: KbCorpusSnapshot): KbCorpusSnapshot {
    if (isSnapshotFresherForInterest(right, left, this.corpusInterest)) {
      return { ...right };
    }
    return { ...left };
  }

  private async shouldSkipStaleProjectionWrite(
    sourceSnapshot: KbCorpusSnapshot,
    targetProjectionIdentityHash: string,
  ): Promise<boolean> {
    const cached = this.snapshotStore.getCache();
    if (cached?.metadata !== undefined) {
      if (
        this.shouldSkipProjectionWriteAgainstMetadata(cached.metadata, sourceSnapshot, targetProjectionIdentityHash)
      ) {
        return true;
      }
    }

    try {
      return this.shouldSkipProjectionWriteAgainstMetadata(
        this.snapshotStore.loadMetadata(),
        sourceSnapshot,
        targetProjectionIdentityHash,
      );
    } catch {
      // A missing or unreadable persisted artifact is handled by the normal write path.
      return false;
    }
  }

  private shouldSkipProjectionWriteAgainstMetadata(
    persistedMetadata: OramaProjectionMetadata,
    sourceSnapshot: KbCorpusSnapshot,
    targetProjectionIdentityHash: string,
  ): boolean {
    const persistedSnapshot = this.snapshotFromMetadata(persistedMetadata);
    if (this.isSnapshotStrictlyFresherForInterest(persistedSnapshot, sourceSnapshot)) {
      return true;
    }

    return (
      persistedMetadata.projectionIdentityHash === targetProjectionIdentityHash &&
      this.snapshotsMatchForInterest(persistedSnapshot, sourceSnapshot)
    );
  }

  private isSnapshotStrictlyFresherForInterest(candidate: KbCorpusSnapshot, source: KbCorpusSnapshot): boolean {
    return (
      isSnapshotFresherForInterest(candidate, source, this.corpusInterest) &&
      !isSnapshotFresherForInterest(source, candidate, this.corpusInterest)
    );
  }

  // Orama has "both" corpus interest; this intentionally compares every snapshot field.
  private snapshotsMatchForInterest(left: KbCorpusSnapshot, right: KbCorpusSnapshot): boolean {
    return (
      left.snapshotId === right.snapshotId &&
      left.contentSeq === right.contentSeq &&
      left.metadataSeq === right.metadataSeq &&
      left.contentManifestHash === right.contentManifestHash &&
      left.metadataManifestHash === right.metadataManifestHash
    );
  }

  private async resolveLatestSettledProjectionInput(ctx: CorpusConsumerApplyContext): Promise<{
    snapshot: KbCorpusSnapshot;
    projectionInput: KbProjectionInput;
  }> {
    let selectedSnapshot = this.latestSnapshot(ctx.snapshot, ctx.corpusStateReader.readCurrentSnapshot());
    let projectionInput =
      selectedSnapshot.snapshotId === ctx.snapshot.snapshotId
        ? ctx.projectionInput
        : await this.runtime.corpusProjectionReader.prepareCurrentProjectionInput({ signal: ctx.signal });

    while (true) {
      const settledSnapshot = this.latestSnapshot(selectedSnapshot, ctx.corpusStateReader.readCurrentSnapshot());
      if (settledSnapshot.snapshotId === selectedSnapshot.snapshotId) {
        return { snapshot: selectedSnapshot, projectionInput };
      }

      selectedSnapshot = settledSnapshot;
      projectionInput = await this.runtime.corpusProjectionReader.prepareCurrentProjectionInput({ signal: ctx.signal });
    }
  }

  private async loadPersistedDeltaBase(
    lease: OramaAnalyzerLeaseContext,
  ): Promise<(KbCachedOramaIndex & { metadata: OramaProjectionMetadata }) | null> {
    try {
      const loaded = await this.snapshotStore.load({
        currentKiwiAnalyzer: () => lease.analyzer,
      });
      if (loaded.metadata?.projectionIdentityHash !== this.projectionIdentityHash()) {
        return null;
      }
      return loaded as KbCachedOramaIndex & { metadata: OramaProjectionMetadata };
    } catch {
      return null;
    }
  }

  private snapshotFromMetadata(metadata: OramaProjectionMetadata): KbCorpusSnapshot {
    return {
      snapshotId: metadata.snapshotId,
      contentSeq: metadata.contentSeq,
      metadataSeq: metadata.metadataSeq,
      contentManifestHash: metadata.contentManifestHash,
      metadataManifestHash: metadata.metadataManifestHash,
    };
  }

  private prepareCurrentDocumentMap(input: KbProjectionInput): CurrentOramaDocumentMap {
    const documents = this.materializeDocuments(input.records, input.communityFresh);
    const byEntryId = new Map<string, KbOramaDocument>();
    for (const document of documents) {
      byEntryId.set(document.entryId, document);
    }
    return byEntryId;
  }

  private requiresFullInstallFromManifest(
    previousManifest: OramaEntryManifest,
    currentByEntryId: CurrentOramaDocumentMap,
  ): boolean {
    const entryIds = new Set([...Object.keys(previousManifest), ...currentByEntryId.keys()]);
    for (const entryId of entryIds) {
      const previous = previousManifest[entryId];
      const current = currentByEntryId.get(entryId);
      // Orama materializes note/source/wiki/community; community is its only unstructured full-install kind.
      if (previous?.kind !== 'community' && current?.kind !== 'community') {
        continue;
      }

      const previousMetadataHash = previous?.metadataHash ?? null;
      const currentMetadataHash = current?.metadataHash ?? null;
      if (previousMetadataHash !== currentMetadataHash) {
        return true;
      }
    }
    return false;
  }

  private async applyDeltaFromManifest(
    db: KbOramaDb,
    previousManifest: OramaEntryManifest,
    currentByEntryId: CurrentOramaDocumentMap,
  ): Promise<void> {
    const replacementDocuments: KbOramaDocument[] = [];
    const insertDocuments: KbOramaDocument[] = [];

    for (const entryId of Object.keys(previousManifest).sort((left, right) => left.localeCompare(right))) {
      const previous = previousManifest[entryId];
      if (previous === undefined) {
        continue;
      }

      const current = currentByEntryId.get(entryId);
      if (current === undefined) {
        await this.removePersistedDocument(db, previous);
        continue;
      }

      if (!this.manifestEntryMatchesDocument(previous, current)) {
        await this.removePersistedDocument(db, previous);
        replacementDocuments.push(current);
      }
    }

    for (const entryId of currentByEntryId.keys()) {
      if (previousManifest[entryId] !== undefined) {
        continue;
      }
      const document = currentByEntryId.get(entryId);
      if (document !== undefined) {
        insertDocuments.push(document);
      }
    }

    for (const document of [...replacementDocuments, ...insertDocuments]) {
      await insert(db, document);
    }
  }

  private async withAnalyzerLease<T>(run: (lease: OramaAnalyzerLeaseContext) => T | Promise<T>): Promise<T> {
    const execute = () =>
      this.analyzerManager.withAnalyzerLease(this.kiwiRuntime, readDeclaredAnalyzers(this.runtime), (lease) =>
        run(lease),
      );
    try {
      return await execute();
    } catch (error: unknown) {
      if (this.analyzerManager.isTerminalLoadError?.(error) !== true) {
        throw error;
      }
      return execute();
    }
  }

  private manifestEntryMatchesDocument(previous: OramaEntryManifestEntry, current: KbOramaDocument): boolean {
    return (
      previous.documentId === current.id &&
      previous.contentHash === current.contentHash &&
      previous.metadataHash === current.metadataHash &&
      previous.kind === current.kind &&
      previous.freshness === current.freshness
    );
  }

  private async removePersistedDocument(db: KbOramaDb, previous: OramaEntryManifestEntry): Promise<void> {
    const removed = await remove(db, previous.documentId);
    if (!removed) {
      throw new Error(`projection manifest document ${previous.documentId} is missing from the Orama db`);
    }
  }

  private materializeDocuments(records: readonly KbProjectionRecord[], communityFresh: boolean): KbOramaDocument[] {
    return records.map((record) => {
      if (record.kind === 'note') {
        return toOramaDocument(
          {
            note: record.entry.slug,
            path: `notes/${record.entry.slug}.md`,
            domain: record.entry.slug.split('-')[0] ?? record.entry.slug,
            title: record.entry.title,
            body: record.body,
            tags: record.entry.tags,
            principles: record.entry.principles,
            source: record.entry.source,
            createdAt: record.entry.createdAt,
            updatedAt: record.entry.updatedAt,
            ...(record.entry.entrySeq === undefined ? {} : { entrySeq: record.entry.entrySeq }),
            ...(record.entry.related === undefined ? {} : { related: record.entry.related }),
          },
          {
            contentHash: computeContentSurfaceHash({
              title: record.entry.title,
              body: record.body,
            }),
            metadataHash: noteMetadataHash(record.entry),
          },
        );
      }

      if (record.kind === 'source') {
        return toOramaDocument(
          {
            slug: record.entry.slug,
            path: `sources/${record.entry.slug}.md`,
            title: record.entry.title,
            body: record.body,
            type: record.entry.type,
            tags: record.entry.tags,
            ...(record.entry.url === undefined ? {} : { url: record.entry.url }),
            importedAt: record.entry.importedAt,
            ...(record.entry.entrySeq === undefined ? {} : { entrySeq: record.entry.entrySeq }),
            ...(record.entry.related === undefined ? {} : { related: record.entry.related }),
          },
          {
            contentHash: computeContentSurfaceHash({
              title: record.entry.title,
              body: record.body,
            }),
            metadataHash: sourceMetadataHash(record.entry),
          },
        );
      }

      if (record.kind === 'wiki') {
        return toOramaDocument(
          {
            slug: record.entry.slug,
            path: `wiki/${record.entry.slug}.md`,
            title: record.entry.title,
            body: record.body,
            tags: record.entry.tags,
            createdAt: record.entry.createdAt,
            updatedAt: record.entry.updatedAt,
            knowledge: record.entry.knowledge,
          },
          {
            contentHash: computeContentSurfaceHash({
              title: record.entry.title,
              body: record.body,
            }),
            metadataHash: wikiMetadataHash(record.entry),
          },
        );
      }

      return toOramaDocument(
        {
          slug: record.entry.slug,
          path: `communities/${record.entry.slug}.md`,
          title: record.entry.title,
          body: record.body,
          level: record.entry.level,
          members: record.entry.members,
          ...(record.entry.parent === undefined ? {} : { parent: record.entry.parent }),
          ...(record.entry.children === undefined ? {} : { children: record.entry.children }),
          ...(record.entry.summary === undefined ? {} : { summary: record.entry.summary }),
          createdAt: record.entry.createdAt,
          updatedAt: record.entry.updatedAt,
        },
        {
          communityFresh,
          contentHash: computeContentSurfaceHash({
            title: record.entry.title,
            body: record.body,
          }),
          metadataHash: communityMetadataHash(record.rawContent),
        },
      );
    });
  }
}

/** Creates the shared Orama projection wrapper for a KB runtime. */
export function createOramaBaseProjection(
  runtime: KbEngineRuntimeBase,
  snapshotStore: OramaSnapshotStore = new OramaSnapshotStore(
    { files: runtime.projectionArtifacts.files },
    runtime.projectionArtifacts.runtimeDir,
  ),
  options: OramaBaseProjectionOptions = {},
): OramaBaseProjection {
  return new OramaBaseProjection(runtime, snapshotStore, options);
}
