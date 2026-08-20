import type { KbRuntime } from '../contract.js';
import { performRescan } from '../corpus/rescan/index.js';
import type { ReindexResult } from '../entry-types.js';
import { throwIfAborted } from '../../runtime/abort.js';

const MAX_REINDEX_COMMIT_ATTEMPTS = 2;

export async function reindex(kb: KbRuntime, options?: { signal?: AbortSignal }): Promise<ReindexResult> {
  const startedAt = kb.time.now();
  const signal = options?.signal;

  for (let attempt = 0; attempt < MAX_REINDEX_COMMIT_ATTEMPTS; attempt += 1) {
    if (signal !== undefined) {
      throwIfAborted(signal, 'scan');
    }
    const startState = kb.readIndexState();
    const result = await performRescan(
      kb,
      {
        contentSeq: startState.contentSeq,
        metadataSeq: startState.metadataSeq,
      },
      { signal },
    );
    if (result.status === 'committed') {
      return {
        ...result.counts,
        duration_ms: kb.time.now() - startedAt,
        mode: 'text',
      };
    }
  }

  return {
    notes: 0,
    sources: 0,
    communities: 0,
    wikis: 0,
    principles: 0,
    tags: 0,
    entities: 0,
    relationships: 0,
    entityCoverage: 0,
    duration_ms: kb.time.now() - startedAt,
    mode: 'text',
    warning: 'kb_reindex_discarded_stale_seq',
  };
}
