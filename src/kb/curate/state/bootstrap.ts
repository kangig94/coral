import { errorMessage } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import { replaceFrontmatter, replaceSourceFrontmatter } from '../../corpus/frontmatter.js';
import { sortedMarkdownEntries } from '../../corpus/markdown-entries.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex } from '../../corpus/index-records.js';
import { advanceIndexStateToEntrySeq, currentEntrySeq } from '../../index-state.js';
import { stripMdExt } from '../../paths.js';
import { loadKbNote, loadKbSource } from '../../read.js';
import type { KbIndexState, KbRuntime } from '../../contract.js';
import { nowIsoString } from '../../../infra/time.js';
import { buildCorpusScanView } from '../../corpus/repair/corpus-scan.js';
import { projectIncidents } from '../../corpus/repair/project-incidents.js';
import { applyDetectedIncidentFixesLocked } from '../../corpus/repair/fix.js';
import { createGitSyncController } from '../git-sync.js';
import { deleteCurateRetryEntry, readCurateRetryQueue } from '../retry.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type KbIndex,
  type KbNoteFrontmatter,
  type KbSourceFrontmatter,
} from '../../entry-types.js';
import {
  compareCursor,
  noteCursor,
  sameStringList,
  type CurateCursor,
  type CurateState,
  type PendingRepair,
} from './model.js';
import { readCurateState, writeCurateState } from './store.js';

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

export type CurateBootstrapScanFailure = {
  kind: 'note' | 'source';
  name: string;
  path: string;
  error: unknown;
};

export type CurateBootstrapScan = {
  scannedNotes: ScannedNote[];
  scannedSources: ScannedSource[];
  scanFailures: CurateBootstrapScanFailure[];
  detectedAt: string;
};

export type CurateBootstrapAssignment = {
  highestAssignedEntrySeq: number;
  rewrittenNotes: ScannedNote[];
  rewrittenSources: ScannedSource[];
};

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

    const cursor = noteCursor(scannedNote.note, entrySeq);
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

export function scanCorpus(
  kb: Pick<KbRuntime, 'time' | 'notesDir' | 'notePath' | 'sourcesDir' | 'sourcePath'>,
  detectedAt = nowIsoString(kb.time),
): CurateBootstrapScan {
  const scannedNotes: ScannedNote[] = [];
  const scannedSources: ScannedSource[] = [];
  const scanFailures: CurateBootstrapScanFailure[] = [];

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

export function assignEntrySeqs(
  indexState: KbIndexState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
  retryQueue: PendingRepair[],
): CurateBootstrapAssignment {
  let highestExistingEntrySeq = currentEntrySeq(indexState);
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
  for (const repair of retryQueue) {
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
  if (highestAssignedEntrySeq > currentEntrySeq(indexState)) {
    kb.writeIndexState(advanceIndexStateToEntrySeq(indexState, highestAssignedEntrySeq));
  }
}

export function persistState(
  kb: Pick<KbRuntime, 'db'>,
  state: CurateState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
): void {
  writeCurateState(kb, {
    ...state,
    processedThrough: inferProcessedThrough(state, scannedNotes, scannedSources),
    initialized: true,
  });
}

export async function initializeCurateStateIfNeeded(kb: KbRuntime): Promise<void> {
  await kb.withMutationLock(async (mutation) => {
    const state = readCurateState(kb);
    if (state.initialized) {
      return;
    }

    const nextIndex = cloneKbIndex(kb.readIndex());
    const indexState = kb.readIndexState();
    const { scannedNotes, scannedSources, scanFailures } = scanCorpus(kb);
    for (const failure of scanFailures) {
      backendLog.warn(
        `Skipping malformed KB ${failure.kind} ${failure.name} during curate bootstrap: ${errorMessage(failure.error)}`,
      );
    }

    const incidents = projectIncidents(buildCorpusScanView(kb));
    const gitSync = createGitSyncController({
      kb,
      spawnCli: kb.spawnCli,
      processPort: kb.processPort,
      storagePort: kb.storagePort,
      envPort: kb.envPort,
    });
    await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, incidents);

    const retryQueue = readCurateRetryQueue(kb.db);
    const { highestAssignedEntrySeq, rewrittenNotes, rewrittenSources } = assignEntrySeqs(
      indexState,
      scannedNotes,
      scannedSources,
      retryQueue,
    );

    rewriteFrontmatter(rewrittenNotes, rewrittenSources);
    syncIndex(kb, nextIndex, scannedNotes, scannedSources);
    reconcileSeqs(kb, indexState, highestAssignedEntrySeq);

    // Sweep typed-incident rows that bootstrap's own rewrites resolved (e.g. assignEntrySeqs
    // satisfying frontmatter-shape/missing-required-fields for entrySeq). Mirrors the rebuild
    // pipeline's post-rebuild cleanup so persistState observes a queue that reflects the
    // post-bootstrap corpus state.
    const postRewriteIncidents = projectIncidents(buildCorpusScanView(kb));
    const stillDetected = new Set(postRewriteIncidents.map((incident) => incident.entryId));
    for (const queued of readCurateRetryQueue(kb.db)) {
      if (queued.canonicalIncident !== undefined && !stillDetected.has(queued.entryId)) {
        deleteCurateRetryEntry(kb.db, queued.entryId);
      }
    }

    persistState(kb, state, scannedNotes, scannedSources);
  });
}
