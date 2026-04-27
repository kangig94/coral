import { readCurateState, writeCurateState } from '../state/index.js';
import { buildCorpusScanView } from '../../corpus/repair/corpus-scan.js';
import { projectIncidents } from '../../corpus/repair/project-incidents.js';
import { applyDetectedIncidentFixesLocked } from '../../corpus/repair/fix.js';
import { createGitSyncController } from '../git-sync.js';
import { deleteCurateRetryEntry, readCurateRetryQueue } from '../retry.js';
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

  constructor(message: string, counts: ReindexCounts) {
    super(message);
    this.name = 'TextSnapshotRebuildError';
    this.counts = counts;
  }
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
}> {
  const scan = buildCorpusScanView(kb);
  const notes = loadNotes(scan);
  const sources = loadSources(scan);
  const principles = loadPrinciples(scan);
  const rebuildInfo = detectTextArtifactRebuildInfo(kb, scan);
  const topologyIndex = buildKbIndex(kb, notes, sources, [], principles);
  const topologyRefresh = prepareCommunityTopologyRefresh(kb, mutation, topologyIndex);
  // Topology refresh may delete/regenerate community files on disk; re-scan the corpus to capture them.
  const communities = loadCommunities(buildCorpusScanView(kb));
  const index = buildKbIndex(kb, notes, sources, communities, principles);
  const counts = buildCounts(notes, sources, communities, principles, index);
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
    throw new TextSnapshotRebuildError(reason, counts);
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
  };
}

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 *
 * This rebuild path refreshes curate repair state and the JSON text artifact only.
 * Retrieval projections are owned by CorpusConsumers after the Corpus state commits.
 *
 * After the rebuild succeeds, runs the typed-detector pipeline against a fresh corpus
 * scan and dispatches each incident through `applyDetectedIncidentFixesLocked` (auto-fix
 * runs inline; manual cases enqueue typed rows on `kb_curate_retry_queue`).
 */
export async function rebuildTextArtifactsAndPersistRepairState(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<Awaited<ReturnType<typeof rebuildTextArtifacts>>> {
  const result = await rebuildTextArtifacts(kb, mutation, startState);
  await runTypedRepairPipelineLocked(kb, mutation);
  return result;
}

async function runTypedRepairPipelineLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
): Promise<void> {
  const incidents = projectIncidents(buildCorpusScanView(kb));

  // Sweep stale typed-incident rows: a queue entry whose entryId no longer appears
  // in the current incident set means the underlying file has been repaired.
  const stillDetected = new Set(incidents.map((incident) => incident.entryId));
  for (const queued of readCurateRetryQueue(kb.db)) {
    if (queued.canonicalIncident !== undefined && !stillDetected.has(queued.entryId)) {
      deleteCurateRetryEntry(kb.db, queued.entryId);
    }
  }

  if (incidents.length > 0) {
    const gitSync = createGitSyncController({
      kb,
      spawnCli: kb.spawnCli,
      processPort: kb.processPort,
      storagePort: kb.storagePort,
      envPort: kb.envPort,
    });
    await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, incidents);
  }

  // Re-persist CurateState so normalizeCurateStateRepairFrontier clamps scheduler progress
  // when pendingRepair surfaces a known frontier — preserving the pre-Phase-4 invariant that
  // discoveryHighSeq/discoveryOffset are clamped on disk, not just at read time.
  writeCurateState(kb, readCurateState(kb));
}
