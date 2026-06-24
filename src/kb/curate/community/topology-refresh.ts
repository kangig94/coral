import { buildCommunityPartitionTree } from './detection.js';
import { buildCommunityDocuments, generateCommunityFiles, loadExistingCommunityState } from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import { readCurateState } from '../state/index.js';
import type { KbMutationEffects, KbRuntime } from '../../contract.js';
import type { KbIndex } from '../../entry-types.js';
import { nowIsoString } from '../../../infra/time.js';
import { curateDb } from '../db-access.js';

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
    return {
      topologyHash,
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
    shouldPersistState: true,
  };
}
