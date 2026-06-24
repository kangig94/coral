import type { FtsRetrieval } from '../contract.js';
import { normalizeWhitespace } from '../text-normalization.js';

type SnippetAnchor = {
  index: number;
  length: number;
};

const SNIPPET_WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });
const TOKEN_ANCHOR_SCAN_LIMIT = 256 * 1024;
const WORD_SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}_'-]+|[\p{Script=Hangul}\p{Mark}\p{Number}_'-]+|[\p{Script=Han}\p{Mark}\p{Number}_'-]+|[\p{Script=Hiragana}\p{Mark}\p{Number}_'-]+|[\p{Script=Katakana}\p{Mark}\p{Number}_'-]+|[\p{Letter}\p{Mark}\p{Number}_'-]+/gu;

export type QueryContext = {
  rawQuery: string;
  normalizedQuery: string;
  queryTokens: readonly string[];
  fts: FtsRetrieval;
};

export async function tokenizeMany(
  fts: FtsRetrieval,
  texts: readonly string[],
): Promise<readonly (readonly string[])[]> {
  if (texts.length === 0) {
    return [];
  }
  return fts.tokenizeBatch?.(texts) ?? Promise.all(texts.map((text) => fts.tokenize(text)));
}

export function hasTokenOverlap(queryTokens: readonly string[], fieldTokens: readonly string[]): boolean {
  if (queryTokens.length === 0 || fieldTokens.length === 0) {
    return false;
  }

  if (queryTokens.length === 1) {
    const token = queryTokens[0];
    return token !== undefined && fieldTokens.includes(token);
  }
  if (fieldTokens.length === 1) {
    const token = fieldTokens[0];
    return token !== undefined && queryTokens.includes(token);
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
  let bestAnchor: SnippetAnchor | null = null;

  const considerCandidate = (candidate: string): void => {
    if (candidate.length === 0) {
      return;
    }

    const matchIndex = normalizedContent.indexOf(candidate.toLowerCase());
    if (matchIndex !== -1 && (bestAnchor === null || matchIndex < bestAnchor.index)) {
      bestAnchor = {
        index: matchIndex,
        length: candidate.length,
      };
    }
  };

  const rawCandidate = rawQuery.trim();
  considerCandidate(rawCandidate);
  if (normalizedQuery !== rawCandidate) {
    considerCandidate(normalizedQuery);
  }

  return bestAnchor;
}

function* snippetTokenCandidates(content: string): Iterable<SnippetAnchor> {
  for (const segment of SNIPPET_WORD_SEGMENTER.segment(content)) {
    if (segment.isWordLike !== true) {
      continue;
    }

    for (const run of segment.segment.matchAll(WORD_SCRIPT_RUN_PATTERN)) {
      yield {
        index: segment.index + (run.index ?? 0),
        length: run[0].length,
      };
    }
  }
}

// Mirrors the tokenizer's Intl word segmentation, splitting mixed-script words into script runs.
async function findTokenAnchor(
  content: string,
  queryTokens: readonly string[],
  fts: FtsRetrieval,
): Promise<SnippetAnchor | null> {
  const scanContent = content.length > TOKEN_ANCHOR_SCAN_LIMIT ? content.slice(0, TOKEN_ANCHOR_SCAN_LIMIT) : content;
  for (const candidate of snippetTokenCandidates(scanContent)) {
    const valueTokens = await fts.tokenize(scanContent.slice(candidate.index, candidate.index + candidate.length));
    if (!hasTokenOverlap(queryTokens, valueTokens)) {
      continue;
    }

    return candidate;
  }

  return null;
}

export async function extractSnippet(content: string, query: QueryContext): Promise<string | undefined> {
  const phraseAnchor = findPhraseAnchor(content, query.rawQuery, query.normalizedQuery);
  const anchor = phraseAnchor ?? (await findTokenAnchor(content, query.queryTokens, query.fts));

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
