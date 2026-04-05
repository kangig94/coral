import { search as oramaSearch } from '@orama/orama';
import {
  type KbOramaDb,
  normalizeOramaTerm,
  normalizeWhitespace,
  tokenizeField,
  tokenizeQuery,
  type KbOramaDocument,
  type KbOramaTokenizer,
} from './orama-factory.js';
import type { KbRuntime } from './contracts.js';
import {
  getEntry,
  isCommunityEntry,
  isNoteEntry,
  parseKbEntryId,
  type KbEntryId,
  type KbIndex,
  type KbMatchSurface,
  type KbResult,
  type KbSearchResponse,
  type KbSearchScope,
} from './types.js';
import { createEmbeddingProvider } from './embedding.js';
import { ensureVectorIndex } from './vector-sync.js';

const MATCH_SURFACE_ORDER: KbMatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];
const ORAMA_SEARCH_PROPERTIES: Array<keyof KbOramaDocument> = ['slug', 'title', 'body', 'tags', 'principles'];
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
const HYBRID_RRF_K = 60;
const VECTOR_CANDIDATE_CAP_MULTIPLIER = 10;

type SnippetAnchor = {
  index: number;
  length: number;
};

type KbSearchHit = {
  document: KbOramaDocument;
  score: number;
};

type ResolvedKbSearchEntry = {
  entryId: KbEntryId;
  slug: string;
  kind: KbResult['kind'];
  title: string;
  tags: string[];
  principles: string[];
};

type ResolvedKbSearchHit = ResolvedKbSearchEntry & {
  document: KbOramaDocument;
  score: number;
};

type VectorKbSearchHit = ResolvedKbSearchEntry & {
  score: number;
};

type HybridKbSearchHit = ResolvedKbSearchEntry & {
  document: KbOramaDocument | null;
  score: number;
  vectorRank?: number;
};

function denormalizeSlug(slug: string): string {
  return slug.replace(/ /g, '-');
}

function sortedMatchedBy(matchedBy: Set<KbMatchSurface>): KbMatchSurface[] {
  return MATCH_SURFACE_ORDER.filter((surface) => matchedBy.has(surface));
}

function hasTokenOverlap(queryTokens: string[], fieldTokens: string[]): boolean {
  if (queryTokens.length === 0 || fieldTokens.length === 0) {
    return false;
  }

  const fieldTokenSet = new Set(fieldTokens);
  return queryTokens.some((token) => fieldTokenSet.has(token));
}

function findSentenceStart(content: string, matchIndex: number): number {
  const paragraphBoundary = content.lastIndexOf('\n\n', matchIndex);
  const sentenceBoundary = content.lastIndexOf('.', matchIndex - 1);
  if (paragraphBoundary === -1 && sentenceBoundary === -1) {
    return 0;
  }
  if (paragraphBoundary > sentenceBoundary) {
    return paragraphBoundary + 2;
  }
  return sentenceBoundary + 1;
}

function findSentenceEnd(content: string, matchIndex: number): number {
  const paragraphBoundary = content.indexOf('\n\n', matchIndex);
  const sentenceBoundary = content.indexOf('.', matchIndex);
  if (paragraphBoundary === -1 && sentenceBoundary === -1) {
    return content.length;
  }
  if (paragraphBoundary === -1) {
    return sentenceBoundary + 1;
  }
  if (sentenceBoundary === -1) {
    return paragraphBoundary;
  }
  return Math.min(paragraphBoundary, sentenceBoundary + 1);
}

function truncateSnippet(snippet: string, matchOffset: number): string {
  if (snippet.length <= 200) {
    return snippet;
  }

  const windowSize = 200;
  let start = Math.max(0, matchOffset - 80);
  const end = Math.min(snippet.length, start + windowSize);
  if (end - start < windowSize) {
    start = Math.max(0, end - windowSize);
  }

  let truncated = snippet.slice(start, end).trim();
  if (start > 0) {
    truncated = `...${truncated}`;
  }
  if (end < snippet.length) {
    truncated = `${truncated}...`;
  }
  if (truncated.length <= 200) {
    return truncated;
  }
  return truncated.slice(0, 200).trimEnd();
}

function normalizedOffset(text: string): number {
  return normalizeWhitespace(text).length;
}

