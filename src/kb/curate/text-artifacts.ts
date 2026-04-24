import { insertMultiple } from '@orama/orama';
import { errorMessage } from '../../infra/error-format.js';
import { readCurateState, writeCurateState, type PendingRepair } from './state.js';
import { applyLaneMutation, detectTextArtifactRebuildInfo } from './text-artifacts-drift.js';
import {
  areCommunityDocumentsFresh,
  isCommunityStateFreshForIndex,
  isCommunitySummaryFresh,
  prepareCommunityTopologyRefresh,
} from './text-artifacts-community.js';
import {
  buildCounts,
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
} from './text-artifacts-loaders.js';
import { createOramaDb, toOramaDocument } from '../orama-factory.js';
import type { KbIndexState, KbMutationEffects, KbRuntime } from '../contracts.js';
import type {
  KbReindexCommunityRecord,
  KbReindexNoteRecord,
  KbReindexSourceRecord,
  ReindexResult,
} from '../entry-types.js';

export { areCommunityDocumentsFresh, isCommunitySummaryFresh } from './text-artifacts-community.js';
export { detectTextArtifactRebuildInfo } from './text-artifacts-drift.js';
export { loadCommunities } from './text-artifacts-loaders.js';

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
  const detectedAt = new Date().toISOString();
  const { entries: notes, pendingRepair: malformedNotes } = loadNotes(kb, detectedAt);
  const { entries: sources, pendingRepair: malformedSources } = loadSources(kb, detectedAt);
  const principles = loadPrinciples(kb);
  const pendingRepair = [...malformedNotes, ...malformedSources];
  const rebuildInfo = detectTextArtifactRebuildInfo(kb);
  const topologyIndex = buildKbIndex(kb, notes, sources, [], principles);
  const topologyRefresh = prepareCommunityTopologyRefresh(kb, mutation, topologyIndex);
  const communities = loadCommunities(kb);
  const index = buildKbIndex(kb, notes, sources, communities, principles);
  const counts = buildCounts(notes, sources, communities, principles, index);
  const pendingRepairState = pendingRepair.length === 0 ? null : pendingRepair;
  const curateState = readCurateState(kb);
  const projectedCommunityState = topologyRefresh.shouldPersistState
    ? {
        ...curateState,
        communityTopologyHash: topologyRefresh.topologyHash,
        communitySummaryTopologyHash: topologyRefresh.topologyHash,
        communitySummaryInputFingerprints: topologyRefresh.nextSummaryInputFingerprints,
      }
    : curateState;
  const communityFresh = isCommunityStateFreshForIndex(projectedCommunityState, kb, index);
  const { db, tokenizer } = await createOramaDb();

  await insertMultiple(db, [
    ...notes.map((note) => toOramaDocument(note)),
    ...sources.map((source) => toOramaDocument(source)),
    ...communities.map((community) => toOramaDocument(community, { communityFresh })),
  ]);
  kb.persistIndexToDisk(index);

  try {
    kb.persistOramaSnapshot(db);
  } catch (error: unknown) {
    const reason = `KB text index rebuild failed: ${errorMessage(error)}`;
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts, pendingRepairState);
  }

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

  kb.installRebuiltArtifacts(index, { db, tokenizer });

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
 * This rebuild path still refreshes curate repair state
 * in addition to rebuilding the base projection. AC4 write-lock installers use
 * `OramaBaseProjection.installFullSnapshotInWriteLock()` instead so lock-held delta/full installs stay
 * pure and do not regenerate repair or curate side effects.
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
