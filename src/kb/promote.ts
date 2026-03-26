import { existsSync, readFileSync, rmSync } from 'node:fs';
import { nowIsoString } from '../shared/mcp-utils.js';
import { parseMemoFrontmatter, serializeNote } from './frontmatter.js';
import { memoPathFromContext } from './paths.js';
import type { KbPromoteInput } from './contracts.js';
import {
  assertNonEmptyText,
  assertSlug,
  cloneKbIndex,
  markTextIndexStale,
  writeFileAtomic,
} from './mutation-helpers.js';
import type { KbRuntime } from './runtime.js';

function duplicateNoteError(notePath: string): Error {
  return new Error(`KB note already exists: ${notePath}`);
}

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
  const topic = assertSlug(input.topic, 'topic');

  const memoPath = memoPathFromContext(projectRoot, memo);
  const noteName = `${domain}-${topic}`;
  const notePath = rt.notePath(noteName);
  const memoContent = readFileSync(memoPath, 'utf-8');
  const { source } = parseMemoFrontmatter(memoContent);

  const result = await rt.withMutationLock(async () => {
    if (existsSync(notePath)) {
      throw duplicateNoteError(notePath);
    }

    const mutationSeqAtPromote = rt.recordMutationCommitted().mutationSeq;
    const createdAt = nowIsoString();
    const noteContent = serializeNote({
      tags: [domain],
      principles: [],
      source,
      createdAt,
      updatedAt: createdAt,
      mutationSeqAtPromote,
    }, title, content);

    writeFileAtomic(notePath, noteContent);

    const nextIndex = cloneKbIndex(rt.readIndex());
    nextIndex.notes[noteName] = {
      title,
      tags: [domain],
      principles: [],
      source: [...source],
      createdAt,
      updatedAt: createdAt,
      mutationSeqAtPromote,
    };
    rt.writeIndex(nextIndex);

    markTextIndexStale(rt.invalidateTextSnapshot, 'KB text snapshot is stale after kb_promote.');

    rmSync(memoPath, { force: true });
    return { path: notePath };
  });

  onSchedule?.();
  return result;
}
