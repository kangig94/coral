import {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  type EntityGraph,
  type EntityMeta,
  type EntityRelationship,
  type EntityType,
  type RelationshipType,
} from '../entry-types.js';
import { compareLocale } from '../validation.js';
import { uniqueTrimmedList } from './content-normalize.js';

const GENERIC_PLURAL_SEGMENTS = new Set([
  'aliases',
  'apis',
  'components',
  'concepts',
  'constraints',
  'contexts',
  'domains',
  'events',
  'hooks',
  'implementations',
  'interfaces',
  'jobs',
  'libraries',
  'members',
  'modules',
  'operations',
  'patterns',
  'pipelines',
  'policies',
  'qualities',
  'queues',
  'services',
  'signals',
  'sources',
  'strategies',
  'systems',
  'tasks',
  'tests',
  'tools',
  'types',
  'workflows',
]);

type EntityCandidate = {
  name: string;
  type: EntityType;
  description: string;
  aliases: string[];
};

export type EntityReplacementMap = Record<string, string>;

export type ConsolidationResult = {
  canonicalGraph: EntityGraph;
  replacementMap: EntityReplacementMap;
};

export type EntityConsolidationDelta = {
  entities?: Array<{
    name: string;
    type: EntityType;
    description: string;
    aliases?: string[];
  }>;
  relationships?: EntityRelationship[];
};

function normalizeEntityId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isWellFormedEntityId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function entitySegments(value: string): string[] {
  const segments: string[] = [];
  for (const segment of value.split('-')) {
    if (segment.length > 0) {
      segments.push(segment);
    }
  }
  return segments;
}

function isKnownEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

function isKnownRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

function singularizeSegment(segment: string): string {
  if (segment === 'apis') {
    return 'api';
  }
  if (segment.endsWith('ies') && segment.length > 3) {
    return `${segment.slice(0, -3)}y`;
  }
  if (/(sses|xes|zes|ches|shes)$/.test(segment) && segment.length > 4) {
    return segment.slice(0, -2);
  }
  if (segment.endsWith('s') && !segment.endsWith('ss') && segment.length > 3) {
    return segment.slice(0, -1);
  }

  return segment;
}

function normalizeEntityGroupKey(value: string, observedKeys: ReadonlySet<string>): string {
  const normalized = normalizeEntityId(value);
  if (!isWellFormedEntityId(normalized)) {
    return normalized;
  }

  const segments = entitySegments(normalized);
  const last = segments[segments.length - 1];
  if (last === undefined) {
    return normalized;
  }

  const singularLast = singularizeSegment(last);
  if (singularLast === last) {
    return normalized;
  }

  const singularKey = [...segments.slice(0, -1), singularLast].join('-');
  if (observedKeys.has(singularKey) || GENERIC_PLURAL_SEGMENTS.has(last)) {
    return singularKey;
  }

  return normalized;
}

function collectEntityCandidates(existingGraph: EntityGraph, delta?: EntityConsolidationDelta): EntityCandidate[] {
  const rawCandidates: EntityCandidate[] = [];
  for (const [name, meta] of Object.entries(existingGraph.entityMeta)) {
    rawCandidates.push({
      name,
      type: meta.type,
      description: meta.description,
      aliases: meta.aliases ?? [],
    });
  }
  for (const candidate of delta?.entities ?? []) {
    rawCandidates.push({
      name: candidate.name,
      type: candidate.type,
      description: candidate.description,
      aliases: candidate.aliases ?? [],
    });
  }

  const candidates: EntityCandidate[] = [];
  for (const candidate of rawCandidates) {
    const name = normalizeEntityId(candidate.name);
    const description = candidate.description.trim();
    if (!isWellFormedEntityId(name) || !isKnownEntityType(candidate.type) || !description) {
      continue;
    }

    const normalizedAliases: string[] = [];
    for (const rawAlias of candidate.aliases) {
      const alias = normalizeEntityId(rawAlias);
      if (isWellFormedEntityId(alias)) {
        normalizedAliases.push(alias);
      }
    }
    const aliases = uniqueTrimmedList(normalizedAliases);

    candidates.push({
      name,
      type: candidate.type,
      description,
      aliases,
    });
  }

  return candidates;
}

