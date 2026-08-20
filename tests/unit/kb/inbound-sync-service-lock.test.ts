import { describe, expect, it } from 'vitest';

import { CorpusInboundSyncService, type CorpusInboundSyncServiceOptions } from '#src/kb/corpus/inbound-sync-service.js';
import { KbIndexStore } from '#src/kb/corpus/index/store.js';
import { createManifestAuthority } from '#src/kb/corpus/manifest-authority.js';
import { createCorpusStorage } from '#src/kb/corpus/rescan/storage.js';
import type { KbIndex } from '#src/kb/entry-types.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('CorpusInboundSyncService', () => {
  it('runs inbound sync through the cross-process mutation wrapper before the controller lock', async () => {
    const events: string[] = [];
    const runtime = new SimulationRuntime();
    const indexStore = new KbIndexStore({
      runtimeDir: '/tmp/coral-inbound-sync-service-lock/runtime',
      storage: runtime.storage,
      ids: { uuid: () => 'inbound-sync-service-lock' },
    });
    indexStore.writeIndex = () => {
      throw new Error('writeIndex should not run for no-change sync');
    };
    const manifestAuthority = createManifestAuthority();
    manifestAuthority.replaceCurrentSurfaceHashes = () => {
      throw new Error('replaceCurrentSurfaceHashes should not run for no-change sync');
    };
    const options: CorpusInboundSyncServiceOptions = {
      indexStore,
      manifestAuthority,
      mutationLockController: {
        withMutationLock: async (fn) => {
          events.push('controller:start');
          const controller = new AbortController();
          const result = await fn(
            {
              startIndex: null as unknown as KbIndex,
              pendingMutationLane: null,
              pendingMutationReason: undefined,
              publication: null,
              pendingOpaqueDeltas: [],
              finalized: false,
            },
            { signal: controller.signal },
          );
          events.push('controller:end');
          return result;
        },
        diagnostics: () => ({ blocked: false }),
      },
      mutationEffects: {
        queueManifestAuthorityDelta: () => {
          throw new Error('queueManifestAuthorityDelta should not run for no-change sync');
        },
        writeEntityGraph: () => {
          throw new Error('writeEntityGraph should not run for no-change sync');
        },
      },
      target: {
        markdownRoot: '/tmp/coral-inbound-sync-service-lock',
        corpusStorage: createCorpusStorage(runtime.storage),
        storagePort: runtime.storage,
        entityGraphPath: () => '/tmp/coral-inbound-sync-service-lock/.entity-graph.json',
        notePath: (note: string) => `/tmp/coral-inbound-sync-service-lock/notes/${note}.md`,
        wikiPath: (slug: string) => `/tmp/coral-inbound-sync-service-lock/wiki/${slug}.md`,
        sourcePath: (source: string) => `/tmp/coral-inbound-sync-service-lock/sources/${source}.md`,
        communityPath: (community: string) => `/tmp/coral-inbound-sync-service-lock/communities/${community}.md`,
        principlePath: (principle: string) => `/tmp/coral-inbound-sync-service-lock/principles/${principle}.md`,
        generatedCommunitySlugs: () => new Set(),
      },
      recordMutationCommitted: () => {
        throw new Error('recordMutationCommitted should not run for no-change sync');
      },
      invalidateKbCache: () => {
        throw new Error('invalidateKbCache should not run for no-change sync');
      },
      async withDirectoryMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
        events.push('directory:start');
        const result = await fn();
        events.push('directory:end');
        return result;
      },
    };
    const service = new CorpusInboundSyncService(options);

    const result = await service.runInboundSync(
      () => {
        events.push('fn');
        return { kind: 'no-change' as const };
      },
      { structuredDiff: true },
    );

    expect(result).toEqual({ kind: 'no-change' });
    expect(events).toEqual(['directory:start', 'controller:start', 'fn', 'controller:end', 'directory:end']);
  });

  it('passes inbound sync abort signal to the cross-process mutation wrapper', async () => {
    const runtime = new SimulationRuntime();
    const indexStore = new KbIndexStore({
      runtimeDir: '/tmp/coral-inbound-sync-service-signal/runtime',
      storage: runtime.storage,
      ids: { uuid: () => 'inbound-sync-service-signal' },
    });
    const manifestAuthority = createManifestAuthority();
    const controller = new AbortController();
    const service = new CorpusInboundSyncService({
      indexStore,
      manifestAuthority,
      mutationLockController: {
        withMutationLock: async (fn, options) => {
          expect(options?.signal).toBe(controller.signal);
          return fn(
            {
              startIndex: null as unknown as KbIndex,
              pendingMutationLane: null,
              pendingMutationReason: undefined,
              publication: null,
              pendingOpaqueDeltas: [],
              finalized: false,
            },
            { signal: controller.signal },
          );
        },
        diagnostics: () => ({ blocked: false }),
      },
      mutationEffects: {
        queueManifestAuthorityDelta: () => {
          throw new Error('queueManifestAuthorityDelta should not run for no-change sync');
        },
        writeEntityGraph: () => {
          throw new Error('writeEntityGraph should not run for no-change sync');
        },
      },
      target: {
        markdownRoot: '/tmp/coral-inbound-sync-service-signal',
        corpusStorage: createCorpusStorage(runtime.storage),
        storagePort: runtime.storage,
        entityGraphPath: () => '/tmp/coral-inbound-sync-service-signal/.entity-graph.json',
        notePath: (note: string) => `/tmp/coral-inbound-sync-service-signal/notes/${note}.md`,
        wikiPath: (slug: string) => `/tmp/coral-inbound-sync-service-signal/wiki/${slug}.md`,
        sourcePath: (source: string) => `/tmp/coral-inbound-sync-service-signal/sources/${source}.md`,
        communityPath: (community: string) => `/tmp/coral-inbound-sync-service-signal/communities/${community}.md`,
        principlePath: (principle: string) => `/tmp/coral-inbound-sync-service-signal/principles/${principle}.md`,
        generatedCommunitySlugs: () => new Set(),
      },
      async withDirectoryMutationLock<T>(fn: () => Promise<T> | T, options?: { signal?: AbortSignal }): Promise<T> {
        expect(options?.signal).toBe(controller.signal);
        return fn();
      },
      recordMutationCommitted: () => {
        throw new Error('recordMutationCommitted should not run for no-change sync');
      },
      invalidateKbCache: () => {
        throw new Error('invalidateKbCache should not run for no-change sync');
      },
    });

    await expect(
      service.runInboundSync(() => ({ kind: 'no-change' as const }), { signal: controller.signal }),
    ).resolves.toEqual({ kind: 'no-change' });
  });
});
