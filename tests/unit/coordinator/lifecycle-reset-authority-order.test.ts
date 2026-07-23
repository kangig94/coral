import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeStoreServices } from '#src/coordinator/index.js';
import {
  createStoreServicesRef,
  type CoordinatorStoreServices,
} from '#src/coordinator/composition/store-services-ref.js';
import { createLifecycle, STARTUP_STORE_BUSY_TIMEOUT_MS, type LifecycleDeps } from '#src/coordinator/lifecycle.js';
import { KB_COMPONENT_ID } from '#src/coordinator/runtime-components/contract.js';
import type { Runtime } from '#src/runtime/ports.js';
import type * as HandoffMod from '#src/coordinator/handoff.js';
import type * as StoreDbMod from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const mockState = vi.hoisted(() => {
  const events: string[] = [];
  const fakeDb = {
    closed: false,
    close: vi.fn(() => {
      fakeDb.closed = true;
      events.push('storeDb.close');
    }),
  };

  return { events, fakeDb };
});

vi.mock('#src/coordinator/handoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffMod>();
  return {
    ...actual,
    bindWithHandoff: vi.fn(async () => {
      mockState.events.push('bindWithHandoff:return');
      return { acquiredViaHandoff: false };
    }),
  };
});

vi.mock('#src/store/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreDbMod>();
  return {
    ...actual,
    createBackendStoreResetAuthority: vi.fn((runtime, handoff, options) => {
      mockState.events.push('resetAuthority:create');
      return {
        socketPath: runtime.paths.coral.coordinator.socketPath,
        storeDbPath: runtime.paths.coral.store.dbFile,
        bundleHash: options.bundleHash,
        flavor: runtime.flavor,
        namespace: options.namespace,
        acquiredViaHandoff: handoff.acquiredViaHandoff,
        issuedAt: runtime.time.now(),
      };
    }),
    openOrResetBackendStoreDb: vi.fn(() => {
      mockState.events.push('storeDb:openOrReset');
      return mockState.fakeDb;
    }),
  };
});

