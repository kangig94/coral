import { nowIsoString } from '../shared/mcp-utils.js';
import { serializeNote } from './frontmatter.js';
import { loadKbNote } from './read.js';
import type { KbUpdateInput } from './types.js';
import { assertNonEmptyText, assertNoteSlug } from './validation.js';
import {
  buildNoteIndexEntry,
  commitIndexUpdate,
  writeFileAtomic,
} from './mutation-helpers.js';
import type { KbRuntime } from './runtime.js';

export async function applyNoteUpdateLocked(
  rt: KbRuntime,
  input: { note: string; title?: string; content?: string },
): Promise<{ path: string }> {
  const notePath = rt.notePath(input.note);
  const { frontmatter, title: existingTitle, body: existingBody } = loadKbNote(notePath);
  const nextTitle = input.title ?? existingTitle;
  const nextContent = input.content ?? existingBody;

  if (nextTitle === existingTitle && nextContent === existingBody) {
    return { path: notePath };
  }

  const updatedAt = nowIsoString();
  const nextFrontmatter = { ...frontmatter, updatedAt };

  writeFileAtomic(notePath, serializeNote(nextFrontmatter, nextTitle, nextContent));
  rt.recordMutationCommitted();

  commitIndexUpdate(
    rt,
    (index) => {
      index.notes[input.note] = buildNoteIndexEntry({
        ...nextFrontmatter,
        title: nextTitle,
      });
    },
    'KB text snapshot is stale after kb_update.',
  );

  return { path: notePath };
}

export async function update(rt: KbRuntime, input: KbUpdateInput): Promise<{ path: string }> {
  const note = assertNoteSlug(input.note, 'note');
  const requestedTitle = input.title === undefined ? undefined : assertNonEmptyText(input.title, 'title');
  const requestedContent = input.content;
  if (requestedContent !== undefined && typeof requestedContent !== 'string') {
    throw new Error('content must be a string');
  }

  return rt.withMutationLock(async () => applyNoteUpdateLocked(rt, {
    note,
    ...(requestedTitle === undefined ? {} : { title: requestedTitle }),
    ...(requestedContent === undefined ? {} : { content: requestedContent }),
  }));
}
