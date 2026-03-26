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

export async function update(rt: KbRuntime, input: KbUpdateInput): Promise<{ path: string }> {
  const note = assertNoteSlug(input.note, 'note');
  const notePath = rt.notePath(note);
  const title = input.title === undefined ? undefined : assertNonEmptyText(input.title, 'title');
  if (input.content !== undefined && typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const nextContent = input.content;

  return rt.withMutationLock(async () => {
    const { frontmatter, title: existingTitle, body: existingBody } = loadKbNote(notePath);
    const normalizedTitle = title ?? existingTitle;
    const normalizedContent = nextContent ?? existingBody;

    if (normalizedTitle === existingTitle && normalizedContent === existingBody) {
      return { path: notePath };
    }

    const updatedAt = nowIsoString();
    const nextFrontmatter = { ...frontmatter, updatedAt };

    writeFileAtomic(notePath, serializeNote(nextFrontmatter, normalizedTitle, normalizedContent));
    rt.recordMutationCommitted();

    commitIndexUpdate(
      rt,
      (index) => {
        index.notes[note] = buildNoteIndexEntry({
          ...frontmatter,
          title: normalizedTitle,
          updatedAt,
        });
      },
      'KB text snapshot is stale after kb_update.',
    );

    return { path: notePath };
  });
}
