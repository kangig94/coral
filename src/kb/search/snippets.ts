import type { FtsRetrieval } from '../contract.js';
import { normalizeWhitespace } from '../text-normalization.js';

type SnippetAnchor = {
  index: number;
  length: number;
};

export type QueryContext = {
  rawQuery: string;
  normalizedQuery: string;
  queryTokens: readonly string[];
  fts: FtsRetrieval;
};

export function hasTokenOverlap(queryTokens: readonly string[], fieldTokens: readonly string[]): boolean {
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

function findPhraseAnchor(content: string, rawQuery: string, normalizedQuery: string): SnippetAnchor | null {
  const normalizedContent = content.toLowerCase();
  const candidates = [...new Set([rawQuery.trim(), normalizedQuery].filter(Boolean))];
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

// Inverse of Orama English SPLITTER, preserving the indexer's word boundaries.
function findTokenAnchor(content: string, queryTokens: readonly string[], fts: FtsRetrieval): SnippetAnchor | null {
  for (const match of content.matchAll(/[A-Za-zàèéìòóù0-9_'-]+/gim)) {
    const value = match[0];
    const valueTokens = fts.tokenize(value);
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

export function extractSnippet(content: string, query: QueryContext): string | undefined {
  const anchor =
    findPhraseAnchor(content, query.rawQuery, query.normalizedQuery) ??
    findTokenAnchor(content, query.queryTokens, query.fts);

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
