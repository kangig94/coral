import { insertMultiple, removeMultiple, search as oramaSearch } from '@orama/orama';
import { readFileSync } from 'node:fs';

import type { KbCorpusSnapshot, KbRuntime } from '../contracts.js';
import {
  buildRetrievalAuthorityText,
  computeContentSurfaceHash,
  computeMetadataSurfaceHash,
} from '../corpus/snapshot.js';
import { areCommunityDocumentsFresh } from '../curate/text-artifacts.js';
import type { CommunityDocument } from '../curate/community-detection.js';
import { extractBody, parseCommunityFrontmatter } from '../corpus/frontmatter.js';
import { cloneKbIndex } from '../corpus/index-records.js';
import { noteMetadataHash, sourceMetadataHash } from '../metadata-hash.js';
import { createOramaDb, normalizeOramaTerm, toOramaDocument, type KbOramaDocument } from '../orama-factory.js';
import type { KbOramaDb, KbOramaTokenizer } from '../orama-schema.js';
import { loadKbNote, loadKbSource } from '../read.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embedding.js';
import type {
  RetrievalScope,
  TextRetrieval,
  TextRetrievalResult,
  VectorRetrieval,
  VectorRetrievalResult,
} from './contract.js';
import {
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
  type KbEntryId,
  type CommunityEntry,
  type KbIndex,
  type NoteEntry,
  type SourceEntry,
} from '../entry-types.js';

export { createOramaDb, normalizeHyphens, normalizeOramaTerm, normalizeWhitespace, tokenizeField, tokenizeQuery, toOramaDocument, type KbOramaDocument } from '../orama-factory.js';
export { ORAMA_SCHEMA, type KbOramaDb, type KbOramaTokenizer } from '../orama-schema.js';

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

export interface PreparedOramaDelta {
  index: KbIndex;
  changedEntryIds: string[];
  deletedEntryIds: string[];
  documents: KbOramaDocument[];
}

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

type ScoredVectorCandidate = {
  document: KbOramaDocument;
  score: number;
};

function compareScoredVectorCandidates(left: ScoredVectorCandidate, right: ScoredVectorCandidate): number {
  return compareScoreAndEntryId(
    { score: left.score, entryId: left.document.entryId },
    { score: right.score, entryId: right.document.entryId },
  );
}

function isWorseVectorCandidate(left: ScoredVectorCandidate, right: ScoredVectorCandidate): boolean {
  return compareScoredVectorCandidates(left, right) > 0;
}

function siftWorseCandidateUp(heap: ScoredVectorCandidate[], startIndex: number): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const current = heap[index];
    const parent = heap[parentIndex];
    if (current === undefined || parent === undefined || !isWorseVectorCandidate(current, parent)) {
      break;
    }
    heap[index] = parent;
    heap[parentIndex] = current;
    index = parentIndex;
  }
}

function siftWorseCandidateDown(heap: ScoredVectorCandidate[], startIndex: number): void {
  let index = startIndex;

  while (true) {
    const leftChildIndex = index * 2 + 1;
    const rightChildIndex = leftChildIndex + 1;
    let worstIndex = index;

    if (
      leftChildIndex < heap.length &&
      heap[leftChildIndex] !== undefined &&
      heap[worstIndex] !== undefined &&
      isWorseVectorCandidate(heap[leftChildIndex], heap[worstIndex])
    ) {
      worstIndex = leftChildIndex;
    }

    if (
      rightChildIndex < heap.length &&
      heap[rightChildIndex] !== undefined &&
      heap[worstIndex] !== undefined &&
      isWorseVectorCandidate(heap[rightChildIndex], heap[worstIndex])
    ) {
      worstIndex = rightChildIndex;
    }

    if (worstIndex === index) {
      return;
    }

    const current = heap[index];
    const worst = heap[worstIndex];
    if (current === undefined || worst === undefined) {
      return;
    }
    heap[index] = worst;
    heap[worstIndex] = current;
    index = worstIndex;
  }
}

function listStoredDocuments(db: KbOramaDb): KbOramaDocument[] {
  // Orama does not expose enumerate-all publicly; documentsStore is internal but stable across minor versions.
  const store = (db as KbOramaDb & {
    documentsStore: { getAll(docs: unknown): Record<number, KbOramaDocument> };
    data: { docs: unknown };
  }).documentsStore;
  const docs = store.getAll((db as KbOramaDb & { data: { docs: unknown } }).data.docs);

  return Object.values(docs).sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function toUnitVector(values: ArrayLike<number>): Float64Array | null {
  if (values.length === 0) {
    return null;
  }

  let magnitude = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    magnitude += value * value;
  }
  if (magnitude === 0) {
    return null;
  }

  const scale = 1 / Math.sqrt(magnitude);
  const normalized = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = values[index] * scale;
  }

  return normalized;
}

function cosineSimilarity(left: Float64Array, right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index] * (right[index] ?? 0);
  }
  return total;
}

function normalizeStoredVector(values: ArrayLike<number>): number[] {
  if (values.length === 0) {
    return [];
  }

  const normalized = toUnitVector(values);
  if (normalized === null) {
    throw new Error('Embedding provider returned a zero-norm vector.');
  }

  return Array.from(normalized);
}

