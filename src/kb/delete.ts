import { rmSync } from 'node:fs';
import { notePathFromName } from './paths.js';
import type { KbDeleteInput } from './contracts.js';
import type { KbContext } from './types.js';
import {
  readKbIndex,
  recordMutationCommitted,
  withKbMutationLock,
  writeKbIndex,
} from './detect.js';
import { assertSlug, cloneKbIndex, markTextIndexStale } from './mutation-helpers.js';

export async function deleteFn(_kb: KbContext, input: KbDeleteInput): Promise<{ deleted: string }> {
  const note = assertSlug(input.note, 'note');
  const notePath = notePathFromName(note);

  return withKbMutationLock(async () => {
    rmSync(notePath);
    recordMutationCommitted();

    const nextIndex = cloneKbIndex(readKbIndex());
    delete nextIndex.notes[note];
    writeKbIndex(nextIndex);

    await markTextIndexStale('KB text snapshot is stale after kb_delete.');

    return { deleted: notePath };
  });
}
