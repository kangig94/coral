import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { nowIsoString } from '../../infra/time.js';
import { captureNoteManifestDeltas } from '../corpus/manifest-authority.js';
import { parseMemoFrontmatter, serializeNote } from '../corpus/frontmatter.js';
import { loadKbWiki } from '../read.js';
import { memoPathFromContext } from '../paths.js';
import { noteEntryId, setEntry, wikiEntryId, type KbPromoteInput } from '../entry-types.js';
import { assertNonEmptyText, assertNoteSlug, assertSlug, assertWikiSlug } from '../validation.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../corpus/index-mutations.js';
import { buildNoteIndexEntry } from '../corpus/index-records.js';
import type { KbRuntime } from '../contract.js';
import { currentEntrySeq } from '../index-state.js';
import { prependWikiKnowledgeLinkInMutation } from './wiki/rewrite.js';
import {
  PROMOTE_MARKER_VERSION,
  promoteRecoveryBackupDir,
  promoteRecoveryMarkerPath,
  promoteRecoveryStagingDir,
  type PromoteRecoveryMarker,
  type PromoteRecoveryPhase,
} from './promote-marker.js';

export async function promote(
  rt: KbRuntime,
  projectRoot: string,
  input: KbPromoteInput,
  onSchedule?: () => void,
): Promise<{ path: string; wikiSlug?: string }> {
  const memo = assertNonEmptyText(input.memo, 'memo');
  const title = assertNonEmptyText(input.title, 'title');
  if (typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const content = input.content;
  const domain = assertSlug(input.domain, 'domain');
  const topic = assertNoteSlug(input.topic, 'topic');
  const wikiSlug = input.wiki === undefined ? undefined : assertWikiSlug(input.wiki, 'wiki');

  // Wiki target validated and loaded BEFORE any memo/note mutation so an
  // invalid target preserves the memo and creates no note (AC31).
  if (wikiSlug !== undefined) {
    const wikiPath = rt.wikiPath(wikiSlug);
    if (!rt.storagePort.existsSync(wikiPath)) {
      throw new Error(`Wiki not found: ${wikiSlug} — create it first with 'kb wiki create ${wikiSlug}'`);
    }
    loadKbWiki(rt.storagePort, wikiPath);
  }

  let memoPath = memoPathFromContext(projectRoot, memo);
  if (!rt.storagePort.existsSync(memoPath) && !memo.endsWith('.md')) {
    memoPath = memoPathFromContext(projectRoot, `${memo}.md`);
  }
  const noteSlug = `${domain}-${topic}`;
  const notePath = rt.notePath(noteSlug);
  if (!rt.storagePort.existsSync(memoPath)) {
    throw new Error(`Memo file not found: ${memoPath}`);
  }

  const result =
    wikiSlug === undefined
      ? await promoteWithoutWiki(rt, { memoPath, notePath, noteSlug, domain, title, content })
      : await promoteWithWiki(rt, {
          memoPath,
          notePath,
          noteSlug,
          domain,
          title,
          content,
          wikiSlug,
        });

  onSchedule?.();
  return wikiSlug === undefined ? result : { ...result, wikiSlug };
}

interface PromoteCommonInput {
  memoPath: string;
  notePath: string;
  noteSlug: string;
  domain: string;
  title: string;
  content: string;
}

async function promoteWithoutWiki(rt: KbRuntime, input: PromoteCommonInput): Promise<{ path: string }> {
  return rt.withMutationLock(async (mutation) => {
    if (rt.storagePort.existsSync(input.notePath)) {
      throw new Error(`KB note already exists: ${input.notePath}`);
    }
    const { noteRaw, noteMeta } = buildNoteRawFromMemo(rt, input);
    writeFileAtomic(rt, input.notePath, noteRaw);
    mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(input.noteSlug, noteRaw));
    commitIndexUpdate(rt, (index) => {
      setEntry(index, noteEntryId(input.noteSlug), buildNoteIndexEntry({ slug: input.noteSlug, title: input.title, ...noteMeta }));
    });
    recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_promote.');
    rt.storagePort.rmSync(input.memoPath, { force: true });
    return { path: input.notePath };
  });
}

interface PromoteWithWikiInput extends PromoteCommonInput {
  wikiSlug: string;
}

/**
 * Promote with a wiki target. Runs note write + wiki Knowledge prepend inside
 * one mutation lock and threads a phase-recorded recovery marker so a crash
 * at any step is rolled back or rolled forward by `runPromoteRecovery` on the
 * next coordinator boot (see AC31 + Phase I0).
 */
