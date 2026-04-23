import type {
  CurateActiveClaimRow,
  CurateCommunitySummaryInputFingerprintRow,
} from '../../store/schema.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import {
  replaceFrontmatter,
  replaceSourceFrontmatter,
} from '../corpus/frontmatter.js';
import { sortedMarkdownEntries } from '../corpus/markdown-entries.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex } from '../corpus/index-records.js';
import { stripMdExt } from '../paths.js';
import { loadKbNote, loadKbSource } from '../read.js';
import type { KbIndexState, KbRuntime } from '../contracts.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type KbIndex,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from '../entry-types.js';
import { parsePositiveInteger } from '../validation.js';
import { readCurateDiscoveryBacklog, syncCurateDiscoveryBacklog } from './discovery-backlog.js';
import { readCurateRetryQueue, syncCurateRetryQueue } from './retry.js';
import {
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  CURATE_STATE_MIGRATION_VERSION,
  compareCursor,
  compareOptionalCursor,
  cursorEntryKind,
  defaultCurateState,
  extractMalformedEntryRepair,
  getCurateRepairFrontier,
  isClaimStale,
  kbEntryIdSchema,
  normalizeCurateStateRepairFrontier,
  noteCursor,
  readMalformedEntryRepair,
  resetCurateStateForBackfill,
  sameStringList,
  type CurateCursor,
  type CurateRepairFrontier,
  type CurateState,
  type PendingDiscovery,
  type PendingRepair,
} from './state-model.js';
import {
  prepareCached,
  resolveSqliteDb,
} from './sqlite.js';
import { readCurateSchedulerState, writeCurateSchedulerState } from './state-scheduler.js';

type CurateStateTarget = Pick<KbRuntime, 'db'>;
type CurateStateRuntime = Pick<
  KbRuntime,
  | 'db'
  | 'runtimeDir'
  | 'notesDir'
  | 'notePath'
  | 'sourcesDir'
  | 'sourcePath'
  | 'withMutationLock'
  | 'readIndex'
  | 'writeIndex'
  | 'readIndexState'
  | 'writeIndexState'
>;

export type ScannedNote = {
  note: string;
  path: string;
  content: string;
  title: string;
  frontmatter: KbNoteFrontmatter;
};

export type ScannedSource = {
  slug: string;
  path: string;
  content: string;
  frontmatter: KbSourceFrontmatter;
};

export type CurateMigrationScanFailure = {
  kind: 'note' | 'source';
  name: string;
  path: string;
  error: unknown;
};

export type CurateMigrationScan = {
  scannedNotes: ScannedNote[];
  scannedSources: ScannedSource[];
  scanFailures: CurateMigrationScanFailure[];
  detectedAt: string;
};

export type CurateMigrationAssignment = {
  highestAssignedEntrySeq: number;
  rewrittenNotes: ScannedNote[];
  rewrittenSources: ScannedSource[];
};

function readActiveClaim(target: CurateStateTarget): CurateState['activeClaim'] {
  const row = prepareCached<[], CurateActiveClaimRow | undefined>(
    target,
    `SELECT id, through_seq, through_entry_id, through_entry_kind, started_at
       FROM curate_active_claim
      WHERE id = 1`,
  ).get();
  if (row === undefined) {
    return null;
  }

  const through = {
    entryId: kbEntryIdSchema.parse(row.through_entry_id),
    entrySeq: parsePositiveInteger(row.through_seq, 'curate_active_claim.through_seq'),
  };
  if (cursorEntryKind(through) !== row.through_entry_kind) {
    throw new Error('curate_active_claim through_entry_kind must match the stored entry ID');
  }

  return {
    through,
    startedAt: row.started_at,
  };
}

function sameActiveClaim(
  left: CurateState['activeClaim'],
  right: CurateState['activeClaim'],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return compareCursor(left.through, right.through) === 0 && left.startedAt === right.startedAt;
}

