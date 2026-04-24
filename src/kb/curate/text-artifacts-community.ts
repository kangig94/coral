import {
  buildCommunityDocuments,
  buildEntityRelationshipGraph,
  computeCommunitySummaryInputFingerprints,
  computeCommunityTopologyFingerprint,
  detectCommunities,
  generateCommunityFiles,
  loadExistingCommunityState,
} from './community-detection.js';
import { readCurateState, type CurateState } from './state.js';
import type { KbMutationEffects, KbRuntime } from '../contracts.js';
import { isCommunityEntry, type KbIndex } from '../entry-types.js';

export function isCommunitySummaryFresh(
  currentFingerprints: Readonly<Record<string, string>>,
  storedFingerprints: Readonly<Record<string, string>> | undefined,
): boolean {
  const currentEntries = Object.entries(currentFingerprints).sort(([left], [right]) => left.localeCompare(right));
  const storedEntries = Object.entries(storedFingerprints ?? {})
    .filter(([slug]) => slug in currentFingerprints)
    .sort(([left], [right]) => left.localeCompare(right));

  return (
    currentEntries.length === storedEntries.length &&
    currentEntries.every(
      ([slug, fingerprint], index) =>
        storedEntries[index]?.[0] === slug && storedEntries[index]?.[1] === fingerprint,
    )
  );
}

export function isCommunityStateFreshForIndex(
  state: Pick<CurateState, 'communityTopologyHash' | 'communitySummaryTopologyHash' | 'communitySummaryInputFingerprints'>,
  kb: Pick<KbRuntime, 'db' | 'notePath' | 'sourcePath'>,
  index: KbIndex,
): boolean {
  const communityEntries = Object.values(index.entries).filter(isCommunityEntry);
  if (communityEntries.length === 0) {
    return true;
  }

  const topologyHash = computeCommunityTopologyFingerprint(index);
  if (state.communityTopologyHash !== topologyHash || state.communitySummaryTopologyHash !== topologyHash) {
    return false;
  }

  try {
    const communities = communityEntries.map((community) => ({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
    }));
    const currentFingerprints = computeCommunitySummaryInputFingerprints(communities, kb, index);
    return isCommunitySummaryFresh(currentFingerprints, state.communitySummaryInputFingerprints);
  } catch {
    return false;
  }
}

export function areCommunityDocumentsFresh(
  kb: Pick<KbRuntime, 'db' | 'notePath' | 'sourcePath'>,
  index: KbIndex,
  state?: CurateState,
): boolean {
  // Avoid touching curate state when there are no community entries.
  const hasCommunityEntries = Object.values(index.entries).some(isCommunityEntry);
  if (!hasCommunityEntries) {
    return true;
  }
  return isCommunityStateFreshForIndex(state ?? readCurateState(kb), kb, index);
}

function normalizedCommunitySummaryFingerprints(
  fingerprints: Readonly<Record<string, string>> | undefined,
  communities: ReadonlyArray<{ slug: string }>,
): Record<string, string> | undefined {
  if (fingerprints === undefined) {
    return undefined;
  }

  const allowedSlugs = new Set(communities.map((community) => community.slug));
  const entries = Object.entries(fingerprints)
    .filter(([slug]) => allowedSlugs.has(slug))
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function prepareCommunityTopologyRefresh(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  index: KbIndex,
): {
  topologyHash: string;
  nextSummaryInputFingerprints: Record<string, string> | undefined;
  shouldPersistState: boolean;
} {
  const state = readCurateState(kb);
  const graph = buildEntityRelationshipGraph({
    entityMeta: index.entityMeta,
    relationships: index.relationships,
  });
  const topologyHash = computeCommunityTopologyFingerprint(index, graph);
  if (state.communityTopologyHash === topologyHash) {
    return {
      topologyHash,
      nextSummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
        state.communitySummaryInputFingerprints,
        Object.values(index.entries).filter(isCommunityEntry),
      ),
      shouldPersistState: false,
    };
  }

  const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);
  const communities = detectCommunities(graph, {
    priorCommunities: priorGeneratedCommunities,
    reservedSlugs,
  });
  const communityDocuments = buildCommunityDocuments(communities, {
    priorGeneratedCommunities,
    today: new Date().toISOString().slice(0, 10),
  });
  generateCommunityFiles(kb, mutation, communityDocuments, priorGeneratedCommunities);

  return {
    topologyHash,
    nextSummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
      state.communitySummaryInputFingerprints,
      communityDocuments,
    ),
    shouldPersistState: true,
  };
}
