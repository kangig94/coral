import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { nowIsoString } from '../../infra/time.js';
import type { KbRuntime } from '../contract.js';
import { captureNoteManifestDeltas, captureWikiManifestDeltas } from '../corpus/manifest-authority.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../corpus/index-mutations.js';
import { buildNoteIndexEntry, buildWikiIndexEntry } from '../corpus/index-records.js';
import { extractBody, extractTitle, parseWikiBody, parseWikiFrontmatter } from '../corpus/frontmatter.js';
import { setEntry } from '../entry-types.js';
import { extractKnowledgeLinks } from '../corpus/wiki-links.js';
import {
  PROMOTE_MARKER_VERSION,
  promoteRecoveryDir,
  promoteRecoveryMarkerPath,
  type PromoteRecoveryMarker,
  type PromoteRecoveryPhase,
} from './promote-marker.js';

/**
 * Subset of `KbRuntime` consumed by the promote-recovery worker. Mirrors the
 * surface the live promote path uses so the worker can reuse the same commit
 * primitives without pulling the full runtime contract through the boot path.
 */
type PromoteRecoveryHost = Pick<
  KbRuntime,
  | 'storagePort'
  | 'ids'
  | 'time'
  | 'runtimeDir'
  | 'withMutationLock'
  | 'readIndex'
  | 'writeIndex'
  | 'recordMutationCommitted'
>;

/**
 * Run promote-recovery scan once at coordinator startup. MUST be invoked
 * before `retryPendingCorpusPublication()`, `ensureCorpusFreshness`, and any
 * `driver.notifyCorpus` boot path so consumers cannot observe a corpus
 * snapshot built from a partially committed promote.
 */
export async function runPromoteRecovery(rt: PromoteRecoveryHost): Promise<void> {
  const dir = promoteRecoveryDir(rt.runtimeDir);
  const markerPaths = listMarkerFiles(rt, dir);
  for (const markerPath of markerPaths) {
    const marker = readMarker(rt, markerPath);
    if (marker === null) {
      // Malformed marker — drop it rather than blocking boot. Backups/staged
      // payloads are intentionally left for operator inspection.
      rt.storagePort.rmSync(markerPath, { force: true });
      backendLog.warn(`promote-recovery: removed malformed marker ${markerPath}`);
      continue;
    }
    try {
      await recoverOne(rt, marker);
    } catch (error: unknown) {
      backendLog.warn(`promote-recovery: failed to recover ${marker.promoteId}: ${errorMessage(error)}`);
    }
  }
}

function listMarkerFiles(rt: PromoteRecoveryHost, dir: string): string[] {
  if (!rt.storagePort.existsSync(dir)) {
    return [];
  }
  const markerPaths: string[] = [];
  for (const name of rt.storagePort.readdirSync(dir)) {
    if (name.endsWith('.json')) {
      markerPaths.push(join(dir, name));
    }
  }
  return markerPaths;
}

