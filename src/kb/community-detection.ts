import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as GraphologyModule from 'graphology';
import * as louvainModule from 'graphology-communities-louvain';
import type { AbstractGraph, GraphConstructor } from 'graphology-types';
import { unlinkIfExists } from '../shared/mcp-utils.js';
import {
  deriveNoteIdentity,
  serializeCommunityFrontmatter,
} from './frontmatter.js';
import { writeFileAtomic } from './mutation-helpers.js';
import { stripMdExt } from './paths.js';
import { loadKbNote, loadKbSource } from './read.js';
import type { KbRuntime } from './runtime.js';
import { sortedMarkdownEntries } from './text-artifacts.js';
import { compareLocale, stripMarkdownCodeFences } from './validation.js';
import { isCommunityEntry, isNoteEntry, isSourceEntry, type CuratableEntry, type KbIndex } from './types.js';

type TagGraphNodeAttributes = Record<string, never>;
type TagGraphEdgeAttributes = { weight: number };
type Louvain = (typeof import('graphology-communities-louvain'))['default'];

const Graph = (
  (GraphologyModule as unknown as { default?: GraphConstructor<TagGraphNodeAttributes, TagGraphEdgeAttributes> }).default ??
  (GraphologyModule as unknown as GraphConstructor<TagGraphNodeAttributes, TagGraphEdgeAttributes>)
);
const louvain = (
  (louvainModule as unknown as { default?: Louvain }).default ?? (louvainModule as unknown as Louvain)
);

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
  level: 0;
  members: string[];
};

export type ExistingGeneratedCommunity = {
  slug: string;
  title: string;
  members: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommunityDocument = {
  slug: string;
  title: string;
  members: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
  membershipFingerprint: string;
  content: string;
};

type DetectCommunitiesOptions = {
  priorCommunities?: ExistingGeneratedCommunity[];
  reservedSlugs?: ReadonlySet<string>;
};

type BuildCommunityDocumentsOptions = {
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  priorMembershipFingerprints?: Readonly<Record<string, string>>;
  today: string;
};

const COMMUNITY_SLUG_TAG_LIMIT = 3;
const COMMUNITY_SUMMARY_DOCUMENT_LIMIT = 3;
const COMMUNITY_SUMMARY_EXCERPT_MAX_CHARS = 800;

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
    const degreeDiff = internalWeightedDegree(right, memberSet, adjacency) - internalWeightedDegree(left, memberSet, adjacency);
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

export function graphTagsForEntry(entry: CuratableEntry): string[] {
  const tags = uniqueSorted(entry.tags);
  if (!isNoteEntry(entry)) {
    return tags;
  }

  const domain = deriveNoteIdentity(entry.slug).domain;
  return tags.filter((tag) => tag !== domain);
}

export function buildTagCooccurrenceGraph(index: KbIndex): TagGraph {
  const edgeWeights = new Map<string, number>();
  const tags = new Set<string>();

  for (const entry of Object.values(index.entries)) {
    if (!isNoteEntry(entry) && !isSourceEntry(entry)) {
      continue;
    }

    const entryTags = graphTagsForEntry(entry);
    for (const tag of entryTags) {
      tags.add(tag);
    }

    if (entryTags.length < 2) {
      continue;
    }

    const contribution = 1 / entryTags.length;
    for (let leftIndex = 0; leftIndex < entryTags.length - 1; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entryTags.length; rightIndex += 1) {
        const key = edgeKey(entryTags[leftIndex]!, entryTags[rightIndex]!);
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + contribution);
      }
    }
  }

  const sortedTags = [...tags].sort(compareLocale);
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

