import { insertMultiple, search as oramaSearch } from '@orama/orama';
import { readFileSync } from 'node:fs';

import type {
  ConsumerApplyError,
  CorpusConsumerApplyContext,
  CorpusConsumerRegistration,
  KbCorpusSnapshot,
  KbRuntime,
} from '../../kb/contract.js';
import {
  computeContentSurfaceHash,
  computeMetadataSurfaceHash,
} from '../../kb/corpus/snapshot.js';
import { areCommunityDocumentsFresh } from '../../kb/curate/community/freshness.js';
import type { CommunityDocument } from '../../kb/curate/community/detection.js';
import { extractBody, parseCommunityFrontmatter } from '../../kb/corpus/frontmatter.js';
import { cloneKbIndex } from '../../kb/corpus/index-records.js';
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
import { loadKbNote, loadKbSource } from '../../kb/read.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import type {
  FtsHit,
  FtsSearchResult,
  RetrievedDocument,
  RetrievalScope,
} from '../../kb/search/contract.js';
import {
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
  type CommunityEntry,
  type KbIndex,
  type NoteEntry,
  type SourceEntry,
} from '../../kb/entry-types.js';

export {
  createOramaDb,
  normalizeHyphens,
  normalizeOramaTerm,
  normalizeWhitespace,
  tokenizeField,
  tokenizeQuery,
  toOramaDocument,
  type KbOramaDocument,
} from './document-builder.js';
export { ORAMA_SCHEMA, type KbOramaDb, type KbOramaTokenizer } from './schema.js';
export { OramaSnapshotStore } from './snapshot.js';

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

type ProjectionRecord =
  | {
      kind: 'note';
      entry: NoteEntry;
      body: string;
    }
  | {
      kind: 'source';
      entry: SourceEntry;
      body: string;
    }
  | {
      kind: 'community';
      entry: CommunityEntry;
      body: string;
      rawContent: string;
    };

export interface PreparedOramaProjection {
  index: KbIndex;
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

/**
 * Coordinator-facing Orama projection that serves lexical search through the
 * engine-blind FTS contract. Owns its own snapshot store (Expansion-internal
 * state) so KbRuntime stays engine-blind.
 */
export class OramaBaseProjection implements CorpusConsumerRegistration {
  readonly id = ORAMA_BASE_CONSUMER_ID;
  readonly authority = 'corpus';
  readonly corpusInterest = 'content';
  onApplyFailure?: (error: ConsumerApplyError) => void;
  private readonly warningSet = new Set<string>();

  constructor(
    private readonly runtime: KbRuntime,
    private readonly snapshotStore: OramaSnapshotStore,
  ) {}

  async apply(ctx: CorpusConsumerApplyContext): Promise<void> {
    // Spec §12.3 lazy non-blocking rescan: kick a background rebuild on
    // staleness but project against the current index now. A subsequent
    // notify-cycle will pick up the rebuilt index when it lands.
    await this.runtime.ensureCorpusFreshness({ wait: false });
    const preparedProjection = await this.prepareFullSnapshotForCurrentCorpus();
    await this.installFullSnapshot(ctx.snapshot, preparedProjection);
    this.runtime.recordIndexSyncSuccess();
  }

  /**
   * Loads the current Orama index artifacts. If no snapshot exists but the KB
   * index is populated, auto-rebuilds from the canonical index — preserves
   * "search works zero-config after a fresh boot or empty cache" behaviour.
   */
  async ensureLoaded(): Promise<OramaLoadedIndex> {
    const cached = this.snapshotStore.getCache();
    if (cached !== null) {
      this.warningSet.delete('fts_index_uninitialized');
      return cached;
    }

    const loaded = await this.snapshotStore.loadIfPresent();
    if (loaded !== null) {
      this.warningSet.delete('fts_index_uninitialized');
      return loaded;
    }

    const currentIndex = this.runtime.readIndex();
    if (currentIndex !== null && Object.keys(currentIndex.entries).length > 0) {
      const prepared = await this.prepareFullSnapshotForCurrentCorpus(currentIndex);
      await this.installFullSnapshot(this.runtime.captureCorpusSnapshot(), prepared);
      const rebuilt = this.snapshotStore.getCache();
      if (rebuilt !== null) {
        this.warningSet.delete('fts_index_uninitialized');
        return rebuilt;
      }
    }

    this.warningSet.add('fts_index_uninitialized');
    const created = await createOramaDb();
    this.snapshotStore.install(created);
    return created;
  }

  /**
   * Eager freshness probe. Reports `'fts_index_uninitialized'` only when there
   * is neither an in-memory cache nor a persisted snapshot AND no KB index to
   * auto-rebuild from — matches the pre-rewrite degraded-search behaviour.
   */
  probeFreshness(): void {
    if (this.snapshotStore.hasCache()) {
      this.warningSet.delete('fts_index_uninitialized');
      return;
    }
    if (this.snapshotStore.hasPersistedSnapshot()) {
      this.warningSet.delete('fts_index_uninitialized');
      return;
    }
    const currentIndex = this.runtime.readIndex();
    if (currentIndex !== null && Object.keys(currentIndex.entries).length > 0) {
      this.warningSet.delete('fts_index_uninitialized');
      return;
    }
    this.warningSet.add('fts_index_uninitialized');
  }

