import { afterEach, describe, expect, it, vi } from 'vitest';

import { startKiwiArtifactFetchOnBoot } from '#src/kb-daemon/expansion/kiwi-boot.js';
import type { ForcedCorpusFreshnessTarget } from '#src/projection-consumers/index.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/constants.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createEmptyGeneratedCommunityProjectionStore } from '#tests/fixtures/test-runtime.js';

function createSnapshot(): KbCorpusSnapshot {
  return {
    snapshotId: 'snapshot-1',
    contentSeq: 1,
    metadataSeq: 2,
    contentManifestHash: 'content-1',
    metadataManifestHash: 'metadata-2',
  };
}

function createRuntime(options: { now?: () => number; sleep?: Runtime['time']['sleep'] } = {}): Runtime {
  return {
    time: {
      now: options.now ?? (() => 0),
      sleep: options.sleep ?? (async () => {}),
    },
  } as Runtime;
}

describe('startKiwiArtifactFetchOnBoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts artifact fetch without blocking boot and reindexes the latest snapshot after fetch', async () => {
    let snapshot = createSnapshot();
    let ready = false;
    let resolveFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const events: string[] = [];

    const handle = startKiwiArtifactFetchOnBoot({
      runtime: createRuntime(),
      kb: {
        declaredAnalyzers: ['ko'],
        generatedCommunityProjectionStore: createEmptyGeneratedCommunityProjectionStore(),
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
      onArtifactFetchStart: () => {
        events.push('health:fetching');
      },
      onArtifactFetchEnd: () => {
        events.push('health:idle');
      },
      hasArtifact: () => ready,
      ensureArtifact: async () => {
        events.push('fetch:start');
        await fetchGate;
        events.push('fetch:done');
        snapshot = { ...snapshot, snapshotId: 'snapshot-2', contentSeq: 3 };
        ready = true;
        return {
          status: 'installed',
          method: 'runtime-download',
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
      'invalidate:kiwi-artifact-installed',
      `force:snapshot-2:${ORAMA_BASE_CONSUMER_ID}`,
      `wait:${ORAMA_BASE_CONSUMER_ID}:7`,
    ]);
  });

  it('retries after contention beyond the former 30-second horizon and installs after the lock is released', async () => {
    let ready = false;
    let attempts = 0;
    const sleepDelays: number[] = [];
    const infoLog = vi.spyOn(backendLog, 'info').mockImplementation(() => {});
    const runtime = createRuntime({
      now: () => (attempts === 0 ? 0 : 31_000),
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
    });
    const invalidateTextSnapshot = vi.fn(() => ({ contentSeq: 1, metadataSeq: 2 }));
    const forceCorpusApply = vi.fn((_snapshot, options) => ({
      generation: 1,
      consumers: options.consumers,
    }));
    const observedLockTimeouts: Array<number | undefined> = [];
    const ensureArtifact = vi.fn(async (_runtime: Runtime, options?: { readonly lockTimeoutMs?: number }) => {
      observedLockTimeouts.push(options?.lockTimeoutMs);
      attempts += 1;
      if (attempts < 5) {
        return {
          status: 'error' as const,
          code: 'expansion_install_lock_contended',
          userMessage: 'busy',
          remediation: 'wait',
        };
      }
      ready = true;
      return {
        status: 'installed' as const,
        method: 'runtime-download' as const,
        version: '0.23.0',
        targetDir: '/tmp/kiwi',
      };
    });

    const handle = startKiwiArtifactFetchOnBoot({
      runtime,
      kb: {
        declaredAnalyzers: ['ko'],
        generatedCommunityProjectionStore: createEmptyGeneratedCommunityProjectionStore(),
        getCorpusStateSnapshot: createSnapshot,
        invalidateTextSnapshot,
      },
      driver: {
        forceCorpusApply,
        waitFreshUntil: async () => {},
      },
      timeoutMs: 25,
      signal: new AbortController().signal,
      hasArtifact: () => ready,
      ensureArtifact,
      lockProbeTimeoutMs: 7,
      lockRetryDelayMs: 10,
      lockRetryMaxDelayMs: 25,
    });

    await handle.completed;

    expect(ensureArtifact).toHaveBeenCalledTimes(5);
    expect(observedLockTimeouts).toEqual([7, 7, 7, 7, 7]);
    expect(sleepDelays).toEqual([10, 20, 25, 25]);
    expect(invalidateTextSnapshot).toHaveBeenCalledTimes(1);
    expect(forceCorpusApply).toHaveBeenCalledTimes(1);
    expect(
      infoLog.mock.calls.filter(([message]) => String(message).includes('another package operation holds')).length,
    ).toBe(1);
  });
});
