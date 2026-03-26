import { search as oramaSearch } from '@orama/orama';
import {
  normalizeOramaTerm,
  normalizeWhitespace,
  tokenizeField,
  tokenizeQuery,
  type KbOramaDocument,
  type KbOramaTokenizer,
} from './orama-factory.js';
import type { KbRuntime } from './runtime.js';
import type { KbIndex, KbMatchSurface, KbResult, KbSearchResponse } from './types.js';

const MATCH_SURFACE_ORDER: KbMatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];
const ORAMA_SEARCH_PROPERTIES: Array<keyof KbOramaDocument> = ['slug', 'title', 'body', 'tags', 'principles'];
const ORAMA_SEARCH_BOOST = {
  slug: 3,
  title: 2,
  tags: 1.5,
  principles: 1.5,
  body: 1,
} as const;

type SnippetAnchor = {
  index: number;
  length: number;
};

function denormalizeSlug(slug: string): string {
  return slug.replace(/ /g, '-');
}

function sortedMatchedBy(matchedBy: Set<KbMatchSurface>): KbMatchSurface[] {
  return MATCH_SURFACE_ORDER.filter(surface => matchedBy.has(surface));
}

function hasTokenOverlap(queryTokens: string[], fieldTokens: string[]): boolean {
  if (queryTokens.length === 0 || fieldTokens.length === 0) {
    return false;
  }

  const fieldTokenSet = new Set(fieldTokens);
  return queryTokens.some(token => fieldTokenSet.has(token));
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
  let end = Math.min(snippet.length, start + windowSize);
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
    if (
      matchIndex !== -1
      && (bestAnchor === null || matchIndex < bestAnchor.index)
    ) {
      bestAnchor = {
        index: matchIndex,
        length: candidate.length,
      };
    }
  }

  return bestAnchor;
}

function findTokenAnchor(content: string, queryTokens: string[], tokenizer: KbOramaTokenizer): SnippetAnchor | null {
  for (const match of content.matchAll(/[A-Za-z0-9-]+/g)) {
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
  const anchor = findPhraseAnchor(content, rawQuery, oramaTerm)
    ?? findTokenAnchor(content, queryTokens, tokenizer);

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

function toResult(
  hit: KbOramaDocument,
  index: KbIndex,
  queryTokens: string[],
  tokenizer: KbOramaTokenizer,
  rawQuery: string,
  oramaTerm: string,
): KbResult {
  const slug = denormalizeSlug(hit.slug);
  const note = index.notes[slug];
  const title = note?.title ?? hit.title;
  const tags = note?.tags ?? [...hit.tags];
  const principles = note?.principles ?? [...hit.principles];
  const matchedBy = new Set<KbMatchSurface>();

  if (hasTokenOverlap(queryTokens, tokenizeField(slug, tokenizer))) {
    matchedBy.add('filename');
  }
  if (principles.some(principle => hasTokenOverlap(queryTokens, tokenizeField(principle, tokenizer)))) {
    matchedBy.add('principle');
  }
  if (tags.some(tag => hasTokenOverlap(queryTokens, tokenizeField(tag, tokenizer)))) {
    matchedBy.add('tag');
  }
  if (hasTokenOverlap(queryTokens, tokenizeField(title, tokenizer))) {
    matchedBy.add('title');
  }

  const contentMatched = hasTokenOverlap(queryTokens, tokenizeField(hit.body, tokenizer));
  if (contentMatched) {
    matchedBy.add('content');
  }

  const snippet = contentMatched
    ? extractSnippet(hit.body, rawQuery, oramaTerm, queryTokens, tokenizer)
    : undefined;

  return {
    note: slug,
    title,
    matchedBy: sortedMatchedBy(matchedBy),
    tags: [...tags],
    principles: [...principles],
    ...(snippet === undefined ? {} : { snippet }),
  };
}

export async function searchKb(rt: KbRuntime, query: string, top_k = 20): Promise<KbSearchResponse> {
  const rawQuery = query.trim();
  const oramaTerm = normalizeOramaTerm(rawQuery);
  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;
  const { db, tokenizer, index } = await rt.ensureOramaIndex();
  const queryTokens = tokenizeQuery(oramaTerm, tokenizer);
  if (queryTokens.length === 0) {
    return {
      results: [],
      mode: 'text',
    };
  }

  const response = await oramaSearch(db, {
    term: oramaTerm,
    properties: ORAMA_SEARCH_PROPERTIES,
    boost: ORAMA_SEARCH_BOOST,
    threshold: 1,
    limit: topK,
  });

  return {
    results: response.hits.map(hit => toResult(hit.document, index, queryTokens, tokenizer, rawQuery, oramaTerm)),
    mode: 'text',
  };
}
