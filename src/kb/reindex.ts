import { runEntrySeqUpgradeGuard, type KbRuntime } from './runtime.js';
import { TextSnapshotRebuildError, rebuildTextArtifacts } from './text-artifacts.js';
import type { ReindexResult } from './types.js';
import { ensureVectorIndex } from './vector-sync.js';

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = Date.now();

  const textResult = await kb.withMutationLock(async () => {
    runEntrySeqUpgradeGuard(kb);
    const startSeq = kb.readIndexState().mutationSeq;
    let rebuildResult: Awaited<ReturnType<typeof rebuildTextArtifacts>>;

    try {
      rebuildResult = await rebuildTextArtifacts(kb, startSeq);
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