function compareCanonicalKeyPreference(left: string, right: string): number {
  const leftSegments = entitySegments(left).length;
  const rightSegments = entitySegments(right).length;

  return rightSegments - leftSegments || right.length - left.length || compareLocale(left, right);
}

function buildAliasTargetMap(candidates: EntityCandidate[], observedKeys: ReadonlySet<string>): Map<string, string> {
  const aliasTargets = new Map<string, string>();
  const descriptiveByPrefix = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const canonicalKey = normalizeEntityGroupKey(candidate.name, observedKeys);
    const [firstSegment] = entitySegments(canonicalKey);
    if (firstSegment === undefined || entitySegments(canonicalKey).length < 2) {
      continue;
    }

    const prefixMatches = descriptiveByPrefix.get(firstSegment) ?? new Set<string>();
    prefixMatches.add(canonicalKey);
    descriptiveByPrefix.set(firstSegment, prefixMatches);
  }

  for (const candidate of candidates) {
    const canonicalKey = normalizeEntityGroupKey(candidate.name, observedKeys);
    for (const alias of candidate.aliases) {
      const aliasKey = normalizeEntityGroupKey(alias, observedKeys);
      if (!aliasKey || aliasKey === canonicalKey) {
        continue;
      }

      const existingTarget = aliasTargets.get(aliasKey);
      if (existingTarget === undefined || compareCanonicalKeyPreference(canonicalKey, existingTarget) < 0) {
        aliasTargets.set(aliasKey, canonicalKey);
      }
    }
  }

  for (const value of observedKeys) {
    if (aliasTargets.has(value) || entitySegments(value).length !== 1) {
      continue;
    }

    const prefixMatches = descriptiveByPrefix.get(value);
    if (prefixMatches?.size !== 1) {
      continue;
    }

    const [match] = [...prefixMatches];
    if (match !== undefined) {
      aliasTargets.set(value, match);
    }
  }

  return aliasTargets;
}

function resolveCanonicalKey(
  value: string,
  observedKeys: ReadonlySet<string>,
  aliasTargets: ReadonlyMap<string, string>,
): string {
  let current = normalizeEntityGroupKey(value, observedKeys);
  const seen = new Set<string>();

  while (!seen.has(current)) {
    seen.add(current);
    const aliasTarget = aliasTargets.get(current);
    if (aliasTarget === undefined || aliasTarget === current) {
      break;
    }
    current = aliasTarget;
  }

  return current;
}

function mergeDescriptions(descriptions: readonly string[]): string {
  const uniqueDescriptions = uniqueTrimmedList(descriptions);
  const merged: string[] = [];

  for (const description of uniqueDescriptions) {
    const normalized = description.toLowerCase();
    let alreadyCovered = false;
    for (const existing of merged) {
      const existingNormalized = existing.toLowerCase();
      if (existingNormalized === normalized || existingNormalized.includes(normalized)) {
        alreadyCovered = true;
        break;
      }
    }
    if (alreadyCovered) {
      continue;
    }

    const withoutRedundantExisting: string[] = [];
    for (const existing of merged) {
      if (!normalized.includes(existing.toLowerCase())) {
        withoutRedundantExisting.push(existing);
      }
    }
    withoutRedundantExisting.push(description);
    withoutRedundantExisting.sort((left, right) => right.length - left.length || compareLocale(left, right));
    merged.splice(0, merged.length, ...withoutRedundantExisting);
  }

  return merged.join(' ');
}

