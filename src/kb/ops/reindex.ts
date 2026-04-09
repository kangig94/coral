import type { KbRuntime } from '../contracts.js';
import { runEntrySeqUpgradeGuard } from '../entry-seq-guard.js';
import { TextSnapshotRebuildError, rebuildTextArtifactsAndPersistRepairState } from '../curate/text-artifacts.js';
import type { ReindexResult } from '../types.js';
import { ensureVectorIndex } from '../vector/sync.js';

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = Date.now();

  const textResult = await kb.withMutationLock(async () => {
    runEntrySeqUpgradeGuard(kb);
    const startState = kb.readIndexState();
    let rebuildResult: Awaited<ReturnType<typeof rebuildTextArtifactsAndPersistRepairState>>;

    try {
      rebuildResult = await rebuildTextArtifactsAndPersistRepairState(kb, {
        contentSeq: startState.contentSeq,
        metadataSeq: startState.metadataSeq,
      });
    } catch (error: unknown) {
      if (error instanceof TextSnapshotRebuildError) {
        return {
          ...error.counts,
          duration_ms: Date.now() - startedAt,
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

  const vectorResult = await ensureVectorIndex(kb);
  return {
    ...textResult,
    duration_ms: Date.now() - startedAt,
    mode: vectorResult.mode,
    ...(vectorResult.warning === undefined ? {} : { warning: vectorResult.warning }),
  };
}
