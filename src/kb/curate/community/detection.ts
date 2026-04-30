import { createHash } from 'node:crypto';
import * as louvainModule from 'graphology-communities-louvain';
import type { DetailedLouvainOutput } from 'graphology-communities-louvain';
import { compareLocale } from '../../validation.js';
import { communityEntryId, type KbIndex } from '../../entry-types.js';
import { communitySlugFromReference, uniqueSorted } from './identity.js';
import { buildEntityRelationshipGraphFromIndex, computeGraphFingerprint } from './graph.js';
import type { DetectedCommunity, ExistingGeneratedCommunity, TagGraph } from './contracts.js';
export {
  buildCommunityDocuments,
  generateCommunityFiles,
  loadExistingCommunityState,
  renderCommunityDocument,
} from './documents.js';
export { buildEntityRelationshipGraph, computeGraphFingerprint } from './graph.js';
export {
  computeCommunitySummaryInputFingerprintForCommunity,
  computeCommunitySummaryInputFingerprints,
  generateCommunitySummary,
} from './summary.js';
export type {
  CommunityDocument,
  DetectedCommunity,
  ExistingGeneratedCommunity,
  TagGraph,
  TagGraphEdge,
} from './contracts.js';

type Louvain = {
  detailed(graph: TagGraph['graph'], options?: Record<string, unknown>): DetailedLouvainOutput;
};
type LouvainDetails = DetailedLouvainOutput;

const louvain: Louvain =
  (louvainModule as unknown as { default?: Louvain }).default ?? (louvainModule as unknown as Louvain);

type DetectCommunitiesOptions = {
  priorCommunities?: ExistingGeneratedCommunity[];
  reservedSlugs?: ReadonlySet<string>;
};

type DetectedCommunitySeed = Omit<DetectedCommunity, 'slug' | 'parent' | 'children'> & {
  freshSlug: string;
  key?: string;
  parentKey?: string;
  childKeys?: string[];
  parentMembershipFingerprint?: string;
};

type PartitionGroup = {
  id: number;
  nodeIndices: number[];
  members: string[];
};

type HierarchySeed = DetectedCommunitySeed & {
  key: string;
  childKeys: string[];
};

type ResolutionEvaluation = {
  resolution: number;
  details: LouvainDetails;
  maxLeafSize: number;
  targetPenalty: number;
  midpointPenalty: number;
};

const COMMUNITY_SLUG_TAG_LIMIT = 3;
const COMMUNITY_LOUVAIN_SEED = 0x5eed1234;
const COMMUNITY_RESOLUTION_MIN = 0.5;
const COMMUNITY_RESOLUTION_MAX = 5;
const COMMUNITY_RESOLUTION_TARGET_MIN = 20;
const COMMUNITY_RESOLUTION_TARGET_MAX = 30;
const COMMUNITY_RESOLUTION_TARGET_MIDPOINT = (COMMUNITY_RESOLUTION_TARGET_MIN + COMMUNITY_RESOLUTION_TARGET_MAX) / 2;
const COMMUNITY_RESOLUTION_SWEEP_STEPS = 12;

function internalWeightedDegree(
  node: string,
  memberSet: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
): number {
  const neighbors = adjacency.get(node);
  if (neighbors === undefined) {
    return 0;
  }

  let total = 0;
  for (const [neighbor, weight] of neighbors.entries()) {
    if (memberSet.has(neighbor)) {
      total += weight;
    }
  }
  return total;
}

function titleCaseTag(tag: string): string {
  return tag
    .split('-')
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(' ');
}

function rankCommunityMembers(
  members: string[],
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
): string[] {
  const memberSet = new Set(members);
  return [...members].sort((left, right) => {
    const degreeDiff =
      internalWeightedDegree(right, memberSet, adjacency) - internalWeightedDegree(left, memberSet, adjacency);
    if (degreeDiff !== 0) {
      return degreeDiff;
    }
    return compareLocale(left, right);
  });
}

function deriveCommunitySlug(rankedMembers: string[]): string {
  return rankedMembers.slice(0, COMMUNITY_SLUG_TAG_LIMIT).join('-') || 'community';
}

export function generateSlug(members: string[], adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>): string {
  return deriveCommunitySlug(rankCommunityMembers(members, adjacency));
}

