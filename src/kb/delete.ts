import { rmSync } from 'node:fs';
import { isNoEntryError } from '../shared/mcp-utils.js';
import type { KbDeleteInput } from './contracts.js';
import { cloneKbIndex, markTextIndexStale } from './mutation-helpers.js';
import type { KbRuntime } from './runtime.js';
import { assertSlug } from './validation.js';

export async function deleteFn(rt: KbRuntime, input: KbDeleteInput): Promise<{ deleted: string }> {
  const note = assertSlug(input.note, 'note');
  const notePath = rt.notePath(note);

  return rt.withMutationLock(async () => {
    try {
      rmSync(notePath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        throw new Error(`KB note not found: ${note}`);
      }
      throw error;
    }
    rt.recordMutationCommitted();

    const nextIndex = cloneKbIndex(rt.readIndex());
    delete nextIndex.notes[note];
    rt.writeIndex(nextIndex);

    markTextIndexStale(rt.invalidateTextSnapshot, 'KB text snapshot is stale after kb_delete.');

    return { deleted: notePath };
  });
}
