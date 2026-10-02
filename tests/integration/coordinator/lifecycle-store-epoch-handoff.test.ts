import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLifecycle,
  createRuntimeState,
  StartupStoreHandoffError,
  type LifecycleDeps,
} from '#src/coordinator/lifecycle.js';
import {
  installSuccessionAttemptChild,
  type SuccessionAttemptChild,
} from '#src/coordinator/succession/attempt-child.js';
import * as successionProtocol from '#src/coordinator/succession/protocol.js';
import * as upgradeIntent from '#src/infra/upgrade-intent.js';
import { SuccessionAttemptStartupHoldError } from '#src/coordinator/succession/startup.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { KB_COMPONENT_ID } from '#src/coordinator/runtime-components/contract.js';
import { type BackendInfo } from '#src/infra/backend-discovery.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import {
  encodeResolvedStoreEpoch,
  listStoreEpochs,
  retirementMintDisposition,
  settleStoreEpoch,
  type ResolvedStoreEpoch,
  type StoreEpochOptions,
} from '#src/store/epoch/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import * as handoffRouting from '#src/coordinator/handoff-routing/runner.js';
import {
  ACTIVE_STORE_SELECTION_VERSION,
  encodeActiveStoreSelection,
  resolveActiveStoreRecordPaths,
} from '#src/store/active-store-selection.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const roots: string[] = [];

