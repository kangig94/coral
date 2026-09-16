import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLifecycle, createRuntimeState } from '#src/coordinator/lifecycle.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { KB_COMPONENT_ID } from '#src/coordinator/runtime-components/contract.js';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { ResolvedStoreEpoch } from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function lifecycleHarness(writeBackendInfoFn: (info: BackendInfo) => boolean | void) {
  const root = mkdtempSync(join(tmpdir(), 'coral-lifecycle-store-epoch-'));
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: join(root, 'state') });
  const storeFormat = currentCoralStoreFormat();
  const storeServicesRef = createStoreServicesRef();
  const scheduleStoreEpochSweepFn = vi.fn<(openStore: ResolvedStoreEpoch) => void>();
  const kbDaemonSupervisor = createMockKbDaemonSupervisor();
  const runtimeState = createRuntimeState(0, {
    register: vi.fn(),
    initAll: vi.fn(),
    disposeAll: vi.fn(async () => {}),
    list: vi.fn(() => []),
    status: vi.fn(() => null),
  } as never);
  const lifecycle = createLifecycle(
    {
      storeFormat,
      identity: {
        pluginRoot,
        namespace: 'lifecycle-store-epoch-handoff',
        version: storeFormat.productVersion,
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        cliBundleHash: '1123456789abcdef',
        claudeAppserverBundleHash: '2123456789abcdef',
        durableWrapperBundleHash: '3123456789abcdef',
        flavor: 'prod',
        instanceId: 'lifecycle-store-epoch-handoff',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        now: () => runtime.time.now(),
        log: () => {},
      },
      runtime,
      backendPid: process.pid,
      runtimeState,
      idleTimer: {
        inflightRequests: 0,
        isDraining: false,
        beginRequest: vi.fn(),
        endRequest: vi.fn(),
        requestDrain: vi.fn(),
        startWatching: vi.fn(),
        stopWatching: vi.fn(),
      } as never,
      storeServicesRef,
      createStoreServicesFromDbFn: (storeDb) => ({
        storeDb,
        progressStore: new JobStore('lifecycle-store-epoch-handoff', runtime, createEventBodyCodec(), {
          db: storeDb,
          providers: permissiveProviderLookupPort,
        }),
        consumerDriver: null,
      }),
      streamResponses: new Set(),
      discussStores: new Map(),
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
      launchCoordinator: new LaunchCoordinator({ runtime }),
      providerRegistry: {} as never,
      server: createServer(),
      getExecutionService: vi.fn() as never,
      getRecoveryService: vi.fn() as never,
      listExecutionServices: () => [],
      scheduleStoreEpochSweepFn,
      stopStoreEpochSweepFn: vi.fn(async () => {}),
      getDiscussStoreForSource: vi.fn() as never,
      knownDiscussSources: () => new Set(),
      getDiscussContext: vi.fn() as never,
      writeBackendInfoFn,
      removeBackendInfoIfOwnerFn: vi.fn(),
      cleanupStaleJobsFn: vi.fn(),
      markJobsAsErrorFn: vi.fn(),
      terminateAllFn: vi.fn(async () => ({ kind: 'all-observed-absent' as const })),
      providerHostManager: { drainForHandoff: vi.fn(), shutdown: vi.fn(async () => {}) } as never,
      handoffQuiescePorts: () => [],
      kbDaemonSupervisor,
      createKbHealthComponentFn: () => ({
        id: KB_COMPONENT_ID,
        status: { id: KB_COMPONENT_ID, phase: 'initializing', attempt: 0 },
        init: async () => {},
        dispose: async () => {},
      }),
      registerBuiltInProvidersFn: vi.fn(),
      recoverPersistedDiscussFn: vi.fn(async () => []),
      hooks: {
        onShutdown: vi.fn(async () => {}),
        onIdleCheck: () => false,
        onRecoveryComplete: vi.fn(async () => {}),
      },
      closeServerFn: vi.fn(async () => {}),
      listenFn: vi.fn(async () => ({ port: 0, host: '127.0.0.1' })),
    },
    async () => [],
  );

  return {
    lifecycle,
    runtimeState,
    storeServicesRef,
    scheduleStoreEpochSweepFn,
    kbDaemonSupervisor,
  };
}

async function disposeHarness(harness: ReturnType<typeof lifecycleHarness>): Promise<void> {
  if (harness.runtimeState.getLifecycle() !== 'stopped') await harness.lifecycle.shutdown('test-complete');
  const services = harness.storeServicesRef.tryGet();
  services?.storeDb.close();
  harness.storeServicesRef.clear();
}

describe('lifecycle store epoch handoff', () => {
  it('passes the resolved filesystem epoch to discovery, the sweep, and the KB daemon', async () => {
    const writeBackendInfoFn = vi.fn((_info: BackendInfo) => true);
    const harness = lifecycleHarness(writeBackendInfoFn);

    try {
      await harness.lifecycle.start();

      expect(writeBackendInfoFn).toHaveBeenCalledTimes(1);
      expect(harness.scheduleStoreEpochSweepFn).toHaveBeenCalledTimes(1);
      expect(harness.kbDaemonSupervisor.start).toHaveBeenCalledTimes(1);
      const publishedEpoch = writeBackendInfoFn.mock.calls[0]?.[0].storeEpoch;
      const scheduledStore = harness.scheduleStoreEpochSweepFn.mock.calls[0]?.[0];
      const daemonStore = vi.mocked(harness.kbDaemonSupervisor.start).mock.calls[0]?.[0];
      expect(publishedEpoch).toBe('1');
      expect(scheduledStore?.epoch).toBe(publishedEpoch);
      expect(daemonStore).toBe(scheduledStore);
    } finally {
      await disposeHarness(harness);
    }
  });

  it('fails startup when discovery publication refuses the resolved epoch', async () => {
    const writeBackendInfoFn = vi.fn((_info: BackendInfo) => false);
    const harness = lifecycleHarness(writeBackendInfoFn);

    try {
      await expect(harness.lifecycle.start()).rejects.toThrow('Coordinator discovery publication failed.');
      expect(writeBackendInfoFn.mock.calls[0]?.[0].storeEpoch).toBe('1');
      expect(harness.runtimeState.getLifecycle()).toBe('stopped');
      expect(harness.scheduleStoreEpochSweepFn).not.toHaveBeenCalled();
      expect(harness.kbDaemonSupervisor.start).not.toHaveBeenCalled();
    } finally {
      await disposeHarness(harness);
    }
  });
});
