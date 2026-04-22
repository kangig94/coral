import { search as oramaSearch } from '@orama/orama';
import { areCommunityDocumentsFresh } from '../curate/text-artifacts.js';
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
  type KbSearchMode,
  type KbSearchResponse,
  type KbSearchScope,
  type RelationshipType,
} from '../entry-types.js';
import type {
  FusedRetrievalHit,
  GraphRetrieval,
  GraphRetrievalResult,
  HybridFusion,
  TextRetrievalResult,
  VectorRetrievalHit,
  VectorRetrievalResult,
} from '../search/contract.js';
import { createEmbeddingProvider } from '../search/embedding.js';
import { createOramaBaseProjection } from '../search/orama-backend.js';
import { createRouter, resolveVectorRoute, type ResolvedVectorRoute } from '../search/router.js';

const MATCH_SURFACE_ORDER: KbMatchSurface[] = ['filename', 'principle', 'tag', 'title', 'content'];
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

type HybridKbSearchHit = FusedRetrievalHit;

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

type SearchResponseWarnings = {
  warning?: string;
  warnings?: string[];
};

type TextSearchState = {
  queryCtx: QueryContext;
  selectedHits: ResolvedKbSearchHit[];
  communitiesFresh: boolean;
  graphFresh: boolean;
};

type TextGraphSearchState = TextSearchState & {
  router: ReturnType<typeof createRouter>;
  graphResult: GraphRetrievalResult;
  textHits: Array<ResolvedKbSearchHit | HybridKbSearchHit>;
};

const EMPTY_VECTOR_RETRIEVAL_RESULT: VectorRetrievalResult = { hits: [] };

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

function isGraphSearchFresh(index: KbIndex, currentGraph: EntityGraph | null): currentGraph is EntityGraph {
  return currentGraph !== null && Object.keys(currentGraph.entityMeta).length > 0 && graphStateMatchesIndex(index, currentGraph);
}

function buildGraphSearchContext(index: KbIndex, currentGraph: EntityGraph | null): GraphSearchContext | null {
  if (!isGraphSearchFresh(index, currentGraph)) {
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

function compareRetrievalRoleHits(
  left: Pick<ResolvedKbSearchEntry, 'entryId'> & { score: number },
  right: Pick<ResolvedKbSearchEntry, 'entryId'> & { score: number },
): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }

  return left.entryId.localeCompare(right.entryId);
}

