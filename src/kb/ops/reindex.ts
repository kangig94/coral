import type { KbRuntime } from '../contract.js';
import { performRescan } from '../corpus/rescan/index.js';
import { isWikiEntry, type ReindexResult } from '../entry-types.js';

/** Heavy-path mutation deadline for `kb reindex` — full corpus rescans on
 * large KBs legitimately exceed the 60s default. */
export const KB_REINDEX_MUTATION_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** `signal` is the caller's AbortSignal — threaded from the KB job's
 * coordinator-owned AbortRegistry into `withMutationLock` and into
 * `performRescan` so `'scan'` / `'repair'` checkpoints honor it. */
export async function reindex(kb: KbRuntime, options?: { signal?: AbortSignal }): Promise<ReindexResult> {
  const startedAt = kb.time.now();
  const signal = options?.signal;

  // The destructured `lockSignal` is the composed signal from the mutation
  // lock (caller signal + internal deadline) and propagates into rescan.
  const counts = await kb.withMutationLock(
    async (mutation, { signal: lockSignal }) => {
      const startState = kb.readIndexState();
      const counts = await performRescan(
        kb,
        mutation,
        {
          contentSeq: startState.contentSeq,
          metadataSeq: startState.metadataSeq,
        },
        { signal: lockSignal },
      );
      const wikis = Object.values(kb.readIndexOrEmpty().entries).filter(isWikiEntry).length;
      return { ...counts, wikis };
    },
    {
      timeoutMs: KB_REINDEX_MUTATION_LOCK_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    },
  );

  return {
    ...counts,
    duration_ms: kb.time.now() - startedAt,
    mode: 'text',
  };
}
