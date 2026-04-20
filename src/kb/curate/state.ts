import { join } from 'node:path';

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
  deleteMetaValue,
  listMetaByPrefix,
  readMetaValue,
  replaceMetaPrefix,
  resolveSqliteDb,
  writeMetaValue,
} from './sqlite.js';
import { readCurateSchedulerState, writeCurateSchedulerState } from './state-scheduler.js';

const LAST_ATTEMPTED_THROUGH_META_PREFIX = 'curate.last_attempted_through.';
const ACTIVE_CLAIM_META_PREFIX = 'curate.active_claim.';
const COMMUNITY_SUMMARY_INPUT_FINGERPRINT_PREFIX = 'curate.community_summary_input_fingerprint:';
const COMMUNITY_SUMMARY_TOPOLOGY_HASH_KEY = 'curate.community_summary_topology_hash';
const RETRY_NOT_BEFORE_KEY = 'curate.retry_not_before';
const INITIALIZED_KEY = 'curate.initialized';
const MIGRATION_VERSION_KEY = 'curate.migration_version';

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

function readOptionalMetaCursor(target: CurateStateTarget, prefix: string): CurateCursor | null {
  const rawEntryId = readMetaValue(target, `${prefix}entry_id`);
  const rawEntrySeq = readMetaValue(target, `${prefix}entry_seq`);
  if (rawEntryId === null && rawEntrySeq === null) {
    return null;
  }
  if (rawEntryId === null || rawEntrySeq === null) {
    throw new Error(`curate meta cursor ${prefix} must store both entry_id and entry_seq`);
  }

  const entryId = kbEntryIdSchema.parse(rawEntryId);
  const entrySeq = parsePositiveInteger(Number.parseInt(rawEntrySeq, 10), `${prefix}entry_seq`);
  return {
    entryId,
    entrySeq,
  };
}

function writeOptionalMetaCursor(target: CurateStateTarget, prefix: string, cursor: CurateCursor | null): void {
  replaceMetaPrefix(
    target,
    prefix,
    cursor === null
      ? {}
      : {
          [`${prefix}entry_id`]: cursor.entryId,
          [`${prefix}entry_seq`]: cursor.entrySeq.toString(10),
        },
  );
}

function readActiveClaim(target: CurateStateTarget): CurateState['activeClaim'] {
  const through = readOptionalMetaCursor(target, ACTIVE_CLAIM_META_PREFIX);
  const startedAt = readMetaValue(target, `${ACTIVE_CLAIM_META_PREFIX}started_at`);
  if (through === null && startedAt === null) {
    return null;
  }
  if (through === null || startedAt === null) {
    throw new Error('curate active claim meta must store both cursor and started_at');
  }

  return {
    through,
    startedAt,
  };
}

function writeActiveClaim(target: CurateStateTarget, activeClaim: CurateState['activeClaim']): void {
  replaceMetaPrefix(
    target,
    ACTIVE_CLAIM_META_PREFIX,
    activeClaim === null
      ? {}
      : {
          [`${ACTIVE_CLAIM_META_PREFIX}entry_id`]: activeClaim.through.entryId,
          [`${ACTIVE_CLAIM_META_PREFIX}entry_seq`]: activeClaim.through.entrySeq.toString(10),
          [`${ACTIVE_CLAIM_META_PREFIX}started_at`]: activeClaim.startedAt,
        },
  );
}

function readCommunitySummaryInputFingerprints(target: CurateStateTarget): Record<string, string> | undefined {
  const rows = listMetaByPrefix(target, COMMUNITY_SUMMARY_INPUT_FINGERPRINT_PREFIX);
  if (rows.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    rows.map(({ key, value }) => [key.slice(COMMUNITY_SUMMARY_INPUT_FINGERPRINT_PREFIX.length), value]),
  );
}

function writeCommunitySummaryInputFingerprints(
  target: CurateStateTarget,
  fingerprints: Record<string, string> | undefined,
): void {
  replaceMetaPrefix(
    target,
    COMMUNITY_SUMMARY_INPUT_FINGERPRINT_PREFIX,
    fingerprints === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(fingerprints).map(([slug, fingerprint]) => [
            `${COMMUNITY_SUMMARY_INPUT_FINGERPRINT_PREFIX}${slug}`,
            fingerprint,
          ]),
        ),
  );
}

function readInitialized(target: CurateStateTarget): boolean {
  return readMetaValue(target, INITIALIZED_KEY) === '1';
}

function readMigrationVersion(target: CurateStateTarget): number {
  const raw = readMetaValue(target, MIGRATION_VERSION_KEY);
  if (raw === null) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
    lastAttemptedThrough: readOptionalMetaCursor(target, LAST_ATTEMPTED_THROUGH_META_PREFIX),
    retryNotBefore: readMetaValue(target, RETRY_NOT_BEFORE_KEY),
    activeClaim: readActiveClaim(target),
    pendingDiscoveries: readCurateDiscoveryBacklog(target),
    pendingRepair: retryQueue.length === 0 ? null : retryQueue,
    communityTopologyHash: scheduler.communityTopologyHash,
    communitySummaryTopologyHash: readMetaValue(target, COMMUNITY_SUMMARY_TOPOLOGY_HASH_KEY) ?? undefined,
    communitySummaryInputFingerprints: readCommunitySummaryInputFingerprints(target),
    consecutiveFailures: scheduler.consecutiveFailures,
    initialized: readInitialized(target),
    migrationVersion: readMigrationVersion(target),
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
      consecutiveFailures: normalized.consecutiveFailures,
      communityTopologyHash: normalized.communityTopologyHash,
    });
    replaceCurateRetryQueue(target, normalized.pendingRepair ?? []);
    replaceCurateDiscoveryBacklog(target, normalized.pendingDiscoveries);
    writeOptionalMetaCursor(target, LAST_ATTEMPTED_THROUGH_META_PREFIX, normalized.lastAttemptedThrough);
    writeActiveClaim(target, normalized.activeClaim);

    if (normalized.retryNotBefore === null) {
      deleteMetaValue(target, RETRY_NOT_BEFORE_KEY);
    } else {
      writeMetaValue(target, RETRY_NOT_BEFORE_KEY, normalized.retryNotBefore);
    }

    if (normalized.communitySummaryTopologyHash === undefined) {
      deleteMetaValue(target, COMMUNITY_SUMMARY_TOPOLOGY_HASH_KEY);
    } else {
      writeMetaValue(target, COMMUNITY_SUMMARY_TOPOLOGY_HASH_KEY, normalized.communitySummaryTopologyHash);
    }

    writeCommunitySummaryInputFingerprints(target, normalized.communitySummaryInputFingerprints);
    writeMetaValue(target, INITIALIZED_KEY, normalized.initialized ? '1' : '0');
    writeMetaValue(target, MIGRATION_VERSION_KEY, normalized.migrationVersion.toString(10));
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
