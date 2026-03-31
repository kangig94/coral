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
import type { KbRuntime } from './runtime.js';
import {
  getEntry,
  isNoteEntry,
  type KbEntryId,
  type KbIndex,
  type KbMatchSurface,
  type KbResult,
  type KbSearchResponse,
  type KbSearchScope,
} from './types.js';

const MATCH_SURFACE_ORDER: KbMatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];
const ORAMA_SEARCH_PROPERTIES: Array<keyof KbOramaDocument> = ['slug', 'title', 'body', 'tags', 'principles'];
const ORAMA_SEARCH_BOOST = {
  slug: 3,
  title: 2,
  tags: 1.5,
  principles: 1.5,
  body: 1,
} as const;
const NOTE_RELEVANCE_BOOST = 1.1;

type SnippetAnchor = {
  index: number;
  length: number;
};

type KbSearchHit = {
  document: KbOramaDocument;
  score: number;
};

type ResolvedKbSearchHit = {
  document: KbOramaDocument;
  score: number;
  slug: string;
  kind: KbResult['kind'];
  title: string;
  tags: string[];
  principles: string[];
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

function extractSnippet(
  content: string,
  rawQuery: string,
  oramaTerm: string,
  queryTokens: string[],
  tokenizer: KbOramaTokenizer,
): string | undefined {
  const anchor = findPhraseAnchor(content, rawQuery, oramaTerm) ?? findTokenAnchor(content, queryTokens, tokenizer);

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

function resolveHit(hit: KbSearchHit, index: KbIndex): ResolvedKbSearchHit {
  const entry = getEntry(index, hit.document.entryId as KbEntryId);
  const slug = entry?.slug ?? denormalizeSlug(hit.document.slug);

  return {
    document: hit.document,
    score: hit.score,
    slug,
    kind: entry?.kind ?? hit.document.kind,
    title: entry?.title ?? hit.document.title,
    tags: entry?.tags ? [...entry.tags] : [...hit.document.tags],
    principles: entry !== undefined && isNoteEntry(entry) ? [...entry.principles] : [...hit.document.principles],
  };
}

function filterHitsByScope(hits: ResolvedKbSearchHit[], scope: KbSearchScope): ResolvedKbSearchHit[] {
  if (scope === 'all') {
    return hits;
  }

  const targetKind = scope === 'notes' ? 'note' : 'source';
  return hits.filter((hit) => hit.kind === targetKind);
}

function adjustedScore(hit: ResolvedKbSearchHit): number {
  return hit.score * (hit.kind === 'note' ? NOTE_RELEVANCE_BOOST : 1);
}

function rerankHits(hits: ResolvedKbSearchHit[]): ResolvedKbSearchHit[] {
  return [...hits].sort((left, right) => {
    const scoreDelta = adjustedScore(right) - adjustedScore(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    if (left.kind !== right.kind) {
      return left.kind === 'note' ? -1 : 1;
    }

    const rawScoreDelta = right.score - left.score;
    if (rawScoreDelta !== 0) {
      return rawScoreDelta;
    }

    return left.slug.localeCompare(right.slug);
  });
}

function maxPossibleOmittedAdjustedScore(hits: KbSearchHit[]): number {
  const boundaryHit = hits.at(-1);
  if (boundaryHit === undefined) {
    return Number.NEGATIVE_INFINITY;
  }

  return boundaryHit.score * NOTE_RELEVANCE_BOOST;
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

  return !exhausted && adjustedScore(rerankedHits[topK - 1]) <= maxPossibleOmittedAdjustedScore(hits);
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

function toResult(
  hit: ResolvedKbSearchHit,
  queryTokens: string[],
  tokenizer: KbOramaTokenizer,
  rawQuery: string,
  oramaTerm: string,
): KbResult {
  const matchedBy = new Set<KbMatchSurface>();

  if (hasTokenOverlap(queryTokens, tokenizeField(hit.slug, tokenizer))) {
    matchedBy.add('filename');
  }
  if (hit.principles.some((principle) => hasTokenOverlap(queryTokens, tokenizeField(principle, tokenizer)))) {
    matchedBy.add('principle');
  }
  if (hit.tags.some((tag) => hasTokenOverlap(queryTokens, tokenizeField(tag, tokenizer)))) {
    matchedBy.add('tag');
  }
  if (hasTokenOverlap(queryTokens, tokenizeField(hit.title, tokenizer))) {
    matchedBy.add('title');
  }

  const snippet = extractSnippet(hit.document.body, rawQuery, oramaTerm, queryTokens, tokenizer);
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

  let limit = topK;
  let hits = await searchOrama(db, oramaTerm, limit);
  let exhausted = hits.length < limit;
  let resolvedHits = hits.map((hit) => resolveHit(hit, index));

  while (shouldContinueWidening(hits, resolvedHits, scope, topK, exhausted)) {
    limit = Math.max(limit + 1, limit * 2);
    hits = await searchOrama(db, oramaTerm, limit);
    exhausted = hits.length < limit;
    resolvedHits = hits.map((hit) => resolveHit(hit, index));
  }

  const selectedHits =
    scope === 'all' ? rerankHits(resolvedHits) : filterHitsByScope(resolvedHits, scope);

  return {
    results: selectedHits
      .slice(0, topK)
      .map((hit) => toResult(hit, queryTokens, tokenizer, rawQuery, oramaTerm)),
    mode: 'text',
  };
}
