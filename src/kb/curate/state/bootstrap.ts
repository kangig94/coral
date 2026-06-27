import { errorMessage } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import { extractBody, replaceFrontmatter, replaceSourceFrontmatter } from '../../corpus/frontmatter.js';
import { sortedMarkdownEntries } from '../../corpus/markdown-entries.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex } from '../../corpus/index/records.js';
import { computeBodySurfaceHash } from '../../corpus/snapshot.js';
import { advanceIndexStateToEntrySeq, currentEntrySeq } from '../../index-state.js';
import { stripMdExt } from '../../paths.js';
import { loadKbNote, loadKbSource } from '../../read.js';
import type { KbIndexState, KbRuntime } from '../../contract.js';
import { nowIsoString } from '../../../infra/time.js';
import { buildCorpusScanView } from '../../corpus/rescan/scan.js';
import { projectIncidents } from '../../corpus/rescan/projections.js';
import { applyDetectedIncidentFixesLocked } from '../../corpus/rescan/auto-fix.js';
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
  sourceCursor,
  type CurateCursor,
  type CurateState,
  type PendingRepair,
} from './model.js';
import { readCurateState, writeCurateState } from './store.js';
import { curateDb } from '../db-access.js';

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

function sortedNoteNames(kb: Pick<KbRuntime, 'notesDir' | 'storagePort'>): string[] {
  const names: string[] = [];
  for (const entry of sortedMarkdownEntries(kb.storagePort, kb.notesDir())) {
    names.push(stripMdExt(entry));
  }
  return names;
}

function sortedSourceNames(kb: Pick<KbRuntime, 'sourcesDir' | 'storagePort'>): string[] {
  const names: string[] = [];
  for (const entry of sortedMarkdownEntries(kb.storagePort, kb.sourcesDir())) {
    names.push(stripMdExt(entry));
  }
  return names;
}

function scanNote(kb: Pick<KbRuntime, 'notePath' | 'storagePort'>, note: string): ScannedNote {
  const path = kb.notePath(note);
  const loaded = loadKbNote(kb.storagePort, path);
  return {
    note,
    path,
    content: loaded.raw,
    title: loaded.title,
    frontmatter: loaded.frontmatter,
  };
}

function scanSource(kb: Pick<KbRuntime, 'sourcePath' | 'storagePort'>, slug: string): ScannedSource {
  const path = kb.sourcePath(slug);
  const loaded = loadKbSource(kb.storagePort, path);
  return {
    slug,
    path,
    content: loaded.raw,
    frontmatter: loaded.frontmatter,
  };
}

function hasCurrentInputFingerprint(frontmatter: KbNoteFrontmatter | KbSourceFrontmatter, content: string): boolean {
  return (
    frontmatter.inputFingerprint !== undefined &&
    frontmatter.inputFingerprint === computeBodySurfaceHash(extractBody(content))
  );
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
    if (!hasCurrentInputFingerprint(scannedNote.frontmatter, scannedNote.content)) {
      continue;
    }

    const cursor = noteCursor(scannedNote.note, scannedNote.frontmatter.createdAt);
    if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
      highestCuratedCursor = cursor;
    }
  }

  for (const scannedSource of scannedSources) {
    if (!hasCurrentInputFingerprint(scannedSource.frontmatter, scannedSource.content)) {
      continue;
    }

    const cursor = sourceCursor(scannedSource.slug, scannedSource.frontmatter.importedAt);
    if (highestCuratedCursor === null || compareCursor(cursor, highestCuratedCursor) > 0) {
      highestCuratedCursor = cursor;
    }
  }

  return highestCuratedCursor;
}