export function computeGraphFingerprint(graph: TagGraph): string {
  const payload = graph.edges.map((edge) => `${edge.left}\t${edge.right}\t${formatEdgeWeight(edge.weight)}`).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

export function computeCommunityMembershipFingerprint(members: string[]): string {
  return createHash('sha256').update(uniqueSorted(members).join('\n')).digest('hex');
}

function jaccardOverlap(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  let intersection = 0;
  for (const member of leftSet) {
    if (rightSet.has(member)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

type DetectedCommunitySeed = Omit<DetectedCommunity, 'slug'> & {
  freshSlug: string;
};

export function carryOverSlugs(
  communities: DetectedCommunitySeed[],
  priorCommunities: ExistingGeneratedCommunity[],
  options: { reservedSlugs?: ReadonlySet<string> } = {},
): DetectedCommunity[] {
  const reservedSlugs = options.reservedSlugs ?? new Set<string>();
  const assignedPriorSlugByIndex = new Map<number, string>();
  const candidateMatches = communities
    .flatMap((community, communityIndex) =>
      priorCommunities
        .map((priorCommunity, priorIndex) => {
          const score = jaccardOverlap(community.members, priorCommunity.members);
          return {
            communityIndex,
            priorIndex,
            score,
            slug: priorCommunity.slug,
          };
        })
        .filter((candidate) => candidate.score > 0),
    )
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      const leftPrior = priorCommunities[left.priorIndex];
      const rightPrior = priorCommunities[right.priorIndex];
      if (leftPrior !== undefined && rightPrior !== undefined) {
        const priorCompare = compareLocale(leftPrior.slug, rightPrior.slug);
        if (priorCompare !== 0) {
          return priorCompare;
        }
      }

      const communityCompare = compareLocale(
        communities[left.communityIndex]?.freshSlug ?? '',
        communities[right.communityIndex]?.freshSlug ?? '',
      );
      if (communityCompare !== 0) {
        return communityCompare;
      }

      return left.communityIndex - right.communityIndex;
    });

  const matchedCommunities = new Set<number>();
  const matchedPriors = new Set<number>();
  for (const candidate of candidateMatches) {
    if (matchedCommunities.has(candidate.communityIndex) || matchedPriors.has(candidate.priorIndex)) {
      continue;
    }

    matchedCommunities.add(candidate.communityIndex);
    matchedPriors.add(candidate.priorIndex);
    assignedPriorSlugByIndex.set(candidate.communityIndex, candidate.slug);
  }

  const finalSlugByIndex = new Map<number, string>();
  const usedSlugs = new Set<string>();

  for (const [communityIndex, carriedSlug] of [...assignedPriorSlugByIndex.entries()].sort((left, right) =>
    compareLocale(left[1], right[1]),
  )) {
    finalSlugByIndex.set(communityIndex, ensureUniqueCommunitySlug(carriedSlug, usedSlugs, reservedSlugs));
  }

  communities.forEach((community, communityIndex) => {
    if (finalSlugByIndex.has(communityIndex)) {
      return;
    }

    finalSlugByIndex.set(communityIndex, ensureUniqueCommunitySlug(community.freshSlug, usedSlugs, reservedSlugs));
  });

  return communities
    .map((community, communityIndex) => ({
      slug: finalSlugByIndex.get(communityIndex) ?? ensureUniqueCommunitySlug(community.freshSlug, usedSlugs, reservedSlugs),
      title: community.title,
      level: 0 as const,
      members: community.members,
    }))
    .sort((left, right) => compareLocale(left.slug, right.slug));
}

export function detectCommunities(graph: TagGraph, options: DetectCommunitiesOptions = {}): DetectedCommunity[] {
  if (graph.graph.order < 2 || graph.graph.size === 0) {
    return [];
  }

  const partition: Record<string, number> = louvain(graph.graph, {
    getEdgeWeight: 'weight',
    randomWalk: false,
  });
  const membersByCommunity = new Map<number, string[]>();
  for (const [node, community] of Object.entries(partition)) {
    const members = membersByCommunity.get(community);
    if (members === undefined) {
      membersByCommunity.set(community, [node]);
      continue;
    }
    members.push(node);
  }

  const seeds = [...membersByCommunity.values()]
    .map((members) => uniqueSorted(members))
    .filter((members) => members.length >= 2)
    .map((members) => {
      const rankedMembers = rankCommunityMembers(members, graph.adjacency);
      return {
        freshSlug: deriveCommunitySlug(rankedMembers),
        title: deriveCommunityTitle(rankedMembers),
        level: 0 as const,
        members,
      };
    });

  return carryOverSlugs(seeds, options.priorCommunities ?? [], {
    reservedSlugs: options.reservedSlugs,
  });
}

export function loadExistingCommunityState(
  kb: Pick<KbRuntime, 'communitiesDir'>,
  index: KbIndex,
): {
  generated: ExistingGeneratedCommunity[];
  reservedSlugs: Set<string>;
} {
  const generated = Object.values(index.entries)
    .filter(isCommunityEntry)
    .sort((left, right) => compareLocale(left.slug, right.slug))
    .map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      members: [...entry.members],
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));

  const indexedSlugs = new Set(generated.map((entry) => entry.slug));
  const reservedSlugs = new Set(
    sortedMarkdownEntries(kb.communitiesDir())
      .map((entry) => stripMdExt(entry))
      .filter((slug) => !indexedSlugs.has(slug)),
  );

  return { generated, reservedSlugs };
}

