import { readCurateState, writeCurateState } from '../../curate/state/index.js';
import { prepareCommunityTopologyRefresh } from '../../curate/community/topology-refresh.js';
import { createGitSyncController } from '../../curate/git-sync.js';
import { deleteCurateRetryEntry, readCurateRetryQueue } from '../../curate/retry.js';
import { throwIfAborted } from '../../../runtime/abort.js';
import { applyDetectedIncidentFixesLocked } from './auto-fix.js';
import { detectRescanInfo } from './drift.js';
import {
  buildCounts,
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
  loadWikis,
  projectIncidents,
} from './projections.js';
import { buildCorpusScanViewInWorker } from './scan-worker.js';
import { buildCorpusSurface } from '../surface.js';
import type { KbIndexState, KbMutationEffects, KbRuntime } from '../../contract.js';
import type { ReindexResult } from '../../entry-types.js';
import type { DetectedIncident } from './incidents/catalog.js';
import { curateDb } from '../../curate/db-access.js';

export type RescanCounts = Pick<
  ReindexResult,
  | 'notes'
  | 'sources'
  | 'communities'
  | 'wikis'
  | 'principles'
  | 'tags'
  | 'entities'
  | 'relationships'
  | 'entityCoverage'
>;

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 *
 * Single-shot rescan: scans the corpus, refreshes derived community topology, projects
 * a fresh `KbIndex` plus typed incidents, applies auto-fixes (manual incidents enqueue),
 * and bumps the freshness state. Either commits the whole rescan or throws — partial
 * state cannot escape under the lock.
 *
 * `signal` is the composed mutation-lock callback signal (caller signal + internal
 * deadline). Honored at named checkpoints — `'scan'` before the corpus scan and
 * `'repair'` before incident auto-fix — so a user `coral-cli abort` lands at a
 * deterministic boundary instead of mid-scan. The corpus scan runs in a worker so
 * aborting the signal can terminate file traversal/read work without keeping the
 * daemon event loop stuck on synchronous filesystem calls.
 */
export async function performRescan(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
  options: { signal?: AbortSignal } = {},
): Promise<RescanCounts> {
  const { signal } = options;
  if (signal !== undefined) {
    throwIfAborted(signal, 'scan');
  }

  const initialScan = await buildCorpusScanViewInWorker(kb, { signal });
  const notes = loadNotes(initialScan);
  const sources = loadSources(initialScan);
  const initialWikis = loadWikis(initialScan);
  const principles = loadPrinciples(initialScan);
  const rebuildInfo = await detectRescanInfo(kb, initialScan);

  // Topology refresh may rewrite community files on disk; rescan once afterwards
  // so the projected index reflects the regenerated communities.
  const topologyIndex = buildKbIndex(initialScan, notes, sources, [], initialWikis, principles);
  const topologyRefresh = prepareCommunityTopologyRefresh(kb, mutation, topologyIndex);
  const finalScan = await buildCorpusScanViewInWorker(kb, { signal });
  const finalSurface = buildCorpusSurface(finalScan);
  const communities = loadCommunities(finalScan);
  const wikis = loadWikis(finalScan);
  const index = buildKbIndex(finalScan, notes, sources, communities, wikis, principles);

  kb.writeIndex(index);
  kb.recordReindexSuccess(startState, rebuildInfo.externalMutation ?? undefined, finalSurface);

  if (topologyRefresh.shouldPersistState) {
    const currentState = readCurateState(curateDb(kb));
    writeCurateState(curateDb(kb), {
      ...currentState,
      communitySummaryTopologyHash: topologyRefresh.topologyHash,
    });
  }

  const incidents = projectIncidents(finalScan);
  syncRetryQueueAgainstIncidents(kb, incidents);
  if (incidents.length > 0) {
    if (signal !== undefined) {
      throwIfAborted(signal, 'repair');
    }
    const gitSync = createGitSyncController({
      kb,
      curateAssistant: kb.curateAssistant,
      processPort: kb.processPort,
      storagePort: kb.storagePort,
      envPort: kb.envPort,
    });
    await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, incidents);
  }

  // Re-persist CurateState so normalizeCurateStateRepairFrontier clamps scheduler progress
  // when the retry queue surfaces a known frontier — preserving the invariant that
  // discoveryHighSeq/discoveryOffset are clamped on disk, not just at read time.
  writeCurateState(curateDb(kb), readCurateState(curateDb(kb)));

  return buildCounts(notes, sources, communities, wikis, principles, index);
}

/**
 * Sweeps stale typed-incident rows: a queue entry whose entryId no longer appears in
 * the current incident set means the underlying file has been repaired since enqueue.
 */
function syncRetryQueueAgainstIncidents(kb: KbRuntime, incidents: readonly DetectedIncident[]): void {
  const stillDetected = new Set<string>();
  for (const incident of incidents) {
    stillDetected.add(incident.entryId);
  }
  for (const queued of readCurateRetryQueue(curateDb(kb))) {
    if (queued.canonicalIncident !== undefined && !stillDetected.has(queued.entryId)) {
      deleteCurateRetryEntry(curateDb(kb), queued.entryId);
    }
  }
}
