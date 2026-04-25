import type { KbRuntime } from '../contracts.js';
import { TextSnapshotRebuildError, rebuildTextArtifactsAndPersistRepairState } from '../curate/text-artifacts/index.js';
import type { ReindexResult } from '../entry-types.js';

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = kb.time.now();

  const textResult = await kb.withMutationLock(async (mutation) => {
    const startState = kb.readIndexState();
    let rebuildResult: Awaited<ReturnType<typeof rebuildTextArtifactsAndPersistRepairState>>;

    try {
      rebuildResult = await rebuildTextArtifactsAndPersistRepairState(
        kb,
        mutation,
        {
          contentSeq: startState.contentSeq,
          metadataSeq: startState.metadataSeq,
        },
      );
    } catch (error: unknown) {
      if (error instanceof TextSnapshotRebuildError) {
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