function writeActiveClaim(target: CurateStateTarget, activeClaim: CurateState['activeClaim']): void {
  const existing = readActiveClaim(target);
  if (sameActiveClaim(existing, activeClaim)) {
    return;
  }

  if (activeClaim === null) {
    prepareCached<[]>(target, `DELETE FROM curate_active_claim WHERE id = 1`).run();
    return;
  }

  const throughEntryKind = cursorEntryKind(activeClaim.through);
  if (existing === null) {
    prepareCached<[number, string, 'note' | 'source', string]>(
      target,
      `INSERT INTO curate_active_claim (
         id,
         through_seq,
         through_entry_id,
         through_entry_kind,
         started_at
       ) VALUES (1, ?, ?, ?, ?)`,
    ).run(
      activeClaim.through.entrySeq,
      activeClaim.through.entryId,
      throughEntryKind,
      activeClaim.startedAt,
    );
    return;
  }

  prepareCached<[number, string, 'note' | 'source', string]>(
    target,
    `UPDATE curate_active_claim
        SET through_seq = ?,
            through_entry_id = ?,
            through_entry_kind = ?,
            started_at = ?
      WHERE id = 1`,
  ).run(
    activeClaim.through.entrySeq,
    activeClaim.through.entryId,
    throughEntryKind,
    activeClaim.startedAt,
  );
}

function readCommunitySummaryInputFingerprints(target: CurateStateTarget): Record<string, string> | undefined {
  const rows = prepareCached<[], CurateCommunitySummaryInputFingerprintRow>(
    target,
    `SELECT community_slug, fingerprint
       FROM curate_community_summary_input_fingerprints
      ORDER BY community_slug ASC`,
  ).all();
  if (rows.length === 0) {
    return undefined;
  }

  return Object.fromEntries(rows.map(({ community_slug, fingerprint }) => [community_slug, fingerprint]));
}

function writeCommunitySummaryInputFingerprints(
  target: CurateStateTarget,
  fingerprints: Record<string, string> | undefined,
): void {
  const existing = readCommunitySummaryInputFingerprints(target) ?? {};
  const next = fingerprints ?? {};

  for (const communitySlug of Object.keys(existing)) {
    if (!(communitySlug in next)) {
      prepareCached<[string]>(
        target,
        `DELETE FROM curate_community_summary_input_fingerprints
          WHERE community_slug = ?`,
      ).run(communitySlug);
    }
  }

  for (const [communitySlug, fingerprint] of Object.entries(next).sort(([left], [right]) => left.localeCompare(right))) {
    if (!(communitySlug in existing)) {
      prepareCached<[string, string]>(
        target,
        `INSERT INTO curate_community_summary_input_fingerprints (
           community_slug,
           fingerprint
         ) VALUES (?, ?)`,
      ).run(communitySlug, fingerprint);
      continue;
    }

    if (existing[communitySlug] !== fingerprint) {
      prepareCached<[string, string]>(
        target,
        `UPDATE curate_community_summary_input_fingerprints
            SET fingerprint = ?
          WHERE community_slug = ?`,
      ).run(fingerprint, communitySlug);
    }
  }
}

function sortedNoteNames(kb: Pick<KbRuntime, 'notesDir'>): string[] {
  return sortedMarkdownEntries(kb.notesDir()).map((entry) => stripMdExt(entry));
}

function sortedSourceNames(kb: Pick<KbRuntime, 'sourcesDir'>): string[] {
  return sortedMarkdownEntries(kb.sourcesDir()).map((entry) => stripMdExt(entry));
}

function scanNote(kb: Pick<KbRuntime, 'notePath'>, note: string): ScannedNote {
  const path = kb.notePath(note);
  const loaded = loadKbNote(path);
  return {
    note,
    path,
    content: loaded.raw,
    title: loaded.title,
    frontmatter: loaded.frontmatter,
  };
}

function scanSource(kb: Pick<KbRuntime, 'sourcePath'>, slug: string): ScannedSource {
  const path = kb.sourcePath(slug);
  const loaded = loadKbSource(path);
  return {
    slug,
    path,
    content: loaded.raw,
    frontmatter: loaded.frontmatter,
  };
}

function hasCuratedNoteMetadata(frontmatter: KbNoteFrontmatter): boolean {
  return frontmatter.tags.length > 0 || frontmatter.principles.length > 0 || (frontmatter.related ?? []).length > 0;
}

function hasCuratedSourceMetadata(frontmatter: KbSourceFrontmatter): boolean {
  return frontmatter.tags.length > 0 || (frontmatter.related ?? []).length > 0;
}