function makeRuntime(): Runtime {
  const sleep: Runtime['time']['sleep'] = (ms, options) =>
    new Promise<void>((resolve) => {
      if (options?.signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, Math.min(Math.max(ms, 0), 1));
      options?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  return {
    flavor: 'prod',
    time: {
      now: () => Date.now(),
      sleep,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    storage: {
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      writeAtomicSync: vi.fn(),
    },
    process: {
      isAlive: () => false,
      kill: vi.fn(),
    },
    ids: {
      uuid: () => 'uuid',
      randomBytes: () => Buffer.alloc(32),
      sha256: () => 'sha256',
    },
    env: {
      get: () => undefined,
      cwd: () => process.cwd(),
      pid: () => process.pid,
      platform: () => process.platform,
      arch: () => process.arch,
      coralSnapshot: () => ({}),
    },
    paths: {
      projectSource: (projectRoot: string) => projectRoot,
      coral: {
        coordinator: {
          socketPath: '/tmp/coral-lifecycle-order.sock',
          runDir: '/tmp',
          infoFile: '/tmp/coral-lifecycle-order.json',
        },
        store: {
          dbDir: '/tmp/coral-lifecycle-order-store',
          dbFile: '/tmp/coral-lifecycle-order-store/store.db',
          walFile: '/tmp/coral-lifecycle-order-store/store.db-wal',
          shmFile: '/tmp/coral-lifecycle-order-store/store.db-shm',
        },
        exports: { jobsRoot: '/tmp/coral-lifecycle-order-jobs' },
        corpus: {
          kbRoot: '/tmp/coral-lifecycle-order-kb',
          notesDir: '/tmp/coral-lifecycle-order-kb/notes',
          sourcesDir: '/tmp/coral-lifecycle-order-kb/sources',
          principlesDir: '/tmp/coral-lifecycle-order-kb/principles',
          communitiesDir: '/tmp/coral-lifecycle-order-kb/communities',
        },
        engine: {
          engineRoot: '/tmp/coral-lifecycle-order-engines',
          dataDir: (name: string) => `/tmp/coral-lifecycle-order-engines/${name}`,
          installLockPath: (name: string) => `/tmp/coral-lifecycle-order-engines/${name}/install.lock`,
        },
      },
    },
  } as unknown as Runtime;
}

function makeLifecycleDeps(): { deps: LifecycleDeps; servicesRef: ReturnType<typeof createStoreServicesRef> } {
  const runtime = makeRuntime();
  const servicesRef = createStoreServicesRef();
  const server = createServer();
  const fakeProgressStore = {
    getDb: () => mockState.fakeDb,
    liveJobCountByNamespace: () => 0,
  };
  const consumerDriver = {
    shutdown: vi.fn(async () => {
      mockState.events.push('consumerDriver:shutdown');
    }),
  };
  const services = {
    storeDb: mockState.fakeDb,
    progressStore: fakeProgressStore,
    consumerDriver,
  } as unknown as CoordinatorStoreServices;
  let lifecycleState: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped' = 'starting';

  return {
    servicesRef,
    deps: {
      storeFormat: currentCoralStoreFormat(),
      identity: {
        pluginRoot: '/tmp/plugin',
        namespace: 'test-ns',
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'test-instance',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        now: () => 1_000,
        log: (message) => {
          mockState.events.push(`log:${message.trim()}`);
        },
      },
      runtime,
      backendPid: process.pid,
      runtimeState: {
        getLifecycle: () => lifecycleState,
        getStartedAt: () => 1_000,
        getLaunchFenceActive: () => false,
        components: {
          register: vi.fn(() => {
            mockState.events.push('components:register');
          }),
          initAll: vi.fn(() => {
            mockState.events.push('components:initAll');
          }),
          disposeAll: vi.fn(async () => {
            mockState.events.push('components:disposeAll');
          }),
          list: vi.fn(() => []),
          status: vi.fn(() => null),
        } as never,
        setLifecycle: vi.fn((state) => {
          mockState.events.push(`setLifecycle:${state}`);
          lifecycleState = state;
        }),
        setStartedAt: vi.fn(),
        setLaunchFenceActive: vi.fn(),
      } as unknown as LifecycleDeps['runtimeState'],
      idleTimer: {
        inflightRequests: 0,
        isDraining: false,
        beginRequest: vi.fn(),
        endRequest: vi.fn(),
        requestDrain: vi.fn(),
        startWatching: vi.fn(),
        stopWatching: vi.fn(),
      } as unknown as LifecycleDeps['idleTimer'],
      storeServicesRef: servicesRef,
      createStoreServicesFromDbFn: () => {
        mockState.events.push('storeServices:create');
        return services;
      },
      streamResponses: new Set(),
      discussStores: new Map(),
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
      launchCoordinator: { active: 0, queueDepth: () => 0, terminateAll: vi.fn() } as never,
      providerRegistry: {} as never,
      server,
      getExecutionService: vi.fn() as never,
      getRecoveryService: vi.fn() as never,
      listExecutionServices: () => [],
      getDiscussStoreForSource: vi.fn() as never,
      knownDiscussSources: () => new Set(),
      getDiscussContext: vi.fn() as never,
      writeBackendInfoFn: vi.fn(() => {
        mockState.events.push('backendInfo:write');
      }),
      removeBackendInfoIfOwnerFn: vi.fn(),
      cleanupStaleJobsFn: vi.fn(() => {
        mockState.events.push('cleanup:after-services');
      }),
      markJobsAsErrorFn: vi.fn(() => {
        expect(mockState.fakeDb.closed).toBe(false);
        mockState.events.push('markJobsAsError:live-store');
      }),
      terminateAllFn: vi.fn(() => {
        mockState.events.push('terminateAll');
      }),
      providerHostManager: {
        shutdown: vi.fn(async () => {
          mockState.events.push('providerHostManager:shutdown');
        }),
        drainForHandoff: vi.fn(),
      } as never,
      handoffQuiescePorts: () => [],
      createKbHealthComponentFn: vi.fn(() => ({
        id: KB_COMPONENT_ID,
        status: { id: KB_COMPONENT_ID, phase: 'initializing', attempt: 0 },
        init: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      })) as never,
      registerBuiltInProvidersFn: vi.fn(),
      recoverPersistedDiscussFn: vi.fn(async () => []),
      runStartupRecoveryFn: vi.fn(async () => []),
      hooks: {
        onShutdown: vi.fn(async () => {
          mockState.events.push('hooks:onShutdown');
        }),
        onIdleCheck: () => false,
        onRecoveryComplete: vi.fn(async () => {}),
      },
      closeServerFn: vi.fn(async () => {}),
      listenFn: vi.fn(async () => ({ port: 4321, host: '127.0.0.1' })),
      ipcServer: {} as never,
      closeIpcServerFn: vi.fn(async () => {}),
      listenIpcFn: vi.fn(async () => ({ socketPath: runtime.paths.coral.coordinator.socketPath })),
    },
  };
}

afterEach(() => {
  mockState.events.length = 0;
  mockState.fakeDb.closed = false;
  vi.clearAllMocks();
});

describe('lifecycle reset authority and finalizer order', () => {
  it('rejects an invalid system provider scope before creating destructive store authority', async () => {
    const { deps: baseDeps } = makeLifecycleDeps();
    const deps: LifecycleDeps = {
      ...baseDeps,
      systemProviderScope: { name: 'invalid-system', profiles: [] } as never,
      providerRegistry: {
        decodeScope: () => ({
          ok: false,
          failure: { reason: 'duplicate-provider-profile', provider: 'codex' },
        }),
      } as never,
      registerBuiltInProvidersFn: vi.fn(() => {
        mockState.events.push('providers:register');
      }),
    };
    const lifecycle = createLifecycle(deps);

    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'system_provider_scope_invalid' });

    expect(mockState.events).toContain('providers:register');
    expect(mockState.events).not.toContain('resetAuthority:create');
    expect(mockState.events).not.toContain('storeDb:openOrReset');
  });

  it('creates reset authority only after bindWithHandoff returns', async () => {
    const { deps } = makeLifecycleDeps();
    const lifecycle = createLifecycle(deps);

    await lifecycle.start();

    expect(mockState.events.indexOf('bindWithHandoff:return')).toBeLessThan(
      mockState.events.indexOf('resetAuthority:create'),
    );
    expect(mockState.events.indexOf('resetAuthority:create')).toBeLessThan(
      mockState.events.indexOf('storeDb:openOrReset'),
    );
    expect(mockState.events.indexOf('storeDb:openOrReset')).toBeLessThan(
      mockState.events.indexOf('storeServices:create'),
    );
  });

  it('threads the startup abort signal into handoff binding', async () => {
    const { deps } = makeLifecycleDeps();
    const lifecycle = createLifecycle(deps);
    const handoff = await import('#src/coordinator/handoff.js');

    await lifecycle.start();

    const handoffOptions = vi.mocked(handoff.bindWithHandoff).mock.calls[0]?.[0];
    const startupSignal = handoffOptions?.signal;
    expect(startupSignal).toBeInstanceOf(AbortSignal);
    expect(startupSignal?.aborted).toBe(false);
  });

  it('opens the startup store with a short busy timeout', async () => {
    const { deps } = makeLifecycleDeps();
    const lifecycle = createLifecycle(deps);
    const storeDb = await import('#src/store/db.js');

    await lifecycle.start();

    expect(storeDb.openOrResetBackendStoreDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ startupBusyTimeoutMs: STARTUP_STORE_BUSY_TIMEOUT_MS }),
    );
  });

  it('registers components before exposing the running lifecycle', async () => {
    const { deps } = makeLifecycleDeps();
    const lifecycle = createLifecycle(deps);

    await lifecycle.start();

    expect(mockState.events.indexOf('components:register')).toBeGreaterThan(-1);
    expect(mockState.events.indexOf('components:register')).toBeLessThan(
      mockState.events.indexOf('setLifecycle:running'),
    );
    expect(mockState.events.indexOf('setLifecycle:running')).toBeLessThan(
      mockState.events.indexOf('components:initAll'),
    );
  });

  it('does not report passive idle while the KB daemon curate scheduler is running', async () => {
    const { deps } = makeLifecycleDeps();
    const childHealth = {
      enabled: true,
      phase: 'online' as const,
      generation: 1,
      pid: 123,
      startedAt: 1_000,
      readyAt: 1_001,
      kbWrite: { phase: 'ready' as const, curateRunning: true },
    };
    (deps as { kbDaemonSupervisor: LifecycleDeps['kbDaemonSupervisor'] }).kbDaemonSupervisor = {
      read: () => childHealth,
      start: async () => childHealth,
      probe: async () => childHealth,
      warmup: async () => childHealth,
      readKb: vi.fn(),
      mutateKb: vi.fn(),
      expansionRpc: vi.fn(),
      stop: async () => childHealth,
      restart: async () => childHealth,
      dispose: async () => undefined,
    } as never;
    const lifecycle = createLifecycle(deps);

    await lifecycle.start();

    const checkIdle = vi.mocked(deps.idleTimer.startWatching).mock.calls[0]?.[0];
    expect(checkIdle).toBeDefined();
    expect(checkIdle?.()).toBe(false);

    childHealth.kbWrite.curateRunning = false;
    expect(checkIdle?.()).toBe(true);
  });

  it('keeps storeDb live through shutdown sequence and closes it only in the finalizer', async () => {
    const { deps, servicesRef } = makeLifecycleDeps();
    const lifecycle = createLifecycle(deps);

    await lifecycle.start();
    await lifecycle.shutdown('unit-hard-stop');
    mockState.events.push('runShutdownSequence:return');
    await finalizeStoreServices(servicesRef);

    expect(mockState.events.indexOf('markJobsAsError:live-store')).toBeGreaterThan(-1);
    expect(mockState.events.indexOf('runShutdownSequence:return')).toBeLessThan(
      mockState.events.indexOf('storeDb.close'),
    );
    expect(servicesRef.tryGet()).toBeNull();
  });
});
