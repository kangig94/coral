import { errorMessage } from '../shared/mcp-utils.js';
import { rebuildEnhancedIndex } from './reindex-enhanced.js';
import { runEntrySeqUpgradeGuard, type KbRuntime } from './runtime.js';
import { TextSnapshotRebuildError, rebuildTextArtifacts } from './text-artifacts.js';
import type { ReindexResult } from './types.js';

function hybridWarning(error: unknown): string {
  return `KB vector tables were not rebuilt: ${errorMessage(error)}. Text search remains available.`;
}

export async function reindex(kb: KbRuntime): Promise<ReindexResult> {
  const startedAt = Date.now();
  const adapter = kb.adapter;

  return kb.withMutationLock(async () => {
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

    let warning: string | undefined;

    if (adapter !== null) {
      try {
        await rebuildEnhancedIndex(kb, rebuildResult.notes);
      } catch (error: unknown) {
        warning = hybridWarning(error);
      }
    }

    return {
      ...rebuildResult.counts,
      duration_ms: Date.now() - startedAt,
      mode: 'text',
      ...(warning === undefined ? {} : { warning }),
    };
  });
}