function inferProcessedThrough(
  state: CurateState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
): CurateCursor | null {
  if (state.processedThrough !== null) {
    return state.processedThrough;
  }

  let highestCuratedCursor: CurateCursor | null = null;
  for (const scannedNote of scannedNotes) {
    const entrySeq = scannedNote.frontmatter.entrySeq;
    if (entrySeq === undefined || !hasCuratedNoteMetadata(scannedNote.frontmatter)) {
      continue;
    }

    const cursor: CurateCursor = {
      entryId: noteEntryId(scannedNote.note),
      entrySeq,
    };
    if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
      highestCuratedCursor = cursor;
    }
  }

  for (const scannedSource of scannedSources) {
    const entrySeq = scannedSource.frontmatter.entrySeq;
    if (entrySeq === undefined || !hasCuratedSourceMetadata(scannedSource.frontmatter)) {
      continue;
    }

    const cursor: CurateCursor = {
      entryId: sourceEntryId(scannedSource.slug),
      entrySeq,
    };
    if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
      highestCuratedCursor = cursor;
    }
  }

  return highestCuratedCursor;
}

function syncIndexNote(
  note: string,
  title: string,
  frontmatter: KbNoteFrontmatter,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const nextEntry = buildNoteIndexEntry({
    slug: note,
    title,
    ...frontmatter,
  });
  const existingEntry = nextIndex.entries[noteEntryId(note)];
  const existing = existingEntry !== undefined && isNoteEntry(existingEntry) ? existingEntry : undefined;
  if (
    existing !== undefined &&
    existing.title === nextEntry.title &&
    existing.entrySeq === nextEntry.entrySeq &&
    sameStringList(existing.tags, nextEntry.tags) &&
    sameStringList(existing.principles, nextEntry.principles) &&
    sameStringList(existing.source, nextEntry.source) &&
    sameStringList(existing.related ?? [], nextEntry.related ?? []) &&
    existing.createdAt === nextEntry.createdAt &&
    existing.updatedAt === nextEntry.updatedAt
  ) {
    return false;
  }

  nextIndex.entries[noteEntryId(note)] = nextEntry;
  return true;
}

function syncIndexSource(
  slug: string,
  frontmatter: KbSourceFrontmatter,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const nextEntry = buildSourceIndexEntry({
    slug,
    ...frontmatter,
  });
  const existingEntry = nextIndex.entries[sourceEntryId(slug)];
  const existing = existingEntry !== undefined && isSourceEntry(existingEntry) ? existingEntry : undefined;
  if (
    existing !== undefined &&
    existing.title === nextEntry.title &&
    existing.type === nextEntry.type &&
    existing.url === nextEntry.url &&
    existing.importedAt === nextEntry.importedAt &&
    existing.entrySeq === nextEntry.entrySeq &&
    sameStringList(existing.tags, nextEntry.tags) &&
    sameStringList(existing.related ?? [], nextEntry.related ?? [])
  ) {
    return false;
  }

  nextIndex.entries[sourceEntryId(slug)] = nextEntry;
  return true;
}

export function readCurateState(target: CurateStateTarget): CurateState {
  const scheduler = readCurateSchedulerState(target);
  const retryQueue = readCurateRetryQueue(target);
  const state = normalizeCurateStateRepairFrontier({
    ...defaultCurateState(),
    processedThrough: scheduler.processedThrough,
    discoveryHighSeq: scheduler.discoveryHighSeq,
    discoveryOffset: scheduler.discoveryOffset,
    lastRunDay: scheduler.lastRunDay,
    lastAttemptedThrough: scheduler.lastAttemptedThrough,
    retryNotBefore: scheduler.retryNotBefore,
    activeClaim: readActiveClaim(target),
    pendingDiscoveries: readCurateDiscoveryBacklog(target),
    pendingRepair: retryQueue.length === 0 ? null : retryQueue,
    communityTopologyHash: scheduler.communityTopologyHash,
    communitySummaryTopologyHash: scheduler.communitySummaryTopologyHash,
    communitySummaryInputFingerprints: readCommunitySummaryInputFingerprints(target),
    consecutiveClaimFailures: scheduler.consecutiveClaimFailures,
    consecutiveCommunityBatchFailures: scheduler.consecutiveCommunityBatchFailures,
    initialized: scheduler.initialized,
    migrationVersion: scheduler.migrationVersion,
  });

  return state;
}