function syncIndexNote(
  note: string,
  title: string,
  content: string,
  frontmatter: KbNoteFrontmatter,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const nextEntry = buildNoteIndexEntry({
    slug: note,
    title,
    body: extractBody(content),
    ...frontmatter,
  });
  const existingEntry = nextIndex.entries[noteEntryId(note)];
  const existing = existingEntry !== undefined && isNoteEntry(existingEntry) ? existingEntry : undefined;
  if (
    existing !== undefined &&
    existing.title === nextEntry.title &&
    existing.entrySeq === nextEntry.entrySeq &&
    existing.bodyHash === nextEntry.bodyHash &&
    existing.inputFingerprint === nextEntry.inputFingerprint &&
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
  content: string,
  frontmatter: KbSourceFrontmatter,
  nextIndex: ReturnType<typeof cloneKbIndex>,
): boolean {
  const nextEntry = buildSourceIndexEntry({
    slug,
    body: extractBody(content),
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
    existing.bodyHash === nextEntry.bodyHash &&
    existing.inputFingerprint === nextEntry.inputFingerprint &&
    sameStringList(existing.tags, nextEntry.tags) &&
    sameStringList(existing.related ?? [], nextEntry.related ?? [])
  ) {
    return false;
  }

  nextIndex.entries[sourceEntryId(slug)] = nextEntry;
  return true;
}

export function scanCorpus(
  kb: Pick<KbRuntime, 'time' | 'notesDir' | 'notePath' | 'sourcesDir' | 'sourcePath' | 'storagePort'>,
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

export function rewriteFrontmatter(
  kb: Pick<KbRuntime, 'storagePort' | 'ids'>,
  rewrittenNotes: ScannedNote[],
  rewrittenSources: ScannedSource[],
): void {
  for (const scannedNote of rewrittenNotes) {
    writeFileAtomic(kb, scannedNote.path, replaceFrontmatter(scannedNote.content, scannedNote.frontmatter));
  }

  for (const scannedSource of rewrittenSources) {
    writeFileAtomic(kb, scannedSource.path, replaceSourceFrontmatter(scannedSource.content, scannedSource.frontmatter));
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
      syncIndexNote(scannedNote.note, scannedNote.title, scannedNote.content, scannedNote.frontmatter, nextIndex) ||
      indexChanged;
  }

  for (const scannedSource of scannedSources) {
    indexChanged =
      syncIndexSource(scannedSource.slug, scannedSource.content, scannedSource.frontmatter, nextIndex) || indexChanged;
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
  kb: KbRuntime,
  state: CurateState,
  scannedNotes: ScannedNote[],
  scannedSources: ScannedSource[],
): void {
  writeCurateState(curateDb(kb), {
    ...state,
    processedThrough: inferProcessedThrough(state, scannedNotes, scannedSources),
    initialized: true,
  });
}

export async function initializeCurateStateIfNeeded(kb: KbRuntime): Promise<void> {
  await kb.withMutationLock(async (mutation) => {
    const state = readCurateState(curateDb(kb));
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
      curateAssistant: kb.curateAssistant,
      processPort: kb.processPort,
      storagePort: kb.storagePort,
      envPort: kb.envPort,
    });
    await applyDetectedIncidentFixesLocked(kb, mutation, gitSync, incidents);

    const retryQueue = readCurateRetryQueue(curateDb(kb));
    const { highestAssignedEntrySeq, rewrittenNotes, rewrittenSources } = assignEntrySeqs(
      indexState,
      scannedNotes,
      scannedSources,
      retryQueue,
    );
    rewriteFrontmatter(kb, rewrittenNotes, rewrittenSources);
    syncIndex(kb, nextIndex, scannedNotes, scannedSources);
    reconcileSeqs(kb, indexState, highestAssignedEntrySeq);

    // Sweep typed-incident rows that bootstrap's own rewrites resolved (e.g. assignEntrySeqs
    // satisfying frontmatter-shape/missing-required-fields for entrySeq). Mirrors the rebuild
    // pipeline's post-rebuild cleanup so persistState observes a queue that reflects the
    // post-bootstrap corpus state.
    const postRewriteIncidents = projectIncidents(buildCorpusScanView(kb));
    const stillDetected = new Set<string>();
    for (const incident of postRewriteIncidents) {
      stillDetected.add(incident.entryId);
    }
    for (const queued of readCurateRetryQueue(curateDb(kb))) {
      if (queued.canonicalIncident !== undefined && !stillDetected.has(queued.entryId)) {
        deleteCurateRetryEntry(curateDb(kb), queued.entryId);
      }
    }

    persistState(kb, state, scannedNotes, scannedSources);
  });
}
