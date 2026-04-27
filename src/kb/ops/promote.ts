import { existsSync, readFileSync, rmSync } from 'node:fs';
import { nowIsoString } from '../../infra/time.js';
import { captureNoteManifestDeltas } from '../corpus/manifest-authority.js';
import { parseMemoFrontmatter, serializeNote } from '../corpus/frontmatter.js';
import { memoPathFromContext } from '../paths.js';
import { noteEntryId, setEntry, type KbPromoteInput } from '../entry-types.js';
import { assertNonEmptyText, assertNoteSlug, assertSlug } from '../validation.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../corpus/index-mutations.js';
import { buildNoteIndexEntry } from '../corpus/index-records.js';
import type { KbRuntime } from '../contract.js';
import { currentEntrySeq } from '../index-state.js';

export async function promote(
  rt: KbRuntime,
  projectRoot: string,
  input: KbPromoteInput,
  onSchedule?: () => void,
): Promise<{ path: string }> {
  const memo = assertNonEmptyText(input.memo, 'memo');
  const title = assertNonEmptyText(input.title, 'title');
  if (typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const content = input.content;
  const domain = assertSlug(input.domain, 'domain');
  const topic = assertNoteSlug(input.topic, 'topic');

  let memoPath = memoPathFromContext(projectRoot, memo);
  if (!existsSync(memoPath) && !memo.endsWith('.md')) {
    memoPath = memoPathFromContext(projectRoot, `${memo}.md`);
  }
  const note = `${domain}-${topic}`;
  const notePath = rt.notePath(note);
  if (!existsSync(memoPath)) {
    throw new Error(`Memo file not found: ${memoPath}`);
  }

  const result = await rt.withMutationLock(async (mutation) => {
    if (existsSync(notePath)) {
      throw new Error(`KB note already exists: ${notePath}`);
    }

    const memoContent = readFileSync(memoPath, 'utf-8');
    const { source } = parseMemoFrontmatter(memoContent);
    const entrySeq = currentEntrySeq(rt.readIndexState()) + 1;
    const createdAt = nowIsoString(rt.time);
    const noteMeta = {
      tags: [domain],
      principles: [],
      source,
      createdAt,
      updatedAt: createdAt,
      related: [],
      entrySeq,
    };
    const noteContent = serializeNote(noteMeta, title, content);

    writeFileAtomic(notePath, noteContent);
    mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(note, noteContent));

    commitIndexUpdate(rt, (index) => {
      setEntry(
        index,
        noteEntryId(note),
        buildNoteIndexEntry({
          slug: note,
          title,
          ...noteMeta,
        }),
      );
    });
    recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_promote.');

    rmSync(memoPath, { force: true });
    return { path: notePath };
  });

  onSchedule?.();
  return result;
}
