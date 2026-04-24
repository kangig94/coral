import { normalizeWhitespace } from '../orama-factory.js';
import type {
  EntityGraph,
  KbIndex,
  KbResult,
  KbSearchScope,
  RelationshipType,
} from '../entry-types.js';
import type { GraphRetrieval, GraphRetrievalResult } from './contract.js';
import {
  compareRetrievalRoleHits,
  isVectorScope,
  rankRetrievalRoleHits,
  resolveEntry,
  type ResolvedKbSearchEntry,
} from './text-retrieval.js';

const GRAPH_MAX_NEIGHBORS_PER_SEED = 10;
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

type GraphNeighbor = {
  entity: string;
  weight: number;
  relationshipTypes: RelationshipType[];
};

export type GraphSearchContext = {
  entityMeta: EntityGraph['entityMeta'];
  adjacency: Map<string, GraphNeighbor[]>;
  aliasLookup: Map<string, Set<string>>;
  phraseLookup: Map<string, Set<string>>;
};

type GraphKbSearchHit = ResolvedKbSearchEntry & {
  score: number;
};

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
    entityMeta: index.entityMeta,
    relationships: index.relationships,
  });

  return JSON.stringify(loadedGraph) === JSON.stringify(stableEntityGraph(currentGraph));
}

export function isGraphSearchFresh(index: KbIndex, currentGraph: EntityGraph | null): currentGraph is EntityGraph {
  return currentGraph !== null && Object.keys(currentGraph.entityMeta).length > 0 && graphStateMatchesIndex(index, currentGraph);
}

export function buildGraphSearchContext(index: KbIndex, currentGraph: EntityGraph | null): GraphSearchContext | null {
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

export class RuntimeGraphRetrieval implements GraphRetrieval {
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
