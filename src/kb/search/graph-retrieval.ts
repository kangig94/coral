import { normalizeWhitespace } from '../text-normalization.js';
import type { EntityGraph, KbIndex, KbSearchScope, RelationshipType } from '../entry-types.js';
import type { GraphRetrieval, GraphRetrievalResult, RetrievalDiagnostic, RetrievalRole } from './contract.js';
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

const BUILTIN_GRAPH_ROLE_DESCRIPTOR = {
  id: 'graph',
  label: 'Graph (Structural)',
  tags: ['structural'],
  phase: 'retrieval-source',
  provides: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
} as const satisfies RetrievalRole['descriptor'];

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
    const values = new Set<string>();
    values.add(value);
    lookup.set(key, values);
    return;
  }

  existing.add(value);
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique.sort((left, right) => left.localeCompare(right));
}

function stableEntityGraph(graph: EntityGraph): EntityGraph {
  const entityMetaEntries = Object.entries(graph.entityMeta).sort(([left], [right]) => left.localeCompare(right));
  const entityMeta: EntityGraph['entityMeta'] = {};
  for (const [entityName, meta] of entityMetaEntries) {
    entityMeta[entityName] = {
      type: meta.type,
      description: meta.description,
      ...(meta.aliases === undefined ? {} : { aliases: sortedUniqueStrings(meta.aliases) }),
    };
  }

  const relationships: EntityGraph['relationships'] = [];
  for (const relationship of graph.relationships) {
    relationships.push({
      source: relationship.source,
      target: relationship.target,
      type: relationship.type,
      description: relationship.description,
      evidence: sortedUniqueStrings(relationship.evidence),
    });
  }
  relationships.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      left.type.localeCompare(right.type) ||
      left.description.localeCompare(right.description),
  );

  return {
    entityMeta,
    relationships,
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
  return (
    currentGraph !== null &&
    Object.keys(currentGraph.entityMeta).length > 0 &&
    graphStateMatchesIndex(index, currentGraph)
  );
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
        const relationshipTypes = new Set<RelationshipType>();
        relationshipTypes.add(relationship.type);
        neighbors.set(target, {
          weight: relationshipWeight,
          relationshipTypes,
        });
        continue;
      }

      existing.weight = Math.max(existing.weight, relationshipWeight);
      existing.relationshipTypes.add(relationship.type);
    }
  }

  const adjacency = new Map<string, GraphNeighbor[]>();
  for (const entityName of Object.keys(currentGraph.entityMeta)) {
    const neighbors: GraphNeighbor[] = [];
    for (const [neighbor, attributes] of adjacencyBuilders.get(entityName)?.entries() ?? []) {
      neighbors.push({
        entity: neighbor,
        weight: attributes.weight,
        relationshipTypes: [...attributes.relationshipTypes].sort((left, right) => left.localeCompare(right)),
      });
    }
    neighbors.sort(
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

    const neighbors = graph.adjacency.get(seed) ?? [];
    const limit = Math.min(neighbors.length, GRAPH_MAX_NEIGHBORS_PER_SEED);
    for (let index = 0; index < limit; index += 1) {
      const neighbor = neighbors[index];
      if (neighbor === undefined) {
        continue;
      }
      addBoundedScore(entityScores, neighbor.entity, seedScore * neighbor.weight, 1.1);
    }
  }

  return entityScores;
}

function scoreGraphMatches(matchScores: readonly number[]): number {
  const topScores: number[] = [];

  for (const score of matchScores) {
    let insertAt = topScores.length;
    while (insertAt > 0 && score > (topScores[insertAt - 1] ?? 0)) {
      insertAt -= 1;
    }

    if (insertAt >= GRAPH_ENTRY_MATCH_WEIGHTS.length) {
      continue;
    }

    topScores.splice(insertAt, 0, score);
    if (topScores.length > GRAPH_ENTRY_MATCH_WEIGHTS.length) {
      topScores.length = GRAPH_ENTRY_MATCH_WEIGHTS.length;
    }
  }

  let total = 0;
  for (let index = 0; index < topScores.length; index += 1) {
    total += (topScores[index] ?? 0) * (GRAPH_ENTRY_MATCH_WEIGHTS[index] ?? 0);
  }
  return total;
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

    const seenTags = new Set<string>();
    const matchScores: number[] = [];
    for (const tag of entry.tags) {
      if (seenTags.has(tag)) {
        continue;
      }
      seenTags.add(tag);

      const score = entityScores.get(tag);
      if (score !== undefined) {
        matchScores.push(score);
      }
    }

    if (matchScores.length === 0) {
      continue;
    }

    hits.push({
      ...entry,
      score: scoreGraphMatches(matchScores),
    });
  }

  return hits.sort(compareRetrievalRoleHits);
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

function graphStaleDiagnostic(): RetrievalDiagnostic {
  return {
    roleId: 'graph',
    code: 'graph_stale',
    recoverable: true,
  };
}

export function createBuiltinGraphRole(currentGraph: () => EntityGraph | null): RetrievalRole {
  return {
    id: BUILTIN_GRAPH_ROLE_DESCRIPTOR.id,
    descriptor: BUILTIN_GRAPH_ROLE_DESCRIPTOR,
    async search(ctx) {
      const index = ctx.index();
      const graph = currentGraph();
      if (!isGraphSearchFresh(index, graph)) {
        return {
          hits: [],
          diagnostic: graphStaleDiagnostic(),
        };
      }

      const graphContext = buildGraphSearchContext(index, graph);
      if (graphContext === null) {
        return {
          hits: [],
          diagnostic: graphStaleDiagnostic(),
        };
      }

      return new RuntimeGraphRetrieval(index, graphContext).search(ctx.rawQuery, ctx.scope);
    },
  };
}
