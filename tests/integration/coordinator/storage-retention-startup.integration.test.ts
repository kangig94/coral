import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

vi.mock('#src/jobs/export-retention.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneJobExports: async () => '',
}));
vi.mock('#src/jobs/progress-retention.js', () => ({ pruneJobProgress: async () => 0 }));
vi.mock('#src/store/retention-vacuum.js', () => ({
  vacuumRetainedJournal: async () => ({ kind: 'kept', subject: 'vacuum', reason: 'no-free-pages' }),
}));
vi.mock('#src/store/epoch/legacy-retention.js', () => ({
  removeLegacyStore: () => ({ kind: 'kept', subject: 'legacy', reason: 'legacy-absent' }),
}));
vi.mock('#src/store/epoch/holder.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneStoreEpochHolders: async () => {},
}));

afterEach(() => vi.useRealTimers());

describe('retention startup composition', () => {
  it('serves a NONE-mode store without a helper and shuts down during stalled cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = createRetentionFixture();
    let serving = false;
    let storeMode: () => unknown = () => undefined;
    const cleanup = vi.fn(() => {
      if (!serving) throw new Error('cleanup delayed running');
      return new Promise<void>(() => {});
    });
    const core = createCoordinatorCore(
      {
        onFatalShutdownError: vi.fn(),
        storeFormat: currentCoralStoreFormat(),
        runtime: f.runtime,
        backendNamespace: 'retention-startup',
        bootSnapshot: {
          version: '0.10.16',
          buildSetId: '123e4567-e89b-42d3-a456-426614174000',
          bundleHash: '0123456789abcdef',
          flavor: 'prod',
          instanceId: 'retention-startup',
          token: 'test-token',
          now: f.runtime.time.now,
          log: () => {},
        },
        kbDaemonSupervisor: createMockKbDaemonSupervisor(),
        createStoreServicesFromDbFn: (db) => {
          db.exec('PRAGMA auto_vacuum=NONE');
          db.exec('VACUUM');
          storeMode = () => db.prepare('PRAGMA auto_vacuum').get();
          return {
            storeDb: db,
            progressStore: new JobStore('retention-startup', f.runtime, createEventBodyCodec(), {
              db,
              reducers: f.reducers,
              providers: permissiveProviderLookupPort,
            }),
            consumerDriver: null,
          };
        },
        createServerFn: (handler) => createServer(handler),
        listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
        closeServerFn: async () => {},
        writeBackendInfoFn: () => {},
        removeBackendInfoIfOwnerFn: () => {},
        cleanupStaleJobsFn: cleanup,
        registerBuiltInProvidersFn: () => {},
        settlePendingLaunchesFn: async () => ({ kind: 'all-pending-launches-settled' }),
        terminateRegisteredChildrenFn: async () => ({ kind: 'all-children-observed-absent' }),
        getConsumerStuck: () => [],
      },
      async () => [],
    );
    const spawn = vi.spyOn(f.runtime.process, 'spawn');
    try {
      await core.lifecycleController.start();
      expect(spawn).not.toHaveBeenCalled();
      expect(storeMode()).toEqual({ auto_vacuum: 0 });
      expect(core.runtimeState.getLifecycle()).toBe('running');
      expect(cleanup).not.toHaveBeenCalled();
      serving = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanup).toHaveBeenCalledOnce();
      expect((await core.lifecycleController.shutdown('test-teardown')).disposition).toBe('finalized');
      await core.lifecycleController.waitForShutdown();
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await core.lifecycleController.shutdown('test-teardown');
      await core.lifecycleController.waitForShutdown();
      f.close();
    }
  });
});