function collectTopKByCosine(
  documents: readonly KbOramaDocument[],
  queryVector: Float64Array,
  topK: number,
  scope?: RetrievalScope,
): ScoredVectorCandidate[] {
  if (topK <= 0) {
    return [];
  }

  const heap: ScoredVectorCandidate[] = [];

  for (const document of documents) {
    if (!scopeAllowsKind(scope, document.kind)) {
      continue;
    }
    if (document.vector.length === 0 || document.vector.length !== queryVector.length) {
      continue;
    }

    const candidate = {
      document,
      score: cosineSimilarity(queryVector, document.vector),
    };

    if (heap.length < topK) {
      heap.push(candidate);
      siftWorseCandidateUp(heap, heap.length - 1);
      continue;
    }

    const worst = heap[0];
    if (worst !== undefined && isWorseVectorCandidate(worst, candidate)) {
      heap[0] = candidate;
      siftWorseCandidateDown(heap, 0);
    }
  }

  return heap.sort(compareScoredVectorCandidates);
}

function communityMetadataHash(rawContent: string): string {
  return computeMetadataSurfaceHash({
    rawBytes: rawContent,
  });
}

function retrievalHitFromDocument(document: KbOramaDocument, score: number, rank: number) {
  return {
    entryId: document.entryId as KbEntryId,
    slug: document.entryId.slice(document.entryId.indexOf(':') + 1),
    kind: document.kind,
    title: document.title,
    tags: document.tags,
    principles: document.principles,
    score,
    rank,
  };
}

/** Coordinator-facing Orama projection that serves both lexical search and base-tier cosine search. */
export class OramaBaseProjection implements TextRetrieval, VectorRetrieval {
  readonly backendKind = 'orama';
  private embeddingProviderPromise: Promise<EmbeddingProvider | null> | null = null;

  constructor(private readonly runtime: KbRuntime) {}

  /** Loads the current Orama index artifacts from the runtime. */
  async ensureLoaded(): Promise<OramaLoadedIndex> {
    const { db, tokenizer } = await this.runtime.ensureOramaIndex();
    return { db, tokenizer };
  }

  async search(query: string, topK: number, scope?: RetrievalScope): Promise<TextRetrievalResult>;
  async search(embedding: number[], topK: number, scope?: RetrievalScope): Promise<VectorRetrievalResult>;
  /** Runs lexical search for text queries and cosine search over stored vectors for embeddings. */
  async search(
    queryOrEmbedding: string | number[],
    topK: number,
    scope?: RetrievalScope,
  ): Promise<TextRetrievalResult | VectorRetrievalResult> {
    const { db } = await this.ensureLoaded();

    if (typeof queryOrEmbedding === 'string') {
      const term = normalizeOramaTerm(queryOrEmbedding);
      if (!term) {
        return { hits: [] };
      }

      const response = await oramaSearch(db, {
        term,
        properties: ORAMA_SEARCH_PROPERTIES,
        boost: ORAMA_SEARCH_BOOST,
        limit: Math.max(topK * 5, topK),
      });
      const hits = response.hits
        .map((hit) => hit.document as KbOramaDocument)
        .filter((document) => scopeAllowsKind(scope, document.kind))
        .map((document, index) => ({
          ...retrievalHitFromDocument(document, response.hits[index]?.score ?? 0, index + 1),
          document,
        }))
        .sort(compareScoreAndEntryId)
        .slice(0, topK)
        .map((hit, index) => ({
          ...hit,
          rank: index + 1,
        }));

      return { hits } as TextRetrievalResult;
    }

    const queryVector = toUnitVector(queryOrEmbedding);
    if (queryVector === null) {
      return { hits: [] };
    }

    const hits = collectTopKByCosine(listStoredDocuments(db), queryVector, topK, scope)
      .slice(0, topK)
      .map(({ document, score }, index) => ({
        ...retrievalHitFromDocument(document, score, index + 1),
      }));

    return { hits } as VectorRetrievalResult;
  }

  /** Prepares the document delta needed to bring Orama in sync with a changed corpus subset. */
  async prepareDeltaForCurrentCorpusEntries(
    index: KbIndex,
    changedEntryIds: readonly string[],
    deletedEntryIds: readonly string[],
  ): Promise<PreparedOramaDelta> {
    const nextIndex = cloneKbIndex(index);
    const actualChangedEntryIds = new Set(changedEntryIds);
    const hasCommunityEntries = Object.values(nextIndex.entries).some(isCommunityEntry);
    if (hasCommunityEntries && changedEntryIds.some((entryId) => entryId.startsWith('note:') || entryId.startsWith('source:'))) {
      for (const entry of Object.values(nextIndex.entries)) {
        if (isCommunityEntry(entry)) {
          actualChangedEntryIds.add(`community:${entry.slug}`);
        }
      }
    }

    const documents = await this.buildDocumentsForEntryIds(nextIndex, [...actualChangedEntryIds].sort());

    return {
      index: nextIndex,
      changedEntryIds: [...actualChangedEntryIds].sort(),
      deletedEntryIds: [...deletedEntryIds].sort(),
      documents,
    };
  }

