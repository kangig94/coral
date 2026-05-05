import {
  isCommunityEntry,
  type CommunityEntry,
  type KbEntryId,
  type KbIndex,
  type KbMatchSurface,
  type KbResult,
  type KbSearchResponse,
} from '../entry-types.js';
import { corpusStructuralCacheKey, type CorpusStructuralKey } from '../corpus/structural-key.js';
import type { RetrievalDiagnostic, RetrievalEvidence } from './contract.js';
import { extractSnippet, hasTokenOverlap, type QueryContext } from './snippets.js';
import {
  type HybridKbSearchHit,
  type ResolvedKbSearchEntry,
  type ResolvedKbSearchHit,
  type SearchResponseWarnings,
} from './text-retrieval.js';

const MATCH_SURFACE_ORDER: KbMatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];
const GRAPH_CONTEXT_MAX_COMMUNITIES = 3;
const GRAPH_COMMUNITY_RESULT_SPAN_MIN = 2;
const COMMUNITY_CONTEXT_INDEX_CACHE_LIMIT = 8;

type CommunityContextIndexEntry = {
  readonly community: CommunityEntry;
  readonly memberSet: ReadonlySet<string>;
};

type CommunityContextIndex = {
  readonly communities: readonly CommunityContextIndexEntry[];
};

const communityContextIndexCache = new Map<string, CommunityContextIndex>();

function sortedMatchedBy(matchedBy: Set<KbMatchSurface>): KbMatchSurface[] {
  const sorted: KbMatchSurface[] = [];
  for (const surface of MATCH_SURFACE_ORDER) {
    if (matchedBy.has(surface)) {
      sorted.push(surface);
    }
  }
  return sorted;
}

function withCommunityContext(result: KbResult, communityContext: string[] | undefined): KbResult {
  if (communityContext === undefined || communityContext.length === 0) {
    return result;
  }

  return {
    ...result,
    communityContext: [...communityContext],
  };
}

function buildCommunityContextIndex(index: KbIndex): CommunityContextIndex {
  const communities: CommunityContextIndexEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (!isCommunityEntry(entry) || typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      continue;
    }
    communities.push({
      community: entry,
      memberSet: new Set(entry.members),
    });
  }
  return { communities };
}

function readCommunityContextIndex(index: KbIndex, structuralKey: CorpusStructuralKey): CommunityContextIndex {
  const cacheKey = corpusStructuralCacheKey(structuralKey);
  const cached = communityContextIndexCache.get(cacheKey);
  if (cached !== undefined) {
    communityContextIndexCache.delete(cacheKey);
    communityContextIndexCache.set(cacheKey, cached);
    return cached;
  }

  const nextIndex = buildCommunityContextIndex(index);
  communityContextIndexCache.set(cacheKey, nextIndex);
  if (communityContextIndexCache.size > COMMUNITY_CONTEXT_INDEX_CACHE_LIMIT) {
    const oldestKey = communityContextIndexCache.keys().next().value;
    if (oldestKey !== undefined) {
      communityContextIndexCache.delete(oldestKey);
    }
  }
  return nextIndex;
}

function buildCommunityContextMap(
  hits: Array<Pick<ResolvedKbSearchEntry, 'entryId' | 'kind' | 'tags'>>,
  index: KbIndex,
  communitiesFresh: boolean,
  structuralKey: CorpusStructuralKey | null,
): Map<KbEntryId, string[]> {
  if (!communitiesFresh || structuralKey === null) {
    return new Map();
  }

  const noteSourceHits: Array<Pick<ResolvedKbSearchEntry, 'entryId' | 'kind' | 'tags'>> = [];
  for (const hit of hits) {
    if (hit.kind !== 'community') {
      noteSourceHits.push(hit);
    }
  }
  if (noteSourceHits.length < GRAPH_COMMUNITY_RESULT_SPAN_MIN) {
    return new Map();
  }

  const contextMap = new Map<KbEntryId, string[]>();
  const hitEntryIdsByTag = new Map<string, Set<KbEntryId>>();
  for (const hit of noteSourceHits) {
    for (const tag of hit.tags) {
      const existing = hitEntryIdsByTag.get(tag);
      if (existing !== undefined) {
        existing.add(hit.entryId);
        continue;
      }
      hitEntryIdsByTag.set(tag, new Set([hit.entryId]));
    }
  }

  const relevantCommunities: Array<{
    community: CommunityEntry;
    overlapMembers: Set<string>;
    matchingEntryIds: Set<KbEntryId>;
  }> = [];

  const communityContextIndex = readCommunityContextIndex(index, structuralKey);
  for (const { community, memberSet } of communityContextIndex.communities) {
    const overlapMembers = new Set<string>();
    const matchingEntryIds = new Set<KbEntryId>();
    for (const member of memberSet) {
      const entryIds = hitEntryIdsByTag.get(member);
      if (entryIds === undefined) {
        continue;
      }
      overlapMembers.add(member);
      for (const entryId of entryIds) {
        matchingEntryIds.add(entryId);
      }
    }

    if (matchingEntryIds.size >= GRAPH_COMMUNITY_RESULT_SPAN_MIN) {
      relevantCommunities.push({
        community,
        overlapMembers,
        matchingEntryIds,
      });
    }
  }

  relevantCommunities.sort(
    (left, right) =>
      right.matchingEntryIds.size - left.matchingEntryIds.size ||
      right.overlapMembers.size - left.overlapMembers.size ||
      left.community.level - right.community.level ||
      left.community.slug.localeCompare(right.community.slug),
  );
  if (relevantCommunities.length > GRAPH_CONTEXT_MAX_COMMUNITIES) {
    relevantCommunities.length = GRAPH_CONTEXT_MAX_COMMUNITIES;
  }

  for (const { community, matchingEntryIds } of relevantCommunities) {
    const summary = community.summary?.trim();
    if (!summary) {
      continue;
    }
    const summaryText = `${community.title}: ${summary}`;
    for (const entryId of matchingEntryIds) {
      const existing = contextMap.get(entryId) ?? [];
      if (!existing.includes(summaryText)) {
        existing.push(summaryText);
      }
      contextMap.set(entryId, existing);
    }
  }

  return contextMap;
}

