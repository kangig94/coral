import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as GraphologyModule from 'graphology';
import * as louvainModule from 'graphology-communities-louvain';
import type { DetailedLouvainOutput } from 'graphology-communities-louvain';
import type { AbstractGraph, GraphConstructor } from 'graphology-types';
import { unlinkIfExists } from '../../infra/fs-errors.js';
import {
  captureCommunityManifestDelta,
  captureRemovedCommunityManifestDelta,
} from '../corpus/manifest-authority.js';
import {
  extractBody,
  extractTitle,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSummaryFromBody,
  serializeCommunityFrontmatter,
} from '../corpus/frontmatter.js';
import { sortedMarkdownEntries } from '../corpus/markdown-entries.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { stripMdExt } from '../paths.js';
import { loadKbNote, loadKbSource } from '../read.js';
import type { KbRuntime } from '../contracts.js';
import { queueManifestAuthorityDelta } from '../runtime-effects.js';
import { compareLocale, stripMarkdownCodeFences } from '../validation.js';
import {
  communityEntryId,
  parseKbEntryId,
  isNoteEntry,
  isSourceEntry,
  type CuratableEntry,
  type EntityGraph,
  type KbIndex,
} from '../entry-types.js';

type TagGraphNodeAttributes = Record<string, never>;
type TagGraphEdgeAttributes = { weight: number };
type Louvain = {
  detailed(
    graph: AbstractGraph<TagGraphNodeAttributes, TagGraphEdgeAttributes>,
    options?: Record<string, unknown>,
  ): DetailedLouvainOutput;
};
type LouvainDetails = DetailedLouvainOutput;

const Graph =
  (GraphologyModule as unknown as { default?: GraphConstructor<TagGraphNodeAttributes, TagGraphEdgeAttributes> })
    .default ?? (GraphologyModule as unknown as GraphConstructor<TagGraphNodeAttributes, TagGraphEdgeAttributes>);
const louvain: Louvain =
  (louvainModule as unknown as { default?: Louvain }).default ?? (louvainModule as unknown as Louvain);

export type TagGraphEdge = {
  left: string;
  right: string;
  weight: number;
};

export type TagGraph = {
  graph: AbstractGraph<TagGraphNodeAttributes, TagGraphEdgeAttributes>;
  tags: string[];
  edges: TagGraphEdge[];
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

export type DetectedCommunity = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
};

export type ExistingGeneratedCommunity = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommunityDocument = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
  content: string;
};

type DetectCommunitiesOptions = {
  priorCommunities?: ExistingGeneratedCommunity[];
  reservedSlugs?: ReadonlySet<string>;
};

type BuildCommunityDocumentsOptions = {
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  today: string;
};

type DetectedCommunitySeed = Omit<DetectedCommunity, 'slug' | 'parent' | 'children'> & {
  freshSlug: string;
  key?: string;
  parentKey?: string;
  childKeys?: string[];
  parentMembershipFingerprint?: string;
};

type RepresentativeDocument = {
  kind: 'note' | 'source';
  slug: string;
  title: string;
  overlapTags: string[];
  excerpt: string;
};

type RepresentativeDocumentCandidate = Omit<RepresentativeDocument, 'excerpt'>;

type ChildCommunitySummary = {
  slug: string;
  title: string;
  members: string[];
  summary: string;
};

type SummaryFingerprintCommunity = Pick<
  ExistingGeneratedCommunity,
  'slug' | 'title' | 'level' | 'members' | 'children' | 'summary'
>;

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
const COMMUNITY_SUMMARY_DOCUMENT_LIMIT = 3;
const COMMUNITY_SUMMARY_EXCERPT_MAX_CHARS = 800;
const COMMUNITY_LOUVAIN_SEED = 0x5eed1234;
const COMMUNITY_RESOLUTION_MIN = 0.5;
const COMMUNITY_RESOLUTION_MAX = 5;
const COMMUNITY_RESOLUTION_TARGET_MIN = 20;
const COMMUNITY_RESOLUTION_TARGET_MAX = 30;
const COMMUNITY_RESOLUTION_TARGET_MIDPOINT =
  (COMMUNITY_RESOLUTION_TARGET_MIN + COMMUNITY_RESOLUTION_TARGET_MAX) / 2;