async function promoteWithWiki(rt: KbRuntime, input: PromoteWithWikiInput): Promise<{ path: string }> {
  const promoteId = rt.ids.uuid();
  const stagingDir = promoteRecoveryStagingDir(rt.runtimeDir, promoteId);
  const backupDir = promoteRecoveryBackupDir(rt.runtimeDir, promoteId);
  const stagedNotePath = join(stagingDir, 'note.md');
  const stagedWikiPath = join(stagingDir, 'wiki.md');
  const backupWikiPath = join(backupDir, 'wiki.md');

  // Hoisted so postFinalize can advance the same marker reference: mutating it
  // inside the lock callback and reading it from postFinalize avoids an extra
  // fsync + JSON.parse round-trip on the happy path. The recovery worker still
  // bootstraps from the on-disk marker, so it never relies on this closure.
  let marker: PromoteRecoveryMarker | null = null;

  const result = await rt.withMutationLock(
    async (mutation) => {
      if (rt.storagePort.existsSync(input.notePath)) {
        throw new Error(`KB note already exists: ${input.notePath}`);
      }

      const wikiPath = rt.wikiPath(input.wikiSlug);
      const oldWikiRaw = rt.storagePort.readFileSync(wikiPath, 'utf-8');
      const { noteRaw, noteMeta } = buildNoteRawFromMemo(rt, input);

      // Stage payloads + backup before any real-path write so recovery has a
      // hash-verifiable record even if the next step crashes mid-write.
      rt.storagePort.mkdirSync(stagingDir, { recursive: true });
      rt.storagePort.mkdirSync(backupDir, { recursive: true });
      rt.storagePort.writeAtomicDurableSync(stagedNotePath, noteRaw, { encoding: 'utf-8' });
      rt.storagePort.writeAtomicDurableSync(backupWikiPath, oldWikiRaw, { encoding: 'utf-8' });

      // newWikiHash is filled after the rewrite produces the on-disk content.
      const activeMarker: PromoteRecoveryMarker = {
        version: PROMOTE_MARKER_VERSION,
        promoteId,
        phase: 'marker-created',
        memoPath: input.memoPath,
        noteSlug: input.noteSlug,
        noteEntryId: noteEntryId(input.noteSlug),
        notePath: input.notePath,
        wikiSlug: input.wikiSlug,
        wikiEntryId: wikiEntryId(input.wikiSlug),
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

      // A throw here leaves the marker at `payloads-staged`; recovery treats
      // that as "no real-path writes happened" and discards staged artifacts.
      writeFileAtomic(rt, input.notePath, noteRaw);
      advanceMarker(rt, activeMarker, 'note-written');

      await prependWikiKnowledgeLinkInMutation(rt, mutation, input.wikiSlug, noteEntryId(input.noteSlug));

      // Capture the post-write wiki content so recovery can hash-check the
      // on-disk file against the marker before rolling forward.
      const newWikiRaw = rt.storagePort.readFileSync(wikiPath, 'utf-8');
      rt.storagePort.writeAtomicDurableSync(stagedWikiPath, newWikiRaw, { encoding: 'utf-8' });
      activeMarker.newWikiHash = sha256(newWikiRaw);
      advanceMarker(rt, activeMarker, 'wiki-written');

      mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(input.noteSlug, noteRaw));
      commitIndexUpdate(rt, (index) => {
        setEntry(index, noteEntryId(input.noteSlug), buildNoteIndexEntry({ slug: input.noteSlug, title: input.title, ...noteMeta }));
      });
      recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_promote.');

      return { notePath: input.notePath };
    },
    {
      postFinalize: async () => {
        if (marker === null) {
          // Lock callback returned without staging the marker (shouldn't happen
          // for a successful mutation, but guard preserves the previous
          // disk-bootstrap fallback shape).
          return;
        }
        advanceMarker(rt, marker, 'state-committed');
        if (rt.storagePort.existsSync(input.memoPath)) {
          rt.storagePort.rmSync(input.memoPath, { force: true });
        }
        advanceMarker(rt, marker, 'memo-removed');
        cleanupPromoteArtifacts(rt, promoteId);
      },
    },
  );

  return { path: result.notePath };
}

interface NoteMeta {
  tags: string[];
  principles: string[];
  source: string[];
  createdAt: string;
  updatedAt: string;
  related: string[];
  entrySeq: number;
}

function buildNoteRawFromMemo(
  rt: KbRuntime,
  input: PromoteCommonInput,
): { noteRaw: string; noteMeta: NoteMeta } {
  const memoContent = rt.storagePort.readFileSync(input.memoPath, 'utf-8');
  const { source } = parseMemoFrontmatter(memoContent);
  const entrySeq = currentEntrySeq(rt.readIndexState()) + 1;
  const createdAt = nowIsoString(rt.time);
  const noteMeta: NoteMeta = {
    tags: [input.domain],
    principles: [],
    source,
    createdAt,
    updatedAt: createdAt,
    related: [],
    entrySeq,
  };
  const noteRaw = serializeNote(noteMeta, input.title, input.content);
  return { noteRaw, noteMeta };
}

// Helpers below operate on the marker file via the runtime storage port. The
// marker is the durable handoff between the in-flight mutation and the
// startup recovery worker; every transition is tmp+fsync+rename+parent-fsync
// (writeAtomicDurableSync) so a crash leaves either the previous or the next
// phase visible — never an intermediate.

function writeMarker(rt: KbRuntime, marker: PromoteRecoveryMarker): void {
  const markerPath = promoteRecoveryMarkerPath(rt.runtimeDir, marker.promoteId);
  rt.storagePort.writeAtomicDurableSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf-8',
  });
}

function advanceMarker(
  rt: KbRuntime,
  marker: PromoteRecoveryMarker,
  next: PromoteRecoveryPhase,
): void {
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
