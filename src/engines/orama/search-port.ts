import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { FtsRetrieval, KbEngineRuntimeBase } from '../../kb/contract.js';
import type { FtsHit, FtsSearchResult, RetrievalScope } from '../../kb/search/contract.js';
import type { Runtime } from '../../runtime/ports.js';
import {
  createOramaDb,
  createIntlOramaTokenizer,
  createOramaTokenizer,
  normalizeOramaTerm,
  tokenizeQuery,
} from './document-builder.js';
import { analyzeOramaSearchQuery } from './search-channels.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';
import { classifyProjectionMismatch, oramaProjectionTokenizerTier } from './artifact-port.js';
import type {
  OramaProjectionIdentityInput,
  OramaProjectionMetadata,
  OramaProjectionMismatchClassification,
} from './artifact-port.js';
import type { KbCachedOramaIndex, OramaSnapshotStore } from './snapshot.js';
import { readDeclaredAnalyzers, type OramaAnalyzerLeaseContext, type OramaAnalyzerManager } from './analyzer.js';
import type { OramaReconcileReason } from './constants.js';
import { collectRankedOramaSearchCandidates, toRetrievedDocument } from './ranking.js';

const FTS_INDEX_UNINITIALIZED_WARNING = 'fts_index_uninitialized';
const FTS_INDEX_STALE_TIER_WARNING = 'fts_index_stale_tier';

type OramaSearchPortOptions = {
  readonly runtime?: KbEngineRuntimeBase;
  readonly kiwiRuntime?: Runtime;
  readonly analyzerManager?: OramaAnalyzerManager;
  readonly projectionIdentityInput?: () => OramaProjectionIdentityInput;
  readonly requestProjectionReconcile?: (reason: OramaReconcileReason) => void;
};

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
      const served = await this.ensureServedIndex(lease);
      const limit = Math.max(safeTopK * 10, 50);
      const analysis = analyzeOramaSearchQuery(term, tokenizeQuery(term, served.dbTokenizer));
      const collected = await collectRankedOramaSearchCandidates(served.db, analysis, limit, scope);

      const hits: FtsHit[] = [];
      for (let index = 0; index < collected.ranked.length && index < safeTopK; index += 1) {
        const candidate = collected.ranked[index];
        if (candidate !== undefined) {
          hits.push({
            documentId: candidate.document.entryId,
            score: candidate.score,
            fields: toRetrievedDocument(candidate.document),
          });
        }
      }

      return { hits, exhausted: collected.exhausted };
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
