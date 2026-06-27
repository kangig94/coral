import { nowIsoString } from '../../../infra/time.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../contract.js';
import { recordMetadataMutation } from '../../corpus/index/mutations.js';
import { compareLocale } from '../../validation.js';
import { buildCommunityPartitionTree } from './detection.js';
import { buildCommunityDocuments, generateCommunityFiles, loadExistingCommunityState } from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import type { CommunityDocument, ExistingGeneratedCommunity } from './contracts.js';
import { CURATE_STALE_REASON } from '../operations.js';
import { readCurateState, writeCurateState } from '../state/index.js';
import { curateDb } from '../db-access.js';
import { readCurateConflictQuarantine } from '../conflict-quarantine.js';

export type RunCommunitySubphaseOptions = {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  onFreshnessMismatch?: () => void;
};

type CommunityPreparedPayload = {
  capturedBaselineSnapshot: KbCorpusSnapshot;
  capturedBaselineState: ReturnType<typeof readCurateState>;
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  reservedSlugs: Set<string>;
  generatedCommunityDocs: CommunityDocument[];
  quarantinedCommunitySlugs: Set<string>;
};

function sameSnapshot(left: KbCorpusSnapshot, right: KbCorpusSnapshot): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    left.contentManifestHash === right.contentManifestHash &&
    left.metadataManifestHash === right.metadataManifestHash
  );
}

// Topology materialization only — does NOT summarize. New or changed communities
// are written carrying their prior summary + fingerprint (or absent if new).
// Stale summaries are detected later by listStaleCommunities() and filled by the
// community-summary agent. The old fingerprint must NOT be refreshed here: if
// members changed, the doc must keep the OLD fingerprint so listStaleCommunities
// correctly detects the mismatch on the next agent run.
async function prepareCommunityPayload(
  kb: KbRuntime,
  options: RunCommunitySubphaseOptions,
): Promise<CommunityPreparedPayload | null> {
  const { signal, shouldStop = () => false } = options;
  if (shouldStop() || signal?.aborted) {
    return null;
  }

  const today = nowIsoString(kb.time).slice(0, 10);
  const capturedBaselineSnapshot = kb.captureCorpusSnapshot();
  const capturedBaselineState = readCurateState(curateDb(kb));
  const capturedFinalIndex = kb.readIndexOrEmpty();
  const graph = buildEntityRelationshipGraph({
    entityMeta: capturedFinalIndex.entityMeta,
    relationships: capturedFinalIndex.relationships,
  });
  const partitionTree = buildCommunityPartitionTree(graph);
  const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);
  const quarantinedCommunitySlugs = new Set<string>();
  for (const entry of readCurateConflictQuarantine(curateDb(kb))) {
    if (entry.kind === 'community') {
      quarantinedCommunitySlugs.add(entry.slug);
    }
  }

  const detectedCommunities = partitionTree.detect({
    priorCommunities: priorGeneratedCommunities,
    reservedSlugs,
  });
  const initialCommunityDocs = buildCommunityDocuments(detectedCommunities, {
    priorGeneratedCommunities,
    today,
  });

  // Write every non-quarantined community carrying its prior summary + fingerprint.
  // If a community is new or its members changed, it has no/stale fingerprint and
  // will appear in listStaleCommunities() for the agent to fill.
  const generatedCommunityDocs: CommunityDocument[] = initialCommunityDocs
    .filter((d) => !quarantinedCommunitySlugs.has(d.slug))
    .sort((left, right) => compareLocale(left.slug, right.slug));

  return {
    capturedBaselineSnapshot,
    capturedBaselineState,
    priorGeneratedCommunities,
    reservedSlugs,
    generatedCommunityDocs,
    quarantinedCommunitySlugs,
  };
}

export async function runCommunitySubphase(kb: KbRuntime, options: RunCommunitySubphaseOptions = {}): Promise<boolean> {
  const prepared = await prepareCommunityPayload(kb, options);
  if (prepared === null) {
    return false;
  }

  const { signal, shouldStop = () => false, onFreshnessMismatch } = options;
  let wroteCommunityFiles = false;

  await kb.withMutationLock(async (mutation) => {
    if (shouldStop() || signal?.aborted) {
      return;
    }

    const currentSnapshot = kb.captureCorpusSnapshot();
    if (!sameSnapshot(prepared.capturedBaselineSnapshot, currentSnapshot)) {
      onFreshnessMismatch?.();
      return;
    }

    const nextState = {
      ...prepared.capturedBaselineState,
      consecutiveCommunityBatchFailures: 0,
      // A successful community batch implicitly clears the lane-disabled stamp
      // (the lane was unblocked); see scheduler.ts INVARIANT.MAX_CONSECUTIVE_FAILURES.
      communityBatchLaneDisabledAt: null,
    };
    const shouldWriteState =
      prepared.capturedBaselineState.consecutiveCommunityBatchFailures !== 0 ||
      prepared.capturedBaselineState.communityBatchLaneDisabledAt !== null;

    const writablePriorCommunities = prepared.priorGeneratedCommunities.filter(
      (community) => !prepared.quarantinedCommunitySlugs.has(community.slug),
    );
    if (generateCommunityFiles(kb, mutation, prepared.generatedCommunityDocs, writablePriorCommunities)) {
      wroteCommunityFiles = true;
    }
    if (shouldWriteState) {
      writeCurateState(curateDb(kb), nextState);
    }

    if (wroteCommunityFiles || shouldWriteState) {
      recordMetadataMutation(kb, CURATE_STALE_REASON);
    }
  });

  return wroteCommunityFiles;
}