function selectCanonicalType(candidates: readonly EntityCandidate[], canonicalName: string): EntityType {
  for (const candidate of candidates) {
    if (candidate.name === canonicalName) {
      return candidate.type;
    }
  }

  const counts = new Map<EntityType, number>();
  for (const candidate of candidates) {
    counts.set(candidate.type, (counts.get(candidate.type) ?? 0) + 1);
  }

  let preferredType: EntityType = 'concept';
  for (const entityType of ENTITY_TYPES) {
    const bestCount = counts.get(preferredType) ?? 0;
    const candidateCount = counts.get(entityType) ?? 0;
    if (candidateCount > bestCount || (candidateCount === bestCount && compareLocale(entityType, preferredType) < 0)) {
      preferredType = entityType;
    }
  }
  return preferredType;
}

function buildCanonicalEntities(
  candidates: EntityCandidate[],
  observedKeys: ReadonlySet<string>,
  aliasTargets: ReadonlyMap<string, string>,
): { entityMeta: Record<string, EntityMeta>; replacementMap: EntityReplacementMap } {
  const grouped = new Map<string, EntityCandidate[]>();
  const replacementEntries = new Map<string, string>();

  for (const candidate of candidates) {
    const canonicalName = resolveCanonicalKey(candidate.name, observedKeys, aliasTargets);
    if (!isWellFormedEntityId(canonicalName)) {
      continue;
    }

    const bucket = grouped.get(canonicalName) ?? [];
    bucket.push(candidate);
    grouped.set(canonicalName, bucket);

    replacementEntries.set(candidate.name, canonicalName);
    replacementEntries.set(normalizeEntityGroupKey(candidate.name, observedKeys), canonicalName);
    for (const alias of candidate.aliases) {
      replacementEntries.set(alias, canonicalName);
      replacementEntries.set(normalizeEntityGroupKey(alias, observedKeys), canonicalName);
    }
  }

  const entityMeta: Record<string, EntityMeta> = {};
  const groupedEntries = [...grouped.entries()].sort(([left], [right]) => compareLocale(left, right));
  for (const [canonicalName, canonicalCandidates] of groupedEntries) {
    const aliasCandidates: string[] = [];
    const directDescriptions: string[] = [];
    const otherDescriptions: string[] = [];
    for (const candidate of canonicalCandidates) {
      if (candidate.name === canonicalName) {
        directDescriptions.push(candidate.description);
      } else {
        aliasCandidates.push(candidate.name);
        otherDescriptions.push(candidate.description);
      }
      for (const alias of candidate.aliases) {
        if (alias !== canonicalName) {
          aliasCandidates.push(alias);
        }
      }
    }
    const aliases = uniqueTrimmedList(aliasCandidates).sort(compareLocale);
    otherDescriptions.sort((left, right) => right.length - left.length || compareLocale(left, right));
    const descriptions = [...directDescriptions, ...otherDescriptions];

    replacementEntries.set(canonicalName, canonicalName);

    entityMeta[canonicalName] = {
      type: selectCanonicalType(canonicalCandidates, canonicalName),
      description: mergeDescriptions(descriptions),
      ...(aliases.length === 0 ? {} : { aliases }),
    };
  }

  const replacementMap: EntityReplacementMap = {};
  for (const [source, target] of [...replacementEntries.entries()].sort(([left], [right]) =>
    compareLocale(left, right),
  )) {
    replacementMap[source] = target;
  }

  return {
    entityMeta,
    replacementMap,
  };
}

function relationshipKey(relationship: Pick<EntityRelationship, 'source' | 'target' | 'type'>): string {
  return `${relationship.source}\u0000${relationship.target}\u0000${relationship.type}`;
}

