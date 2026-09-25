import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLifecycle, createRuntimeState } from '#src/coordinator/lifecycle.js';
import {
  installSuccessionAttemptChild,
  type SuccessionAttemptChild,
} from '#src/coordinator/succession/attempt-child.js';
import * as successionProtocol from '#src/coordinator/succession/protocol.js';
import * as upgradeIntent from '#src/infra/upgrade-intent.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { KB_COMPONENT_ID } from '#src/coordinator/runtime-components/contract.js';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import {
  encodeResolvedStoreEpoch,
  listStoreEpochs,
  settleStoreEpoch,
  type ResolvedStoreEpoch,
} from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const roots: string[] = [];

afterEach(() => {
  installSuccessionAttemptChild(null);
  vi.restoreAllMocks();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function lifecycleHarness(
  writeBackendInfoFn: (info: BackendInfo) => boolean | void,
  successionAttemptChild: SuccessionAttemptChild | null = null,
) {
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
  const identity = {
    pluginRoot,
    namespace: 'lifecycle-store-epoch-handoff',
    version: storeFormat.productVersion,
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    bundleHash: '0123456789abcdef',
    cliBundleHash: '1123456789abcdef',
    claudeAppserverBundleHash: '2123456789abcdef',
    durableWrapperBundleHash: '3123456789abcdef',
    flavor: 'prod' as const,
    instanceId: 'lifecycle-store-epoch-handoff',
    token: 'test-token',
    bootToken: 'test-boot-token',
    shutdownToken: 'test-shutdown-token',
    now: () => runtime.time.now(),
    log: () => {},
  };
  const ipcServer: IpcListener = { server: createNetServer(), sockets: new Set(), socketPath: null };
  const lifecycle = createLifecycle(
    {
      storeFormat,
      identity,
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
      readSelfIncarnationFn: () => null,
      markJobsAsErrorFn: vi.fn(),
      settlePendingLaunchesFn: vi.fn(async () => ({ kind: 'all-pending-launches-settled' }) as const),
      terminateRegisteredChildrenFn: vi.fn(async () => ({ kind: 'all-children-observed-absent' }) as const),
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
      ...(successionAttemptChild === null
        ? {}
        : {
            ipcServer,
            listenIpcFn: vi.fn(),
            closeIpcServerFn: vi.fn(async () => {}),
          }),
      onFatalShutdownError: vi.fn(),
    },
    async () => [],
  );

  return {
    lifecycle,
    runtimeState,
    storeServicesRef,
    scheduleStoreEpochSweepFn,
    kbDaemonSupervisor,
    runtime,
    storeFormat,
    identity,
  };
}

async function disposeHarness(harness: ReturnType<typeof lifecycleHarness>): Promise<void> {
  if (harness.runtimeState.getLifecycle() !== 'stopped') await harness.lifecycle.shutdown('test-teardown');
  const services = harness.storeServicesRef.tryGet();
  services?.storeDb.close();
  harness.storeServicesRef.clear();
}

describe('lifecycle store epoch handoff', () => {
  it('reports an attempt child open hold after acceptance without minting or publishing', async () => {
    let agreedPath: string | null = null;
    const child: SuccessionAttemptChild = {
      attemptId: 'attempt-open-hold',
      bootToken: 'test-boot-token',
      epochKey: '',
      receiptIds: [],
      adoptListeners: vi.fn(async () => {}),
      acknowledge: vi.fn(async () => {}),
      waitForWritersParked: vi.fn(async () => {
        if (agreedPath === null) throw new Error('agreed epoch was not prepared');
        writeFileSync(agreedPath, '');
      }),
      waitForServing: vi.fn(async () => {}),
      isServing: () => false,
      markServing: vi.fn(),
    };
    const writeBackendInfoFn = vi.fn((_info: BackendInfo) => true);
    const harness = lifecycleHarness(writeBackendInfoFn, child);
    const { runtime, storeFormat, identity } = harness;
    const build = {
      version: identity.version,
      buildSetId: identity.buildSetId,
      bundleHash: identity.bundleHash,
      cliBundleHash: identity.cliBundleHash,
      claudeAppserverBundleHash: identity.claudeAppserverBundleHash,
      durableWrapperBundleHash: identity.durableWrapperBundleHash,
      flavor: identity.flavor,
      storeFormatFingerprint: storeFormat.fingerprint,
    };
    const initial = settleStoreEpoch(runtime, { storeFormat, build });
    initial.db.close();
    agreedPath = initial.store.path;
    const epochKey = encodeResolvedStoreEpoch(initial.store);
    const targetKey = JSON.stringify([
      identity.pluginRoot,
      identity.version,
      identity.buildSetId,
      identity.flavor,
      storeFormat.fingerprint,
      identity.bundleHash,
      identity.cliBundleHash,
      identity.claudeAppserverBundleHash,
      identity.durableWrapperBundleHash,
    ]);
    const capabilities = {
      version: 'v1',
      buildSetId: identity.buildSetId,
      bundleHash: identity.bundleHash,
      protocols: ['prepare', 'commit'],
      accepts: [],
    };
    const preparation = {
      version: 'v1',
      requestId: 'request-open-hold',
      attemptId: child.attemptId,
      incumbentInstanceId: 'incumbent',
      incumbentPid: process.pid,
      incumbentKey: JSON.stringify(['incumbent', process.pid, null, 'old-version', 'old-bundle', 'prod']),
      targetKey,
      capabilitiesKey: JSON.stringify(capabilities),
      epochKey,
      admissionRevision: 0,
      accepts: [],
      receipts: [],
      stage: 'prepared',
      ready: null,
    };
    const intent = {
      version: 'v1',
      requestId: preparation.requestId,
      revision: 1,
      incumbent: {
        instanceId: 'incumbent',
        pid: process.pid,
        incarnation: null,
        version: 'old-version',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: identity.pluginRoot },
      attemptId: child.attemptId,
      attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: process.pid, incarnation: null },
      disposition: 'pending',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: preparation,
    };
    vi.spyOn(upgradeIntent, 'readUpgradeIntent').mockReturnValue({ kind: 'readable', intent } as never);
    vi.spyOn(upgradeIntent, 'revalidateUpgradeIntentTarget').mockReturnValue({ kind: 'validated' } as never);
    vi.spyOn(successionProtocol, 'readSuccessionCapabilities').mockReturnValue({
      kind: 'declared',
      capabilities,
    } as never);
    installSuccessionAttemptChild({ ...child, epochKey });

    try {
      await expect(harness.lifecycle.start()).rejects.toThrow('Succession attempt startup holds: open-failed');
      expect(child.acknowledge).toHaveBeenCalledWith({ kind: 'ready', epochKey, receiptIds: [] });
      expect(child.acknowledge).toHaveBeenCalledWith({
        kind: 'hold',
        reason: 'Succession attempt startup holds: open-failed',
      });
      expect(child.adoptListeners).toHaveBeenCalledTimes(1);
      expect(child.waitForWritersParked).toHaveBeenCalledTimes(1);
      expect(writeBackendInfoFn).not.toHaveBeenCalled();
      expect(harness.scheduleStoreEpochSweepFn).not.toHaveBeenCalled();
      expect(listStoreEpochs(runtime).map(({ epoch }) => epoch)).toEqual(['1']);
      expect(harness.runtimeState.getLifecycle()).toBe('stopped');
    } finally {
      await disposeHarness(harness);
    }
  });

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