  /** Materializes a full Orama projection from the current runtime corpus view. */
  async prepareFullSnapshotForCurrentCorpus(index: KbIndex = this.runtime.readIndexOrEmpty()): Promise<PreparedOramaProjection> {
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
    const documents = await this.buildDocumentsForIndex(nextIndex, params.generatedCommunityDocs, params.forceCommunityFresh);

    return {
      index: nextIndex,
      db,
      tokenizer,
      documents,
    };
  }

  /** Applies a prepared delta while the caller already holds the KB mutation lock. */
  async applyDeltaInWriteLock(snapshot: KbCorpusSnapshot, preparedDelta: PreparedOramaDelta): Promise<void> {
    // snapshot reserved for future freshness FIFO write guard; Orama writes are sync under mutation lock.
    void snapshot;

    const loaded = await this.runtime.loadOramaSnapshotIfPresent();
    if (loaded === null) {
      const preparedProjection = await this.prepareFullSnapshotForProjectedIndex({
        index: preparedDelta.index,
      });
      await this.installFullSnapshotInWriteLock(snapshot, preparedProjection);
      return;
    }

    const idsToReplace = [...new Set([...preparedDelta.deletedEntryIds, ...preparedDelta.changedEntryIds])];
    if (idsToReplace.length > 0) {
      await removeMultiple(loaded.db, idsToReplace);
    }
    if (preparedDelta.documents.length > 0) {
      await insertMultiple(loaded.db, preparedDelta.documents);
    }

    this.runtime.persistIndexToDisk(preparedDelta.index);
    this.runtime.persistOramaSnapshot(loaded.db);
    this.runtime.installRebuiltArtifacts(preparedDelta.index, loaded);
  }

  /** Installs a fully rebuilt Orama projection while the caller already holds the KB mutation lock. */
  async installFullSnapshotInWriteLock(
    snapshot: KbCorpusSnapshot,
    preparedProjection: PreparedOramaProjection,
  ): Promise<void> {
    // snapshot reserved for future freshness FIFO write guard; Orama writes are sync under mutation lock.
    void snapshot;

    if (preparedProjection.documents.length > 0) {
      await insertMultiple(preparedProjection.db, preparedProjection.documents);
    }
    this.runtime.persistIndexToDisk(preparedProjection.index);
    this.runtime.persistOramaSnapshot(preparedProjection.db);
    this.runtime.installRebuiltArtifacts(preparedProjection.index, {
      db: preparedProjection.db,
      tokenizer: preparedProjection.tokenizer,
    });
  }

  private async getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
    this.embeddingProviderPromise ??= createEmbeddingProvider(this.runtime.runtimeDir);
    return this.embeddingProviderPromise;
  }

  private async buildDocumentsForEntryIds(index: KbIndex, entryIds: readonly string[]): Promise<KbOramaDocument[]> {
    const communityFresh = areCommunityDocumentsFresh(this.runtime, index);
    const records = entryIds
      .map((entryId) => this.loadProjectionRecordForEntry(index, entryId))
      .filter((record): record is ProjectionRecord => record !== null);

    return this.materializeDocuments(records, communityFresh);
  }

  private async buildDocumentsForIndex(
    index: KbIndex,
    generatedCommunityDocs: readonly CommunityDocument[] = [],
    forceCommunityFresh?: boolean,
  ): Promise<KbOramaDocument[]> {
    const generatedCommunityDocsBySlug = new Map(generatedCommunityDocs.map((document) => [document.slug, document] as const));
    const communityFresh = forceCommunityFresh ?? areCommunityDocumentsFresh(this.runtime, index);

    const records = Object.entries(index.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => this.loadProjectionRecord(entry, generatedCommunityDocsBySlug))
      .filter((record): record is ProjectionRecord => record !== null);

    return this.materializeDocuments(records, communityFresh);
  }

  private async materializeDocuments(
    records: readonly ProjectionRecord[],
    communityFresh: boolean,
  ): Promise<KbOramaDocument[]> {
    const provider = await this.getEmbeddingProvider();
    const authorityTexts = records.map((record) => buildRetrievalAuthorityText(record.entry.title, record.body));
    const embeddings = provider === null ? [] : await provider.embedDocuments(authorityTexts);

    return records.map((record, index) => {
      if (provider !== null && embeddings[index] === undefined) {
        throw new Error(`Embedding provider returned too few vectors for ${record.entry.slug}.`);
      }
      const vector = provider === null ? [] : normalizeStoredVector(embeddings[index]);

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
            vector,
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
            vector,
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
          vector,
        },
      );
    });
  }

  private loadProjectionRecordForEntry(index: KbIndex, entryId: string): ProjectionRecord | null {
    const entry = index.entries[entryId];
    return this.loadProjectionRecord(entry);
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
        loaded = loadKbNote(this.runtime.notePath(entry.slug));
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
        loaded = loadKbSource(this.runtime.sourcePath(entry.slug));
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
export function createOramaBaseProjection(runtime: KbRuntime): OramaBaseProjection {
  return new OramaBaseProjection(runtime);
}