function buildCanonicalRelationships(
  existingGraph: EntityGraph,
  delta: EntityConsolidationDelta | undefined,
  entityMeta: Readonly<Record<string, EntityMeta>>,
  replacementMap: EntityReplacementMap,
): EntityRelationship[] {
  const grouped = new Map<
    string,
    {
      source: string;
      target: string;
      type: RelationshipType;
      descriptions: string[];
      evidence: string[];
    }
  >();
  const addRelationship = (relationship: EntityRelationship): void => {
    const source = resolveCanonicalEntityId(relationship.source, replacementMap);
    const target = resolveCanonicalEntityId(relationship.target, replacementMap);
    const description = relationship.description.trim();
    const evidence = uniqueTrimmedList(relationship.evidence).sort(compareLocale);

    if (
      !isWellFormedEntityId(source) ||
      !isWellFormedEntityId(target) ||
      source === target ||
      entityMeta[source] === undefined ||
      entityMeta[target] === undefined ||
      !isKnownRelationshipType(relationship.type) ||
      !description ||
      evidence.length === 0
    ) {
      return;
    }

    const key = relationshipKey({ source, target, type: relationship.type });
    const bucket = grouped.get(key) ?? {
      source,
      target,
      type: relationship.type,
      descriptions: [],
      evidence: [],
    };
    bucket.descriptions.push(description);
    bucket.evidence.push(...evidence);
    grouped.set(key, bucket);
  };

  for (const relationship of existingGraph.relationships) {
    addRelationship(relationship);
  }
  for (const relationship of delta?.relationships ?? []) {
    addRelationship(relationship);
  }

  const relationships: EntityRelationship[] = [];
  for (const bucket of grouped.values()) {
    relationships.push({
      source: bucket.source,
      target: bucket.target,
      type: bucket.type,
      description: mergeDescriptions(bucket.descriptions),
      evidence: uniqueTrimmedList(bucket.evidence).sort(compareLocale),
    });
  }
  return relationships.sort(
    (left, right) =>
      compareLocale(left.source, right.source) ||
      compareLocale(left.target, right.target) ||
      compareLocale(left.type, right.type) ||
      compareLocale(left.description, right.description),
  );
}

export function resolveCanonicalEntityId(entityId: string, replacementMap: EntityReplacementMap): string {
  const normalized = normalizeEntityId(entityId);
  return replacementMap[entityId.trim()] ?? replacementMap[normalized] ?? normalized;
}

export function consolidateEntityGraph(
  existingGraph: EntityGraph,
  delta?: EntityConsolidationDelta,
): ConsolidationResult {
  const result = consolidateEntityGraphOnce(existingGraph, delta);
  let canonicalGraph = result.canonicalGraph;
  let replacementMap = result.replacementMap;

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const next = consolidateEntityGraphOnce(canonicalGraph);
    replacementMap = composeReplacementMaps(replacementMap, next.replacementMap);
    if (entityGraphsEqual(canonicalGraph, next.canonicalGraph)) {
      return {
        canonicalGraph,
        replacementMap,
      };
    }
    canonicalGraph = next.canonicalGraph;
  }

  throw new Error('Entity graph consolidation did not converge.');
}

function consolidateEntityGraphOnce(
  existingGraph: EntityGraph,
  delta?: EntityConsolidationDelta,
): ConsolidationResult {
  const candidates = collectEntityCandidates(existingGraph, delta);
  const observedKeys = new Set<string>();

  for (const candidate of candidates) {
    observedKeys.add(candidate.name);
    for (const alias of candidate.aliases) {
      observedKeys.add(alias);
    }
  }

  const aliasTargets = buildAliasTargetMap(candidates, observedKeys);
  const { entityMeta, replacementMap } = buildCanonicalEntities(candidates, observedKeys, aliasTargets);
  const relationships = buildCanonicalRelationships(existingGraph, delta, entityMeta, replacementMap);

  return {
    canonicalGraph: {
      entityMeta,
      relationships,
    },
    replacementMap,
  };
}

export function entityGraphsEqual(left: EntityGraph, right: EntityGraph): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function composeReplacementMaps(
  previous: EntityReplacementMap,
  next: EntityReplacementMap,
): EntityReplacementMap {
  const entries = new Map<string, string>();

  for (const [source, target] of Object.entries(previous)) {
    entries.set(source, next[target] ?? target);
  }
  for (const [source, target] of Object.entries(next)) {
    if (!entries.has(source)) {
      entries.set(source, target);
    }
  }

  const replacementMap: EntityReplacementMap = {};
  for (const [source, target] of [...entries.entries()].sort(([left], [right]) => compareLocale(left, right))) {
    replacementMap[source] = target;
  }
  return replacementMap;
}
