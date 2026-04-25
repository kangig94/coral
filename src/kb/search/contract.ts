import type { KbEntryId, KbResult, KbSearchScope } from '../entry-types.js';
import type { KbOramaDocument } from '../orama-document-builder.js';

export type RetrievalScope = KbSearchScope;
export type RetrievalKind = KbResult['kind'];

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
  document: KbOramaDocument;
}

export type VectorRetrievalHit = RankedRetrievalHit;

export type GraphRetrievalHit = RankedRetrievalHit;

export interface FusedRetrievalHit extends RetrievalEntry {
  rank: number;
  score: number;
  document: KbOramaDocument | null;
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

export interface TextRetrieval {
  search(query: string, topK: number, scope?: RetrievalScope): Promise<TextRetrievalResult>;
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
