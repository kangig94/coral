import type { KbRuntime } from '../contract.js';
import { performRescan } from '../corpus/rescan/index.js';
import type { ReindexResult } from '../entry-types.js';

/** Heavy-path mutation deadline for `kb reindex` — full corpus rescans on
 * large KBs legitimately exceed the 60s default. */
export const KB_REINDEX_MUTATION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = kb.time.now();

  const counts = await kb.withMutationLock(
    async (mutation) => {
      const startState = kb.readIndexState();
      return performRescan(kb, mutation, {
        contentSeq: startState.contentSeq,
        metadataSeq: startState.metadataSeq,
      });
    },
    { timeoutMs: KB_REINDEX_MUTATION_LOCK_TIMEOUT_MS },
  );

  return {
    ...counts,
    duration_ms: kb.time.now() - startedAt,
    mode: 'text',
  };
}
