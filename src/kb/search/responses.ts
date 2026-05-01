import {
  isCommunityEntry,
  type KbEntryId,
  type KbIndex,
  type KbMatchSurface,
  type KbResult,
  type KbSearchResponse,
} from '../entry-types.js';
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

function sortedMatchedBy(matchedBy: Set<KbMatchSurface>): KbMatchSurface[] {
  return MATCH_SURFACE_ORDER.filter((surface) => matchedBy.has(surface));
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

function buildCommunityContextMap(
  hits: Array<Pick<ResolvedKbSearchEntry, 'entryId' | 'kind' | 'tags'>>,
  index: KbIndex,
  communitiesFresh: boolean,
  graphFresh: boolean,
): Map<KbEntryId, string[]> {
  if (!communitiesFresh || !graphFresh) {
    return new Map();
  }

  const noteSourceHits = hits.filter((hit) => hit.kind !== 'community');
  if (noteSourceHits.length < GRAPH_COMMUNITY_RESULT_SPAN_MIN) {
    return new Map();
  }

  const contextMap = new Map<KbEntryId, string[]>();
  const relevantCommunities = Object.values(index.entries)
    .filter(isCommunityEntry)
    .filter((community) => typeof community.summary === 'string' && community.summary.trim() !== '')
    .map((community) => {
      const memberSet = new Set(community.members);
      const overlapMembers = new Set<string>();
      const matchingEntryIds = new Set<KbEntryId>();

      for (const hit of noteSourceHits) {
        const matchedMembers = hit.tags.filter((tag) => memberSet.has(tag));
        if (matchedMembers.length === 0) {
          continue;
        }

        matchingEntryIds.add(hit.entryId);
        for (const member of matchedMembers) {
          overlapMembers.add(member);
        }
      }

      return {
        community,
        memberSet,
        overlapMembers,
        matchingEntryIds,
      };
    })
    .filter(({ matchingEntryIds }) => matchingEntryIds.size >= GRAPH_COMMUNITY_RESULT_SPAN_MIN)
    .sort(
      (left, right) =>
        right.matchingEntryIds.size - left.matchingEntryIds.size ||
        right.overlapMembers.size - left.overlapMembers.size ||
        left.community.level - right.community.level ||
        left.community.slug.localeCompare(right.community.slug),
    )
    .slice(0, GRAPH_CONTEXT_MAX_COMMUNITIES);

  for (const { community, memberSet } of relevantCommunities) {
    const summary = community.summary?.trim();
    if (!summary) {
      continue;
    }
    const summaryText = `${community.title}: ${summary}`;
    for (const hit of noteSourceHits) {
      if (!hit.tags.some((tag) => memberSet.has(tag))) {
        continue;
      }

      const existing = contextMap.get(hit.entryId) ?? [];
      if (!existing.includes(summaryText)) {
        existing.push(summaryText);
      }
      contextMap.set(hit.entryId, existing);
    }
  }

  return contextMap;
}

function toResult(hit: ResolvedKbSearchHit, query: QueryContext): KbResult {
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
    ...(snippet === undefined ? {} : { snippet }),
  };
}

function toVectorOnlyResult(hit: ResolvedKbSearchEntry, communityContext?: string[]): KbResult {
  return withCommunityContext(
    {
      note: hit.slug,
      kind: hit.kind,
      title: hit.title,
      matchedBy: [],
      tags: [...hit.tags],
      principles: [...hit.principles],
    },
    communityContext,
  );
}

function toHybridResult(
  hit: ResolvedKbSearchHit | HybridKbSearchHit,
  query: QueryContext,
  communityContext?: string[],
): KbResult {
  const base =
    hit.document === null
      ? toVectorOnlyResult(hit, communityContext)
      : withCommunityContext(toResult(hit as ResolvedKbSearchHit, query), communityContext);
  const graphRank = 'graphRank' in hit ? hit.graphRank : undefined;

  return graphRank === undefined ? base : { ...base, graphRank };
}

export function buildTextResponse(
  hits: Array<ResolvedKbSearchHit | HybridKbSearchHit>,
  query: QueryContext,
  topK: number,
  index: KbIndex,
  communitiesFresh: boolean,
  graphFresh: boolean,
  responseWarnings: SearchResponseWarnings = {},
): KbSearchResponse {
  const finalHits = hits.slice(0, topK);
  const communityContext = buildCommunityContextMap(finalHits, index, communitiesFresh, graphFresh);

  return {
    results: finalHits.map((hit) => toHybridResult(hit, query, communityContext.get(hit.entryId))),
    mode: 'text',
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
  graphFresh: boolean,
  responseWarnings: SearchResponseWarnings = {},
): KbSearchResponse {
  const finalHits = hits.slice(0, topK);
  const communityContext = buildCommunityContextMap(finalHits, index, communitiesFresh, graphFresh);

  return {
    results: finalHits.map((hit) => toHybridResult(hit, query, communityContext.get(hit.entryId))),
    mode: 'hybrid',
    ...(responseWarnings.warning === undefined ? {} : { warning: responseWarnings.warning }),
    ...(responseWarnings.warnings === undefined ? {} : { warnings: responseWarnings.warnings }),
  };
}

export function buildVectorResponse(
  hits: readonly ResolvedKbSearchEntry[],
  topK: number,
  responseWarnings: SearchResponseWarnings = {},
): KbSearchResponse {
  return {
    results: hits.slice(0, topK).map((hit) => toVectorOnlyResult(hit)),
    mode: 'vector',
    ...(responseWarnings.warning === undefined ? {} : { warning: responseWarnings.warning }),
    ...(responseWarnings.warnings === undefined ? {} : { warnings: responseWarnings.warnings }),
  };
}
