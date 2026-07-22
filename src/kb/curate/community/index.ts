import { nowIsoString } from '../../../infra/time.js';
import { unlinkIfExists } from '../../../infra/fs-errors.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../contract.js';
import { compareLocale } from '../../validation.js';
import { buildCommunityPartitionTree } from './detection.js';
import { buildCommunityDocuments } from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import type { CommunityDocument, ExistingGeneratedCommunity } from './contracts.js';
import { readCurateState, writeCurateState } from '../state/index.js';
import { curateDb } from '../db-access.js';
import { readCurateConflictQuarantine } from '../conflict-quarantine.js';
import { buildCorpusScanViewInWorker } from '../../corpus/rescan/scan-worker.js';
import type { GeneratedCommunityProjectionCandidate } from './generated-projection-store.js';

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
  stagedGeneration: GeneratedCommunityProjectionCandidate | null;
  migratedGeneratedSlugs: Set<string>;
  quarantinedCommunitySlugs: Set<string>;
};

function generatedDocsMatchActive(
  activeRecords: readonly { readonly slug: string; readonly content: string }[],
  documents: readonly { readonly slug: string; readonly content: string }[],
): boolean {
  if (activeRecords.length !== documents.length) {
    return false;
  }
  const activeBySlug = new Map(activeRecords.map((record) => [record.slug, record.content]));
  for (const document of documents) {
    if (activeBySlug.get(document.slug) !== document.content) {
      return false;
    }
  }
  return true;
}

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
  const capturedScan = await buildCorpusScanViewInWorker(kb, { signal });
  const capturedFinalIndex = kb.readIndexOrEmpty();
  const graph = buildEntityRelationshipGraph({
    entityMeta: capturedFinalIndex.entityMeta,
    relationships: capturedFinalIndex.relationships,
  });
  const partitionTree = buildCommunityPartitionTree(graph);
  const activePriorCommunities: ExistingGeneratedCommunity[] = kb.generatedCommunityProjectionStore
    .readActiveGeneration()
    .records.map((record) => ({
      slug: record.slug,
      title: record.title,
      level: record.level,
      members: [...record.members],
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(record.children === undefined ? {} : { children: [...record.children] }),
      ...(record.summary === undefined ? {} : { summary: record.summary }),
      ...(record.summaryInputFingerprint === undefined
        ? {}
        : { summaryInputFingerprint: record.summaryInputFingerprint }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  const unreservedDetectedCommunities = partitionTree.detect({
    priorCommunities: activePriorCommunities,
    reservedSlugs: new Set(),
  });
  const existingCommunityState = kb.generatedCommunityProjectionStore.loadExistingCommunityState({
    communityFiles: capturedScan.markdownFiles.filter((file) => file.kind === 'community'),
    detectedCommunities: unreservedDetectedCommunities,
  });
  const { generated: priorGeneratedCommunities, reservedSlugs } = existingCommunityState;
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
  const activeGenerated = kb.generatedCommunityProjectionStore.readActiveGeneration();
  const shouldStage =
    activeGenerated.topologyHash !== partitionTree.computeTopologyFingerprint() ||
    !generatedDocsMatchActive(activeGenerated.records, generatedCommunityDocs) ||
    existingCommunityState.migratedGeneratedSlugs.size > 0;
  const stagedGeneration = shouldStage
    ? kb.generatedCommunityProjectionStore.stageGeneration({
        snapshot: capturedBaselineSnapshot,
        topologyHash: partitionTree.computeTopologyFingerprint(),
        documents: generatedCommunityDocs,
      })
    : null;

  return {
    capturedBaselineSnapshot,
    capturedBaselineState,
    priorGeneratedCommunities,
    reservedSlugs,
    generatedCommunityDocs,
    stagedGeneration,
    migratedGeneratedSlugs: existingCommunityState.migratedGeneratedSlugs,
    quarantinedCommunitySlugs,
  };
}

export async function runCommunitySubphase(kb: KbRuntime, options: RunCommunitySubphaseOptions = {}): Promise<boolean> {
  const prepared = await prepareCommunityPayload(kb, options);
  if (prepared === null) {
    return false;
  }

  const { signal, shouldStop = () => false, onFreshnessMismatch } = options;
  let adoptedGeneratedProjection = false;

  try {
    await kb.withMutationLock(async (mutation) => {
      void mutation;
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

      if (prepared.stagedGeneration !== null) {
        const result = kb.generatedCommunityProjectionStore.adoptStagedGeneration(
          prepared.stagedGeneration,
          currentSnapshot,
        );
        if (result.status === 'discarded') {
          onFreshnessMismatch?.();
          return;
        }
        for (const slug of prepared.migratedGeneratedSlugs) {
          unlinkIfExists(kb.communityPath(slug));
        }
        kb.invalidateTextSnapshot('generated-community-projection');
        kb.publishGeneratedCommunityProjection({
          snapshot: currentSnapshot,
          generatedCommunityGeneration: result.generation,
          generatedCommunityDocsHash: result.generatedCommunityDocsHash,
        });
        adoptedGeneratedProjection = true;
      }
      if (shouldWriteState) {
        writeCurateState(curateDb(kb), nextState);
      }
    });
  } finally {
    if (!adoptedGeneratedProjection && prepared.stagedGeneration !== null) {
      kb.generatedCommunityProjectionStore.discardStagedGeneration(prepared.stagedGeneration);
    }
  }

  return adoptedGeneratedProjection;
}