function ensureUniqueCommunitySlug(
  baseSlug: string,
  usedSlugs: Set<string>,
  reservedSlugs: ReadonlySet<string>,
): string {
  let candidate = baseSlug;
  let suffix = 2;

  while (usedSlugs.has(candidate) || reservedSlugs.has(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  usedSlugs.add(candidate);
  return candidate;
}

function deriveCommunityTitle(rankedMembers: string[]): string {
  return rankedMembers.slice(0, COMMUNITY_SLUG_TAG_LIMIT).map(titleCaseTag).join(' / ');
}

export function seededRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normalizeDendrogramLevels(graph: TagGraph, details: LouvainDetails): number[][] {
  const rawDendrogram = (details as LouvainDetails & { dendrogram: LouvainDetails['dendrogram'] | null }).dendrogram;
  const levels = (rawDendrogram ?? []).map((level) => Array.from(level, (community) => Number(community)));
  const meaningfulLevels = levels.length > 1 ? levels.slice(1) : levels;
  const normalizedLevels =
    meaningfulLevels.length > 0
      ? meaningfulLevels
      : [graph.tags.map((tag, index) => details.communities[tag] ?? index)];

  const deduped: number[][] = [];
  for (const level of normalizedLevels) {
    const previous = deduped.at(-1);
    if (
      previous !== undefined &&
      previous.length === level.length &&
      previous.every((value, index) => value === level[index])
    ) {
      continue;
    }
    deduped.push(level);
  }

  return deduped;
}

function partitionGroupsForLevel(nodes: string[], partition: number[]): PartitionGroup[] {
  const membersByCommunity = new Map<number, { members: string[]; nodeIndices: number[] }>();

  partition.forEach((communityId, nodeIndex) => {
    const member = nodes[nodeIndex];
    if (member === undefined) {
      return;
    }

    const existing = membersByCommunity.get(communityId);
    if (existing === undefined) {
      membersByCommunity.set(communityId, {
        members: [member],
        nodeIndices: [nodeIndex],
      });
      return;
    }

    existing.members.push(member);
    existing.nodeIndices.push(nodeIndex);
  });

  return [...membersByCommunity.entries()]
    .map(([id, group]) => ({
      id,
      nodeIndices: [...group.nodeIndices],
      members: uniqueSorted(group.members),
    }))
    .sort((left, right) => {
      const leftFingerprint = computeCommunityMembershipFingerprint(left.members);
      const rightFingerprint = computeCommunityMembershipFingerprint(right.members);
      const fingerprintCompare = compareLocale(leftFingerprint, rightFingerprint);
      if (fingerprintCompare !== 0) {
        return fingerprintCompare;
      }
      return left.id - right.id;
    });
}

function buildHierarchySeeds(graph: TagGraph, details: LouvainDetails): HierarchySeed[] {
  const nodes = graph.graph.nodes();
  const partitions = normalizeDendrogramLevels(graph, details);
  if (partitions.length === 0) {
    return [];
  }

  const groupsByLevel = partitions.map((partition) => partitionGroupsForLevel(nodes, partition));
  const seeds = new Map<string, HierarchySeed>();

  for (let level = 0; level < groupsByLevel.length; level += 1) {
    const groups = groupsByLevel[level] ?? [];
    const nextPartition = partitions[level + 1];

    for (const group of groups) {
      const rankedMembers = rankCommunityMembers(group.members, graph.adjacency);
      const parentGroup =
        nextPartition === undefined
          ? undefined
          : groupsByLevel[level + 1]?.find((candidate) => candidate.id === nextPartition[group.nodeIndices[0] ?? 0]);
      const key = `${level}:${group.id}`;

      seeds.set(key, {
        key,
        freshSlug: deriveCommunitySlug(rankedMembers),
        title: deriveCommunityTitle(rankedMembers),
        level,
        members: group.members,
        ...(parentGroup === undefined ? {} : { parentKey: `${level + 1}:${parentGroup.id}` }),
        ...(parentGroup === undefined
          ? {}
          : { parentMembershipFingerprint: computeCommunityMembershipFingerprint(parentGroup.members) }),
        childKeys: [],
      });
    }
  }

  for (const seed of seeds.values()) {
    if (seed.parentKey === undefined) {
      continue;
    }

    const parent = seeds.get(seed.parentKey);
    if (parent !== undefined) {
      parent.childKeys.push(seed.key);
    }
  }

  return [...seeds.values()].sort((left, right) => {
    if (left.level !== right.level) {
      return left.level - right.level;
    }

    const fingerprintCompare = compareLocale(
      computeCommunityMembershipFingerprint(left.members),
      computeCommunityMembershipFingerprint(right.members),
    );
    if (fingerprintCompare !== 0) {
      return fingerprintCompare;
    }

    return compareLocale(left.key, right.key);
  });
}

function maxLeafCommunitySize(graph: TagGraph, details: LouvainDetails): number {
  const firstLevel = normalizeDendrogramLevels(graph, details)[0];
  if (firstLevel === undefined) {
    return 0;
  }

  const counts = new Map<number, number>();
  for (const communityId of firstLevel) {
    counts.set(communityId, (counts.get(communityId) ?? 0) + 1);
  }

  return Math.max(...counts.values(), 0);
}

function evaluateResolution(graph: TagGraph, resolution: number): ResolutionEvaluation {
  const details = louvain.detailed(graph.graph, {
    getEdgeWeight: 'weight',
    randomWalk: false,
    rng: seededRng(COMMUNITY_LOUVAIN_SEED),
    resolution,
  });
  const maxLeafSize = maxLeafCommunitySize(graph, details);
  const targetPenalty =
    maxLeafSize > COMMUNITY_RESOLUTION_TARGET_MAX
      ? maxLeafSize - COMMUNITY_RESOLUTION_TARGET_MAX
      : maxLeafSize < COMMUNITY_RESOLUTION_TARGET_MIN
        ? COMMUNITY_RESOLUTION_TARGET_MIN - maxLeafSize
        : 0;

  return {
    resolution,
    details,
    maxLeafSize,
    targetPenalty,
    midpointPenalty: Math.abs(maxLeafSize - COMMUNITY_RESOLUTION_TARGET_MIDPOINT),
  };
}

function isBetterResolutionCandidate(
  candidate: ResolutionEvaluation,
  currentBest: ResolutionEvaluation | null,
): boolean {
  if (currentBest === null) {
    return true;
  }
  if (candidate.targetPenalty !== currentBest.targetPenalty) {
    return candidate.targetPenalty < currentBest.targetPenalty;
  }
  if (candidate.midpointPenalty !== currentBest.midpointPenalty) {
    return candidate.midpointPenalty < currentBest.midpointPenalty;
  }
  if (candidate.details.modularity !== currentBest.details.modularity) {
    return candidate.details.modularity > currentBest.details.modularity;
  }
  return candidate.resolution < currentBest.resolution;
}

function chooseBestResolution(graph: TagGraph): LouvainDetails {
  let low = COMMUNITY_RESOLUTION_MIN;
  let high = COMMUNITY_RESOLUTION_MAX;
  let best: ResolutionEvaluation | null = null;

  for (const resolution of [COMMUNITY_RESOLUTION_MIN, COMMUNITY_RESOLUTION_MAX]) {
    const evaluation = evaluateResolution(graph, resolution);
    if (isBetterResolutionCandidate(evaluation, best)) {
      best = evaluation;
    }
  }

  for (let step = 0; step < COMMUNITY_RESOLUTION_SWEEP_STEPS; step += 1) {
    const resolution = (low + high) / 2;
    const evaluation = evaluateResolution(graph, resolution);
    if (isBetterResolutionCandidate(evaluation, best)) {
      best = evaluation;
    }

    if (evaluation.maxLeafSize > COMMUNITY_RESOLUTION_TARGET_MAX) {
      low = resolution;
      continue;
    }
    if (evaluation.maxLeafSize < COMMUNITY_RESOLUTION_TARGET_MIN) {
      high = resolution;
      continue;
    }

    high = resolution;
  }

  if (best === null) {
    throw new Error('Failed to evaluate Louvain resolution sweep.');
  }

  return best.details;
}

function buildCarryOverSignature(
  community: Pick<DetectedCommunitySeed, 'level' | 'members' | 'parentMembershipFingerprint'>,
): string {
  return [
    String(community.level),
    computeCommunityMembershipFingerprint(community.members),
    community.parentMembershipFingerprint ?? '',
  ].join('\u0000');
}

function priorParentMembershipFingerprint(
  community: ExistingGeneratedCommunity,
  priorBySlug: ReadonlyMap<string, ExistingGeneratedCommunity>,
): string | undefined {
  if (community.parent === undefined) {
    return undefined;
  }

  const parentSlug = communitySlugFromReference(community.parent);
  const parent = priorBySlug.get(parentSlug);
  return parent === undefined ? undefined : computeCommunityMembershipFingerprint(parent.members);
}

function assignCommunitySlugs(
  communities: DetectedCommunitySeed[],
  priorCommunities: ExistingGeneratedCommunity[],
  options: { reservedSlugs?: ReadonlySet<string> } = {},
): Array<DetectedCommunity & { key?: string; parentKey?: string; childKeys?: string[] }> {
  const reservedSlugs = options.reservedSlugs ?? new Set<string>();
  const priorBySlug = new Map(priorCommunities.map((community) => [community.slug, community] as const));
  const reusablePriorSlugs = new Map<string, string[]>();

  for (const priorCommunity of priorCommunities) {
    const signature = buildCarryOverSignature({
      level: priorCommunity.level,
      members: priorCommunity.members,
      parentMembershipFingerprint: priorParentMembershipFingerprint(priorCommunity, priorBySlug),
    });
    const existing = reusablePriorSlugs.get(signature);
    if (existing === undefined) {
      reusablePriorSlugs.set(signature, [priorCommunity.slug]);
      continue;
    }
    existing.push(priorCommunity.slug);
  }

  for (const slugs of reusablePriorSlugs.values()) {
    slugs.sort(compareLocale);
  }

  const usedSlugs = new Set<string>();
  const assignedSlugs = new Map<string | number, string>();
  const sortedCommunities = [...communities].sort((left, right) => {
    if (left.level !== right.level) {
      return left.level - right.level;
    }
    const leftSignature = buildCarryOverSignature(left);
    const rightSignature = buildCarryOverSignature(right);
    const signatureCompare = compareLocale(leftSignature, rightSignature);
    if (signatureCompare !== 0) {
      return signatureCompare;
    }
    return compareLocale(left.freshSlug, right.freshSlug);
  });

  for (const community of sortedCommunities) {
    const key = community.key ?? `${community.level}:${computeCommunityMembershipFingerprint(community.members)}`;
    const reusable = reusablePriorSlugs.get(buildCarryOverSignature(community));
    const carriedSlug = reusable?.shift();

    assignedSlugs.set(key, ensureUniqueCommunitySlug(carriedSlug ?? community.freshSlug, usedSlugs, reservedSlugs));
  }

  return communities
    .map((community, index) => {
      const key = community.key ?? index;
      return {
        slug: assignedSlugs.get(key) ?? ensureUniqueCommunitySlug(community.freshSlug, usedSlugs, reservedSlugs),
        title: community.title,
        level: community.level,
        members: community.members,
        ...(community.parentKey === undefined ? {} : { parentKey: community.parentKey }),
        ...(community.childKeys === undefined ? {} : { childKeys: community.childKeys }),
        ...(community.key === undefined ? {} : { key: community.key }),
      };
    })
    .sort((left, right) => compareLocale(left.slug, right.slug));
}

export function carryOverSlugs(
  communities: DetectedCommunitySeed[],
  priorCommunities: ExistingGeneratedCommunity[],
  options: { reservedSlugs?: ReadonlySet<string> } = {},
): DetectedCommunity[] {
  return assignCommunitySlugs(communities, priorCommunities, options).map((community) => ({
    slug: community.slug,
    title: community.title,
    level: community.level,
    members: community.members,
  }));
}

function detectCommunitiesForHash(
  graph: TagGraph,
): Array<Pick<DetectedCommunity, 'slug' | 'level' | 'members' | 'parent' | 'children'>> {
  return detectCommunities(graph).map((community) => ({
    slug: community.slug,
    level: community.level,
    members: community.members,
    ...(community.parent === undefined ? {} : { parent: community.parent }),
    ...(community.children === undefined ? {} : { children: community.children }),
  }));
}

export function detectCommunities(graph: TagGraph, options: DetectCommunitiesOptions = {}): DetectedCommunity[] {
  if (graph.graph.order === 0) {
    return [];
  }

  const details = chooseBestResolution(graph);
  const hierarchySeeds = buildHierarchySeeds(graph, details);
  if (hierarchySeeds.length === 0) {
    return [];
  }

  const assignedCommunities = assignCommunitySlugs(hierarchySeeds, options.priorCommunities ?? [], {
    reservedSlugs: options.reservedSlugs,
  });
  const slugByKey = new Map(
    assignedCommunities
      .filter((community): community is typeof community & { key: string } => typeof community.key === 'string')
      .map((community) => [community.key, community.slug] as const),
  );

  return assignedCommunities
    .map((community) => ({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.parentKey === undefined
        ? {}
        : { parent: communityEntryId(slugByKey.get(community.parentKey) ?? community.parentKey) }),
      ...(community.childKeys === undefined || community.childKeys.length === 0
        ? {}
        : {
            children: community.childKeys
              .map((childKey) => slugByKey.get(childKey))
              .filter((slug): slug is string => slug !== undefined)
              .sort(compareLocale)
              .map((slug) => communityEntryId(slug)),
          }),
    }))
    .sort((left, right) => {
      if (left.level !== right.level) {
        return left.level - right.level;
      }
      return compareLocale(left.slug, right.slug);
    });
}

export function computeCommunityTopologyFingerprint(
  index: KbIndex,
  graph = buildEntityRelationshipGraphFromIndex(index),
): string {
  const communities = detectCommunitiesForHash(graph);
  return createHash('sha256')
    .update(
      JSON.stringify({
        graph: computeGraphFingerprint(graph),
        communities: communities.map((community) => ({
          slug: community.slug,
          level: community.level,
          members: community.members,
          ...(community.parent === undefined ? {} : { parent: community.parent }),
          ...(community.children === undefined ? {} : { children: community.children }),
        })),
      }),
    )
    .digest('hex');
}

export function computeCommunityMembershipFingerprint(members: string[]): string {
  return createHash('sha256').update(uniqueSorted(members).join('\n')).digest('hex');
}
