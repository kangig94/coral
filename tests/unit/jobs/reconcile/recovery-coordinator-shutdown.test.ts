import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

import { createRealRuntime } from '#src/runtime/real.js';
import { jobsDir } from '#src/infra/paths.js';
import type { Runtime } from '#src/runtime/ports.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { JobLaunch } from '#src/jobs/records.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: '',
  baseTmp: `${process.env.TMPDIR ?? '/tmp'}/coral-recovery-shutdown-${process.pid}-${Date.now()}`,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
  };
});

type LoadedModules = Awaited<ReturnType<typeof loadModules>>;

type HarnessOptions = {
  modules: LoadedModules;
  runtime: Runtime;
  pluginRoot: string;
  projectRoot: string;
  serviceOverrides?: Record<string, unknown>;
  recoverPersistedDiscussImpl?: () => Promise<[]>;
  workflowResumeImpl?: () => Promise<void>;
};

async function loadModules() {
  vi.resetModules();
  const [
    progressStoreModule,
    lifecycleModule,
    recoveryErrorsModule,
    engineModule,
    eventBusModule,
    pathsModule,
    sessionQueriesModule,
    providerRegistryModule,
  ] = await Promise.all([
    import('#src/jobs/job-store.js'),
    import('#src/coordinator/control.js'),
    import('#src/coordinator/startup-error.js'),
    import('#src/coordinator/live/admission.js'),
    import('#src/coordinator/event-bus.js'),
    import('#src/infra/paths.js'),
    import('#src/sessions/lookup.js'),
    import('#src/providers/registry.js'),
  ]);

  return {
    progressStoreModule,
    lifecycleModule,
    recoveryErrorsModule,
    engineModule,
    eventBusModule,
    pathsModule,
    sessionQueriesModule,
    providerRegistryModule,
  };
}

function createProjectRoot(name: string): string {
  const projectRoot = join(mockState.tmpHome, name);
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
}

function createLaunchCoordinator(
  modules: LoadedModules,
  runtime: Runtime,
): InstanceType<LoadedModules['engineModule']['LaunchCoordinator']> {
  return new modules.engineModule.LaunchCoordinator({ runtime });
}