afterEach(() => {
  installSuccessionAttemptChild(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function lifecycleHarness(
  writeBackendInfoFn: (info: BackendInfo) => boolean | void,
  successionAttemptChild: SuccessionAttemptChild | null = null,
  authorizeStartupMint: StoreEpochOptions['authorizeMint'] = ({ incumbent, observedEpochCount }) =>
    incumbent === null && observedEpochCount === 0 ? retirementMintDisposition('initial', null) : null,
  overrides: Partial<LifecycleDeps> = {},
  existingRoot?: string,
) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'coral-lifecycle-store-epoch-'));
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  if (existingRoot === undefined) roots.push(root);
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
  const registerBuiltInProvidersFn = vi.fn();
  const lifecycle = createLifecycle(
    {
      storeFormat,
      identity,
      runtime,
      authorizeStartupMint,
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
      successionIncumbent: () => ({
        instanceId: 'test-coordinator',
        pid: process.pid,
        incarnation: null,
        version: '0.0.0',
        bundleHash: 'test-bundle',
        flavor: 'prod',
      }),
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
      registerBuiltInProvidersFn,
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
      ...overrides,
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
    registerBuiltInProvidersFn,
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
      recovery: false,
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
    const initial = settleStoreEpoch(runtime, {
      storeFormat,
      build,
      authorizeMint: ({ incumbent, observedEpochCount }) =>
        incumbent === null && observedEpochCount === 0 ? retirementMintDisposition('initial', null) : null,
    });
    initial.db.close();
    agreedPath = initial.store.path;
    const epochKey = encodeResolvedStoreEpoch(runtime, initial.store);
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

  it('should hand a newer selected build the store before binding anything', async () => {
    const harness = lifecycleHarness(vi.fn((_info: BackendInfo) => true));
    const { runtime, storeFormat, identity } = harness;
    const selectionFile = resolveActiveStoreRecordPaths(runtime).selectionFile;
    mkdirSync(dirname(selectionFile), { recursive: true, mode: 0o700 });
    writeFileSync(
      selectionFile,
      encodeActiveStoreSelection({
        version: ACTIVE_STORE_SELECTION_VERSION,
        manifest: {
          version: '99.0.0',
          buildSetId: '323e4567-e89b-42d3-a456-426614174000',
          bundleHash: 'aaaaaaaaaaaaaaaa',
          cliBundleHash: 'aaaaaaaaaaaaaaaa',
          claudeAppserverBundleHash: 'aaaaaaaaaaaaaaaa',
          durableWrapperBundleHash: 'aaaaaaaaaaaaaaaa',
          flavor: identity.flavor,
          storeFormatFingerprint: storeFormat.fingerprint,
        },
        bundleDir: join(identity.pluginRoot, '..', 'newer', 'bridge'),
        activeStoreFingerprint: storeFormat.fingerprint,
      }),
      { mode: 0o600 },
    );
    vi.spyOn(handoffRouting, 'validateForeignHandoffTarget').mockReturnValue({
      kind: 'validated',
      target: { build: { version: '99.0.0' } },
    } as never);

    try {
      await expect(harness.lifecycle.start()).rejects.toBeInstanceOf(StartupStoreHandoffError);
      expect(harness.registerBuiltInProvidersFn).not.toHaveBeenCalled();
    } finally {
      await disposeHarness(harness);
    }
  });

  it('should observe a withheld retirement mint again within the same startup instead of failing it', async () => {
    const decisions: (ReturnType<typeof retirementMintDisposition> | null)[] = [];
    const authorize = vi.fn<NonNullable<StoreEpochOptions['authorizeMint']>>(({ incumbentEpochKey }) => {
      const disposition = decisions.length === 0 ? null : retirementMintDisposition('unopenable', incumbentEpochKey);
      decisions.push(disposition);
      return disposition;
    });
    const harness = lifecycleHarness(
      vi.fn((_info: BackendInfo) => true),
      null,
      authorize,
    );
    const { runtime, storeFormat, identity } = harness;
    const settled = settleStoreEpoch(runtime, {
      storeFormat,
      build: {
        version: identity.version,
        buildSetId: identity.buildSetId,
        bundleHash: identity.bundleHash,
        cliBundleHash: identity.cliBundleHash,
        claudeAppserverBundleHash: identity.claudeAppserverBundleHash,
        durableWrapperBundleHash: identity.durableWrapperBundleHash,
        flavor: identity.flavor,
        storeFormatFingerprint: storeFormat.fingerprint,
      },
      authorizeMint: ({ incumbent, observedEpochCount }) =>
        incumbent === null && observedEpochCount === 0 ? retirementMintDisposition('initial', null) : null,
    });
    settled.db.close();
    const unreadable = newRawDatabase(settled.store.path);
    unreadable.exec(`UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint'`);
    unreadable.close();
    vi.spyOn(runtime.time, 'sleep').mockResolvedValue(undefined);

    try {
      await harness.lifecycle.start();
      expect(decisions.map((decision) => decision?.kind ?? null)).toEqual([null, 'unopenable']);
      expect(listStoreEpochs(runtime).map(({ epoch }) => epoch)).toContain('2');
    } finally {
      await disposeHarness(harness);
    }
  });

  it('should refuse a retirement mint withheld on both observations with a typed hold naming the next startup', async () => {
    const harness = lifecycleHarness(
      vi.fn((_info: BackendInfo) => true),
      null,
      () => null,
    );
    const { runtime, storeFormat, identity } = harness;
    const settled = settleStoreEpoch(runtime, {
      storeFormat,
      build: {
        version: identity.version,
        buildSetId: identity.buildSetId,
        bundleHash: identity.bundleHash,
        cliBundleHash: identity.cliBundleHash,
        claudeAppserverBundleHash: identity.claudeAppserverBundleHash,
        durableWrapperBundleHash: identity.durableWrapperBundleHash,
        flavor: identity.flavor,
        storeFormatFingerprint: storeFormat.fingerprint,
      },
      authorizeMint: ({ incumbent, observedEpochCount }) =>
        incumbent === null && observedEpochCount === 0 ? retirementMintDisposition('initial', null) : null,
    });
    settled.db.close();
    const unreadable = newRawDatabase(settled.store.path);
    unreadable.exec(`UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint'`);
    unreadable.close();
    vi.spyOn(runtime.time, 'sleep').mockResolvedValue(undefined);

    try {
      const refused = await harness.lifecycle.start().then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(SuccessionAttemptStartupHoldError);
      expect((refused as SuccessionAttemptStartupHoldError).hold).toMatchObject({
        kind: 'retirement-mint-withheld',
        attemptId: null,
      });
      expect((refused as Error).message).toContain('the next startup observes it again');
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
