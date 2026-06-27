import { describe, expect, it } from 'vitest';

import { startKiwiArtifactFetchOnBoot } from '#src/coordinator/kb-child/expansion/lifecycle.js';
import type { ForcedCorpusFreshnessTarget } from '#src/coordinator/consumer-driver/index.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/backend.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';
import type { Runtime } from '#src/runtime/ports.js';

function createSnapshot(): KbCorpusSnapshot {
  return {
    snapshotId: 'snapshot-1',
    contentSeq: 1,
    metadataSeq: 2,
    contentManifestHash: 'content-1',
    metadataManifestHash: 'metadata-2',
  };
}

describe('startKiwiArtifactFetchOnBoot', () => {
  it('starts model fetch without blocking boot and forces Orama reindex after fetch', async () => {
    const snapshot = createSnapshot();
    let resolveFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const events: string[] = [];

    const handle = startKiwiArtifactFetchOnBoot({
      runtime: {} as Runtime,
      kb: {
        declaredAnalyzers: ['ko'],
        getCorpusStateSnapshot: () => snapshot,
        invalidateTextSnapshot: (reason: string) => {
          events.push(`invalidate:${reason}`);
          return { contentSeq: 1, metadataSeq: 2, textStaleReason: reason };
        },
      },
      driver: {
        forceCorpusApply: (forcedSnapshot, options) => {
          events.push(`force:${forcedSnapshot.snapshotId}:${options.consumers.join(',')}`);
          return { generation: 7, consumers: options.consumers };
        },
        waitFreshUntil: async (_authority, target, consumerId) => {
          const forcedTarget = target as ForcedCorpusFreshnessTarget;
          events.push(`wait:${consumerId}:${forcedTarget.atLeastGeneration}`);
        },
      },
      timeoutMs: 25,
      signal: new AbortController().signal,
      onModelFetchStart: () => {
        events.push('health:fetching');
      },
      onModelFetchEnd: () => {
        events.push('health:idle');
      },
      hasModelArtifact: () => false,
      ensureModelArtifact: async () => {
        events.push('fetch:start');
        await fetchGate;
        events.push('fetch:done');
        return {
          status: 'installed',
          method: 'github-release',
          version: '0.23.0',
          targetDir: '/tmp/kiwi',
        };
      },
    });

    expect(handle.started).toBe(true);
    expect(events).toEqual(['health:fetching', 'fetch:start']);

    resolveFetch();
    await handle.completed;

    expect(events).toEqual([
      'health:fetching',
      'fetch:start',
      'fetch:done',
      'health:idle',
      'invalidate:kiwi-model-installed',
      `force:snapshot-1:${ORAMA_BASE_CONSUMER_ID}`,
      `wait:${ORAMA_BASE_CONSUMER_ID}:7`,
    ]);
  });

  it('does nothing when Korean is not declared', () => {
    const handle = startKiwiArtifactFetchOnBoot({
      runtime: {} as Runtime,
      kb: {
        declaredAnalyzers: [],
        getCorpusStateSnapshot: createSnapshot,
        invalidateTextSnapshot: () => ({ contentSeq: 0, metadataSeq: 0 }),
      },
      driver: {
        forceCorpusApply: () => ({ generation: 1, consumers: [] }),
        waitFreshUntil: async () => {},
      },
      timeoutMs: 25,
      signal: new AbortController().signal,
      hasModelArtifact: () => false,
      ensureModelArtifact: async () => {
        throw new Error('should not fetch');
      },
    });

    expect(handle).toEqual({ started: false, completed: null });
  });
});