export function writeCurateState(target: CurateStateTarget, state: CurateState): void {
  const normalized = normalizeCurateStateRepairFrontier(state);
  const db = resolveSqliteDb(target);
  db.transaction(() => {
    writeCurateSchedulerState(target, {
      processedThrough: normalized.processedThrough,
      discoveryHighSeq: normalized.discoveryHighSeq,
      discoveryOffset: normalized.discoveryOffset,
      lastRunDay: normalized.lastRunDay,
      lastAttemptedThrough: normalized.lastAttemptedThrough,
      retryNotBefore: normalized.retryNotBefore,
      consecutiveClaimFailures: normalized.consecutiveClaimFailures,
      consecutiveCommunityBatchFailures: normalized.consecutiveCommunityBatchFailures,
      communityTopologyHash: normalized.communityTopologyHash,
      communitySummaryTopologyHash: normalized.communitySummaryTopologyHash,
      initialized: normalized.initialized,
      migrationVersion: normalized.migrationVersion,
    });
    syncCurateRetryQueue(target, normalized.pendingRepair ?? []);
    syncCurateDiscoveryBacklog(target, normalized.pendingDiscoveries);
    writeActiveClaim(target, normalized.activeClaim);
    writeCommunitySummaryInputFingerprints(target, normalized.communitySummaryInputFingerprints);
  })();
}

export function scanCorpus(
  kb: Pick<KbRuntime, 'notesDir' | 'notePath' | 'sourcesDir' | 'sourcePath'>,
  detectedAt = new Date().toISOString(),
): CurateMigrationScan {
  const scannedNotes: ScannedNote[] = [];
  const scannedSources: ScannedSource[] = [];
  const scanFailures: CurateMigrationScanFailure[] = [];

  for (const note of sortedNoteNames(kb)) {
    try {
      scannedNotes.push(scanNote(kb, note));
    } catch (error: unknown) {
      scanFailures.push({
        kind: 'note',
        name: note,
        path: kb.notePath(note),
        error,
      });
    }
  }

  for (const slug of sortedSourceNames(kb)) {
    try {
      scannedSources.push(scanSource(kb, slug));
    } catch (error: unknown) {
      scanFailures.push({
        kind: 'source',
        name: slug,
        path: kb.sourcePath(slug),
        error,
      });
    }
  }

  return {
    scannedNotes,
    scannedSources,
    scanFailures,
    detectedAt,
  };
}

export function detectRepairs(
  scanFailures: CurateMigrationScanFailure[],
  detectedAt: string,
): PendingRepair[] {
  const pendingRepair: PendingRepair[] = [];

  for (const failure of scanFailures) {
    const repair = readMalformedEntryRepair(failure.path, failure.kind, failure.name, detectedAt);
    if (repair !== null) {
      pendingRepair.push(repair);
    }
    backendLog.warn(
      `Skipping malformed KB ${failure.kind} ${failure.name} during state migration: ${errorMessage(failure.error)}`,
    );
  }

  return pendingRepair;
}

export function assignEntrySeqs(
  indexState: KbIndexState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
  pendingRepair: PendingRepair[],
): CurateMigrationAssignment {
  let highestExistingEntrySeq = indexState.mutationSeq;
  for (const scannedNote of scannedNotes) {
    if (scannedNote.frontmatter.entrySeq !== undefined) {
      highestExistingEntrySeq = Math.max(highestExistingEntrySeq, scannedNote.frontmatter.entrySeq);
    }
  }
  for (const scannedSource of scannedSources) {
    if (scannedSource.frontmatter.entrySeq !== undefined) {
      highestExistingEntrySeq = Math.max(highestExistingEntrySeq, scannedSource.frontmatter.entrySeq);
    }
  }
  for (const repair of pendingRepair) {
    if (repair.entrySeq !== null) {
      highestExistingEntrySeq = Math.max(highestExistingEntrySeq, repair.entrySeq);
    }
  }

  let nextEntrySeq = highestExistingEntrySeq + 1;
  let highestAssignedEntrySeq = highestExistingEntrySeq;
  const rewrittenNotes: ScannedNote[] = [];
  const rewrittenSources: ScannedSource[] = [];

  for (const scannedNote of scannedNotes) {
    if (scannedNote.frontmatter.entrySeq === undefined) {
      scannedNote.frontmatter = {
        ...scannedNote.frontmatter,
        entrySeq: nextEntrySeq,
      };
      rewrittenNotes.push(scannedNote);
      nextEntrySeq += 1;
    }

    highestAssignedEntrySeq = Math.max(highestAssignedEntrySeq, scannedNote.frontmatter.entrySeq ?? 0);
  }

  for (const scannedSource of scannedSources) {
    if (scannedSource.frontmatter.entrySeq === undefined) {
      scannedSource.frontmatter = {
        ...scannedSource.frontmatter,
        entrySeq: nextEntrySeq,
      };
      rewrittenSources.push(scannedSource);
      nextEntrySeq += 1;
    }

    highestAssignedEntrySeq = Math.max(highestAssignedEntrySeq, scannedSource.frontmatter.entrySeq ?? 0);
  }

  return {
    highestAssignedEntrySeq,
    rewrittenNotes,
    rewrittenSources,
  };
}

