import { rmSync } from 'node:fs';
import { isNoEntryError } from '../../shared/utils.js';
import { deleteEntry, noteEntryId, type KbDeleteInput } from '../entry-types.js';
import { commitIndexUpdate, recordContentAndMetadataMutation } from '../corpus/mutation-helpers.js';
import type { KbRuntime } from '../contracts.js';
import { assertNoteSlug } from '../validation.js';

export async function deleteFn(rt: KbRuntime, input: KbDeleteInput): Promise<{ deleted: string }> {
  const note = assertNoteSlug(input.note, 'note');
  const notePath = rt.notePath(note);

  return rt.withMutationLock(async () => {
    try {
      rmSync(notePath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        throw new Error(`KB note not found: ${note}`, { cause: error });
      }
      throw error;
    }
    recordContentAndMetadataMutation(rt, 'KB text snapshot is stale after kb_delete.');

    commitIndexUpdate(rt, (index) => {
      deleteEntry(index, noteEntryId(note));
    });

    return { deleted: notePath };
  });
}