function readMarker(rt: PromoteRecoveryHost, markerPath: string): PromoteRecoveryMarker | null {
  let raw: string;
  try {
    raw = rt.storagePort.readFileSync(markerPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as PromoteRecoveryMarker;
    if (parsed.version !== PROMOTE_MARKER_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function recoverOne(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): Promise<void> {
  switch (marker.phase) {
    case 'marker-created':
    case 'payloads-staged':
      // No real-path file writes happened; just discard staged artifacts.
      cleanupArtifacts(rt, marker);
      return;
    case 'note-written':
      // Note file written but wiki not yet touched → roll back the note.
      rollbackNote(rt, marker);
      cleanupArtifacts(rt, marker);
      return;
    case 'wiki-written':
      if (filesMatchExpectedHashes(rt, marker)) {
        await completeForward(rt, marker);
      } else {
        // Hash mismatch — staged content does not agree with what is on disk.
        // Restore wiki backup if we have one, remove note file, and abandon.
        rollbackWiki(rt, marker);
        rollbackNote(rt, marker);
        cleanupArtifacts(rt, marker);
      }
      return;
    case 'state-committed':
    case 'memo-removed':
      // Corpus state already published; only memo removal + cleanup left.
      removeMemoIfPresent(rt, marker);
      cleanupArtifacts(rt, marker);
      return;
    case 'cleanup-complete':
      cleanupArtifacts(rt, marker);
      return;
  }
}

function rollbackNote(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): void {
  const onDisk = readFileOrNull(rt, marker.notePath);
  if (onDisk === null) {
    return;
  }
  // Only remove a note that matches the hash we wrote — leave foreign files alone.
  if (sha256(onDisk) === marker.newNoteHash) {
    rt.storagePort.rmSync(marker.notePath, { force: true });
  }
}

function rollbackWiki(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): void {
  if (marker.backupWikiPath === undefined || marker.oldWikiHash === undefined) {
    return;
  }
  const backup = readFileOrNull(rt, marker.backupWikiPath);
  if (backup === null || sha256(backup) !== marker.oldWikiHash) {
    return;
  }
  rt.storagePort.mkdirSync(dirname(marker.wikiPath), { recursive: true });
  rt.storagePort.writeAtomicDurableSync(marker.wikiPath, backup, { encoding: 'utf-8' });
}

function filesMatchExpectedHashes(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): boolean {
  const note = readFileOrNull(rt, marker.notePath);
  const wiki = readFileOrNull(rt, marker.wikiPath);
  if (note === null || wiki === null) {
    return false;
  }
  return sha256(note) === marker.newNoteHash && sha256(wiki) === marker.newWikiHash;
}

async function completeForward(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): Promise<void> {
  await rt.withMutationLock(
    async (mutation) => {
      const noteRaw = rt.storagePort.readFileSync(marker.notePath, 'utf-8');
      const wikiRaw = rt.storagePort.readFileSync(marker.wikiPath, 'utf-8');
      mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(marker.noteSlug, noteRaw));
      mutation.queueManifestAuthorityDelta(captureWikiManifestDeltas(marker.wikiSlug, wikiRaw));
      commitIndexUpdate(rt, (index) => {
        setEntry(
          index,
          marker.noteEntryId,
          buildNoteIndexEntry({
            slug: marker.noteSlug,
            title: extractTitle(noteRaw),
            body: extractBody(noteRaw),
            tags: marker.noteTags,
            principles: [],
            source: marker.noteSource,
            createdAt: marker.noteCreatedAt,
            updatedAt: marker.noteUpdatedAt,
            related: [],
            entrySeq: marker.noteEntrySeq,
          }),
        );
        const wikiSections = parseWikiBody(extractBody(wikiRaw));
        const wikiFrontmatter = parseWikiFrontmatter(wikiRaw);
        setEntry(
          index,
          marker.wikiEntryId,
          buildWikiIndexEntry({
            slug: marker.wikiSlug,
            title: extractTitle(wikiRaw),
            ...wikiFrontmatter,
            knowledge: extractKnowledgeLinks(wikiSections.knowledge),
          }),
        );
      });
      recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after promote recovery.');
    },
    {
      postFinalize: async () => {
        advanceMarker(rt, marker, 'state-committed');
        removeMemoIfPresent(rt, marker);
        advanceMarker(rt, marker, 'memo-removed');
        cleanupArtifacts(rt, marker);
      },
    },
  );
}

function removeMemoIfPresent(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): void {
  if (!rt.storagePort.existsSync(marker.memoPath)) {
    return;
  }
  rt.storagePort.rmSync(marker.memoPath, { force: true });
}

function cleanupArtifacts(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker): void {
  const dir = promoteRecoveryDir(rt.runtimeDir);
  rt.storagePort.rmSync(join(dir, 'payloads', marker.promoteId), {
    recursive: true,
    force: true,
  });
  rt.storagePort.rmSync(join(dir, 'backups', marker.promoteId), {
    recursive: true,
    force: true,
  });
  rt.storagePort.rmSync(promoteRecoveryMarkerPath(rt.runtimeDir, marker.promoteId), {
    force: true,
  });
}

function readFileOrNull(rt: PromoteRecoveryHost, path: string): string | null {
  try {
    return rt.storagePort.readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

function advanceMarker(rt: PromoteRecoveryHost, marker: PromoteRecoveryMarker, next: PromoteRecoveryPhase): void {
  const updatedAt = nowIsoString(rt.time);
  const updated: PromoteRecoveryMarker = { ...marker, phase: next, updatedAt };
  marker.phase = next;
  marker.updatedAt = updatedAt;
  rt.storagePort.writeAtomicDurableSync(
    promoteRecoveryMarkerPath(rt.runtimeDir, marker.promoteId),
    `${JSON.stringify(updated, null, 2)}\n`,
    { encoding: 'utf-8' },
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}
