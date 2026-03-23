import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readKbIndex } from './detect.js';
import { extractTitle, parseFrontmatter } from './frontmatter.js';
import { notesDir } from './paths.js';
import type { KbContext, KbResult, KbSearchResponse } from './types.js';
import { isNoEntryError } from '../shared/mcp-utils.js';

type MatchSurface = 'filename' | 'principle' | 'tag' | 'title' | 'content';

type SearchCandidate = {
  slug: string;
  path: string;
  title: string;
  tags: string[];
  principles: string[];
  matchedBy: Set<MatchSurface>;
  snippet?: string;
};

const MATCH_SURFACE_ORDER: MatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];

const MATCH_SURFACE_PRIORITY: Record<MatchSurface, number> = {
  filename: 0,
  principle: 1,
  tag: 2,
  title: 3,
  content: 4,
};

function notePathForSlug(slug: string): string {
  return `notes/${slug}.md`;
}

function sortedMatchedBy(matchedBy: Set<MatchSurface>): MatchSurface[] {
  return [...matchedBy].sort((left, right) => MATCH_SURFACE_PRIORITY[left] - MATCH_SURFACE_PRIORITY[right]);
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  const countDiff = right.matchedBy.size - left.matchedBy.size;
  if (countDiff !== 0) {
    return countDiff;
  }

  for (const surface of MATCH_SURFACE_ORDER) {
    const leftHas = left.matchedBy.has(surface);
    const rightHas = right.matchedBy.has(surface);
    if (leftHas !== rightHas) {
      return leftHas ? -1 : 1;
    }
  }

  return left.slug.localeCompare(right.slug);
}

function cloneCandidate(candidate: SearchCandidate): SearchCandidate {
  return {
    ...candidate,
    tags: [...candidate.tags],
    principles: [...candidate.principles],
    matchedBy: new Set(candidate.matchedBy),
  };
}

function createIndexedCandidate(
  slug: string,
  title: string,
  tags: string[],
  principles: string[],
): SearchCandidate {
  return {
    slug,
    path: notePathForSlug(slug),
    title,
    tags: [...tags],
    principles: [...principles],
    matchedBy: new Set<MatchSurface>(),
  };
}

function toResult(candidate: SearchCandidate): KbResult {
  return {
    path: candidate.path,
    title: candidate.title,
    matchedBy: sortedMatchedBy(candidate.matchedBy),
    tags: [...candidate.tags],
    principles: [...candidate.principles],
    ...(candidate.snippet === undefined ? {} : { snippet: candidate.snippet }),
  };
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

function extractSnippet(content: string, normalizedQuery: string): string | undefined {
  const normalizedContent = content.toLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex === -1) {
    return undefined;
  }

  const sentenceStart = findSentenceStart(content, matchIndex);
  const sentenceEnd = findSentenceEnd(content, matchIndex);
  const rawSnippet = content.slice(sentenceStart, sentenceEnd).replace(/\s+/g, ' ').trim();
  if (!rawSnippet) {
    return undefined;
  }

  const normalizedSnippet = rawSnippet.toLowerCase();
  const snippetMatchIndex = normalizedSnippet.indexOf(normalizedQuery);
  return truncateSnippet(rawSnippet, snippetMatchIndex === -1 ? 0 : snippetMatchIndex);
}

function rerank(candidates: Iterable<SearchCandidate>, topK: number): SearchCandidate[] {
  return [...candidates]
    .map(cloneCandidate)
    .sort(compareCandidates)
    .slice(0, topK);
}

function scanContentMatches(excludedSlugs: Set<string>, normalizedQuery: string): SearchCandidate[] {
  const matches: SearchCandidate[] = [];

  let entries: string[];
  try {
    entries = readdirSync(notesDir());
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return matches;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) {
      continue;
    }

    const slug = entry.slice(0, -3);
    if (excludedSlugs.has(slug)) {
      continue;
    }

    const path = join(notesDir(), entry);
    const raw = readFileSync(path, 'utf-8');
    if (!raw.toLowerCase().includes(normalizedQuery)) {
      continue;
    }

    const frontmatter = parseFrontmatter(raw);
    const candidate: SearchCandidate = {
      slug,
      path: notePathForSlug(slug),
      title: extractTitle(raw),
      tags: [...frontmatter.tags],
      principles: [...frontmatter.principles],
      matchedBy: new Set<MatchSurface>(['content']),
    };
    const snippet = extractSnippet(raw, normalizedQuery);
    if (snippet !== undefined) {
      candidate.snippet = snippet;
    }
    matches.push(candidate);
  }

  return matches;
}

export function searchBasic(kb: KbContext, query: string, top_k = 20): KbSearchResponse {
  void kb;

  const index = readKbIndex();
  if (index === null) {
    return {
      results: [],
      mode: 'basic',
      warning: 'Run kb_reindex to build the search index.',
    };
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return {
      results: [],
      mode: 'basic',
    };
  }
  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;
  const tierOne = new Map<string, SearchCandidate>();

  for (const [slug, note] of Object.entries(index.notes)) {
    const candidate = createIndexedCandidate(slug, note.title, note.tags, note.principles);

    if (slug.toLowerCase().includes(normalizedQuery)) {
      candidate.matchedBy.add('filename');
    }
    if (note.principles.some((principle) => principle.toLowerCase() === normalizedQuery)) {
      candidate.matchedBy.add('principle');
    }
    if (note.tags.some((tag) => tag.toLowerCase() === normalizedQuery)) {
      candidate.matchedBy.add('tag');
    }
    if (note.title.toLowerCase().includes(normalizedQuery)) {
      candidate.matchedBy.add('title');
    }

    if (candidate.matchedBy.size > 0) {
      tierOne.set(slug, candidate);
    }
  }

  const tierTwo = rerank(tierOne.values(), topK);
  if (tierTwo.length >= topK) {
    return {
      results: tierTwo.map(toResult),
      mode: 'basic',
    };
  }

  const merged = new Map<string, SearchCandidate>(tierTwo.map((candidate) => [candidate.slug, candidate]));
  const contentMatches = scanContentMatches(new Set(merged.keys()), normalizedQuery);

  for (const candidate of contentMatches) {
    merged.set(candidate.slug, candidate);
  }

  return {
    results: rerank(merged.values(), topK).map(toResult),
    mode: 'basic',
  };
}
