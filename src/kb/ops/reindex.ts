import type { KbRuntime } from '../contract.js';
import { performRescan } from '../corpus/rescan/index.js';
import type { ReindexResult } from '../entry-types.js';

/** Heavy-path mutation deadline for `kb reindex` — full corpus rescans on
 * large KBs legitimately exceed the 60s default. */
export const KB_REINDEX_MUTATION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = kb.time.now();

  // Cooperative: the destructured `signal` is the composed signal from the
  // mutation-lock (caller signal + internal deadline). Phase 6 threads it
  // into `performRescan` for `'scan'` / `'repair'` checkpoints.
  const counts = await kb.withMutationLock(
    async (mutation, { signal: _signal }) => {
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