export function rewriteFrontmatter(rewrittenNotes: ScannedNote[], rewrittenSources: ScannedSource[]): void {
  for (const scannedNote of rewrittenNotes) {
    writeFileAtomic(scannedNote.path, replaceFrontmatter(scannedNote.content, scannedNote.frontmatter));
  }

  for (const scannedSource of rewrittenSources) {
    writeFileAtomic(scannedSource.path, replaceSourceFrontmatter(scannedSource.content, scannedSource.frontmatter));
  }
}

export function syncIndex(
  kb: Pick<KbRuntime, 'writeIndex'>,
  nextIndex: KbIndex,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
): void {
  let indexChanged = false;

  for (const scannedNote of scannedNotes) {
    indexChanged =
      syncIndexNote(scannedNote.note, scannedNote.title, scannedNote.frontmatter, nextIndex) || indexChanged;
  }

  for (const scannedSource of scannedSources) {
    indexChanged = syncIndexSource(scannedSource.slug, scannedSource.frontmatter, nextIndex) || indexChanged;
  }

  if (indexChanged) {
    kb.writeIndex(nextIndex);
  }
}

export function reconcileSeqs(
  kb: Pick<KbRuntime, 'writeIndexState'>,
  indexState: KbIndexState,
  highestAssignedEntrySeq: number,
): void {
  if (highestAssignedEntrySeq > indexState.mutationSeq) {
    kb.writeIndexState({
      ...indexState,
      contentSeq: highestAssignedEntrySeq,
      metadataSeq: highestAssignedEntrySeq,
      mutationSeq: highestAssignedEntrySeq,
      textIndexedSeq: highestAssignedEntrySeq,
    });
  }
}

export function persistState(
  kb: Pick<KbRuntime, 'db'>,
  state: CurateState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
  pendingRepair: PendingRepair[],
): void {
  writeCurateState(kb, {
    ...state,
    processedThrough: inferProcessedThrough(state, scannedNotes, scannedSources),
    pendingRepair: pendingRepair.length === 0 ? null : pendingRepair,
    initialized: true,
    migrationVersion: CURATE_STATE_MIGRATION_VERSION,
  });
}

export async function migrateCurateStateIfNeeded(kb: CurateStateRuntime): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    if (state.initialized && state.migrationVersion >= CURATE_STATE_MIGRATION_VERSION) {
      return;
    }

    const nextIndex = cloneKbIndex(kb.readIndex());
    const indexState = kb.readIndexState();
    const { scannedNotes, scannedSources, scanFailures, detectedAt } = scanCorpus(kb);
    const pendingRepair = detectRepairs(scanFailures, detectedAt);
    const { highestAssignedEntrySeq, rewrittenNotes, rewrittenSources } = assignEntrySeqs(
      indexState,
      scannedNotes,
      scannedSources,
      pendingRepair,
    );

    rewriteFrontmatter(rewrittenNotes, rewrittenSources);
    syncIndex(kb, nextIndex, scannedNotes, scannedSources);
    reconcileSeqs(kb, indexState, highestAssignedEntrySeq);
    persistState(kb, state, scannedNotes, scannedSources, pendingRepair);
  });
}

export {
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  CURATE_STATE_MIGRATION_VERSION,
  compareCursor,
  compareOptionalCursor,
  defaultCurateState,
  extractMalformedEntryRepair,
  getCurateRepairFrontier,
  isClaimStale,
  normalizeCurateStateRepairFrontier,
  noteCursor,
  resetCurateStateForBackfill,
  sameStringList,
};
export type {
  CurateCursor,
  CurateRepairFrontier,
  CurateState,
  PendingDiscovery,
  PendingRepair,
};
