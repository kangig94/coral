import { readCurateState, writeCurateState } from '../../curate/state/index.js';
import { prepareCommunityTopologyRefresh } from '../../curate/community/topology-refresh.js';
import { createGitSyncController } from '../../curate/git-sync.js';
import { deleteCurateRetryEntry, readCurateRetryQueue } from '../../curate/retry.js';
import { applyDetectedIncidentFixesLocked } from './auto-fix.js';
import { detectRescanInfo } from './drift.js';
import {
  buildCounts,
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
  projectIncidents,
} from './projections.js';
import { buildCorpusScanView } from './scan.js';
import type { KbIndexState, KbMutationEffects, KbRuntime } from '../../contract.js';
import type { ReindexResult } from '../../entry-types.js';
import type { DetectedIncident } from './incidents/catalog.js';

export type RescanCounts = Pick<
  ReindexResult,
  'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
>;

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 *
 * Single-shot rescan: scans the corpus, refreshes derived community topology, projects
 * a fresh `KbIndex` plus typed incidents, applies auto-fixes (manual incidents enqueue),
 * and bumps the freshness state. Either commits the whole rescan or throws — partial
 * state cannot escape under the lock.
 */
export async function performRescan(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<RescanCounts> {
  const initialScan = buildCorpusScanView(kb);
  const notes = loadNotes(initialScan);
  const sources = loadSources(initialScan);
  const principles = loadPrinciples(initialScan);
  const rebuildInfo = detectRescanInfo(kb, initialScan);

  // Topology refresh may rewrite community files on disk; rescan once afterwards
  // so the projected index reflects the regenerated communities.
  const topologyIndex = buildKbIndex(initialScan, notes, sources, [], principles);
  const topologyRefresh = prepareCommunityTopologyRefresh(kb, mutation, topologyIndex);
  const finalScan = buildCorpusScanView(kb);
  const communities = loadCommunities(finalScan);
  const index = buildKbIndex(finalScan, notes, sources, communities, principles);

  kb.writeIndex(index);
  kb.recordReindexSuccess(startState, rebuildInfo.externalMutation);

  if (topologyRefresh.shouldPersistState) {
    const currentState = readCurateState(kb);
    writeCurateState(kb, {
      ...currentState,
      communityTopologyHash: topologyRefresh.topologyHash,
      communitySummaryTopologyHash: topologyRefresh.topologyHash,
      communitySummaryInputFingerprints: topologyRefresh.nextSummaryInputFingerprints,
    });
  }

  const incidents = projectIncidents(finalScan);
  syncRetryQueueAgainstIncidents(kb, incidents);
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
  // when the retry queue surfaces a known frontier — preserving the invariant that
  // discoveryHighSeq/discoveryOffset are clamped on disk, not just at read time.
  writeCurateState(kb, readCurateState(kb));

  return buildCounts(notes, sources, communities, principles, index);
}

/**
 * Sweeps stale typed-incident rows: a queue entry whose entryId no longer appears in
 * the current incident set means the underlying file has been repaired since enqueue.
 */
function syncRetryQueueAgainstIncidents(
  kb: KbRuntime,
  incidents: readonly DetectedIncident[],
): void {
  const stillDetected = new Set(incidents.map((incident) => incident.entryId));
  for (const queued of readCurateRetryQueue(kb.db)) {
    if (queued.canonicalIncident !== undefined && !stillDetected.has(queued.entryId)) {
      deleteCurateRetryEntry(kb.db, queued.entryId);
    }
  }
}
