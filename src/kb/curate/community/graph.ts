import { createHash } from 'node:crypto';
import * as GraphologyModule from 'graphology';
import type { GraphConstructor } from 'graphology-types';
import { compareLocale } from '../../validation.js';
import type { EntityGraph } from '../../entry-types.js';
import { uniqueSorted } from './identity.js';
import type { TagGraph } from './contracts.js';

type TagGraphNodeAttributes = Record<string, never>;
type TagGraphEdgeAttributes = { weight: number };

const Graph =
  (GraphologyModule as unknown as { default?: GraphConstructor<TagGraphNodeAttributes, TagGraphEdgeAttributes> })
    .default ?? (GraphologyModule as unknown as GraphConstructor<TagGraphNodeAttributes, TagGraphEdgeAttributes>);

function edgeKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function parseEdgeKey(key: string): [string, string] {
  const [left, right] = key.split('\u0000');
  if (left === undefined || right === undefined) {
    throw new Error(`Invalid tag graph edge key: ${key}`);
  }
  return [left, right];
}

function formatEdgeWeight(weight: number): string {
  return weight.toFixed(12);
}

export function buildEntityRelationshipGraph(entityGraph: EntityGraph): TagGraph {
  const sortedTags = Object.keys(entityGraph.entityMeta).sort(compareLocale);
  const tagSet = new Set(sortedTags);
  const edgeWeights = new Map<string, number>();

  const sortedRelationships = [...entityGraph.relationships].sort((left, right) => {
    const sourceCompare = compareLocale(left.source, right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }
    const targetCompare = compareLocale(left.target, right.target);
    if (targetCompare !== 0) {
      return targetCompare;
    }
    const typeCompare = compareLocale(left.type, right.type);
    if (typeCompare !== 0) {
      return typeCompare;
    }
    return compareLocale(left.description, right.description);
  });

  for (const relationship of sortedRelationships) {
    if (
      relationship.source === relationship.target ||
      !tagSet.has(relationship.source) ||
      !tagSet.has(relationship.target)
    ) {
      continue;
    }

    const evidence = uniqueSorted(relationship.evidence);
    const contribution = evidence.length;
    if (contribution === 0) {
      continue;
    }

    const key = edgeKey(relationship.source, relationship.target);
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + contribution);
  }

  const edges: TagGraph['edges'] = [];
  for (const [key, weight] of edgeWeights.entries()) {
    const [left, right] = parseEdgeKey(key);
    edges.push({ left, right, weight });
  }
  edges.sort((left, right) => {
    const leftCompare = compareLocale(left.left, right.left);
    if (leftCompare !== 0) {
      return leftCompare;
    }
    return compareLocale(left.right, right.right);
  });

  const adjacency = new Map<string, Map<string, number>>();
  for (const tag of sortedTags) {
    adjacency.set(tag, new Map());
  }
  for (const edge of edges) {
    adjacency.get(edge.left)?.set(edge.right, edge.weight);
    adjacency.get(edge.right)?.set(edge.left, edge.weight);
  }

  const graph = new Graph({ type: 'undirected' });
  for (const tag of sortedTags) {
    graph.addNode(tag);
  }
  for (const edge of edges) {
    graph.mergeUndirectedEdge(edge.left, edge.right, { weight: edge.weight });
  }

  return {
    graph,
    tags: sortedTags,
    edges,
    adjacency,
  };
}

export function computeGraphFingerprint(graph: TagGraph): string {
  const lines: string[] = [];
  for (const tag of graph.tags) {
    lines.push(`N\t${tag}`);
  }
  for (const edge of graph.edges) {
    lines.push(`${edge.left}\t${edge.right}\t${formatEdgeWeight(edge.weight)}`);
  }
  const payload = lines.join('\n');
  return createHash('sha256').update(payload).digest('hex');
}
