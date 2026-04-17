import { search as oramaSearch } from '@orama/orama';
import {
  computeCommunitySummaryInputFingerprints,
  computeCommunityTopologyFingerprint,
} from '../curate/community-detection.js';
import { readCurateState } from '../curate/state.js';
import {
  normalizeOramaTerm,
  normalizeWhitespace,
  tokenizeField,
  tokenizeQuery,
  type KbOramaDocument,
} from '../orama-factory.js';
import type { KbOramaDb, KbOramaTokenizer } from '../orama-schema.js';
import type { KbRuntime } from '../contracts.js';
import {
  type EntityGraph,
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
  type RelationshipType,
} from '../types.js';
import { createEmbeddingProvider } from '../vector/embedding.js';
import { ensureVectorIndex } from '../vector/sync.js';

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
const GRAPH_RRF_WEIGHT = 0.22;
const GRAPH_MAX_NEIGHBORS_PER_SEED = 10;
const GRAPH_CONTEXT_MAX_COMMUNITIES = 3;
const GRAPH_COMMUNITY_RESULT_SPAN_MIN = 2;
const GRAPH_ENTRY_MATCH_WEIGHTS = [1, 0.65, 0.4] as const;
const GRAPH_RELATIONSHIP_WEIGHTS: Record<RelationshipType, number> = {
  enables: 0.78,
  requires: 0.74,
  constrains: 0.58,
  implements: 0.76,
  specializes: 0.66,
  'conflicts-with': 0.42,
  precedes: 0.48,
  composes: 0.7,
  abstracts: 0.54,
  replaces: 0.6,
};

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
  graphRank?: number;
};

type GraphNeighbor = {
  entity: string;
  weight: number;
  relationshipTypes: RelationshipType[];
};

type GraphSearchContext = {
  entityMeta: EntityGraph['entityMeta'];
  adjacency: Map<string, GraphNeighbor[]>;
  aliasLookup: Map<string, Set<string>>;
  phraseLookup: Map<string, Set<string>>;
};

type GraphKbSearchHit = ResolvedKbSearchEntry & {
  score: number;
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
  const anchor =
    findPhraseAnchor(content, query.rawQuery, query.oramaTerm) ??
    findTokenAnchor(content, query.queryTokens, query.tokenizer);

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

function normalizeGraphPhrase(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' '),
  );
}

function normalizeGraphSlug(value: string): string {
  const phrase = normalizeGraphPhrase(value);
  return phrase === '' ? '' : phrase.replace(/\s+/g, '-');
}

function addLookupValue(lookup: Map<string, Set<string>>, key: string, value: string): void {
  if (key === '') {
    return;
  }

  const existing = lookup.get(key);
  if (existing === undefined) {
    lookup.set(key, new Set([value]));
    return;
  }

  existing.add(value);
}

function stableEntityGraph(graph: EntityGraph): EntityGraph {
  return {
    entityMeta: Object.fromEntries(
      Object.entries(graph.entityMeta)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entityName, meta]) => [
          entityName,
          {
            type: meta.type,
            description: meta.description,
            ...(meta.aliases === undefined
              ? {}
              : { aliases: [...new Set(meta.aliases)].sort((left, right) => left.localeCompare(right)) }),
          },
        ]),
    ),
    relationships: [...graph.relationships]
      .map((relationship) => ({
        source: relationship.source,
        target: relationship.target,
        type: relationship.type,
        description: relationship.description,
        evidence: [...new Set(relationship.evidence)].sort((left, right) => left.localeCompare(right)),
      }))
      .sort(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          left.target.localeCompare(right.target) ||
          left.type.localeCompare(right.type) ||
          left.description.localeCompare(right.description),
      ),
  };
}

function graphStateMatchesIndex(index: KbIndex, currentGraph: EntityGraph): boolean {
  const loadedGraph = stableEntityGraph({
    entityMeta: index.entityMeta ?? {},
    relationships: index.relationships ?? [],
  });

  return JSON.stringify(loadedGraph) === JSON.stringify(stableEntityGraph(currentGraph));
}

