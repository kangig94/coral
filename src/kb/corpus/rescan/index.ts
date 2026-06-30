import { writeCurateState, readCurateState } from '../../curate/state/index.js';
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
import type { KbIndexState, KbRuntime } from '../../contract.js';
import type { DetectedIncident } from './incidents/catalog.js';
import { curateDb } from '../../curate/db-access.js';
import { indexStateMatchesSnapshot } from '../lanes.js';
import type {
  CorpusProjectionCandidate,
  CorpusProjectionCommitResult,
  CorpusProjectionFaultInjection,
  CorpusProjectionSeq,
  RescanCounts,
  StagedCorpusProjection,
} from '../projection-lifecycle.js';

export type { RescanCounts } from '../projection-lifecycle.js';

export async function deriveCorpusProjection(
  kb: KbRuntime,
  startState: CorpusProjectionSeq,
  options: { signal?: AbortSignal } = {},
): Promise<CorpusProjectionCandidate> {
  const { signal } = options;
  if (signal !== undefined) {
    throwIfAborted(signal, 'scan');
  }

  const initialScan = await buildCorpusScanViewInWorker(kb, { signal });
  const notes = loadNotes(initialScan);
  const sources = loadSources(initialScan);
  const wikis = loadWikis(initialScan);
  const principles = loadPrinciples(initialScan);
  const rebuildInfo = await detectRescanInfo(kb, initialScan);
  const activeGeneratedCommunities = kb.generatedCommunityProjectionStore.readActiveGeneration();

  const finalSurface = buildCorpusSurface(initialScan);
  const communities = loadCommunities(initialScan);
  const index = buildKbIndex(initialScan, notes, sources, communities, wikis, principles, {
    generatedCommunityDocuments: activeGeneratedCommunities.records,
    generatedCommunityFreshness: {
      generatedCommunityGeneration: activeGeneratedCommunities.generatedCommunityGeneration,
      generatedCommunityDocsHash: activeGeneratedCommunities.generatedCommunityDocsHash,
    },
  });

  const incidents = projectIncidents(initialScan);
  return {
    startSeq: startState,
    priorGeneratedGeneration: activeGeneratedCommunities.generatedCommunityGeneration,
    priorGeneratedDocsHash: activeGeneratedCommunities.generatedCommunityDocsHash,
    index,
    finalSurface,
    incidents,
    ...(rebuildInfo.externalMutation === undefined ? {} : { externalMutation: rebuildInfo.externalMutation }),
    counts: buildCounts(notes, sources, communities, wikis, principles, index),
  };
}

export function stageCorpusProjectionArtifacts(
  kb: KbRuntime,
  candidate: CorpusProjectionCandidate,
): StagedCorpusProjection {
  return kb.stageCorpusProjectionArtifacts(candidate);
}

export async function commitCorpusProjection(
  kb: KbRuntime,
  staged: StagedCorpusProjection,
  options: { faultInjection?: CorpusProjectionFaultInjection } = {},
): Promise<CorpusProjectionCommitResult> {
  return kb.commitCorpusProjection(staged, options);
}

/**
 * Single-attempt corpus projection rebuild: derive and stage off-lock, then
 * attempt a short seq+generated-generation CAS commit under the mutation lock.
 * Discarded candidates perform no retry-queue, curate-state, or incident-fix
 * side effects.
 */
export async function performRescan(
  kb: KbRuntime,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
  options: { signal?: AbortSignal; faultInjection?: CorpusProjectionFaultInjection } = {},
): Promise<CorpusProjectionCommitResult> {
  const candidate = await deriveCorpusProjection(kb, startState, options);
  const staged = stageCorpusProjectionArtifacts(kb, candidate);
  const result = await commitCorpusProjection(kb, staged, options);
  if (result.status === 'committed') {
    await runCommittedProjectionSideEffects(kb, candidate, result, options);
  }
  return result;
}

async function runCommittedProjectionSideEffects(
  kb: KbRuntime,
  candidate: CorpusProjectionCandidate,
  result: Extract<CorpusProjectionCommitResult, { readonly status: 'committed' }>,
  options: { signal?: AbortSignal },
): Promise<void> {
  await applyCommittedProjectionQueueSideEffects(kb, candidate, result.state);
  for (const incident of candidate.incidents) {
    if (options.signal !== undefined) {
      throwIfAborted(options.signal, 'repair');
    }
    await applyDetectedIncidentFixForCommittedProjection(kb, incident, result.state);
  }
}

async function applyCommittedProjectionQueueSideEffects(
  kb: KbRuntime,
  candidate: CorpusProjectionCandidate,
  committedState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<void> {
  await kb.withMutationLock(() => {
    if (!indexStateMatchesSnapshot(kb.readIndexState(), committedState)) {
      return;
    }
    syncRetryQueueAgainstIncidents(kb, candidate.incidents);

    // Re-persist CurateState so normalizeCurateStateRepairFrontier clamps scheduler progress
    // when the retry queue surfaces a known frontier — preserving the invariant that
    // discoveryHighSeq/discoveryOffset are clamped on disk, not just at read time.
    writeCurateState(curateDb(kb), readCurateState(curateDb(kb)));
  });
}

async function applyDetectedIncidentFixForCommittedProjection(
  kb: KbRuntime,
  incident: DetectedIncident,
  committedState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<void> {
  await kb.withMutationLock(async (mutation, { signal }) => {
    if (!indexStateMatchesSnapshot(kb.readIndexState(), committedState)) {
      return;
    }
    throwIfAborted(signal, 'repair');
    const gitSync = createGitSyncController({
      kb,
      curateAssistant: kb.curateAssistant,
      processPort: kb.processPort,
      storagePort: kb.storagePort,
      envPort: kb.envPort,
    });
    await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, [incident]);
  });
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
