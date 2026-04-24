import { nowIsoString } from '../../infra/time.js';
import { captureNoteManifestDeltas } from '../corpus/manifest-authority.js';
import { serializeNote } from '../corpus/frontmatter.js';
import { loadKbNote } from '../read.js';
import { noteEntryId, setEntry, type KbUpdateInput } from '../entry-types.js';
import { assertNonEmptyText, assertNoteSlug } from '../validation.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { commitIndexUpdate, recordContentMutation } from '../corpus/index-mutations.js';
import { buildNoteIndexEntry } from '../corpus/index-records.js';
import type { KbMutationEffects, KbRuntime } from '../contracts.js';

export async function applyNoteUpdateLocked(
  rt: KbRuntime,
  mutation: KbMutationEffects,
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
  const nextRaw = serializeNote(nextFrontmatter, nextTitle, nextContent);

  writeFileAtomic(notePath, nextRaw);
  mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(input.note, nextRaw));

  commitIndexUpdate(rt, (index) => {
    setEntry(
      index,
      noteEntryId(input.note),
      buildNoteIndexEntry({
        slug: input.note,
        title: nextTitle,
        ...nextFrontmatter,
      }),
    );
  });
  recordContentMutation(rt, 'KB text snapshot is stale after kb_update.');

  return { path: notePath };
}

export async function update(rt: KbRuntime, input: KbUpdateInput): Promise<{ path: string }> {
  const note = assertNoteSlug(input.note, 'note');
  const requestedTitle = input.title === undefined ? undefined : assertNonEmptyText(input.title, 'title');
  const requestedContent = input.content;
  if (requestedContent !== undefined && typeof requestedContent !== 'string') {
    throw new Error('content must be a string');
  }

  return rt.withMutationLock(async (mutation) =>
    applyNoteUpdateLocked(
      rt,
      mutation,
      {
        note,
        title: requestedTitle,
        content: requestedContent,
      },
    ),
  );
}
