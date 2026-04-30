import { insertMultiple, search as oramaSearch } from '@orama/orama';

import type {
  ConsumerApplyError,
  CorpusConsumerApplyContext,
  CorpusConsumerRegistration,
  FtsRetrieval,
  KbEngineRuntimeBase,
  KbCorpusSnapshot,
  KbProjectionInput,
  KbProjectionRecord,
} from '../../kb/contract.js';
import { computeContentSurfaceHash, computeMetadataSurfaceHash } from '../../kb/corpus/snapshot.js';
import { noteMetadataHash, sourceMetadataHash } from '../../kb/metadata-hash.js';
import {
  createOramaDb,
  createOramaTokenizer,
  normalizeOramaTerm,
  toOramaDocument,
  tokenizeQuery,
  type KbOramaDocument,
} from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';
import { OramaSnapshotStore } from './snapshot.js';
import type { FtsHit, FtsSearchResult, RetrievedDocument, RetrievalScope } from '../../kb/search/contract.js';

export {
  createOramaDb,
  normalizeOramaTerm,
  tokenizeQuery,
  toOramaDocument,
  type KbOramaDocument,
} from './document-builder.js';
export { type KbOramaDb, type KbOramaTokenizer } from './schema.js';

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

export interface PreparedOramaProjection {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
  documents: KbOramaDocument[];
}

export interface OramaLoadedIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
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
  private fallbackCacheActive = false;
  private lazyTokenizer: KbOramaTokenizer | null = null;

  constructor(private readonly snapshotStore: OramaSnapshotStore) {}

  async ensureLoaded(): Promise<OramaLoadedIndex> {
    const cached = this.snapshotStore.getCache();
    if (cached !== null && !(this.fallbackCacheActive && this.snapshotStore.hasPersistedSnapshot())) {
      if (!this.fallbackCacheActive) {
        this.warningSet.delete('fts_index_uninitialized');
      }
      return cached;
    }

    if (this.fallbackCacheActive && this.snapshotStore.hasPersistedSnapshot()) {
      this.snapshotStore.clear();
    }

    const loaded = await this.snapshotStore.loadReadOnly();
    if (loaded !== null) {
      this.fallbackCacheActive = false;
      this.warningSet.delete('fts_index_uninitialized');
      return loaded;
    }

    this.warningSet.add('fts_index_uninitialized');
    const created = await createOramaDb();
    this.snapshotStore.install(created);
    this.fallbackCacheActive = true;
    return created;
  }

  probeFreshness(): void {
    if (this.snapshotStore.hasPersistedSnapshot()) {
      this.warningSet.delete('fts_index_uninitialized');
      this.fallbackCacheActive = false;
      return;
    }
    if (this.snapshotStore.hasCache() && !this.fallbackCacheActive) {
      this.warningSet.delete('fts_index_uninitialized');
      return;
    }
    this.warningSet.add('fts_index_uninitialized');
  }

  async search(query: string, topK: number, scope?: RetrievalScope): Promise<FtsSearchResult> {
    const safeTopK = topK > 0 ? topK : 1;
    const term = normalizeOramaTerm(query);
    if (!term) {
      return { hits: [], exhausted: true };
    }

    const { db } = await this.ensureLoaded();
    const limit = Math.max(safeTopK * 5, safeTopK);

    const response = await oramaSearch(db, {
      term,
      properties: ORAMA_SEARCH_PROPERTIES,
      boost: ORAMA_SEARCH_BOOST,
      limit,
    });

    const filtered = response.hits
      .map((hit, index) => ({
        document: hit.document as KbOramaDocument,
        score: response.hits[index]?.score ?? 0,
      }))
      .filter(({ document }) => scopeAllowsKind(scope, document.kind))
      .sort((left, right) =>
        compareScoreAndEntryId(
          { score: left.score, entryId: left.document.entryId },
          { score: right.score, entryId: right.document.entryId },
        ),
      );

    const exhausted = response.hits.length < limit;
    const hits: FtsHit[] = filtered.slice(0, safeTopK).map(({ document, score }) => ({
      documentId: document.entryId,
      score,
      fields: toRetrievedDocument(document),
    }));

    return { hits, exhausted };
  }

  tokenize(text: string): readonly string[] {
    const tokenizer = this.tokenizerProbe();
    return tokenizeQuery(normalizeOramaTerm(text), tokenizer);
  }

  warnings(): readonly string[] {
    this.probeFreshness();
    return [...this.warningSet];
  }

  private tokenizerProbe(): KbOramaTokenizer {
    const cached = this.snapshotStore.getCache();
    if (cached !== null && !this.fallbackCacheActive) {
      return cached.tokenizer;
    }
    this.lazyTokenizer ??= createOramaTokenizer();
    return this.lazyTokenizer;
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
  readonly corpusInterest = 'content';
  readonly kind = 'apply';
  readonly projectionSync = 'text-index';
  registrationKind: 'base' | 'expansion' = 'base';
  onApplyFailure?: (error: ConsumerApplyError) => void;
  private readonly searchPort: OramaSearchPort;

  constructor(
    private readonly runtime: KbEngineRuntimeBase,
    private readonly snapshotStore: OramaSnapshotStore,
  ) {
    this.searchPort = new OramaSearchPort(snapshotStore);
  }

  async apply(ctx: CorpusConsumerApplyContext): Promise<void> {
    const preparedProjection = await this.prepareFullSnapshot(ctx.projectionInput);
    await this.installFullSnapshot(ctx.snapshot, preparedProjection);
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
  tokenize(text: string): readonly string[] {
    return this.searchPort.tokenize(text);
  }

  warnings(): readonly string[] {
    return this.searchPort.warnings();
  }

  createSearchPort(): OramaSearchPort {
    return new OramaSearchPort(this.snapshotStore);
  }

  /** Builds a complete projection from KB-materialized corpus input. */
  async prepareFullSnapshot(input: KbProjectionInput): Promise<PreparedOramaProjection> {
    const { db, tokenizer } = await createOramaDb();
    const documents = this.materializeDocuments(input.records, input.communityFresh);

    return {
      db,
      tokenizer,
      documents,
    };
  }

  async installFullSnapshot(snapshot: KbCorpusSnapshot, preparedProjection: PreparedOramaProjection): Promise<void> {
    if (preparedProjection.documents.length > 0) {
      await insertMultiple(preparedProjection.db, preparedProjection.documents);
    }
    this.snapshotStore.persist(snapshot, preparedProjection.db);
    this.snapshotStore.install({
      db: preparedProjection.db,
      tokenizer: preparedProjection.tokenizer,
    });
    this.searchPort.probeFreshness();
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
): OramaBaseProjection {
  return new OramaBaseProjection(runtime, snapshotStore);
}