function evidenceFrom(hit: ResolvedKbSearchEntry | ResolvedKbSearchHit | HybridKbSearchHit): RetrievalEvidence[] {
  if (!('evidence' in hit)) {
    return [];
  }

  const evidence: RetrievalEvidence[] = [];
  for (const item of hit.evidence) {
    if (item.match === undefined) {
      evidence.push({ ...item });
      continue;
    }
    evidence.push({ ...item, match: [...item.match] });
  }
  return evidence;
}

function toResult(hit: ResolvedKbSearchHit, query: QueryContext, evidence: RetrievalEvidence[] = []): KbResult {
  const matchedBy = new Set<KbMatchSurface>();

  if (hasTokenOverlap(query.queryTokens, query.fts.tokenize(hit.slug))) {
    matchedBy.add('filename');
  }
  if (hit.principles.some((principle) => hasTokenOverlap(query.queryTokens, query.fts.tokenize(principle)))) {
    matchedBy.add('principle');
  }
  if (hit.tags.some((tag) => hasTokenOverlap(query.queryTokens, query.fts.tokenize(tag)))) {
    matchedBy.add('tag');
  }
  if (hasTokenOverlap(query.queryTokens, query.fts.tokenize(hit.title))) {
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
    evidence,
    ...(snippet === undefined ? {} : { snippet }),
  };
}

function toVectorOnlyResult(
  hit: ResolvedKbSearchEntry,
  communityContext?: string[],
  evidence: RetrievalEvidence[] = [],
): KbResult {
  return withCommunityContext(
    {
      note: hit.slug,
      kind: hit.kind,
      title: hit.title,
      matchedBy: [],
      tags: [...hit.tags],
      principles: [...hit.principles],
      evidence,
    },
    communityContext,
  );
}

function toHybridResult(
  hit: ResolvedKbSearchHit | HybridKbSearchHit,
  query: QueryContext,
  communityContext?: string[],
): KbResult {
  const evidence = evidenceFrom(hit);
  const base =
    hit.document === null
      ? toVectorOnlyResult(hit, communityContext, evidence)
      : withCommunityContext(toResult(hit as ResolvedKbSearchHit, query, evidence), communityContext);

  return base;
}

export function buildTextResponse(
  hits: Array<ResolvedKbSearchHit | HybridKbSearchHit>,
  query: QueryContext,
  topK: number,
  index: KbIndex,
  communitiesFresh: boolean,
  structuralKey: CorpusStructuralKey | null,
  responseWarnings: SearchResponseWarnings = {},
  retrievalDiagnostics: readonly RetrievalDiagnostic[] = [],
): KbSearchResponse {
  const finalHits = hits.slice(0, topK);
  const communityContext = buildCommunityContextMap(finalHits, index, communitiesFresh, structuralKey);
  const results: KbResult[] = [];
  for (const hit of finalHits) {
    results.push(toHybridResult(hit, query, communityContext.get(hit.entryId)));
  }

  return {
    results,
    mode: 'text',
    retrievalDiagnostics: [...retrievalDiagnostics],
    ...(responseWarnings.warning === undefined ? {} : { warning: responseWarnings.warning }),
    ...(responseWarnings.warnings === undefined ? {} : { warnings: responseWarnings.warnings }),
  };
}

export function buildHybridResponse(
  hits: HybridKbSearchHit[],
  query: QueryContext,
  topK: number,
  index: KbIndex,
  communitiesFresh: boolean,
  structuralKey: CorpusStructuralKey | null,
  responseWarnings: SearchResponseWarnings = {},
  retrievalDiagnostics: readonly RetrievalDiagnostic[] = [],
): KbSearchResponse {
  const finalHits = hits.slice(0, topK);
  const communityContext = buildCommunityContextMap(finalHits, index, communitiesFresh, structuralKey);
  const results: KbResult[] = [];
  for (const hit of finalHits) {
    results.push(toHybridResult(hit, query, communityContext.get(hit.entryId)));
  }

  return {
    results,
    mode: 'hybrid',
    retrievalDiagnostics: [...retrievalDiagnostics],
    ...(responseWarnings.warning === undefined ? {} : { warning: responseWarnings.warning }),
    ...(responseWarnings.warnings === undefined ? {} : { warnings: responseWarnings.warnings }),
  };
}

export function buildVectorResponse(
  hits: readonly (ResolvedKbSearchEntry | HybridKbSearchHit)[],
  topK: number,
  responseWarnings: SearchResponseWarnings = {},
  retrievalDiagnostics: readonly RetrievalDiagnostic[] = [],
): KbSearchResponse {
  const results: KbResult[] = [];
  for (const hit of hits.slice(0, topK)) {
    results.push(toVectorOnlyResult(hit, undefined, evidenceFrom(hit)));
  }

  return {
    results,
    mode: 'vector',
    retrievalDiagnostics: [...retrievalDiagnostics],
    ...(responseWarnings.warning === undefined ? {} : { warning: responseWarnings.warning }),
    ...(responseWarnings.warnings === undefined ? {} : { warnings: responseWarnings.warnings }),
  };
}
