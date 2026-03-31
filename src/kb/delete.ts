import { rmSync } from 'node:fs';
import { isNoEntryError } from '../shared/mcp-utils.js';
import type { KbDeleteInput } from './types.js';
import { commitIndexUpdate } from './mutation-helpers.js';
import type { KbRuntime } from './runtime.js';
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
        delete index.notes[note];
      },
      'KB text snapshot is stale after kb_delete.',
    );

    return { deleted: notePath };
  });
}