function findPhraseAnchor(content: string, rawQuery: string, oramaTerm: string): SnippetAnchor | null {
  const normalizedContent = content.toLowerCase();
  const candidates = [...new Set([rawQuery.trim(), oramaTerm].filter(Boolean))];
  let bestAnchor: SnippetAnchor | null = null;

  for (const candidate of candidates) {
    const matchIndex = normalizedContent.indexOf(candidate.toLowerCase());
    if (matchIndex !== -1 && (bestAnchor === null || matchIndex < bestAnchor.index)) {
      bestAnchor = {
        index: matchIndex,
        length: candidate.length,
      };
    }
  }

  return bestAnchor;
}

// Inverse of Orama English SPLITTER — keeps the same word boundaries the indexer uses.
function findTokenAnchor(content: string, queryTokens: string[], tokenizer: KbOramaTokenizer): SnippetAnchor | null {
  for (const match of content.matchAll(/[A-Za-zàèéìòóù0-9_'-]+/gim)) {
    const value = match[0];
    const valueTokens = tokenizeField(value, tokenizer);
    if (!hasTokenOverlap(queryTokens, valueTokens)) {
      continue;
    }

    return {
      index: match.index ?? 0,
      length: value.length,
    };
  }

  return null;
}

type QueryContext = {
  rawQuery: string;
  oramaTerm: string;
  queryTokens: string[];
  tokenizer: KbOramaTokenizer;
};

function extractSnippet(content: string, query: QueryContext): string | undefined {
  const anchor = findPhraseAnchor(content, query.rawQuery, query.oramaTerm) ?? findTokenAnchor(content, query.queryTokens, query.tokenizer);

  if (anchor === null) {
    return undefined;
  }

  const sentenceStart = findSentenceStart(content, anchor.index);
  const sentenceEnd = findSentenceEnd(content, anchor.index + anchor.length);
  const sentence = content.slice(sentenceStart, sentenceEnd);
  const rawSnippet = normalizeWhitespace(sentence);
  if (!rawSnippet) {
    return undefined;
  }

  const matchOffset = normalizedOffset(sentence.slice(0, Math.max(0, anchor.index - sentenceStart)));
  return truncateSnippet(rawSnippet, matchOffset);
}

function resolveEntry(entryId: string, index: KbIndex): ResolvedKbSearchEntry | null {
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

function resolveHit(hit: KbSearchHit, index: KbIndex): ResolvedKbSearchHit {
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

function filterHitsByScope<T extends { kind: KbResult['kind'] }>(hits: T[], scope: KbSearchScope): T[] {
  if (scope === 'all') {
    // Communities are meta-documents — exclude from default results so they
    // don't displace actual notes/sources. Use --scope communities explicitly.
    return hits.filter((hit) => hit.kind !== 'community');
  }

  const targetKind = scope === 'notes' ? 'note' : scope === 'sources' ? 'source' : 'community';
  return hits.filter((hit) => hit.kind === targetKind);
}

function rerankHits<T extends { score: number; kind: KbResult['kind']; slug: string }>(hits: T[]): T[] {
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

function shouldContinueWidening(
  hits: KbSearchHit[],
  resolvedHits: ResolvedKbSearchHit[],
  scope: KbSearchScope,
  topK: number,
  exhausted: boolean,
): boolean {
  if (scope !== 'all') {
    return !exhausted && filterHitsByScope(resolvedHits, scope).length < topK;
  }

  const rerankedHits = rerankHits(resolvedHits);
  if (rerankedHits.length < topK) {
    return !exhausted;
  }

  return !exhausted && rerankedHits[topK - 1].score <= maxPossibleOmittedScore(hits);
}

async function searchOrama(db: KbOramaDb, oramaTerm: string, limit: number): Promise<KbSearchHit[]> {
  const response = await oramaSearch(db, {
    term: oramaTerm,
    properties: ORAMA_SEARCH_PROPERTIES,
    boost: ORAMA_SEARCH_BOOST,
    threshold: 1,
    limit,
  });

  return response.hits as KbSearchHit[];
}

function toResult(hit: ResolvedKbSearchHit, query: QueryContext): KbResult {
  const matchedBy = new Set<KbMatchSurface>();

  if (hasTokenOverlap(query.queryTokens, tokenizeField(hit.slug, query.tokenizer))) {
    matchedBy.add('filename');
  }
  if (hit.principles.some((principle) => hasTokenOverlap(query.queryTokens, tokenizeField(principle, query.tokenizer)))) {
    matchedBy.add('principle');
  }
  if (hit.tags.some((tag) => hasTokenOverlap(query.queryTokens, tokenizeField(tag, query.tokenizer)))) {
    matchedBy.add('tag');
  }
  if (hasTokenOverlap(query.queryTokens, tokenizeField(hit.title, query.tokenizer))) {
    matchedBy.add('title');
  }

  const snippet = extractSnippet(hit.document.body, query);
  if (snippet !== undefined) {
    matchedBy.add('content');
  } else if (matchedBy.size === 0) {
    matchedBy.add('content');
  }

  return {
    note: hit.slug,
    kind: hit.kind,
    title: hit.title,
    matchedBy: sortedMatchedBy(matchedBy),
    tags: [...hit.tags],
    principles: [...hit.principles],
    ...(snippet === undefined ? {} : { snippet }),
  };
}

function toVectorOnlyResult(hit: ResolvedKbSearchEntry): KbResult {
  return {
    note: hit.slug,
    kind: hit.kind,
    title: hit.title,
    matchedBy: [],
    tags: [...hit.tags],
    principles: [...hit.principles],
  };
}

function toHybridResult(hit: HybridKbSearchHit, query: QueryContext): KbResult {
  if (hit.document === null) {
    return toVectorOnlyResult(hit);
  }

  return toResult(
    {
      ...hit,
      document: hit.document,
    },
    query,
  );
}

function buildTextResponse(
  hits: ResolvedKbSearchHit[],
  query: QueryContext,
  topK: number,
  warning?: string,
): KbSearchResponse {
  return {
    results: hits.slice(0, topK).map((hit) => toResult(hit, query)),
    mode: 'text',
    ...(warning === undefined ? {} : { warning }),
  };
}

function isVectorScope(kind: KbResult['kind'], scope: KbSearchScope): boolean {
  if (kind === 'community') {
    return false;
  }

  return scope === 'all' || (scope === 'notes' ? kind === 'note' : scope === 'sources' ? kind === 'source' : false);
}

function aggregateVectorHits(
  hits: Array<{ chunkId: string; entryId: string; score: number }>,
  index: KbIndex,
  scope: KbSearchScope,
): VectorKbSearchHit[] {
  const aggregated = new Map<KbEntryId, VectorKbSearchHit>();

  for (const hit of hits) {
    const entry = resolveEntry(hit.entryId, index);
    if (entry === null || !isVectorScope(entry.kind, scope)) {
      continue;
    }

    const previous = aggregated.get(entry.entryId);
    if (previous === undefined || hit.score > previous.score) {
      aggregated.set(entry.entryId, {
        ...entry,
        score: hit.score,
      });
    }
  }

  return rerankHits([...aggregated.values()]);
}

function rrfScore(rank: number): number {
  return 1 / (HYBRID_RRF_K + rank);
}

function fuseHits(oramaHits: ResolvedKbSearchHit[], vectorHits: VectorKbSearchHit[]): HybridKbSearchHit[] {
  const fused = new Map<KbEntryId, HybridKbSearchHit>();

  for (const [index, hit] of oramaHits.entries()) {
    fused.set(hit.entryId, {
      ...hit,
      document: hit.document,
      score: rrfScore(index + 1),
    });
  }

  for (const [index, hit] of vectorHits.entries()) {
    const vectorRank = index + 1;
    const contribution = rrfScore(vectorRank);
    const previous = fused.get(hit.entryId);

    if (previous === undefined) {
      fused.set(hit.entryId, {
        ...hit,
        document: null,
        score: contribution,
        vectorRank,
      });
      continue;
    }

    fused.set(hit.entryId, {
      ...previous,
      score: previous.score + contribution,
      vectorRank,
    });
  }

  return rerankHits([...fused.values()]);
}

async function searchVectorEntries(
  searchVector: (query: Float32Array, candidateK: number) => Promise<Array<{ chunkId: string; entryId: string; score: number }>>,
  queryVector: Float32Array,
  topK: number,
  index: KbIndex,
  scope: KbSearchScope,
): Promise<VectorKbSearchHit[]> {
  let candidateK = topK;
  const candidateCap = Math.max(topK, VECTOR_CANDIDATE_CAP_MULTIPLIER * topK);
  let hits = await searchVector(queryVector, candidateK);
  let aggregated = aggregateVectorHits(hits, index, scope);
  let exhausted = hits.length < candidateK;

  while (aggregated.length < topK && !exhausted && candidateK < candidateCap) {
    const nextCandidateK = Math.min(candidateK * 2, candidateCap);
    if (nextCandidateK === candidateK) {
      break;
    }

    candidateK = nextCandidateK;
    hits = await searchVector(queryVector, candidateK);
    aggregated = aggregateVectorHits(hits, index, scope);
    exhausted = hits.length < candidateK;
  }

  return aggregated;
}

export async function searchKb(
  rt: KbRuntime,
  query: string,
  top_k = 20,
  scope: KbSearchScope = 'all',
): Promise<KbSearchResponse> {
  const rawQuery = query.trim();
  const oramaTerm = normalizeOramaTerm(rawQuery);
  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;
  const { db, tokenizer, index } = await rt.ensureOramaIndex();

  if (Object.keys(index.entries).length === 0) {
    return {
      results: [],
      mode: 'text',
    };
  }

  const queryTokens = tokenizeQuery(oramaTerm, tokenizer);
  if (queryTokens.length === 0) {
    return {
      results: [],
      mode: 'text',
    };
  }

  const queryCtx: QueryContext = { rawQuery, oramaTerm, queryTokens, tokenizer };
  const indexState = rt.readIndexState();

  let limit = topK;
  let hits = await searchOrama(db, oramaTerm, limit);
  let exhausted = hits.length < limit;
  let resolvedHits = hits.map((hit) => resolveHit(hit, index));

  while (shouldContinueWidening(hits, resolvedHits, scope, topK, exhausted)) {
    const prevCount = hits.length;
    limit = Math.max(limit + 1, limit * 2);
    hits = await searchOrama(db, oramaTerm, limit);
    exhausted = hits.length < limit;
    for (let i = prevCount; i < hits.length; i++) {
      resolvedHits.push(resolveHit(hits[i], index));
    }
  }

  const selectedHits = scope === 'all' ? rerankHits(resolvedHits) : filterHitsByScope(resolvedHits, scope);
  if (scope === 'communities') {
    return buildTextResponse(selectedHits, queryCtx, topK);
  }

  const vectorResult = await ensureVectorIndex(rt);
  const vectorLease = await rt.acquireVectorLease();

  try {
    const canUseHybrid =
      vectorResult.mode === 'hybrid' &&
      vectorResult.specId !== null &&
      vectorLease !== null &&
      vectorLease.specId === vectorResult.specId &&
      vectorLease.vectorStatus !== null &&
      vectorLease.vectorStatus.indexedSeq === indexState.mutationSeq &&
      vectorLease.vectorStatus.staleReason === undefined &&
      vectorLease.vectorStatus.activeSnapshotId === vectorLease.snapshotId;

    if (!canUseHybrid) {
      return buildTextResponse(selectedHits, queryCtx, topK, vectorResult.warning);
    }

    try {
      const provider = await createEmbeddingProvider(rt.runtimeDir);
      if (provider === null) {
        return buildTextResponse(selectedHits, queryCtx, topK, vectorResult.warning);
      }

      const queryVector = await provider.embedQuery(rawQuery);
      const vectorHits = await searchVectorEntries(vectorLease.store.searchVector.bind(vectorLease.store), queryVector, topK, index, scope);
      const fusedHits = fuseHits(selectedHits, vectorHits);
      const finalHits = fusedHits.slice(0, topK);
      const usedVector = finalHits.some((hit) => hit.vectorRank !== undefined);

      if (!usedVector) {
        return buildTextResponse(selectedHits, queryCtx, topK, vectorResult.warning);
      }

      return {
        results: finalHits.map((hit) => toHybridResult(hit, queryCtx)),
        mode: 'hybrid',
        ...(vectorResult.warning === undefined ? {} : { warning: vectorResult.warning }),
      };
    } catch {
      return buildTextResponse(selectedHits, queryCtx, topK, vectorResult.warning);
    }
  } finally {
    await vectorLease?.release();
  }
}