  /** Single-shot ranked lexical search; KB-tier owns the widening loop. */
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

  /** Engine tokenizer pipeline; used for snippet anchoring. */
  tokenize(text: string): readonly string[] {
    const tokenizer = this.tokenizerProbe();
    return tokenizeQuery(normalizeOramaTerm(text), tokenizer);
  }

  /**
   * Returns a tokenizer for synchronous callers. Lazily creates one if no
   * snapshot has materialized yet — the ENGLISH stemmer is configuration-only,
   * matching what `createOramaDb` produces.
   */
  private tokenizerProbe(): KbOramaTokenizer {
    const cached = this.snapshotStore.getCache();
    if (cached !== null) {
      return cached.tokenizer;
    }
    this.lazyTokenizer ??= createOramaTokenizer();
    return this.lazyTokenizer;
  }

  private lazyTokenizer: KbOramaTokenizer | null = null;

  warnings(): readonly string[] {
    this.probeFreshness();
    return [...this.warningSet];
  }

  /** Materializes a full Orama projection from the current runtime corpus view. */
  async prepareFullSnapshotForCurrentCorpus(
    index: KbIndex = this.runtime.readIndexOrEmpty(),
  ): Promise<PreparedOramaProjection> {
    return this.prepareFullSnapshotForProjectedIndex({ index });
  }

  /** Builds a complete projection from a provided index, optionally injecting generated community docs. */
  async prepareFullSnapshotForProjectedIndex(params: {
    index: KbIndex;
    generatedCommunityDocs?: readonly CommunityDocument[];
    forceCommunityFresh?: boolean;
  }): Promise<PreparedOramaProjection> {
    const nextIndex = cloneKbIndex(params.index);
    const { db, tokenizer } = await createOramaDb();
    const documents = this.buildDocumentsForIndex(
      nextIndex,
      params.generatedCommunityDocs,
      params.forceCommunityFresh,
    );

    return {
      index: nextIndex,
      db,
      tokenizer,
      documents,
    };
  }

  async installFullSnapshot(snapshot: KbCorpusSnapshot, preparedProjection: PreparedOramaProjection): Promise<void> {
    void snapshot;

    if (preparedProjection.documents.length > 0) {
      await insertMultiple(preparedProjection.db, preparedProjection.documents);
    }
    this.runtime.writeIndex(preparedProjection.index);
    this.snapshotStore.persist(preparedProjection.db);
    this.snapshotStore.install({
      db: preparedProjection.db,
      tokenizer: preparedProjection.tokenizer,
    });
    this.warningSet.delete('fts_index_uninitialized');
  }

  private buildDocumentsForIndex(
    index: KbIndex,
    generatedCommunityDocs: readonly CommunityDocument[] = [],
    forceCommunityFresh?: boolean,
  ): KbOramaDocument[] {
    const generatedCommunityDocsBySlug = new Map(
      generatedCommunityDocs.map((document) => [document.slug, document] as const),
    );
    const communityFresh = forceCommunityFresh ?? areCommunityDocumentsFresh(this.runtime, index);

    const records = Object.entries(index.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => this.loadProjectionRecord(entry, generatedCommunityDocsBySlug))
      .filter((record): record is ProjectionRecord => record !== null);

    return this.materializeDocuments(records, communityFresh);
  }

  private materializeDocuments(
    records: readonly ProjectionRecord[],
    communityFresh: boolean,
  ): KbOramaDocument[] {
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

  private loadProjectionRecord(
    entry: KbIndex['entries'][string] | undefined,
    generatedCommunityDocs: ReadonlyMap<string, CommunityDocument> = new Map(),
  ): ProjectionRecord | null {
    if (entry === undefined) {
      return null;
    }

    if (isNoteEntry(entry)) {
      let loaded: ReturnType<typeof loadKbNote>;
      try {
        loaded = loadKbNote(this.runtime.storagePort, this.runtime.notePath(entry.slug));
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          return null;
        }
        throw error;
      }
      return {
        kind: 'note',
        entry,
        body: loaded.body,
      };
    }

    if (isSourceEntry(entry)) {
      let loaded: ReturnType<typeof loadKbSource>;
      try {
        loaded = loadKbSource(this.runtime.storagePort, this.runtime.sourcePath(entry.slug));
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          return null;
        }
        throw error;
      }
      return {
        kind: 'source',
        entry,
        body: loaded.body,
      };
    }

    if (!isCommunityEntry(entry)) {
      return null;
    }

    const generated = generatedCommunityDocs.get(entry.slug);
    if (generated !== undefined) {
      return {
        kind: 'community',
        entry,
        body: extractBody(generated.content),
        rawContent: generated.content,
      };
    }

    const raw = readFileSync(this.runtime.communityPath(entry.slug), 'utf-8');
    parseCommunityFrontmatter(raw);
    return {
      kind: 'community',
      entry,
      body: extractBody(raw),
      rawContent: raw,
    };
  }
}

/** Creates the shared Orama projection wrapper for a KB runtime. */
export function createOramaBaseProjection(
  runtime: KbRuntime,
  snapshotStore: OramaSnapshotStore = new OramaSnapshotStore(
    { storage: runtime.storagePort, ids: runtime.ids },
    runtime.runtimeDir,
  ),
): OramaBaseProjection {
  return new OramaBaseProjection(runtime, snapshotStore);
}
