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
import { uniqueTrimmedList } from './shared.js';

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
  return value.split('-').filter((segment) => segment.length > 0);
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
  const rawCandidates: EntityCandidate[] = [
    ...Object.entries(existingGraph.entityMeta).map(([name, meta]) => ({
      name,
      type: meta.type,
      description: meta.description,
      aliases: meta.aliases ?? [],
    })),
    ...((delta?.entities ?? []).map((candidate) => ({
      name: candidate.name,
      type: candidate.type,
      description: candidate.description,
      aliases: candidate.aliases ?? [],
    })) as EntityCandidate[]),
  ];

  const candidates: EntityCandidate[] = [];
  for (const candidate of rawCandidates) {
    const name = normalizeEntityId(candidate.name);
    const description = candidate.description.trim();
    if (!isWellFormedEntityId(name) || !isKnownEntityType(candidate.type) || !description) {
      continue;
    }

    const aliases = uniqueTrimmedList(
      candidate.aliases.map((alias) => normalizeEntityId(alias)).filter((alias) => isWellFormedEntityId(alias)),
    );

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

function buildAliasTargetMap(
  candidates: EntityCandidate[],
  observedKeys: ReadonlySet<string>,
): Map<string, string> {
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
    if (
      merged.some((existing) => {
        const existingNormalized = existing.toLowerCase();
        return existingNormalized === normalized || existingNormalized.includes(normalized);
      })
    ) {
      continue;
    }

    const withoutRedundantExisting = merged.filter((existing) => !normalized.includes(existing.toLowerCase()));
    withoutRedundantExisting.push(description);
    withoutRedundantExisting.sort((left, right) => right.length - left.length || compareLocale(left, right));
    merged.splice(0, merged.length, ...withoutRedundantExisting);
  }

  return merged.join(' ');
}

function selectCanonicalType(candidates: readonly EntityCandidate[], canonicalName: string): EntityType {
  const directMatch = candidates.find((candidate) => candidate.name === canonicalName);
  if (directMatch !== undefined) {
    return directMatch.type;
  }

  const counts = new Map<EntityType, number>();
  for (const candidate of candidates) {
    counts.set(candidate.type, (counts.get(candidate.type) ?? 0) + 1);
  }

  const preferredType = [...ENTITY_TYPES].sort(
    (left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || compareLocale(left, right),
  )[0];

  return preferredType ?? 'concept';
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

  const entityMetaEntries = [...grouped.entries()]
    .sort(([left], [right]) => compareLocale(left, right))
    .map(([canonicalName, canonicalCandidates]) => {
      const aliases = uniqueTrimmedList(
        canonicalCandidates.flatMap((candidate) => [candidate.name, ...candidate.aliases]).filter((alias) => alias !== canonicalName),
      ).sort(compareLocale);
      const descriptions = [
        ...canonicalCandidates
          .filter((candidate) => candidate.name === canonicalName)
          .map((candidate) => candidate.description),
        ...canonicalCandidates
          .filter((candidate) => candidate.name !== canonicalName)
          .map((candidate) => candidate.description)
          .sort((left, right) => right.length - left.length || compareLocale(left, right)),
      ];

      replacementEntries.set(canonicalName, canonicalName);

      return [
        canonicalName,
        {
          type: selectCanonicalType(canonicalCandidates, canonicalName),
          description: mergeDescriptions(descriptions),
          ...(aliases.length === 0 ? {} : { aliases }),
        },
      ] as const;
    });

  const replacementMap = Object.fromEntries([...replacementEntries.entries()].sort(([left], [right]) => compareLocale(left, right)));

  return {
    entityMeta: Object.fromEntries(entityMetaEntries),
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
  const allRelationships = [...existingGraph.relationships, ...(delta?.relationships ?? [])];

  for (const relationship of allRelationships) {
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
      continue;
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
  }

  return [...grouped.values()]
    .map((bucket) => ({
      source: bucket.source,
      target: bucket.target,
      type: bucket.type,
      description: mergeDescriptions(bucket.descriptions),
      evidence: uniqueTrimmedList(bucket.evidence).sort(compareLocale),
    }))
    .sort(
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
