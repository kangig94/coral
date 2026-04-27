import { search as oramaSearch } from '@orama/orama';

import { denormalizeSlug } from './snippets.js';
import type {
  FusedRetrievalHit,
  HybridFusion,
  TextRetrievalResult,
  VectorRetrievalHit,
} from './contract.js';
import type { KbOramaDocument } from './orama/document-builder.js';
import type { KbOramaDb } from './orama/schema.js';
import {
  getEntry,
  isCommunityEntry,
  isNoteEntry,
  parseKbEntryId,
  type KbEntryId,
  type KbIndex,
  type KbResult,
  type KbSearchMode,
  type KbSearchResponse,
  type KbSearchScope,
} from '../entry-types.js';

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
const KIND_ORDER: Record<KbResult['kind'], number> = {
  note: 0,
  community: 1,
  source: 2,
};

export type KbSearchHit = {
  document: KbOramaDocument;
  score: number;
};

export type ResolvedKbSearchEntry = {
  entryId: KbEntryId;
  slug: string;
  kind: KbResult['kind'];
  title: string;
  tags: string[];
  principles: string[];
};

export type ResolvedKbSearchHit = ResolvedKbSearchEntry & {
  document: KbOramaDocument;
  score: number;
};

export type HybridKbSearchHit = FusedRetrievalHit;

export type SearchResponseWarnings = {
  warning?: string;
  warnings?: string[];
};

export function resolveEntry(entryId: string, index: KbIndex): ResolvedKbSearchEntry | null {
  const normalizedEntryId = parseKbEntryId(entryId);
  if (normalizedEntryId === null) {
    return null;
  }

  const entry = getEntry(index, normalizedEntryId);
  if (entry === undefined) {
    return null;
  }

  return {
    entryId: normalizedEntryId,
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    tags: isCommunityEntry(entry) ? [...entry.members] : [...entry.tags],
    principles: isNoteEntry(entry) ? [...entry.principles] : [],
  };
}

export function resolveHit(hit: KbSearchHit, index: KbIndex): ResolvedKbSearchHit {
  const resolvedEntry = resolveEntry(hit.document.entryId, index);

  return {
    entryId: resolvedEntry?.entryId ?? (hit.document.entryId as KbEntryId),
    document: hit.document,
    score: hit.score,
    slug: resolvedEntry?.slug ?? denormalizeSlug(hit.document.slug),
    kind: resolvedEntry?.kind ?? hit.document.kind,
    title: resolvedEntry?.title ?? hit.document.title,
    tags: resolvedEntry?.tags ?? [...hit.document.tags],
    principles: resolvedEntry?.principles ?? [...hit.document.principles],
  };
}

export function compareRetrievalRoleHits(
  left: Pick<ResolvedKbSearchEntry, 'entryId'> & { score: number },
  right: Pick<ResolvedKbSearchEntry, 'entryId'> & { score: number },
): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }

  return left.entryId.localeCompare(right.entryId);
}

export function rankRetrievalRoleHits<T extends { entryId: KbEntryId; score: number }>(
  hits: readonly T[],
): Array<T & { rank: number }> {
  return [...hits]
    .sort(compareRetrievalRoleHits)
    .map((hit, index) => ({
      ...hit,
      rank: index + 1,
    }));
}

function toTextRetrievalResult(hits: readonly ResolvedKbSearchHit[]): TextRetrievalResult {
  return {
    hits: rankRetrievalRoleHits(hits).map((hit) => ({
      ...hit,
      document: hit.document,
    })),
  };
}

export function fuseRetrievalRoles(
  hybrid: HybridFusion,
  textHits: readonly ResolvedKbSearchHit[],
  vectorHits: readonly VectorRetrievalHit[],
  graph: Parameters<HybridFusion['fuse']>[2],
): HybridKbSearchHit[] {
  return hybrid.fuse(toTextRetrievalResult(textHits), { hits: [...vectorHits] }, graph).hits;
}

export function filterHitsByScope<T extends { kind: KbResult['kind'] }>(hits: T[], scope: KbSearchScope): T[] {
  if (scope === 'all') {
    // Communities are meta-documents: include them only when explicitly requested.
    return hits.filter((hit) => hit.kind !== 'community');
  }

  if (scope === 'notes') {
    return hits.filter((hit) => hit.kind === 'note');
  }

  if (scope === 'sources') {
    return hits.filter((hit) => hit.kind === 'source');
  }

  return hits.filter((hit) => hit.kind === 'community');
}

function isSearchableHit(hit: ResolvedKbSearchHit, communitiesFresh: boolean): boolean {
  if (hit.kind !== 'community') {
    return true;
  }

  if (hit.document.freshness === 'stale') {
    return false;
  }

  if (hit.document.freshness === 'fresh') {
    return true;
  }

  return communitiesFresh;
}

export function filterSearchableHits(hits: ResolvedKbSearchHit[], communitiesFresh: boolean): ResolvedKbSearchHit[] {
  return hits.filter((hit) => isSearchableHit(hit, communitiesFresh));
}

export function rerankHits<T extends { score: number; kind: KbResult['kind']; slug: string }>(hits: T[]): T[] {
  return [...hits].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    if (left.kind !== right.kind) {
      return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    }

    return left.slug.localeCompare(right.slug);
  });
}

function maxPossibleOmittedScore(hits: KbSearchHit[]): number {
  const boundaryHit = hits.at(-1);
  if (boundaryHit === undefined) {
    return Number.NEGATIVE_INFINITY;
  }

  return boundaryHit.score;
}

export function shouldContinueWidening(
  hits: KbSearchHit[],
  resolvedHits: ResolvedKbSearchHit[],
  communitiesFresh: boolean,
  scope: KbSearchScope,
  topK: number,
  exhausted: boolean,
): boolean {
  const searchableHits = filterSearchableHits(resolvedHits, communitiesFresh);
  if (scope !== 'all') {
    return !exhausted && filterHitsByScope(searchableHits, scope).length < topK;
  }

  const rerankedHits = rerankHits(searchableHits);
  if (rerankedHits.length < topK) {
    return !exhausted;
  }

  return !exhausted && rerankedHits[topK - 1].score <= maxPossibleOmittedScore(hits);
}

export async function searchOrama(db: KbOramaDb, oramaTerm: string, limit: number): Promise<KbSearchHit[]> {
  const response = await oramaSearch(db, {
    term: oramaTerm,
    properties: ORAMA_SEARCH_PROPERTIES,
    boost: ORAMA_SEARCH_BOOST,
    threshold: 1,
    limit,
  });

  return response.hits as KbSearchHit[];
}

export function isVectorScope(kind: KbResult['kind'], scope: KbSearchScope): boolean {
  if (kind === 'community') {
    return false;
  }

  if (scope === 'all') {
    return true;
  }

  if (scope === 'notes') {
    return kind === 'note';
  }

  if (scope === 'sources') {
    return kind === 'source';
  }

  return false;
}

export function emptySearchResponse(mode?: KbSearchMode): KbSearchResponse {
  if (mode === 'vector') {
    return {
      results: [],
      mode: 'vector',
    };
  }
  if (mode === 'hybrid') {
    return {
      results: [],
      mode: 'hybrid',
    };
  }
  return {
    results: [],
    mode: 'text',
  };
}
