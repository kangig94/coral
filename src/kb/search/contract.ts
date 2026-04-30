import type { KbEntryId, KbResult, KbSearchScope } from '../entry-types.js';

export type RetrievalScope = KbSearchScope;
export type RetrievalKind = KbResult['kind'];

/**
 * Engine-blind document shape returned with each FTS hit. Carries the fields
 * KB-tier consumes for snippet anchoring, scope filtering, and freshness gating.
 */
export interface RetrievedDocument {
  readonly entryId: string;
  readonly slug: string;
  readonly kind: RetrievalKind;
  readonly freshness: 'fresh' | 'stale';
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly principles: readonly string[];
}

export type RetrievedDocumentFields = RetrievedDocument;

export interface RetrievalEntry {
  entryId: KbEntryId;
  slug: string;
  kind: RetrievalKind;
  title: string;
  tags: string[];
  principles: string[];
}

export interface RankedRetrievalHit extends RetrievalEntry {
  rank: number;
  score: number;
}

export interface TextRetrievalHit extends RankedRetrievalHit {
  document: RetrievedDocument;
}

export type VectorRetrievalHit = RankedRetrievalHit;

export type GraphRetrievalHit = RankedRetrievalHit;

export interface FusedRetrievalHit extends RetrievalEntry {
  rank: number;
  score: number;
  document: RetrievedDocument | null;
  textRank?: number;
  vectorRank?: number;
  graphRank?: number;
}

export interface TextRetrievalResult {
  hits: TextRetrievalHit[];
}

export interface VectorRetrievalResult {
  hits: VectorRetrievalHit[];
}

export interface GraphRetrievalResult {
  hits: GraphRetrievalHit[];
}

export interface FusedResult {
  hits: FusedRetrievalHit[];
}

/**
 * FTS hit shape returned by `FtsRetrieval.search`. The `documentId` is the
 * KB-owned entry id; `fields` carries the engine-blind document for snippet
 * anchoring and scope filtering.
 */
export interface FtsHit {
  readonly documentId: string;
  readonly score: number;
  readonly fields: RetrievedDocumentFields;
}

export interface FtsSearchResult {
  readonly hits: readonly FtsHit[];
  /** True when the engine has no more results past the requested topK. */
  readonly exhausted: boolean;
}

export interface VectorRetrieval {
  search(embedding: number[], topK: number, scope?: RetrievalScope): Promise<VectorRetrievalResult>;
}

// Graph retrieval stays routed through entity-graph queries and is fused explicitly.
export interface GraphRetrieval {
  search(query: string, scope?: RetrievalScope): Promise<GraphRetrievalResult>;
}

// Fusion consumes explicit graph hits instead of treating graph as a text/vector backend.
export interface HybridFusion {
  fuse(text: TextRetrievalResult, vector: VectorRetrievalResult, graph: GraphRetrievalResult): FusedResult;
}
