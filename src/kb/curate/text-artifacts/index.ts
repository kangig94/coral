import { readCurateState, writeCurateState, type PendingRepair } from '../state/index.js';
import { buildCorpusScanView } from '../../corpus/repair/corpus-scan.js';
import { applyLaneMutation, detectTextArtifactRebuildInfo } from './drift.js';
import {
  prepareCommunityTopologyRefresh,
} from './community.js';
import {
  buildCounts,
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
} from './loaders.js';
import type { KbIndexState, KbMutationEffects, KbRuntime } from '../../contract.js';
import { nowIsoString } from '../../../infra/time.js';
import type {
  KbReindexCommunityRecord,
  KbReindexNoteRecord,
  KbReindexSourceRecord,
  ReindexResult,
} from '../../entry-types.js';

export { areCommunityDocumentsFresh } from './community.js';
export { detectTextArtifactRebuildInfo } from './drift.js';
export { loadCommunities } from './loaders.js';

type ReindexCounts = Pick<
  ReindexResult,
  'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
>;

export class TextSnapshotRebuildError extends Error {
  readonly counts: ReindexCounts;
  readonly pendingRepair: PendingRepair[] | null;

  constructor(message: string, counts: ReindexCounts, pendingRepair: PendingRepair[] | null) {
    super(message);
    this.name = 'TextSnapshotRebuildError';
    this.counts = counts;
    this.pendingRepair = pendingRepair;
  }
}

function persistPendingRepair(kb: KbRuntime, pendingRepair: PendingRepair[] | null): void {
  const state = readCurateState(kb);
  writeCurateState(kb, {
    ...state,
    pendingRepair,
  });
}

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 */
export async function rebuildTextArtifacts(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<{
  notes: KbReindexNoteRecord[];
  sources: KbReindexSourceRecord[];
  communities: KbReindexCommunityRecord[];
  principles: Array<[string, string]>;
  counts: ReindexCounts;
  pendingRepair: PendingRepair[] | null;
}> {
  const detectedAt = nowIsoString(kb.time);
  const scan = buildCorpusScanView(kb);
  const { entries: notes, pendingRepair: malformedNotes } = loadNotes(scan, detectedAt);
  const { entries: sources, pendingRepair: malformedSources } = loadSources(scan, detectedAt);
  const principles = loadPrinciples(scan);
  const pendingRepair = [...malformedNotes, ...malformedSources];
  const rebuildInfo = detectTextArtifactRebuildInfo(kb, scan);
  const topologyIndex = buildKbIndex(kb, notes, sources, [], principles);
  const topologyRefresh = prepareCommunityTopologyRefresh(kb, mutation, topologyIndex);
  // Topology refresh may delete/regenerate community files on disk; re-scan the corpus to capture them.
  const communities = loadCommunities(buildCorpusScanView(kb));
  const index = buildKbIndex(kb, notes, sources, communities, principles);
  const counts = buildCounts(notes, sources, communities, principles, index);
  const pendingRepairState = pendingRepair.length === 0 ? null : pendingRepair;
  kb.writeIndex(index);

  const nextState = kb.recordReindexSuccess(startState, rebuildInfo.externalMutation);
  const expectedState = applyLaneMutation(startState, rebuildInfo.externalMutation);
  if (
    nextState.contentSeq !== expectedState.contentSeq ||
    nextState.metadataSeq !== expectedState.metadataSeq ||
    nextState.textStaleReason !== undefined
  ) {
    const reason = 'KB text index freshness changed during rebuild.';
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts, pendingRepairState);
  }

  if (topologyRefresh.shouldPersistState) {
    const currentState = readCurateState(kb);
    writeCurateState(kb, {
      ...currentState,
      communityTopologyHash: topologyRefresh.topologyHash,
      communitySummaryTopologyHash: topologyRefresh.topologyHash,
      communitySummaryInputFingerprints: topologyRefresh.nextSummaryInputFingerprints,
    });
  }

  return {
    notes,
    sources,
    communities,
    principles,
    counts,
    pendingRepair: pendingRepairState,
  };
}

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 *
 * This rebuild path refreshes curate repair state and the JSON text artifact only.
 * Retrieval projections are owned by CorpusConsumers after the Corpus state commits.
 */
export async function rebuildTextArtifactsAndPersistRepairState(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<Awaited<ReturnType<typeof rebuildTextArtifacts>>> {
  try {
    const result = await rebuildTextArtifacts(kb, mutation, startState);
    persistPendingRepair(kb, result.pendingRepair);
    return result;
  } catch (error: unknown) {
    if (error instanceof TextSnapshotRebuildError) {
      persistPendingRepair(kb, error.pendingRepair);
    }
    throw error;
  }
}
