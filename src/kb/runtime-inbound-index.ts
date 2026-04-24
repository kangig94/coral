import { isNoEntryError } from '../infra/fs-errors.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex } from './corpus/index-records.js';
import type { KbIndex } from './entry-types.js';
import { loadKbNote, loadKbSource } from './read.js';

type InboundIndexPaths = {
  notePath(note: string): string;
  sourcePath(source: string): string;
};

export function buildInboundSyncIndexDelta(
  startIndex: KbIndex | null,
  changedEntryIds: readonly string[],
  paths: InboundIndexPaths,
): KbIndex {
  const nextIndex = cloneKbIndex(startIndex);

  for (const entryId of changedEntryIds) {
    if (entryId.startsWith('note:')) {
      const slug = entryId.slice('note:'.length);
      const notePath = paths.notePath(slug);

      try {
        const { frontmatter, title } = loadKbNote(notePath);
        nextIndex.entries[entryId] = buildNoteIndexEntry({
          slug,
          title,
          ...frontmatter,
        });
      } catch (error: unknown) {
        if (!isNoEntryError(error)) {
          throw error;
        }
        delete nextIndex.entries[entryId];
      }
      continue;
    }

    if (entryId.startsWith('source:')) {
      const slug = entryId.slice('source:'.length);
      const sourcePath = paths.sourcePath(slug);

      try {
        const { frontmatter } = loadKbSource(sourcePath);
        nextIndex.entries[entryId] = buildSourceIndexEntry({
          slug,
          ...frontmatter,
        });
      } catch (error: unknown) {
        if (!isNoEntryError(error)) {
          throw error;
        }
        delete nextIndex.entries[entryId];
      }
    }
  }

  return nextIndex;
}
