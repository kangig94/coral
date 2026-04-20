import { join } from 'node:path';

import type {
  CurateActiveClaimRow,
  CurateCommunitySummaryInputFingerprintRow,
} from '../../store/schema.js';
import { backendLog } from '../../shared/backend-log.js';
import { errorMessage } from '../../shared/utils.js';
import {
  replaceFrontmatter,
  replaceSourceFrontmatter,
} from '../corpus/frontmatter.js';
import { sortedMarkdownEntries } from '../corpus/markdown-entries.js';
import {
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  cloneKbIndex,
  writeFileAtomic,
} from '../corpus/mutation-helpers.js';
import { stripMdExt } from '../paths.js';
import { loadKbNote, loadKbSource } from '../read.js';
import type { KbRuntime } from '../contracts.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from '../entry-types.js';
import { parsePositiveInteger } from '../validation.js';
import { readCurateDiscoveryBacklog, replaceCurateDiscoveryBacklog } from './discovery-backlog.js';
import { readCurateRetryQueue, replaceCurateRetryQueue } from './retry.js';
import {
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
} from './state-shared.js';
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

type ScannedNote = {
  note: string;
  path: string;
  content: string;
  title: string;
  frontmatter: KbNoteFrontmatter;
};

type ScannedSource = {
  slug: string;
  path: string;
  content: string;
  frontmatter: KbSourceFrontmatter;
};

function cursorEntryKind(cursor: CurateCursor): 'note' | 'source' {
  if (cursor.entryId.startsWith('note:')) {
    return 'note';
  }
  if (cursor.entryId.startsWith('source:')) {
    return 'source';
  }

  throw new Error(`curate cursor must point at a note or source entry: ${cursor.entryId}`);
}

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

function writeActiveClaim(target: CurateStateTarget, activeClaim: CurateState['activeClaim']): void {
  prepareCached<[]>(target, `DELETE FROM curate_active_claim WHERE id = 1`).run();
  if (activeClaim === null) {
    return;
  }

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
    cursorEntryKind(activeClaim.through),
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
  prepareCached<[]>(target, `DELETE FROM curate_community_summary_input_fingerprints`).run();
  if (fingerprints === undefined) {
    return;
  }

  const insert = prepareCached<[string, string]>(
    target,
    `INSERT INTO curate_community_summary_input_fingerprints (
       community_slug,
       fingerprint
     ) VALUES (?, ?)`,
  );
  for (const [communitySlug, fingerprint] of Object.entries(fingerprints).sort(([left], [right]) => left.localeCompare(right))) {
    insert.run(communitySlug, fingerprint);
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
    consecutiveFailures: scheduler.consecutiveFailures,
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
      consecutiveFailures: normalized.consecutiveFailures,
      communityTopologyHash: normalized.communityTopologyHash,
      communitySummaryTopologyHash: normalized.communitySummaryTopologyHash,
      initialized: normalized.initialized,
      migrationVersion: normalized.migrationVersion,
    });
    replaceCurateRetryQueue(target, normalized.pendingRepair ?? []);
    replaceCurateDiscoveryBacklog(target, normalized.pendingDiscoveries);
    writeActiveClaim(target, normalized.activeClaim);
    writeCommunitySummaryInputFingerprints(target, normalized.communitySummaryInputFingerprints);
  })();
}

/**
 * Legacy test helper retained as a non-authoritative debug path now that curate state lives in SQLite.
 */
export function curateStatePath(target: Pick<KbRuntime, 'runtimeDir'> | string): string {
  return typeof target === 'string' ? join(target, 'curate-state.retired') : join(target.runtimeDir, 'curate-state.retired');
}

export async function migrateCurateStateIfNeeded(kb: CurateStateRuntime): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    if (state.initialized && state.migrationVersion >= CURATE_STATE_MIGRATION_VERSION) {
      return;
    }

    const nextIndex = cloneKbIndex(kb.readIndex());
    const indexState = kb.readIndexState();
    const scannedNotes: ScannedNote[] = [];
    const scannedSources: ScannedSource[] = [];
    const pendingRepair: PendingRepair[] = [];
    const detectedAt = new Date().toISOString();

    for (const note of sortedNoteNames(kb)) {
      try {
        scannedNotes.push(scanNote(kb, note));
      } catch (error: unknown) {
        const repair = readMalformedEntryRepair(kb.notePath(note), 'note', note, detectedAt);
        if (repair !== null) {
          pendingRepair.push(repair);
        }
        backendLog.warn(`Skipping malformed KB note ${note} during state migration: ${errorMessage(error)}`);
      }
    }

    for (const slug of sortedSourceNames(kb)) {
      try {
        scannedSources.push(scanSource(kb, slug));
      } catch (error: unknown) {
        const repair = readMalformedEntryRepair(kb.sourcePath(slug), 'source', slug, detectedAt);
        if (repair !== null) {
          pendingRepair.push(repair);
        }
        backendLog.warn(`Skipping malformed KB source ${slug} during state migration: ${errorMessage(error)}`);
      }
    }

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
    let indexChanged = false;

    for (const scannedNote of scannedNotes) {
      if (scannedNote.frontmatter.entrySeq === undefined) {
        scannedNote.frontmatter = {
          ...scannedNote.frontmatter,
          entrySeq: nextEntrySeq,
        };
        nextEntrySeq += 1;
        writeFileAtomic(scannedNote.path, replaceFrontmatter(scannedNote.content, scannedNote.frontmatter));
      }

      highestAssignedEntrySeq = Math.max(highestAssignedEntrySeq, scannedNote.frontmatter.entrySeq ?? 0);
      indexChanged =
        syncIndexNote(scannedNote.note, scannedNote.title, scannedNote.frontmatter, nextIndex) || indexChanged;
    }

    for (const scannedSource of scannedSources) {
      if (scannedSource.frontmatter.entrySeq === undefined) {
        scannedSource.frontmatter = {
          ...scannedSource.frontmatter,
          entrySeq: nextEntrySeq,
        };
        nextEntrySeq += 1;
        writeFileAtomic(scannedSource.path, replaceSourceFrontmatter(scannedSource.content, scannedSource.frontmatter));
      }

      highestAssignedEntrySeq = Math.max(highestAssignedEntrySeq, scannedSource.frontmatter.entrySeq ?? 0);
      indexChanged = syncIndexSource(scannedSource.slug, scannedSource.frontmatter, nextIndex) || indexChanged;
    }

    if (indexChanged) {
      kb.writeIndex(nextIndex);
    }

    if (highestAssignedEntrySeq > indexState.mutationSeq) {
      kb.writeIndexState({
        ...indexState,
        contentSeq: highestAssignedEntrySeq,
        metadataSeq: highestAssignedEntrySeq,
        mutationSeq: highestAssignedEntrySeq,
        textIndexedSeq: highestAssignedEntrySeq,
      });
    }

    writeCurateState(kb, {
      ...state,
      processedThrough: inferProcessedThrough(state, scannedNotes, scannedSources),
      pendingRepair: pendingRepair.length === 0 ? null : pendingRepair,
      initialized: true,
      migrationVersion: CURATE_STATE_MIGRATION_VERSION,
    });
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
