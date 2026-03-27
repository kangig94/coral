import { existsSync, readFileSync, rmSync } from 'node:fs';
import { nowIsoString } from '../shared/mcp-utils.js';
import { parseMemoFrontmatter, serializeNote } from './frontmatter.js';
import { memoPathFromContext } from './paths.js';
import type { KbPromoteInput } from './types.js';
import { assertNonEmptyText, assertNoteSlug, assertSlug } from './validation.js';
import {
  buildNoteIndexEntry,
  commitIndexUpdate,
  writeFileAtomic,
} from './mutation-helpers.js';
import type { KbRuntime } from './runtime.js';

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

  const memoPath = memoPathFromContext(projectRoot, memo);
  const note = `${domain}-${topic}`;
  const notePath = rt.notePath(note);
  if (!existsSync(memoPath)) {
    throw new Error(`Memo file not found: ${memoPath}`);
  }

  const result = await rt.withMutationLock(async () => {
    if (existsSync(notePath)) {
      throw new Error(`KB note already exists: ${notePath}`);
    }

    const memoContent = readFileSync(memoPath, 'utf-8');
    const { source } = parseMemoFrontmatter(memoContent);
    const mutationSeqAtPromote = rt.recordMutationCommitted().mutationSeq;
    const createdAt = nowIsoString();
    const noteMeta = {
      tags: [domain],
      principles: [],
      source,
      createdAt,
      updatedAt: createdAt,
      mutationSeqAtPromote,
    };
    const noteContent = serializeNote(noteMeta, title, content);

    writeFileAtomic(notePath, noteContent);

    commitIndexUpdate(
      rt,
      (index) => {
        index.notes[note] = buildNoteIndexEntry({
          ...noteMeta,
          title,
        });
      },
      'KB text snapshot is stale after kb_promote.',
    );

    rmSync(memoPath, { force: true });
    return { path: notePath };
  });

  onSchedule?.();
  return result;
}
