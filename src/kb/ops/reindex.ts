import type { KbRuntime } from '../contract.js';
import { performRescan } from '../corpus/rescan/index.js';
import type { ReindexResult } from '../entry-types.js';

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = kb.time.now();

  const counts = await kb.withMutationLock(async (mutation) => {
    const startState = kb.readIndexState();
    return performRescan(kb, mutation, {
      contentSeq: startState.contentSeq,
      metadataSeq: startState.metadataSeq,
    });
  });

  return {
    ...counts,
    duration_ms: kb.time.now() - startedAt,
    mode: 'text',
  };
}
