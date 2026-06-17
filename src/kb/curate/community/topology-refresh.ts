import { buildCommunityPartitionTree } from './detection.js';
import { buildCommunityDocuments, generateCommunityFiles, loadExistingCommunityState } from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import { readCurateState } from '../state/index.js';
import type { KbMutationEffects, KbRuntime } from '../../contract.js';
import { isCommunityEntry, type CommunityEntry, type KbIndex } from '../../entry-types.js';
import { nowIsoString } from '../../../infra/time.js';
import { curateDb } from '../db-access.js';

export function normalizedCommunitySummaryFingerprints(
  fingerprints: Readonly<Record<string, string>> | undefined,
  communities: ReadonlyArray<{ slug: string }>,
): Record<string, string> | undefined {
  if (fingerprints === undefined) {
    return undefined;
  }

  const allowedSlugs = new Set<string>();
  for (const community of communities) {
    allowedSlugs.add(community.slug);
  }
  const entries: Array<[string, string]> = [];
  for (const [slug, fingerprint] of Object.entries(fingerprints)) {
    if (allowedSlugs.has(slug)) {
      entries.push([slug, fingerprint]);
    }
  }
  entries.sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [slug, fingerprint] of entries) {
    normalized[slug] = fingerprint;
  }
  return normalized;
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
  const partitionTree = buildCommunityPartitionTree(graph);
  const topologyHash = partitionTree.computeTopologyFingerprint();
  if (state.communitySummaryTopologyHash === topologyHash) {
    const communityEntries: CommunityEntry[] = [];
    for (const entry of Object.values(index.entries)) {
      if (isCommunityEntry(entry)) {
        communityEntries.push(entry);
      }
    }

    return {
      topologyHash,
      nextSummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
        state.communitySummaryInputFingerprints,
        communityEntries,
      ),
      shouldPersistState: false,
    };
  }

  const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);
  const communities = partitionTree.detect({
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