export function renderCommunityDocument(document: {
  title: string;
  members: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}): string {
  const frontmatter = serializeCommunityFrontmatter({
    level: 0,
    members: document.members,
    ...(document.summary === undefined ? {} : { summary: document.summary }),
    generatedBy: 'curate',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
  const summarySection =
    document.summary === undefined ? '' : `## Summary\n\n${document.summary}\n\n`;

  return `${frontmatter}# ${document.title}\n\n${summarySection}${renderMembersSection(document.members)}\n`;
}

function priorMembershipFingerprintForCommunity(
  community: ExistingGeneratedCommunity | undefined,
  priorMembershipFingerprints?: Readonly<Record<string, string>>,
): string | undefined {
  if (community === undefined) {
    return undefined;
  }

  return priorMembershipFingerprints?.[community.slug] ?? computeCommunityMembershipFingerprint(community.members);
}

export function buildCommunityDocuments(
  communities: DetectedCommunity[],
  options: BuildCommunityDocumentsOptions,
): CommunityDocument[] {
  const priorBySlug = new Map(options.priorGeneratedCommunities.map((community) => [community.slug, community] as const));

  return communities.map((community) => {
    const priorCommunity = priorBySlug.get(community.slug);
    const membershipFingerprint = computeCommunityMembershipFingerprint(community.members);
    const priorMembershipFingerprint = priorMembershipFingerprintForCommunity(
      priorCommunity,
      options.priorMembershipFingerprints,
    );
    const preserveSummary =
      priorCommunity?.summary !== undefined && priorMembershipFingerprint === membershipFingerprint;
    const createdAt = priorCommunity?.createdAt ?? options.today;
    const title = community.title;
    const summary = preserveSummary ? priorCommunity.summary : undefined;

    return {
      slug: community.slug,
      title,
      members: community.members,
      ...(summary === undefined ? {} : { summary }),
      createdAt,
      updatedAt: options.today,
      membershipFingerprint,
      content: renderCommunityDocument({
        title,
        members: community.members,
        ...(summary === undefined ? {} : { summary }),
        createdAt,
        updatedAt: options.today,
      }),
    };
  });
}

export function generateCommunityFiles(
  kb: Pick<KbRuntime, 'communityPath'>,
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
    onWrite?.();
    wroteFiles = true;
  }

  for (const document of documents) {
    writeFileAtomic(kb.communityPath(document.slug), document.content);
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

type RepresentativeDocument = {
  kind: 'note' | 'source';
  slug: string;
  title: string;
  overlapTags: string[];
  excerpt: string;
};

type RepresentativeDocumentCandidate = Omit<RepresentativeDocument, 'excerpt'>;

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

function buildCommunitySummaryPrompt(community: DetectedCommunity, documents: RepresentativeDocument[]): string {
  const memberLines = community.members.map((member) => `- ${member}`);
  const excerptBlocks = documents.map(
    (document) =>
      [
        `## ${document.kind}:${document.slug}`,
        `Title: ${document.title}`,
        `Overlap tags: ${document.overlapTags.join(', ')}`,
        'Excerpt:',
        document.excerpt,
      ].join('\n'),
  );

  return [
    'Return plain text only. No heading, bullets, or code fences.',
    'Write a concise KB community summary in 2-3 sentences.',
    'Base it only on the member tags and representative excerpts below.',
    'If the excerpts are mixed, describe the shared thread conservatively and do not invent unsupported claims.',
    '',
    'Community members:',
    ...memberLines,
    '',
    'Representative excerpts:',
    ...excerptBlocks,
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
  priorCommunity?: ExistingGeneratedCommunity;
  priorMembershipFingerprint?: string;
  runClaude: (prompt: string, extraArgs?: string[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const membershipFingerprint = computeCommunityMembershipFingerprint(options.community.members);
  if (
    options.priorCommunity?.summary !== undefined &&
    options.priorMembershipFingerprint === membershipFingerprint
  ) {
    return options.priorCommunity.summary;
  }

  const representativeDocuments = selectRepresentativeDocuments(options.kb, options.index, options.community.members);
  const prompt = buildCommunitySummaryPrompt(options.community, representativeDocuments);
  const rawSummary = await options.runClaude(prompt, undefined, options.signal);
  const summary = normalizeGeneratedSummary(rawSummary);
  if (summary === undefined) {
    throw new Error(`Community summary returned empty text for ${options.community.slug}.`);
  }

  return summary;
}
