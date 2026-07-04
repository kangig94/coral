import { parseEntityGraph, renderEntityGraph } from '../corpus/entity-graph-store.js';
import type { EntityGraph, EntityMeta, EntityRelationship } from '../entry-types.js';
import { compareLocale } from '../validation.js';
import { uniqueTrimmedList } from './content-normalize.js';
import { consolidateEntityGraph, type EntityConsolidationDelta } from './entity-consolidation.js';

const EMPTY_GRAPH: EntityGraph = {
  entityMeta: {},
  relationships: [],
};

export type EntityGraphMergeDriverPaths = {
  basePath: string;
  oursPath: string;
  theirsPath: string;
};

export type EntityGraphMergeDriverHost = {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string, encoding: 'utf-8'): void;
};

type EntityCandidateInput = NonNullable<EntityConsolidationDelta['entities']>[number];

export function canonicalSortEntityGraph(graph: EntityGraph): EntityGraph {
  const entityMeta: Record<string, EntityMeta> = {};
  for (const [name, meta] of Object.entries(graph.entityMeta).sort(([left], [right]) => compareLocale(left, right))) {
    const aliases = meta.aliases === undefined ? [] : uniqueTrimmedList(meta.aliases).sort(compareLocale);
    entityMeta[name] = {
      type: meta.type,
      description: meta.description,
      ...(aliases.length === 0 ? {} : { aliases }),
    };
  }

  const relationships = graph.relationships.map(canonicalSortRelationship).sort(compareRelationships);

  return {
    entityMeta,
    relationships,
  };
}

export function buildCanonicalEntityGraphMergeDelta(
  graphs: readonly [EntityGraph, EntityGraph],
): EntityConsolidationDelta {
  const entities: EntityCandidateInput[] = [];
  const relationships: EntityRelationship[] = [];

  for (const graph of graphs) {
    const sortedGraph = canonicalSortEntityGraph(graph);
    for (const [name, meta] of Object.entries(sortedGraph.entityMeta)) {
      entities.push({
        name,
        type: meta.type,
        description: meta.description,
        ...(meta.aliases === undefined ? {} : { aliases: [...meta.aliases] }),
      });
    }
    for (const relationship of sortedGraph.relationships) {
      relationships.push(relationship);
    }
  }

  entities.sort(compareEntityCandidates);
  relationships.sort(compareRelationships);

  return {
    entities,
    relationships,
  };
}

export function consolidateCanonicalEntityGraph(graph: EntityGraph): EntityGraph {
  return consolidateEntityGraph(canonicalSortEntityGraph(graph)).canonicalGraph;
}

export function mergeEntityGraphRevisions(ours: EntityGraph, theirs: EntityGraph): EntityGraph {
  return consolidateEntityGraph(EMPTY_GRAPH, buildCanonicalEntityGraphMergeDelta([ours, theirs])).canonicalGraph;
}

function readEntityGraphPathFromHost(
  host: Pick<EntityGraphMergeDriverHost, 'readFileSync'>,
  path: string,
): EntityGraph {
  return parseEntityGraph(JSON.parse(host.readFileSync(path, 'utf-8')) as unknown);
}

function writeEntityGraphPath(
  host: Pick<EntityGraphMergeDriverHost, 'writeFileSync'>,
  path: string,
  graph: EntityGraph,
): void {
  host.writeFileSync(path, renderEntityGraph(graph), 'utf-8');
}

export function runEntityGraphMergeDriver(paths: EntityGraphMergeDriverPaths, host: EntityGraphMergeDriverHost): void {
  // Base is intentionally ignored: this graph has no deletion semantics beyond consolidation collapse.
  void paths.basePath;
  const ours = readEntityGraphPathFromHost(host, paths.oursPath);
  const theirs = readEntityGraphPathFromHost(host, paths.theirsPath);
  writeEntityGraphPath(host, paths.oursPath, mergeEntityGraphRevisions(ours, theirs));
}

function canonicalSortRelationship(relationship: EntityRelationship): EntityRelationship {
  return {
    source: relationship.source,
    target: relationship.target,
    type: relationship.type,
    description: relationship.description,
    evidence: uniqueTrimmedList(relationship.evidence).sort(compareLocale),
  };
}

function compareEntityCandidates(left: EntityCandidateInput, right: EntityCandidateInput): number {
  return (
    compareLocale(left.name, right.name) ||
    compareLocale(left.type, right.type) ||
    compareLocale(left.description, right.description) ||
    compareLocale((left.aliases ?? []).join('\u0000'), (right.aliases ?? []).join('\u0000'))
  );
}

function compareRelationships(left: EntityRelationship, right: EntityRelationship): number {
  return (
    compareLocale(left.source, right.source) ||
    compareLocale(left.target, right.target) ||
    compareLocale(left.type, right.type) ||
    compareLocale(left.description, right.description) ||
    compareLocale(left.evidence.join('\u0000'), right.evidence.join('\u0000'))
  );
}