const COMMUNITY_RESOLUTION_SWEEP_STEPS = 12;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareLocale);
}

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

function computeTextFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function communitySlugFromReference(reference: string): string {
  const parsed = parseKbEntryId(reference);
  if (parsed !== null && parsed.startsWith('community:')) {
    return parsed.slice('community:'.length);
  }
  return reference;
}

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

function formatEdgeWeight(weight: number): string {
  return weight.toFixed(12);
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

function renderMembersSection(members: string[]): string {
  return ['## Members', '', ...members.map((member) => `- #${member}`)].join('\n');
}

function renderChildrenSection(children: string[]): string {
  return ['## Children', '', ...children.map((child) => `- ${child}`)].join('\n');
}

function normalizeEntityGraph(index: KbIndex): EntityGraph {
  return {
    entityMeta: index.entityMeta,
    relationships: index.relationships,
  };
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

  const edges = [...edgeWeights.entries()]
    .map(([key, weight]) => {
      const [left, right] = parseEdgeKey(key);
      return { left, right, weight };
    })
    .sort((left, right) => {
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

function buildEntityRelationshipGraphFromIndex(index: KbIndex): TagGraph {
  return buildEntityRelationshipGraph(normalizeEntityGraph(index));
}

export function computeGraphFingerprint(graph: TagGraph): string {
  const payload = [
    ...graph.tags.map((tag) => `N\t${tag}`),
    ...graph.edges.map((edge) => `${edge.left}\t${edge.right}\t${formatEdgeWeight(edge.weight)}`),
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

function normalizeDendrogramLevels(
  graph: TagGraph,
  details: LouvainDetails,
): number[][] {
  const rawDendrogram = (details as LouvainDetails & { dendrogram: LouvainDetails['dendrogram'] | null }).dendrogram;
  const levels = (rawDendrogram ?? []).map((level) => Array.from(level, (community) => Number(community)));
  const meaningfulLevels = levels.length > 1 ? levels.slice(1) : levels;
  const normalizedLevels = meaningfulLevels.length > 0 ? meaningfulLevels : [graph.tags.map((tag, index) => details.communities[tag] ?? index)];

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
          : groupsByLevel[level + 1]?.find(
              (candidate) => candidate.id === nextPartition[group.nodeIndices[0] ?? 0],
            );
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

    assignedSlugs.set(
      key,
      ensureUniqueCommunitySlug(carriedSlug ?? community.freshSlug, usedSlugs, reservedSlugs),
    );
  }

  return communities
    .map((community, index) => {
      const key = community.key ?? index;
      return {
        slug:
          assignedSlugs.get(key) ??
          ensureUniqueCommunitySlug(community.freshSlug, usedSlugs, reservedSlugs),
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

export function computeCommunityTopologyFingerprint(index: KbIndex, graph = buildEntityRelationshipGraphFromIndex(index)): string {
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

export function loadExistingCommunityState(kb: Pick<KbRuntime, 'communitiesDir'>): {
  generated: ExistingGeneratedCommunity[];
  reservedSlugs: Set<string>;
} {
  const generated: ExistingGeneratedCommunity[] = [];
  const reservedSlugs = new Set<string>();

  for (const entry of sortedMarkdownEntries(kb.communitiesDir())) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(kb.communitiesDir(), entry), 'utf-8');

    try {
      const frontmatter = parseCommunityFrontmatter(raw);
      const body = extractBody(raw);
      generated.push({
        slug,
        title: extractTitle(raw),
        level: frontmatter.level,
        members: parseMembersFromBody(body),
        ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
        ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
        summary: parseSummaryFromBody(body),
        createdAt: frontmatter.createdAt,
        updatedAt: frontmatter.updatedAt,
      });
    } catch {
      reservedSlugs.add(slug);
    }
  }

  return { generated, reservedSlugs };
}

export function renderCommunityDocument(document: {
  title: string;
  members: string[];
  level?: number;
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}): string {
  const frontmatter = serializeCommunityFrontmatter({
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    level: document.level,
    ...(document.parent === undefined ? {} : { parent: document.parent }),
    ...(document.children === undefined ? {} : { children: document.children }),
  });
  const summarySection = document.summary === undefined ? '' : `## Summary\n\n${document.summary}\n\n`;
  const childrenSection =
    document.children === undefined || document.children.length === 0
      ? ''
      : `\n\n${renderChildrenSection(document.children)}`;

  return `${frontmatter}# ${document.title}\n\n${summarySection}${renderMembersSection(document.members)}${childrenSection}\n`;
}

export function buildCommunityDocuments(
  communities: DetectedCommunity[],
  options: BuildCommunityDocumentsOptions,
): CommunityDocument[] {
  const priorBySlug = new Map(
    options.priorGeneratedCommunities.map((community) => [community.slug, community] as const),
  );

  return communities.map((community) => {
    const priorCommunity = priorBySlug.get(community.slug);
    const createdAt = priorCommunity?.createdAt ?? options.today;
    const summary = priorCommunity?.summary;
    const title = community.title;

    return {
      slug: community.slug,
      title,
      level: community.level,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(summary === undefined ? {} : { summary }),
      createdAt,
      updatedAt: options.today,
      content: renderCommunityDocument({
        title,
        members: community.members,
        level: community.level,
        ...(community.parent === undefined ? {} : { parent: community.parent }),
        ...(community.children === undefined ? {} : { children: community.children }),
        ...(summary === undefined ? {} : { summary }),
        createdAt,
        updatedAt: options.today,
      }),
    };
  });
}

export function generateCommunityFiles(
  kb: KbRuntime,
  documents: CommunityDocument[],
  priorGeneratedCommunities: ExistingGeneratedCommunity[],
  onWrite?: () => void,
): boolean {
  let wroteFiles = false;

  for (const community of priorGeneratedCommunities) {
    const communityPath = kb.communityPath(community.slug);
    if (!existsSync(communityPath)) {
      continue;
    }

    unlinkIfExists(communityPath);
    queueManifestAuthorityDelta(kb, captureRemovedCommunityManifestDelta(community.slug));
    onWrite?.();
    wroteFiles = true;
  }

  for (const document of documents) {
    writeFileAtomic(kb.communityPath(document.slug), document.content);
    queueManifestAuthorityDelta(kb, captureCommunityManifestDelta(document.slug, document.content));
    onWrite?.();
    wroteFiles = true;
  }

  return wroteFiles;
}

function trimSummaryExcerpt(body: string, maxChars: number): string {
  const normalized = body.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, maxChars).trimEnd();
}

function selectRepresentativeDocuments(
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath'>,
  index: KbIndex,
  members: string[],
): RepresentativeDocument[] {
  const memberSet = new Set(members);
  const candidates = Object.values(index.entries)
    .filter((entry): entry is CuratableEntry => isNoteEntry(entry) || isSourceEntry(entry))
    .map((entry) => {
      const overlapTags = uniqueSorted(entry.tags.filter((tag) => memberSet.has(tag)));
      if (overlapTags.length === 0) {
        return null;
      }

      return {
        kind: entry.kind,
        slug: entry.slug,
        title: entry.title,
        overlapTags,
      };
    })
    .filter((entry): entry is RepresentativeDocumentCandidate => entry !== null)
    .sort((left, right) => {
      const overlapDiff = right.overlapTags.length - left.overlapTags.length;
      if (overlapDiff !== 0) {
        return overlapDiff;
      }

      if (left.kind !== right.kind) {
        return left.kind === 'note' ? -1 : 1;
      }

      const titleCompare = compareLocale(left.title, right.title);
      if (titleCompare !== 0) {
        return titleCompare;
      }

      return compareLocale(left.slug, right.slug);
    })
    .slice(0, COMMUNITY_SUMMARY_DOCUMENT_LIMIT);

  return candidates.map((candidate) => {
    const loaded =
      candidate.kind === 'note' ? loadKbNote(kb.notePath(candidate.slug)) : loadKbSource(kb.sourcePath(candidate.slug));

    return {
      kind: candidate.kind,
      slug: candidate.slug,
      title: loaded.title,
      overlapTags: candidate.overlapTags,
      excerpt: trimSummaryExcerpt(loaded.body, COMMUNITY_SUMMARY_EXCERPT_MAX_CHARS),
    };
  });
}

function representativeDocumentFingerprint(document: RepresentativeDocument): string {
  return computeTextFingerprint(
    JSON.stringify({
      kind: document.kind,
      slug: document.slug,
      overlapTags: document.overlapTags,
      excerpt: document.excerpt,
    }),
  );
}

function leafSummaryFingerprintPayload(
  community: Pick<DetectedCommunity, 'members'>,
  index: KbIndex,
  documents: RepresentativeDocument[],
): string {
  const entityMeta = index.entityMeta;

  return JSON.stringify({
    kind: 'leaf',
    members: uniqueSorted(community.members),
    entityMeta: uniqueSorted(community.members).map((member) => {
      const meta = entityMeta[member];
      return {
        member,
        type: meta?.type ?? '',
        description: meta?.description ?? '',
        aliases: [...(meta?.aliases ?? [])].sort(compareLocale),
      };
    }),
    excerpts: documents.map((document) => ({
      kind: document.kind,
      slug: document.slug,
      fingerprint: representativeDocumentFingerprint(document),
    })),
  });
}

function summaryTextFingerprint(summary: string | undefined): string {
  return computeTextFingerprint((summary ?? '').trim());
}

function childCommunitiesForCommunity(
  community: Pick<SummaryFingerprintCommunity, 'children'>,
  communitiesBySlug: ReadonlyMap<string, SummaryFingerprintCommunity>,
): ChildCommunitySummary[] {
  const childReferences = [...(community.children ?? [])].sort((left, right) =>
    compareLocale(communitySlugFromReference(left), communitySlugFromReference(right)),
  );

  return childReferences.map((reference) => {
    const slug = communitySlugFromReference(reference);
    const child = communitiesBySlug.get(slug);
    if (child === undefined) {
      throw new Error(`Missing child community ${reference} while computing parent summary dependencies.`);
    }
    if (child.summary === undefined) {
      throw new Error(`Missing child summary for ${reference} while computing parent summary dependencies.`);
    }

    return {
      slug: child.slug,
      title: child.title,
      members: child.members,
      summary: child.summary,
    };
  });
}

function parentSummaryFingerprintPayload(
  community: Pick<DetectedCommunity, 'members'>,
  childCommunities: ChildCommunitySummary[],
): string {
  return JSON.stringify({
    kind: 'parent',
    members: uniqueSorted(community.members),
    children: childCommunities.map((child) => ({
      slug: child.slug,
      summaryFingerprint: summaryTextFingerprint(child.summary),
    })),
  });
}

export function computeCommunitySummaryInputFingerprintForCommunity(
  community: SummaryFingerprintCommunity,
  communitiesBySlug: ReadonlyMap<string, SummaryFingerprintCommunity>,
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath'>,
  index: KbIndex,
): string {
  if (community.children === undefined || community.children.length === 0) {
    return computeTextFingerprint(
      leafSummaryFingerprintPayload(community, index, selectRepresentativeDocuments(kb, index, community.members)),
    );
  }

  return computeTextFingerprint(
    parentSummaryFingerprintPayload(community, childCommunitiesForCommunity(community, communitiesBySlug)),
  );
}

export function computeCommunitySummaryInputFingerprints(
  communities: SummaryFingerprintCommunity[],
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath'>,
  index: KbIndex,
): Record<string, string> {
  const communitiesBySlug = new Map(communities.map((community) => [community.slug, community] as const));
  const orderedCommunities = [...communities].sort((left, right) => {
    if (left.level !== right.level) {
      return left.level - right.level;
    }
    return compareLocale(left.slug, right.slug);
  });

  return Object.fromEntries(
    orderedCommunities.map((community) => [
      community.slug,
      computeCommunitySummaryInputFingerprintForCommunity(community, communitiesBySlug, kb, index),
    ]),
  );
}

function buildLeafCommunitySummaryPrompt(
  community: Pick<DetectedCommunity, 'members'>,
  index: KbIndex,
  documents: RepresentativeDocument[],
): string {
  const entityMeta = index.entityMeta;
  const entityLines = uniqueSorted(community.members).map((member) => {
    const meta = entityMeta[member];
    const typeSegment = meta?.type === undefined ? '' : ` (${meta.type})`;
    const description = meta?.description ?? 'No stored description.';
    return `- ${member}${typeSegment}: ${description}`;
  });
  const excerptBlocks = documents.map((document) =>
    [
      `## ${document.kind}:${document.slug}`,
      `Title: ${document.title}`,
      `Overlap entities: ${document.overlapTags.join(', ')}`,
      'Excerpt:',
      document.excerpt,
    ].join('\n'),
  );

  return [
    'Return plain text only. No heading, bullets, or code fences.',
    'Write a concise KB community summary in 2-3 sentences.',
    'Base it only on the entity descriptions and representative excerpts below.',
    'If the excerpts are mixed, describe the shared thread conservatively and do not invent unsupported claims.',
    '',
    'Entity descriptions:',
    ...entityLines,
    '',
    'Representative excerpts:',
    ...excerptBlocks,
  ].join('\n');
}

function buildParentCommunitySummaryPrompt(
  community: Pick<DetectedCommunity, 'members'>,
  childCommunities: ChildCommunitySummary[],
): string {
  const childBlocks = childCommunities.map((child) =>
    [
      `## ${child.slug}`,
      `Title: ${child.title}`,
      `Members: ${child.members.join(', ')}`,
      'Summary:',
      child.summary,
    ].join('\n'),
  );

  return [
    'Return plain text only. No heading, bullets, or code fences.',
    'Write a concise KB community summary in 2-3 sentences.',
    'Base it only on the child community summaries below.',
    'Synthesize the shared abstraction across the children without inventing unsupported details.',
    '',
    'Parent members:',
    ...community.members.map((member) => `- ${member}`),
    '',
    'Child community summaries:',
    ...childBlocks,
  ].join('\n');
}

function normalizeGeneratedSummary(raw: string): string | undefined {
  const normalized = stripMarkdownCodeFences(raw).replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

export async function generateCommunitySummary(options: {
  community: DetectedCommunity;
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath'>;
  index: KbIndex;
  childCommunities?: ChildCommunitySummary[];
  priorCommunity?: ExistingGeneratedCommunity;
  priorSummaryInputFingerprint?: string;
  runClaude: (prompt: string, extraArgs?: string[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const childCommunities = options.childCommunities?.length ? [...options.childCommunities] : undefined;
  const summaryInputFingerprint =
    childCommunities === undefined
      ? computeTextFingerprint(
          leafSummaryFingerprintPayload(
            options.community,
            options.index,
            selectRepresentativeDocuments(options.kb, options.index, options.community.members),
          ),
        )
      : computeTextFingerprint(parentSummaryFingerprintPayload(options.community, childCommunities));

  if (
    options.priorCommunity?.summary !== undefined &&
    options.priorSummaryInputFingerprint === summaryInputFingerprint
  ) {
    return options.priorCommunity.summary;
  }

  const prompt =
    childCommunities === undefined
      ? buildLeafCommunitySummaryPrompt(
          options.community,
          options.index,
          selectRepresentativeDocuments(options.kb, options.index, options.community.members),
        )
      : buildParentCommunitySummaryPrompt(options.community, childCommunities);

  const rawSummary = await options.runClaude(prompt, undefined, options.signal);
  const summary = normalizeGeneratedSummary(rawSummary);
  if (summary === undefined) {
    throw new Error(`Community summary returned empty text for ${options.community.slug}.`);
  }

  return summary;
}
