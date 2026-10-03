import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { handoffRoutingStatusPathForRunDir } from '#src/infra/path/coordinator.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import {
  handoffRoutingStatusStoreSchema,
  publishGenerationCoordinatedHandoffRoutingTransitions,
  readHandoffRoutingStatus,
} from '#src/coordinator/handoff-routing/status.js';

async function verifyReconciliationStartup(gateBeforeReadiness: boolean): Promise<void> {
  const f = createRetentionFixture();
  const runtime = {
    ...f.runtime,
    process: {
      ...f.runtime.process,
      observeProcessIdentities: vi.fn<typeof f.runtime.process.observeProcessIdentities>(async (owners) =>
        owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' } })),
      ),
    },
  };
  const interval = vi.spyOn(runtime.time, 'setInterval');
  const clearInterval = vi.spyOn(runtime.time, 'clearInterval');
  const path = handoffRoutingStatusPathForRunDir(
    runtime.paths.coral.coordinator.runDir,
    handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema()),
  );
  expect(
    await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [
      {
        kind: 'routing-selected',
        eventId: 'selection',
        invocationId: 'pending',
        observedAt: new Date(runtime.time.now()).toISOString(),
        owner: { pid: 101, incarnation: testIncarnation(101) },
        disposition: {
          kind: 'continue-current',
          basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
        },
      },
    ]),
  ).toMatchObject({ kind: 'committed' });
  let releaseRecovery = () => {};
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  let enteredRecovery = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredRecovery = resolve;
  });
  let releaseListener = () => {};
  const listener = new Promise<void>((resolve) => {
    releaseListener = resolve;
  });
  let enteredListener = () => {};
  const listening = new Promise<void>((resolve) => {
    enteredListener = resolve;
  });
  const core = createCoordinatorCore(
    {
      onFatalShutdownError: vi.fn(),
      storeFormat: currentCoralStoreFormat(),
      runtime,
      backendNamespace: 'routing-startup',
      bootSnapshot: {
        version: '0.10.17',
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        instanceId: 'routing-startup',
        token: 'test-token',
        now: runtime.time.now,
        log: () => {},
      },
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      createStoreServicesFromDbFn: (db) => ({
        storeDb: db,
        progressStore: new JobStore('routing-startup', runtime, createEventBodyCodec(), {
          db,
          reducers: f.reducers,
          providers: permissiveProviderLookupPort,
        }),
        consumerDriver: null,
      }),
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        enteredListener();
        if (gateBeforeReadiness) await listener;
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn: () => {},
      cleanupStaleJobsFn: () => {},
      registerBuiltInProvidersFn: () => {},
      settlePendingLaunchesFn: async () => ({ kind: 'all-pending-launches-settled' }),
      terminateRegisteredChildrenFn: async () => ({ kind: 'all-children-observed-absent' }),
      getConsumerStuck: () => [],
    },
    async () => {
      enteredRecovery();
      await recovery;
      return [];
    },
  );
  const starting = core.lifecycleController.start();
  try {
    if (gateBeforeReadiness) {
      await listening;
      expect(core.runtimeState.getLifecycle()).toBe('starting');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtime.process.observeProcessIdentities).not.toHaveBeenCalled();
      expect(interval.mock.calls.some(([, ms]) => ms === 1_000)).toBe(false);
      expect(readHandoffRoutingStatus(runtime, path)).toMatchObject({
        kind: 'current',
        statuses: [{ kind: 'unresolved' }],
      });
      releaseListener();
    }
    await entered;
    expect(core.runtimeState.getLifecycle()).toBe('kernel-ready');
    await vi.waitFor(() =>
      expect(readHandoffRoutingStatus(runtime, path)).toMatchObject({
        kind: 'current',
        statuses: [{ kind: 'retired', tombstone: { resolutionReason: 'owner-absent' } }],
      }),
    );
    const index = interval.mock.calls.findIndex(([, ms]) => ms === 1_000);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = interval.mock.results[index].value;
    releaseRecovery();
    await starting;
    expect(core.runtimeState.getLifecycle()).toBe('running');
    await core.lifecycleController.shutdown('test-teardown');
    expect(clearInterval).toHaveBeenCalledWith(timer);
  } finally {
    releaseListener();
    releaseRecovery();
    await starting;
    await core.lifecycleController.shutdown('test-teardown');
    vi.restoreAllMocks();
    f.close();
  }
}

it('does not sweep before kernel readiness', async () => {
  await verifyReconciliationStartup(true);
});

it('reconciles at kernel readiness while recovery is stalled and stops its interval on shutdown', async () => {
  await verifyReconciliationStartup(false);
});
