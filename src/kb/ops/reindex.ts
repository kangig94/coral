import type { KbRuntime } from '../contract.js';
import { RescanError, performRescan } from '../corpus/rescan/index.js';
import type { ReindexResult } from '../entry-types.js';

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = kb.time.now();

  const textResult = await kb.withMutationLock(async (mutation) => {
    const startState = kb.readIndexState();
    let rebuildResult: Awaited<ReturnType<typeof performRescan>>;

    try {
      rebuildResult = await performRescan(
        kb,
        mutation,
        {
          contentSeq: startState.contentSeq,
          metadataSeq: startState.metadataSeq,
        },
      );
    } catch (error: unknown) {
      if (error instanceof RescanError) {
        return {
          ...error.counts,
          duration_ms: kb.time.now() - startedAt,
          mode: 'text',
          warning: error.message,
        };
      }

      throw error;
    }

    return {
      ...rebuildResult.counts,
      mode: 'text',
    };
  });
  return {
    ...textResult,
    duration_ms: kb.time.now() - startedAt,
    mode: 'text',
  };
}
