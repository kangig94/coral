import { existsSync, readFileSync, rmSync } from 'node:fs';
import { nowIsoString } from '../shared/mcp-utils.js';
import { scheduleCurate } from './curate.js';
import { parseMemoFrontmatter, serializeNote } from './frontmatter.js';
import { memoPathFromContext, notePathFromParts } from './paths.js';
import type { KbPromoteInput } from './contracts.js';
import type { KbContext } from './types.js';
import {
  readKbIndex,
  recordMutationCommitted,
  withKbMutationLock,
  writeKbIndex,
} from './detect.js';
import {
  assertNonEmptyText,
  assertSlug,
  cloneKbIndex,
  markTextIndexStale,
  writeFileAtomic,
} from './mutation-helpers.js';

function duplicateNoteError(notePath: string): Error {
  return new Error(`KB note already exists: ${notePath}`);
}

export async function promote(kb: KbContext, input: KbPromoteInput): Promise<{ path: string }> {
  const memo = assertNonEmptyText(input.memo, 'memo');
  const title = assertNonEmptyText(input.title, 'title');
  if (typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const content = input.content;
  const domain = assertSlug(input.domain, 'domain');
  const topic = assertSlug(input.topic, 'topic');

  const memoPath = memoPathFromContext(kb.projectRoot, memo);
  const notePath = notePathFromParts(domain, topic);
  const memoContent = readFileSync(memoPath, 'utf-8');
  const { source } = parseMemoFrontmatter(memoContent);
  const noteName = `${domain}-${topic}`;

  const result = await withKbMutationLock(async () => {
    if (existsSync(notePath)) {
      throw duplicateNoteError(notePath);
    }

    const mutationSeqAtPromote = recordMutationCommitted().mutationSeq;
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

    const nextIndex = cloneKbIndex(readKbIndex());
    nextIndex.notes[noteName] = {
      title,
      tags: [domain],
      principles: [],
      source: [...source],
      createdAt,
      updatedAt: createdAt,
      mutationSeqAtPromote,
    };
    writeKbIndex(nextIndex);

    await markTextIndexStale('KB text snapshot is stale after kb_promote.');

    rmSync(memoPath, { force: true });
    return { path: notePath };
  });

  scheduleCurate(kb);
  return result;
}