function buildGraphSearchContext(index: KbIndex, currentGraph: EntityGraph | null): GraphSearchContext | null {
  if (currentGraph === null || Object.keys(currentGraph.entityMeta).length === 0 || !graphStateMatchesIndex(index, currentGraph)) {
    return null;
  }

  const adjacencyBuilders = new Map<
    string,
    Map<string, { weight: number; relationshipTypes: Set<RelationshipType> }>
  >();
  const aliasLookup = new Map<string, Set<string>>();
  const phraseLookup = new Map<string, Set<string>>();

  const ensureNeighbors = (entityName: string) => {
    const existing = adjacencyBuilders.get(entityName);
    if (existing !== undefined) {
      return existing;
    }

    const next = new Map<string, { weight: number; relationshipTypes: Set<RelationshipType> }>();
    adjacencyBuilders.set(entityName, next);
    return next;
  };

  for (const [entityName, meta] of Object.entries(currentGraph.entityMeta)) {
    addLookupValue(phraseLookup, normalizeGraphPhrase(entityName), entityName);

    for (const alias of meta.aliases ?? []) {
      addLookupValue(aliasLookup, normalizeGraphSlug(alias), entityName);
      addLookupValue(phraseLookup, normalizeGraphPhrase(alias), entityName);
    }
  }

  for (const relationship of currentGraph.relationships) {
    if (
      currentGraph.entityMeta[relationship.source] === undefined ||
      currentGraph.entityMeta[relationship.target] === undefined ||
      relationship.source === relationship.target
    ) {
      continue;
    }

    const relationshipWeight = GRAPH_RELATIONSHIP_WEIGHTS[relationship.type];
    for (const [source, target] of [
      [relationship.source, relationship.target],
      [relationship.target, relationship.source],
    ] as const) {
      const neighbors = ensureNeighbors(source);
      const existing = neighbors.get(target);
      if (existing === undefined) {
        neighbors.set(target, {
          weight: relationshipWeight,
          relationshipTypes: new Set([relationship.type]),
        });
        continue;
      }

      existing.weight = Math.max(existing.weight, relationshipWeight);
      existing.relationshipTypes.add(relationship.type);
    }
  }

  const adjacency = new Map<string, GraphNeighbor[]>();
  for (const entityName of Object.keys(currentGraph.entityMeta)) {
    const neighbors = [...(adjacencyBuilders.get(entityName)?.entries() ?? [])]
      .map(([neighbor, attributes]) => ({
        entity: neighbor,
        weight: attributes.weight,
        relationshipTypes: [...attributes.relationshipTypes].sort((left, right) => left.localeCompare(right)),
      }))
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          left.entity.localeCompare(right.entity) ||
          left.relationshipTypes.join('\u0000').localeCompare(right.relationshipTypes.join('\u0000')),
      );
    adjacency.set(entityName, neighbors);
  }

  return {
    entityMeta: currentGraph.entityMeta,
    adjacency,
    aliasLookup,
    phraseLookup,
  };
}

function containsNormalizedPhrase(query: string, phrase: string): boolean {
  if (query === '' || phrase === '') {
    return false;
  }

  return ` ${query} `.includes(` ${phrase} `);
}

function setMaxScore(scores: Map<string, number>, entity: string, score: number): void {
  const current = scores.get(entity) ?? 0;
  if (score > current) {
    scores.set(entity, score);
  }
}

function addBoundedScore(scores: Map<string, number>, entity: string, score: number, cap: number): void {
  const current = scores.get(entity) ?? 0;
  scores.set(entity, Math.min(cap, current + score));
}

function resolveGraphSeeds(rawQuery: string, graph: GraphSearchContext): Map<string, number> {
  const seeds = new Map<string, number>();
  const normalizedSlug = normalizeGraphSlug(rawQuery);
  if (normalizedSlug !== '' && graph.entityMeta[normalizedSlug] !== undefined) {
    setMaxScore(seeds, normalizedSlug, 1);
  }

  for (const canonicalName of graph.aliasLookup.get(normalizedSlug) ?? []) {
    setMaxScore(seeds, canonicalName, 0.96);
  }

  const normalizedQuery = normalizeGraphPhrase(rawQuery);
  if (normalizedQuery === '') {
    return seeds;
  }

  for (const [phrase, canonicalNames] of graph.phraseLookup.entries()) {
    if (!containsNormalizedPhrase(normalizedQuery, phrase)) {
      continue;
    }

    for (const canonicalName of canonicalNames) {
      setMaxScore(seeds, canonicalName, 0.86);
    }
  }

  return seeds;
}

function expandGraphEntityScores(seeds: ReadonlyMap<string, number>, graph: GraphSearchContext): Map<string, number> {
  const entityScores = new Map<string, number>();

  for (const [seed, seedScore] of seeds.entries()) {
    addBoundedScore(entityScores, seed, seedScore, 1.35);

    for (const neighbor of (graph.adjacency.get(seed) ?? []).slice(0, GRAPH_MAX_NEIGHBORS_PER_SEED)) {
      addBoundedScore(entityScores, neighbor.entity, seedScore * neighbor.weight, 1.1);
    }
  }

  return entityScores;
}

function scoreGraphMatches(matchScores: number[]): number {
  return [...matchScores]
    .sort((left, right) => right - left)
    .slice(0, GRAPH_ENTRY_MATCH_WEIGHTS.length)
    .reduce((total, score, index) => total + score * GRAPH_ENTRY_MATCH_WEIGHTS[index], 0);
}