function rankRetrievalRoleHits<T extends { entryId: KbEntryId; score: number }>(
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

function fuseRetrievalRoles(
  hybrid: HybridFusion,
  textHits: readonly ResolvedKbSearchHit[],
  vectorHits: readonly VectorRetrievalHit[],
  graph: GraphRetrievalResult,
): HybridKbSearchHit[] {
  return hybrid.fuse(toTextRetrievalResult(textHits), { hits: [...vectorHits] }, graph).hits;
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

  return [...hits].sort(compareRetrievalRoleHits);
}

class RuntimeGraphRetrieval implements GraphRetrieval {
  constructor(
    private readonly index: KbIndex,
    private readonly graph: GraphSearchContext | null,
  ) {}

  async search(query: string, scope: KbSearchScope = 'all'): Promise<GraphRetrievalResult> {
    return {
      hits: rankRetrievalRoleHits(buildGraphHits(this.index, query, scope, this.graph)),
    };
  }
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
  const base =
    hit.document === null
      ? toVectorOnlyResult(hit, communityContext)
      : withCommunityContext(toResult(hit as ResolvedKbSearchHit, query), communityContext);
  const graphRank = 'graphRank' in hit ? hit.graphRank : undefined;

  return graphRank === undefined ? base : { ...base, graphRank };
}

function buildTextResponse(
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

function buildHybridResponse(
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

function buildVectorResponse(
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

function emptySearchResponse(mode?: KbSearchMode): KbSearchResponse {
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

async function embedQueryForVectorSearch(rt: KbRuntime, rawQuery: string): Promise<number[] | null> {
  const provider = await createEmbeddingProvider(rt.runtimeDir);
  if (provider === null) {
    return null;
  }

  const queryVector = await provider.embedQuery(rawQuery);
  return Array.from(queryVector);
}

async function searchExplicitVectorResults(
  rt: KbRuntime,
  rawQuery: string,
  topK: number,
  scope: KbSearchScope,
  vectorRoute: ResolvedVectorRoute,
  options: {
    allowNeedleFallbackToOrama: boolean;
  },
): Promise<{ hits: VectorRetrievalHit[]; responseWarnings: SearchResponseWarnings; fallbackToText: boolean }> {
  const responseWarnings: SearchResponseWarnings =
    vectorRoute.warning === undefined ? {} : { warning: vectorRoute.warning };
  let queryVector: number[] | null;
  try {
    queryVector = await embedQueryForVectorSearch(rt, rawQuery);
  } catch {
    return {
      hits: [],
      responseWarnings: {
        warning: responseWarnings.warning ?? 'KB vector query embedding is unavailable.',
      },
      fallbackToText: true,
    };
  }
  if (queryVector === null) {
    return {
      hits: [],
      responseWarnings: {
        warning: responseWarnings.warning ?? 'KB vector query embedding is unavailable.',
      },
      fallbackToText: true,
    };
  }

  try {
    return {
      hits: (await vectorRoute.retrieval.search(queryVector, topK, scope)).hits,
      responseWarnings,
      fallbackToText: false,
    };
  } catch {
    if (vectorRoute.backend === 'needle' && options.allowNeedleFallbackToOrama) {
      try {
        return {
          hits: (await createOramaBaseProjection(rt).search(queryVector, topK, scope)).hits,
          responseWarnings: {
            warning:
              responseWarnings.warning ??
              'KB needle search is unavailable; falling back to Orama cosine for this query.',
          },
          fallbackToText: false,
        };
      } catch {
        // Fall through to text fallback below.
      }
    }

    return {
      hits: [],
      responseWarnings: {
        warning: responseWarnings.warning ?? 'KB vector search is unavailable for this query.',
      },
      fallbackToText: true,
    };
  }
}

export async function searchKb(
  rt: KbRuntime,
  query: string,
  top_k = 20,
  scope: KbSearchScope = 'all',
  mode?: KbSearchMode,
): Promise<KbSearchResponse> {
  const rawQuery = query.trim();
  const oramaTerm = normalizeOramaTerm(rawQuery);
  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;
  const { db, tokenizer, index, warnings: oramaWarnings } = await rt.ensureOramaIndex();
  if (oramaWarnings?.includes('orama_snapshot_absent')) {
    return {
      mode: 'text',
      results: [],
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    };
  }

  if (Object.keys(index.entries).length === 0) {
    return emptySearchResponse(mode);
  }

  let queryCtx: QueryContext | undefined;
  let communitiesFresh: boolean | undefined;
  let currentGraphLoaded = false;
  let currentGraph: EntityGraph | null = null;
  let graphFresh: boolean | undefined;
  let graphContextLoaded = false;
  let graphContext: GraphSearchContext | null = null;
  let textStatePromise: Promise<TextSearchState> | undefined;
  let textGraphStatePromise: Promise<TextGraphSearchState> | undefined;
  let cachedVectorRoute: ResolvedVectorRoute | undefined;

  const getQueryContext = (): QueryContext => {
    if (queryCtx !== undefined) {
      return queryCtx;
    }
    queryCtx = {
      rawQuery,
      oramaTerm,
      queryTokens: tokenizeQuery(oramaTerm, tokenizer),
      tokenizer,
    };
    return queryCtx;
  };

  const getCommunitiesFresh = (): boolean => {
    if (communitiesFresh !== undefined) {
      return communitiesFresh;
    }
    communitiesFresh = areCommunityDocumentsFresh(rt, index);
    return communitiesFresh;
  };

  const getCurrentGraph = (): EntityGraph | null => {
    if (!currentGraphLoaded) {
      currentGraph = rt.readEntityGraph();
      currentGraphLoaded = true;
    }
    return currentGraph;
  };

  const getGraphFresh = (): boolean => {
    if (graphFresh !== undefined) {
      return graphFresh;
    }
    if (graphContextLoaded) {
      graphFresh = graphContext !== null;
      return graphFresh;
    }
    graphFresh = isGraphSearchFresh(index, getCurrentGraph());
    return graphFresh;
  };

  const getGraphContext = (): GraphSearchContext | null => {
    if (!graphContextLoaded) {
      graphContext = buildGraphSearchContext(index, getCurrentGraph());
      graphContextLoaded = true;
      graphFresh = graphContext !== null;
    }
    return graphContext;
  };

  const getVectorRoute = (): ResolvedVectorRoute => {
    if (cachedVectorRoute !== undefined) {
      return cachedVectorRoute;
    }
    cachedVectorRoute = resolveVectorRoute(rt);
    return cachedVectorRoute;
  };

  const getTextState = async (): Promise<TextSearchState> => {
    if (textStatePromise !== undefined) {
      return textStatePromise;
    }

    textStatePromise = (async () => {
      const nextQueryCtx = getQueryContext();
      const nextCommunitiesFresh = getCommunitiesFresh();
      const resolvedHits: ResolvedKbSearchHit[] = [];

      if (nextQueryCtx.queryTokens.length > 0) {
        let limit = topK;
        let hits = await searchOrama(db, oramaTerm, limit);
        let exhausted = hits.length < limit;
        resolvedHits.push(...hits.map((hit) => resolveHit(hit, index)));

        while (shouldContinueWidening(hits, resolvedHits, nextCommunitiesFresh, scope, topK, exhausted)) {
          const prevCount = hits.length;
          limit = Math.max(limit + 1, limit * 2);
          hits = await searchOrama(db, oramaTerm, limit);
          exhausted = hits.length < limit;
          for (let i = prevCount; i < hits.length; i += 1) {
            resolvedHits.push(resolveHit(hits[i], index));
          }
        }
      }

      const searchableHits = filterSearchableHits(resolvedHits, nextCommunitiesFresh);
      return {
        queryCtx: nextQueryCtx,
        selectedHits: scope === 'all' ? rerankHits(searchableHits) : filterHitsByScope(searchableHits, scope),
        communitiesFresh: nextCommunitiesFresh,
        graphFresh: getGraphFresh(),
      };
    })();

    return textStatePromise;
  };

  const getTextGraphState = async (): Promise<TextGraphSearchState> => {
    if (textGraphStatePromise !== undefined) {
      return textGraphStatePromise;
    }

    textGraphStatePromise = (async () => {
      const textState = await getTextState();
      const router = createRouter(rt, {
        graph: new RuntimeGraphRetrieval(index, getGraphContext()),
        vectorRoute: getVectorRoute(),
      });
      const nextGraphResult = await router.graph.search(rawQuery, scope);

      return {
        ...textState,
        graphFresh: getGraphFresh(),
        router,
        graphResult: nextGraphResult,
        textHits:
          nextGraphResult.hits.length === 0
            ? textState.selectedHits
            : fuseRetrievalRoles(router.hybrid, textState.selectedHits, EMPTY_VECTOR_RETRIEVAL_RESULT.hits, nextGraphResult),
      };
    })();

    return textGraphStatePromise;
  };

  // ── mode dispatch ──

  if (mode === 'text') {
    const textState = await getTextState();
    return buildTextResponse(
      textState.selectedHits,
      textState.queryCtx,
      topK,
      index,
      textState.communitiesFresh,
      textState.graphFresh,
    );
  }

  if (mode === 'vector') {
    if (scope === 'communities') {
      return buildVectorResponse([], topK);
    }

    const vectorRoute = getVectorRoute();
    const vectorResult = await searchExplicitVectorResults(rt, rawQuery, topK, scope, vectorRoute, {
      allowNeedleFallbackToOrama: true,
    });
    if (vectorResult.fallbackToText) {
      const textState = await getTextState();
      return buildTextResponse(
        textState.selectedHits,
        textState.queryCtx,
        topK,
        index,
        textState.communitiesFresh,
        textState.graphFresh,
        vectorResult.responseWarnings,
      );
    }
    return buildVectorResponse(vectorResult.hits, topK, vectorResult.responseWarnings);
  }

  if (mode === 'hybrid') {
    if (scope === 'communities') {
      const textGraphState = await getTextGraphState();
      return buildHybridResponse(
        fuseRetrievalRoles(
          textGraphState.router.hybrid,
          textGraphState.selectedHits,
          EMPTY_VECTOR_RETRIEVAL_RESULT.hits,
          textGraphState.graphResult,
        ),
        textGraphState.queryCtx,
        topK,
        index,
        textGraphState.communitiesFresh,
        textGraphState.graphFresh,
      );
    }

    const vectorRoute = getVectorRoute();
    const vectorResult = await searchExplicitVectorResults(rt, rawQuery, topK, scope, vectorRoute, {
      allowNeedleFallbackToOrama: true,
    });
    if (vectorResult.fallbackToText) {
      const textState = await getTextState();
      return buildTextResponse(
        textState.selectedHits,
        textState.queryCtx,
        topK,
        index,
        textState.communitiesFresh,
        textState.graphFresh,
        vectorResult.responseWarnings,
      );
    }

    const textGraphState = await getTextGraphState();
    return buildHybridResponse(
      fuseRetrievalRoles(
        textGraphState.router.hybrid,
        textGraphState.selectedHits,
        vectorResult.hits,
        textGraphState.graphResult,
      ),
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      vectorResult.responseWarnings,
    );
  }

  if (scope === 'communities') {
    const textState = await getTextState();
    return buildTextResponse(
      textState.selectedHits,
      textState.queryCtx,
      topK,
      index,
      textState.communitiesFresh,
      textState.graphFresh,
    );
  }

  const vectorRoute = getVectorRoute();
  const textGraphState = await getTextGraphState();
  if (vectorRoute.backend !== 'needle') {
    const responseWarnings = vectorRoute.warning === undefined ? {} : { warning: vectorRoute.warning };
    return buildTextResponse(
      textGraphState.textHits,
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      responseWarnings,
    );
  }

  const vectorResult = await searchExplicitVectorResults(rt, rawQuery, topK, scope, vectorRoute, {
    allowNeedleFallbackToOrama: false,
  });
  if (vectorResult.fallbackToText) {
    return buildTextResponse(
      textGraphState.textHits,
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      vectorResult.responseWarnings,
    );
  }

  const fusedHits = fuseRetrievalRoles(
    textGraphState.router.hybrid,
    textGraphState.selectedHits,
    vectorResult.hits,
    textGraphState.graphResult,
  );
  const usedVector = fusedHits.slice(0, topK).some((hit) => hit.vectorRank !== undefined);
  if (!usedVector) {
    return buildTextResponse(
      textGraphState.textHits,
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      vectorResult.responseWarnings,
    );
  }

  return buildHybridResponse(
    fusedHits,
    textGraphState.queryCtx,
    topK,
    index,
    textGraphState.communitiesFresh,
    textGraphState.graphFresh,
    vectorResult.responseWarnings,
  );
}