function createFakeProviderHostManager() {
  return {
    acquireServer: vi.fn(),
    borrowLiveServer: vi.fn(),
    drainForHandoff: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

function createFakeIdleTimer() {
  let inflight = 0;
  return {
    beginRequest: vi.fn(() => {
      inflight += 1;
    }),
    endRequest: vi.fn(() => {
      if (inflight > 0) inflight -= 1;
    }),
    get inflightRequests() {
      return inflight;
    },
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    requestDrain: vi.fn(),
    isDraining: false,
  };
}

function createRuntimeStateMock() {
  let lifecycle = 'starting';
  let startedAt = 0;
  let kbSubsystem: {
    kb: unknown;
    curateScheduler: {
      start: ReturnType<typeof vi.fn>;
      schedule: ReturnType<typeof vi.fn>;
      scheduleDeferredCommit: ReturnType<typeof vi.fn>;
      isRunning(): boolean;
      stop: ReturnType<typeof vi.fn>;
    };
  } | null = null;
  let launchFenceActive = false;

  const runtimeState = {
    getLifecycle: () => lifecycle,
    getStartedAt: () => startedAt,
    getKbSubsystem: () => kbSubsystem as never,
    getKbInitError: () => null,
    getLaunchFenceActive: () => launchFenceActive,
    setLifecycle: vi.fn((state: string) => {
      lifecycle = state;
    }),
    setStartedAt: vi.fn((ts: number) => {
      startedAt = ts;
    }),
    setKbSubsystem: vi.fn((kb: typeof kbSubsystem) => {
      kbSubsystem = kb;
    }),
    setKbInitError: vi.fn(),
    setLaunchFenceActive: vi.fn((active: boolean) => {
      launchFenceActive = active;
    }),
  };

  return { runtimeState, setLifecycle: runtimeState.setLifecycle };
}

function createMockKbSubsystem() {
  return {
    kb: {} as never,
    curateScheduler: {
      start: vi.fn(async () => {}),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      isRunning: () => false,
      stop: vi.fn(async () => {}),
    },
  };
}

function createFakeExecutionAndRecoveryService(overrides: Record<string, unknown> = {}) {
  return {
    adoptRunningJob: vi.fn(() => ({ cleanup: vi.fn() })),
    recoverQueuedJob: vi.fn(() => 'recovered-job'),
    completeRecoveredJob: vi.fn(),
    finalizeInterruptedAppServerJob: vi.fn(async () => {}),
    interruptAppServerJob: vi.fn(async () => {}),
    ...overrides,
  };
}

function stubLaunchRecord(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['ProgressStore']>,
  overrides: {
    jobId: string;
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
    enqueueSequence?: number;
    pool?: string;
  },
): void {
  const record: JobLaunch = {
    jobId: overrides.jobId,
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    jobKind: 'provider',
    pool: overrides.pool ?? 'default',
    enqueueSequence: overrides.enqueueSequence ?? 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: overrides.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date().toISOString(),
  };
  progressStore.appendLaunchRequested(overrides.jobId, record);
}

function stubRuntimeRecord(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['ProgressStore']>,
  runtime: Runtime,
  options: {
    jobId: string;
    pid: number;
    startTime?: string;
  },
): void {
  progressStore.appendRuntimeStarted(options.jobId, {
    pid: options.pid,
    stdoutPath: join(jobsDir(), options.jobId, 'stdout'),
    stderrPath: join(jobsDir(), options.jobId, 'stderr'),
    startTime: options.startTime ?? '2026-04-17T00:00:00.000Z',
  });
}

async function stopLifecycleController(controller: {
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
}): Promise<void> {
  try {
    await controller.shutdown('test-cleanup');
  } catch {
    /* best effort */
  }
  try {
    await controller.waitForShutdown();
  } catch {
    /* best effort */
  }
}

function createCoordinatorShutdownHarness(options: HarnessOptions) {
  const { modules, runtime, pluginRoot, projectRoot } = options;
  const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
  const eventBus = new modules.eventBusModule.TypedEventBus();
  const progressStore = new modules.progressStoreModule.ProgressStore(
    namespace,
    runtime,
    createDefaultUpcasterRegistry(),
    { eventBus },
  );
  const { runtimeState, setLifecycle } = createRuntimeStateMock();
  const idleTimer = createFakeIdleTimer();
  const providerRegistry = new modules.providerRegistryModule.ProviderRegistry();
  const launchCoordinator = createLaunchCoordinator(modules, runtime);
  const fakeService = createFakeExecutionAndRecoveryService(options.serviceOverrides);
  const writeBackendInfoFn = vi.fn();
  const recoverPersistedDiscussFn = vi.fn(async () => {
    if (options.recoverPersistedDiscussImpl) {
      return options.recoverPersistedDiscussImpl();
    }
    return [];
  });
  const workflowResumeHook = vi.fn(async () => {
    if (options.workflowResumeImpl) {
      await options.workflowResumeImpl();
    }
  });

  const controller = modules.lifecycleModule.createLifecycle({
    identity: {
      pluginRoot,
      namespace,
      version: '9.9.9',
      bundleHash: 'testhash1234',
      flavor: 'prod',
      instanceId: `recovery-shutdown-${Math.random()}`,
      token: 'test-token',
      now: () => 1,
      log: () => {},
    },
    runtime,
    backendPid: 1234,
    runtimeState: runtimeState as never,
    idleTimer: idleTimer as never,
    progressStore,
    streamResponses: new Set(),
    discussStores: new Map(),
    eventBus,
    launchCoordinator,
    providerRegistry,
    server: createServer(),
    getExecutionService: () => fakeService as never,
    getRecoveryService: () => fakeService as never,
    listExecutionServices: () => [fakeService as never],
    getDiscussStoreForSource: () => {
      throw new Error('Unexpected discuss store lookup');
    },
    knownDiscussSources: () => new Set<string>(),
    getDiscussContext: () => {
      throw new Error('Unexpected discuss context lookup');
    },
    acquireLockFn: async () => {},
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn: () => {},
    removeLockIfOwnerFn: () => {},
    cleanupStaleJobsFn: () => {},
    markJobsAsErrorFn: () => {},
    terminateAllFn: () => {},
    providerHostManager: createFakeProviderHostManager() as never,
    createKbSubsystemFn: async () => createMockKbSubsystem(),
    registerBuiltInProvidersFn: () => {},
    // Required by createLifecycle's contract but unused: the custom runStartupRecoveryFn below
    // calls its own closure-captured spy (recoverPersistedDiscussSpy) so the tail-cut assertion
    // can observe whether the post-recovery startup tail ran.
    recoverPersistedDiscussFn: async () => [],
    runStartupRecoveryFn: async ({
      identity,
      runtime,
      progressStore,
      providerRegistry,
      getRecoveryService,
      createInvocationContext,
      recoveryCoordinator,
      assertStartupStillActive,
      cleanupStaleJobs,
    }) => {
      await recoveryCoordinator.runStartupRecovery({
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        assertStartupStillActive,
        log: identity.log,
        cleanupStaleJobs,
        sessionLookup: modules.sessionQueriesModule.createProjectionSessionLookup(progressStore.getDb()),
      });
      assertStartupStillActive();
      const recoveredDiscussResumes = await recoverPersistedDiscussFn();
      assertStartupStillActive();
      await workflowResumeHook();
      assertStartupStillActive();
      return recoveredDiscussResumes;
    },
    hooks: {
      onShutdown: async () => {},
      onIdleCheck: () => false,
      onRecoveryComplete: async () => {},
    },
    closeServerFn: async () => {},
    listenFn: async () => ({ port: 4105, host: '127.0.0.1' }),
  });

  progressStore.initJob({
    jobId: 'running-adoption-job',
    sessionId: 'running-adoption-session',
    provider: 'fakeprovider',
    projectRoot,
    backendNamespace: namespace,
    initialPhase: 'running',
  });
  stubLaunchRecord(progressStore, {
    jobId: 'running-adoption-job',
    sessionId: 'running-adoption-session',
    provider: 'fakeprovider',
    projectRoot,
    backendNamespace: namespace,
  });

  return {
    controller,
    runtime,
    runtimeState,
    setLifecycle,
    progressStore,
    fakeService,
    writeBackendInfoFn,
    recoverPersistedDiscussFn,
    workflowResumeHook,
  };
}

describe('recovery coordinator shutdown', () => {
  beforeEach(() => {
    mkdirSync(mockState.baseTmp, { recursive: true });
    mockState.tmpRoot = mkdtempSync(join(mockState.baseTmp, 'run-'));
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
    vi.stubEnv('HOME', mockState.tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (mockState.tmpRoot) {
      rmSync(mockState.tmpRoot, { recursive: true, force: true });
    }
    mockState.tmpHome = '';
    mockState.tmpRoot = '';
  });

  it('stops the startup tail when shutdown begins during recovery adoption', async () => {
    const modules = await loadModules();
    const runtime = createRealRuntime();
    const pluginRoot = createProjectRoot('plugin-mid-adoption');
    const projectRoot = createProjectRoot('project-mid-adoption');
    const cleanupSpy = vi.fn();
    // eslint-disable-next-line prefer-const -- circular: adoptRunningJob closure reads controller, but controller assignment depends on harness which wires adoptRunningJob
    let controller!: ReturnType<LoadedModules['lifecycleModule']['createLifecycle']>;

    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        adoptRunningJob: vi.fn(() => {
          void controller.shutdown('test-mid-recovery');
          return { cleanup: cleanupSpy };
        }),
      },
    });
    controller = harness.controller;

    stubRuntimeRecord(harness.progressStore, runtime, {
      jobId: 'running-adoption-job',
      pid: process.pid,
      startTime: '2026-03-11T00:00:00.000Z',
    });

    try {
      const startResult = await controller.start().catch((error: unknown) => error);
      await controller.waitForShutdown();

      expect(startResult).toBeInstanceOf(modules.recoveryErrorsModule.StartupInterruptedError);
      expect(harness.fakeService.adoptRunningJob).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(harness.recoverPersistedDiscussFn).not.toHaveBeenCalled();
      expect(harness.workflowResumeHook).not.toHaveBeenCalled();
      expect(harness.writeBackendInfoFn).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('cleans up an adopted running job on shutdown after the recovery poller is live and suppresses late completion', async () => {
    const modules = await loadModules();
    const runtime = new SimulationRuntime();
    const pluginRoot = createProjectRoot('plugin-after-poller');
    const projectRoot = createProjectRoot('project-after-poller');
    const cleanupSpy = vi.fn();
    const recoveryPollMs = 500;
    const pid = 41_424;
    let pidAlive = true;
    let recoveryPollHandle: ReturnType<typeof runtime.time.setInterval> | null = null;
    // eslint-disable-next-line prefer-const -- circular: recoverPersistedDiscussImpl closure reads controller, but controller assignment depends on harness which wires that closure
    let controller!: ReturnType<LoadedModules['lifecycleModule']['createLifecycle']>;

    const originalSetInterval = runtime.time.setInterval.bind(runtime.time);
    const clearIntervalSpy = vi.spyOn(runtime.time, 'clearInterval');
    vi.spyOn(runtime.time, 'setInterval').mockImplementation((fn, ms) => {
      const handle = originalSetInterval(fn, ms);
      if (ms === recoveryPollMs && recoveryPollHandle === null) {
        recoveryPollHandle = handle;
      }
      return handle;
    });
    vi.spyOn(runtime.process, 'isAlive').mockImplementation((candidatePid: number) => candidatePid === pid && pidAlive);

    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        adoptRunningJob: vi.fn(() => ({ cleanup: cleanupSpy })),
      },
      recoverPersistedDiscussImpl: async () => {
        expect(recoveryPollHandle).not.toBeNull();
        void controller.shutdown('test-after-poller-live');
        return [];
      },
    });
    controller = harness.controller;

    stubRuntimeRecord(harness.progressStore, runtime, {
      jobId: 'running-adoption-job',
      pid,
    });

    try {
      const startResult = await controller.start().catch((error: unknown) => error);
      await controller.waitForShutdown();

      expect(startResult).toBeInstanceOf(modules.recoveryErrorsModule.StartupInterruptedError);
      expect(harness.fakeService.adoptRunningJob).toHaveBeenCalledTimes(1);
      expect(recoveryPollHandle).not.toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalledWith(recoveryPollHandle);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(harness.workflowResumeHook).not.toHaveBeenCalled();
      expect(harness.writeBackendInfoFn).not.toHaveBeenCalled();
      expect(harness.setLifecycle).not.toHaveBeenCalledWith('running');

      pidAlive = false;
      runtime.time.tick(recoveryPollMs + 1);

      expect(harness.fakeService.completeRecoveredJob).not.toHaveBeenCalled();
      expect(harness.writeBackendInfoFn).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(harness.setLifecycle).not.toHaveBeenCalledWith('running');
    } finally {
      await stopLifecycleController(controller);
    }
  });
});