function buildGraphHits(
  index: KbIndex,
  rawQuery: string,
  scope: KbSearchScope,
  graph: GraphSearchContext | null,
): GraphKbSearchHit[] {
  if (graph === null) {
    return [];
  }

  const seeds = resolveGraphSeeds(rawQuery, graph);
  if (seeds.size === 0) {
    return [];
  }

  const entityScores = expandGraphEntityScores(seeds, graph);
  if (entityScores.size === 0) {
    return [];
  }

  const hits: GraphKbSearchHit[] = [];
  for (const entryId of Object.keys(index.entries)) {
    const entry = resolveEntry(entryId, index);
    if (entry === null || !isVectorScope(entry.kind, scope)) {
      continue;
    }

    const matchScores = [...new Set(entry.tags)]
      .map((tag) => entityScores.get(tag))
      .filter((score): score is number => score !== undefined);
    if (matchScores.length === 0) {
      continue;
    }

    hits.push({
      ...entry,
      score: scoreGraphMatches(matchScores),
    });
  }

  return rerankHits(hits);
}

function filterHitsByScope<T extends { kind: KbResult['kind'] }>(hits: T[], scope: KbSearchScope): T[] {
  if (scope === 'all') {
    // Communities are meta-documents — exclude from default results so they
    // don't displace actual notes/sources. Use --scope communities explicitly.
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

function areCommunityResultsFresh(
  rt: Pick<KbRuntime, 'curateStatePath' | 'notePath' | 'sourcePath'>,
  index: KbIndex,
): boolean {
  const hasCommunityEntries = Object.values(index.entries).some((entry) => entry.kind === 'community');
  if (!hasCommunityEntries) {
    return true;
  }

  const state = readCurateState(rt);
  const topologyHash = computeCommunityTopologyFingerprint(index);
  if (state.communityTopologyHash !== topologyHash || state.communitySummaryTopologyHash !== topologyHash) {
    return false;
  }

  try {
    const communities = Object.values(index.entries)
      .filter(isCommunityEntry)
      .map((community) => ({
        slug: community.slug,
        title: community.title,
        level: community.level,
        members: community.members,
        ...(community.children === undefined ? {} : { children: community.children }),
        ...(community.summary === undefined ? {} : { summary: community.summary }),
      }));
    const currentFingerprints = computeCommunitySummaryInputFingerprints(communities, rt, index);
    const storedFingerprints = state.communitySummaryInputFingerprints ?? {};
    const currentEntries = Object.entries(currentFingerprints).sort(([left], [right]) => left.localeCompare(right));
    const storedEntries = Object.entries(storedFingerprints)
      .filter(([slug]) => slug in currentFingerprints)
      .sort(([left], [right]) => left.localeCompare(right));

    return (
      currentEntries.length === storedEntries.length &&
      currentEntries.every(
        ([slug, fingerprint], index) =>
          storedEntries[index]?.[0] === slug && storedEntries[index]?.[1] === fingerprint,
      )
    );
  } catch {
    return false;
  }
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

function filterSearchableHits(hits: ResolvedKbSearchHit[], communitiesFresh: boolean): ResolvedKbSearchHit[] {
  return hits.filter((hit) => isSearchableHit(hit, communitiesFresh));
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

  if (hasTokenOverlap(query.queryTokens, tokenizeField(hit.slug, query.tokenizer))) {
    matchedBy.add('filename');
  }
  if (
    hit.principles.some((principle) => hasTokenOverlap(query.queryTokens, tokenizeField(principle, query.tokenizer)))
  ) {
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
  if (hit.document === null) {
    return toVectorOnlyResult(hit, communityContext);
  }

  return withCommunityContext(toResult(hit as ResolvedKbSearchHit, query), communityContext);
}

function buildTextResponse(
  hits: Array<ResolvedKbSearchHit | HybridKbSearchHit>,
  query: QueryContext,
  topK: number,
  index: KbIndex,
  communitiesFresh: boolean,
  graphFresh: boolean,
  warning?: string,
): KbSearchResponse {
  const finalHits = hits.slice(0, topK);
  const communityContext = buildCommunityContextMap(finalHits, index, communitiesFresh, graphFresh);

  return {
    results: finalHits.map((hit) => toHybridResult(hit, query, communityContext.get(hit.entryId))),
    mode: 'text',
    ...(warning === undefined ? {} : { warning }),
  };
}

function buildHybridResponse(
  hits: HybridKbSearchHit[],
  query: QueryContext,
  topK: number,
  index: KbIndex,
  communitiesFresh: boolean,
  graphFresh: boolean,
  warning?: string,
): KbSearchResponse {
  const finalHits = hits.slice(0, topK);
  const communityContext = buildCommunityContextMap(finalHits, index, communitiesFresh, graphFresh);

  return {
    results: finalHits.map((hit) => toHybridResult(hit, query, communityContext.get(hit.entryId))),
    mode: 'hybrid',
    ...(warning === undefined ? {} : { warning }),
  };
}

function isVectorScope(kind: KbResult['kind'], scope: KbSearchScope): boolean {
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

function fuseHits(
  oramaHits: ResolvedKbSearchHit[],
  vectorHits: VectorKbSearchHit[],
  graphHits: GraphKbSearchHit[],
): HybridKbSearchHit[] {
  const fused = new Map<KbEntryId, HybridKbSearchHit>();

  for (const [index, hit] of oramaHits.entries()) {
    fused.set(hit.entryId, {
      ...hit,
      document: hit.document,
      score: rrfScore(index + 1),
    });
  }

  for (const [index, hit] of graphHits.entries()) {
    const graphRank = index + 1;
    const contribution = GRAPH_RRF_WEIGHT * rrfScore(graphRank);
    const previous = fused.get(hit.entryId);

    if (previous === undefined) {
      fused.set(hit.entryId, {
        ...hit,
        document: null,
        score: contribution,
        graphRank,
      });
      continue;
    }

    fused.set(hit.entryId, {
      ...previous,
      score: previous.score + contribution,
      graphRank,
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
  searchVector: (
    query: Float32Array,
    candidateK: number,
  ) => Promise<Array<{ chunkId: string; entryId: string; score: number }>>,
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
  const communitiesFresh = areCommunityResultsFresh(rt, index);
  const graphContext = buildGraphSearchContext(index, rt.readEntityGraph());
  const graphFresh = graphContext !== null;

  let limit = topK;
  let hits = await searchOrama(db, oramaTerm, limit);
  let exhausted = hits.length < limit;
  const resolvedHits = hits.map((hit) => resolveHit(hit, index));

  while (shouldContinueWidening(hits, resolvedHits, communitiesFresh, scope, topK, exhausted)) {
    const prevCount = hits.length;
    limit = Math.max(limit + 1, limit * 2);
    hits = await searchOrama(db, oramaTerm, limit);
    exhausted = hits.length < limit;
    for (let i = prevCount; i < hits.length; i++) {
      resolvedHits.push(resolveHit(hits[i], index));
    }
  }

  const searchableHits = filterSearchableHits(resolvedHits, communitiesFresh);
  const selectedHits = scope === 'all' ? rerankHits(searchableHits) : filterHitsByScope(searchableHits, scope);
  const graphHits = buildGraphHits(index, rawQuery, scope, graphContext);
  const textHits: Array<ResolvedKbSearchHit | HybridKbSearchHit> =
    graphHits.length === 0 ? selectedHits : fuseHits(selectedHits, [], graphHits);
  if (scope === 'communities') {
    return buildTextResponse(selectedHits, queryCtx, topK, index, communitiesFresh, graphFresh);
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
      vectorLease.vectorStatus.indexedSeq === indexState.contentSeq &&
      vectorLease.vectorStatus.staleReason === undefined &&
      vectorLease.vectorStatus.activeSnapshotId === vectorLease.snapshotId;

    if (!canUseHybrid) {
      return buildTextResponse(textHits, queryCtx, topK, index, communitiesFresh, graphFresh, vectorResult.warning);
    }

    try {
      const provider = await createEmbeddingProvider(rt.runtimeDir);
      if (provider === null) {
        return buildTextResponse(textHits, queryCtx, topK, index, communitiesFresh, graphFresh, vectorResult.warning);
      }

      const queryVector = await provider.embedQuery(rawQuery);
      const vectorHits = await searchVectorEntries(
        vectorLease.store.searchVector.bind(vectorLease.store),
        queryVector,
        topK,
        index,
        scope,
      );
      const fusedHits = fuseHits(selectedHits, vectorHits, graphHits);
      const finalHits = fusedHits.slice(0, topK);
      const usedVector = finalHits.some((hit) => hit.vectorRank !== undefined);

      if (!usedVector) {
        return buildTextResponse(textHits, queryCtx, topK, index, communitiesFresh, graphFresh, vectorResult.warning);
      }

      return buildHybridResponse(fusedHits, queryCtx, topK, index, communitiesFresh, graphFresh, vectorResult.warning);
    } catch {
      return buildTextResponse(textHits, queryCtx, topK, index, communitiesFresh, graphFresh, vectorResult.warning);
    }
  } finally {
    await vectorLease?.release();
  }
}
