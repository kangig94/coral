import { computeCommunityTopologyFingerprint, detectCommunities } from './detection.js';
import { buildCommunityDocuments, generateCommunityFiles, loadExistingCommunityState } from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import { readCurateState } from '../state/index.js';
import type { KbMutationEffects, KbRuntime } from '../../contract.js';
import { isCommunityEntry, type KbIndex } from '../../entry-types.js';
import { nowIsoString } from '../../../infra/time.js';
import { curateDb } from '../db-access.js';

export function normalizedCommunitySummaryFingerprints(
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

/**
 * @precondition Caller already holds `kb.withMutationLock()` and supplies the `mutation`
 * context captured by that lock. `generateCommunityFiles` writes corpus markdown via the
 * mutation context, so the function MUST run under the rescan-held lock.
 */
export function prepareCommunityTopologyRefresh(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  index: KbIndex,
): {
  topologyHash: string;
  nextSummaryInputFingerprints: Record<string, string> | undefined;
  shouldPersistState: boolean;
} {
  const state = readCurateState(curateDb(kb));
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
    today: nowIsoString(kb.time).slice(0, 10),
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
