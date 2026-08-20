import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { nowIsoString } from '../../../infra/time.js';
import { captureNoteManifestDeltas } from '../../corpus/manifest-authority.js';
import { extractBody } from '../../corpus/frontmatter.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../../corpus/index/mutations.js';
import { buildNoteIndexEntry } from '../../corpus/index/records.js';
import { loadKbWiki } from '../../read.js';
import { memoPathFromContext } from '../../paths.js';
import {
  noteEntryId,
  setEntry,
  wikiEntryId,
  type KbWikiAdoptInput,
  type KbWikiAdoptResponse,
} from '../../entry-types.js';
import { assertNonEmptyText, assertNoteSlug, assertSlug, assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import { buildPromotedNoteFromMemo } from '../promote.js';
import {
  PROMOTE_MARKER_VERSION,
  promoteRecoveryBackupDir,
  promoteRecoveryMarkerPath,
  promoteRecoveryStagingDir,
  type PromoteRecoveryMarker,
  type PromoteRecoveryPhase,
} from '../promote-marker.js';
import { prependWikiKnowledgeLinkInMutation } from './mutation.js';

/**
 * The phase-recorded recovery marker lets `runPromoteRecovery` roll forward
 * (or back) on the next boot if a crash interrupts the multi-file write.
 */
export async function adoptIntoWiki(
  rt: KbRuntime,
  projectDataDir: string,
  input: KbWikiAdoptInput,
  onSchedule?: () => void,
): Promise<KbWikiAdoptResponse> {
  const wikiSlug = assertWikiSlug(input.slug, 'wiki');
  const memo = assertNonEmptyText(input.memo, 'memo');
  const title = assertNonEmptyText(input.title, 'title');
  if (typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const content = input.content;
  const domain = assertSlug(input.domain, 'domain');
  const topic = assertNoteSlug(input.topic, 'topic');

  const wikiPath = rt.wikiPath(wikiSlug);
  if (!rt.storagePort.existsSync(wikiPath)) {
    throw new Error(`Wiki not found: ${wikiSlug} — create it first with 'kb wiki create ${wikiSlug}'`);
  }
  loadKbWiki(rt.storagePort, wikiPath);

  let memoPath = memoPathFromContext(projectDataDir, memo);
  if (!rt.storagePort.existsSync(memoPath) && !memo.endsWith('.md')) {
    memoPath = memoPathFromContext(projectDataDir, `${memo}.md`);
  }
  if (!rt.storagePort.existsSync(memoPath)) {
    throw new Error(`Memo file not found: ${memoPath}`);
  }
  const noteSlug = `${domain}-${topic}`;
  const notePath = rt.notePath(noteSlug);

  const promoteId = rt.ids.uuid();
  const stagingDir = promoteRecoveryStagingDir(rt.runtimeDir, promoteId);
  const backupDir = promoteRecoveryBackupDir(rt.runtimeDir, promoteId);
  const stagedNotePath = join(stagingDir, 'note.md');
  const stagedWikiPath = join(stagingDir, 'wiki.md');
  const backupWikiPath = join(backupDir, 'wiki.md');

  let marker: PromoteRecoveryMarker | null = null;

  const result = await rt.withMutationLock(
    async (mutation) => {
      if (rt.storagePort.existsSync(notePath)) {
        throw new Error(`KB note already exists: ${notePath}`);
      }

      const oldWikiRaw = rt.storagePort.readFileSync(wikiPath, 'utf-8');
      const { noteRaw, noteMeta } = buildPromotedNoteFromMemo(rt, {
        memoPath,
        domain,
        title,
        content,
      });

      rt.storagePort.mkdirSync(stagingDir, { recursive: true });
      rt.storagePort.mkdirSync(backupDir, { recursive: true });
      rt.storagePort.writeAtomicDurableSync(stagedNotePath, noteRaw, { encoding: 'utf-8' });
      rt.storagePort.writeAtomicDurableSync(backupWikiPath, oldWikiRaw, { encoding: 'utf-8' });

      const activeMarker: PromoteRecoveryMarker = {
        version: PROMOTE_MARKER_VERSION,
        promoteId,
        phase: 'marker-created',
        memoPath,
        noteSlug,
        noteEntryId: noteEntryId(noteSlug),
        notePath,
        wikiSlug,
        wikiEntryId: wikiEntryId(wikiSlug),
        wikiPath,
        stagedNotePath,
        stagedWikiPath,
        backupWikiPath,
        oldWikiHash: sha256(oldWikiRaw),
        newNoteHash: sha256(noteRaw),
        newWikiHash: '',
        noteSource: noteMeta.source,
        noteCreatedAt: noteMeta.createdAt,
        noteUpdatedAt: noteMeta.updatedAt,
        noteEntrySeq: noteMeta.entrySeq,
        noteTags: noteMeta.tags,
        createdAt: nowIsoString(rt.time),
        updatedAt: nowIsoString(rt.time),
      };
      marker = activeMarker;
      writeMarker(rt, activeMarker);
      advanceMarker(rt, activeMarker, 'payloads-staged');

      writeFileAtomic(rt, notePath, noteRaw);
      advanceMarker(rt, activeMarker, 'note-written');

      await prependWikiKnowledgeLinkInMutation(rt, mutation, wikiSlug, noteEntryId(noteSlug));

      const newWikiRaw = rt.storagePort.readFileSync(wikiPath, 'utf-8');
      rt.storagePort.writeAtomicDurableSync(stagedWikiPath, newWikiRaw, { encoding: 'utf-8' });
      activeMarker.newWikiHash = sha256(newWikiRaw);
      advanceMarker(rt, activeMarker, 'wiki-written');

      mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(noteSlug, noteRaw));
      commitIndexUpdate(rt, (index) => {
        setEntry(
          index,
          noteEntryId(noteSlug),
          buildNoteIndexEntry({ slug: noteSlug, title, body: extractBody(noteRaw), ...noteMeta }),
        );
      });
      recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_wiki_adopt.');

      return { notePath };
    },
    {
      postFinalize: async () => {
        if (marker === null) return;
        advanceMarker(rt, marker, 'state-committed');
        if (rt.storagePort.existsSync(memoPath)) {
          rt.storagePort.rmSync(memoPath, { force: true });
        }
        advanceMarker(rt, marker, 'memo-removed');
        advanceMarker(rt, marker, 'cleanup-complete');
        cleanupPromoteArtifacts(rt, promoteId);
      },
    },
  );

  onSchedule?.();
  return { path: result.notePath, wikiSlug };
}

function writeMarker(rt: KbRuntime, marker: PromoteRecoveryMarker): void {
  const markerPath = promoteRecoveryMarkerPath(rt.runtimeDir, marker.promoteId);
  rt.storagePort.writeAtomicDurableSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf-8',
  });
}

function advanceMarker(rt: KbRuntime, marker: PromoteRecoveryMarker, next: PromoteRecoveryPhase): void {
  marker.phase = next;
  marker.updatedAt = nowIsoString(rt.time);
  writeMarker(rt, marker);
}

function cleanupPromoteArtifacts(rt: KbRuntime, promoteId: string): void {
  rt.storagePort.rmSync(promoteRecoveryStagingDir(rt.runtimeDir, promoteId), {
    recursive: true,
    force: true,
  });
  rt.storagePort.rmSync(promoteRecoveryBackupDir(rt.runtimeDir, promoteId), {
    recursive: true,
    force: true,
  });
  rt.storagePort.rmSync(promoteRecoveryMarkerPath(rt.runtimeDir, promoteId), { force: true });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}
