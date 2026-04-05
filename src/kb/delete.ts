import { rmSync } from 'node:fs';
import { isNoEntryError } from '../shared/mcp-utils.js';
import { deleteEntry, noteEntryId, type KbDeleteInput } from './types.js';
import { commitIndexUpdate } from './mutation-helpers.js';
import type { KbRuntime } from './contracts.js';
import { assertNoteSlug } from './validation.js';

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
    rt.recordMutationCommitted();

    commitIndexUpdate(
      rt,
      (index) => {
        deleteEntry(index, noteEntryId(note));
      },
      'KB text snapshot is stale after kb_delete.',
    );

    return { deleted: notePath };
  });
}
