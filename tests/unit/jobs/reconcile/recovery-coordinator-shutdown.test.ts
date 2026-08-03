import { currentCoralStoreFormat } from '#src/store-format.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

import { createRealRuntime } from '#src/runtime/real.js';
import { createKbDaemonHealthComponent } from '#src/coordinator/runtime-components/kb-health-component.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { jobsDir } from '#src/jobs/paths.js';
import type { Runtime } from '#src/runtime/ports.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { LaunchPool } from '#src/jobs/contracts/admission.js';
import type { RecoveryCommitFence } from '#src/jobs/reconcile/contracts.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { parseExpression } from '#src/workflow/parser.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { commitWorkflowEvents } from '#src/workflow/projections.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import type { WorkflowFinalizationIntent } from '#src/workflow/finalization.js';

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
    engineModule,
    eventBusModule,
    pathsModule,
    sessionQueriesModule,
    providerRegistryModule,
    workflowRecoverModule,
    jobReadQueriesModule,
  ] = await Promise.all([
    import('#src/jobs/store.js'),
    import('#src/coordinator/lifecycle.js'),
    import('#src/coordinator/live/admission.js'),
    import('#src/coordinator/event-bus.js'),
    import('#src/infra/plugin-identity.js'),
    import('#src/sessions/lookup.js'),
    import('#src/providers/registry.js'),
    import('#src/workflow/recover.js'),
    import('#src/jobs/read-queries.js'),
  ]);

  return {
    progressStoreModule,
    lifecycleModule,
    engineModule,
    eventBusModule,
    pathsModule,
    sessionQueriesModule,
    providerRegistryModule,
    workflowRecoverModule,
    jobReadQueriesModule,
  };
}

function createProjectRoot(name: string): string {
  const projectRoot = join(mockState.tmpHome, name);
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
}

function createStoreServicesHarness(progressStore: { getDb(): { close(): void } }): {
  storeServicesRef: never;
  createStoreServicesFromDbFn: (storeDb: { close(): void }) => never;
} {
  const services = {
    storeDb: progressStore.getDb(),
    progressStore,
    consumerDriver: null,
  };
  let current: typeof services | null = null;
  return {
    storeServicesRef: {
      tryGet: () => current,
      get: () => {
        if (current === null) throw new Error('store services not set');
        return current;
      },
      set: (next: typeof services) => {
        current = next;
      },
      clear: () => {
        current = null;
      },
    } as never,
    createStoreServicesFromDbFn: (storeDb) => {
      if (storeDb !== services.storeDb) {
        storeDb.close();
      }
      current = services;
      return services as never;
    },
  };
}

function createLaunchCoordinator(
  modules: LoadedModules,
  runtime: Runtime,
): InstanceType<LoadedModules['engineModule']['LaunchCoordinator']> {
  return new modules.engineModule.LaunchCoordinator({ runtime });
}

function createFakeProviderHostManager() {
  return {
    openSession: vi.fn(),
    attachSession: vi.fn(async () => null),
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
  let launchFenceActive = false;
  // Stub component registry. KB-routed handlers are not exercised here.
  const components = {
    register: vi.fn(),
    initAll: vi.fn(),
    disposeAll: vi.fn(async () => {}),
    list: vi.fn(() => []),
    status: vi.fn(() => null),
  };

  const runtimeState = {
    getLifecycle: () => lifecycle,
    getStartedAt: () => startedAt,
    getLaunchFenceActive: () => launchFenceActive,
    components: components as never,
    setLifecycle: vi.fn((state: string) => {
      lifecycle = state;
    }),
    setStartedAt: vi.fn((ts: number) => {
      startedAt = ts;
    }),
    setLaunchFenceActive: vi.fn((active: boolean) => {
      launchFenceActive = active;
    }),
  };

  return { runtimeState, setLifecycle: runtimeState.setLifecycle };
}

function createFakeExecutionAndRecoveryService(overrides: Record<string, unknown> = {}) {
  return {
    adoptRunningJob: vi.fn(() => ({ adopted: true, cleanup: vi.fn() })),
    captureProviderRecoveryAuthority: vi.fn((launchRecord: JobLaunch) => ({
      ok: true,
      authority: {
        launchRecord,
        session: { sessionId: launchRecord.sessionId },
        boundProvider: { name: launchRecord.provider },
      },
    })),
    finalizeProviderRecoveryBindingFailure: vi.fn(() => 'released' as const),
    recoverQueuedJob: vi.fn(() => 'recovered-job'),
    completeRecoveredJob: vi.fn(),
    finalizeInterruptedAppServerJob: vi.fn(async () => {}),
    finalizeInterruptedDurableJob: vi.fn(async () => {}),
    interruptAppServerJob: vi.fn(async () => {}),
    ...overrides,
  };
}

function stubLaunchRecord(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  overrides: {
    jobId: string;
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
    enqueueSequence?: number;
    pool?: LaunchPool;
  },
): void {
  const record: JobLaunch = {
    jobId: overrides.jobId,
    owner: { kind: 'provider-session', id: overrides.sessionId },
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
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  runtime: Runtime,
  options: {
    jobId: string;
    pid: number;
    startTime?: string;
  },
): void {
  progressStore.appendRuntimeStarted(options.jobId, {
    transport: 'durable-cli',
    pid: options.pid,
    stdoutPath: join(jobsDir(runtime.env), options.jobId, 'stdout'),
    stderrPath: join(jobsDir(runtime.env), options.jobId, 'stderr'),
    startTime: options.startTime ?? '2026-04-17T00:00:00.000Z',
  });
}

function stubRecoverableWorkflow(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  runtime: Runtime,
  options: {
    workflowId: string;
    projectRoot: string;
    backendNamespace: string;
    completedAtom: boolean;
  },
): void {
  const plan = buildWorkflowPlan(options.workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
  commitWorkflowEvents(
    progressStore.getDb(),
    (c) => {
      c.append(workflowPlanDeclaredEvent(options.workflowId, plan, TEST_PROVIDER_SCOPE));
      return undefined;
    },
    runtime.time,
    permissiveProviderLookupPort,
  );
  progressStore.appendLaunchRequested(options.workflowId, {
    jobId: options.workflowId,
    owner: { kind: 'workflow', id: options.workflowId },
    sessionId: null,
    provider: null,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    request: {
      prompt: '',
      cwd: options.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date(runtime.time.now()).toISOString(),
  });
  progressStore.commit((c) => {
    c.append({
      type: 'job.runtime.started',
      stream: { kind: 'job', id: options.workflowId },
      namespace: options.backendNamespace,
      project: options.projectRoot,
      refs: { jobId: options.workflowId, workflowId: options.workflowId },
      body: { transport: 'workflow', startedAt: new Date(runtime.time.now()).toISOString() },
    });
    return undefined;
  });

  if (!options.completedAtom) {
    return;
  }

  const slot = plan.slots[0];
  const sessionId = `${options.workflowId}-session`;
  seedTestSessionProjection(progressStore.getDb(), {
    sessionId,
    provider: slot.provider,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
    activeJobId: slot.slotId,
  });
  progressStore.appendLaunchRequested(slot.slotId, {
    jobId: slot.slotId,
    owner: { kind: 'workflow', id: options.workflowId },
    sessionId,
    provider: slot.provider,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    providerAction: 'exec',
    parentWorkflowJobId: options.workflowId,
    workflowSlotId: slot.slotId,
    workflowSlotGeneration: 0,
    request: {
      prompt: '',
      cwd: options.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date(runtime.time.now()).toISOString(),
  });
  commitJobTerminal(progressStore, slot.slotId, sessionId, {
    content: 'recovered output',
    outcome: { kind: 'completed' },
    durationMs: 0,
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
  const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
    db: openTestStoreDb(runtime, ':memory:'),
    eventBus,
    providers: permissiveProviderLookupPort,
  });
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
  const storeServices = createStoreServicesHarness(progressStore);
  const kbDaemonSupervisor = createMockKbDaemonSupervisor();

  const controller = modules.lifecycleModule.createLifecycle({
    storeFormat: currentCoralStoreFormat(),
    identity: {
      pluginRoot,
      namespace,
      version: '9.9.9',
      buildSetId: '00000000-0000-4000-8000-000000000000',
      bundleHash: 'testhash1234',
      cliBundleHash: 'testclihash1234',
      claudeAppserverBundleHash: 'testclaudehash12',
      flavor: 'prod',
      instanceId: `recovery-shutdown-${Math.random()}`,
      token: 'test-token',
      bootToken: 'test-boot-token',
      shutdownToken: 'test-shutdown-token',
      now: () => 1,
      log: () => {},
    },
    runtime,
    backendPid: 1234,
    runtimeState: runtimeState as never,
    idleTimer: idleTimer as never,
    storeServicesRef: storeServices.storeServicesRef,
    createStoreServicesFromDbFn: storeServices.createStoreServicesFromDbFn,
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
    writeBackendInfoFn,
    removeBackendInfoIfOwnerFn: () => {},
    cleanupStaleJobsFn: () => {},
    markJobsAsErrorFn: () => {},
    terminateAllFn: () => {},
    providerHostManager: createFakeProviderHostManager() as never,
    kbDaemonSupervisor,
    handoffQuiescePorts: () => [],
    createKbHealthComponentFn: () => createKbDaemonHealthComponent(kbDaemonSupervisor),
    registerBuiltInProvidersFn: () => {},
    // Required by createLifecycle's contract but unused: the custom runStartupRecoveryFn below
    // calls its own closure-captured spy (recoverPersistedDiscussSpy) so the tail-cut assertion
    // can observe whether the post-recovery startup tail ran.
    recoverPersistedDiscussFn: async () => [],
    runStartupRecoveryFn: async ({
      identity,
      runtime,
      progressStore,
      getRecoveryService,
      createInvocationContext,
      recoveryCoordinator,
      signal,
    }) => {
      await recoveryCoordinator.runStartupRecovery({
        namespace: identity.namespace,
        runtime,
        progressStore,
        getRecoveryService,
        createInvocationContext,
        signal,
        log: identity.log,
        coordinatorCommit: createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
      });
      signal.throwIfAborted();
      const recoveredDiscussResumes = await recoverPersistedDiscussFn();
      signal.throwIfAborted();
      await workflowResumeHook();
      signal.throwIfAborted();
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

  seedTestJobSession(progressStore, {
    jobId: 'running-adoption-job',
    sessionId: 'running-adoption-session',
    provider: 'codex',
    projectRoot,
    backendNamespace: namespace,
    initialPhase: 'running',
  });
  stubLaunchRecord(progressStore, {
    jobId: 'running-adoption-job',
    sessionId: 'running-adoption-session',
    provider: 'codex',
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
    const runtime = createRealRuntime('prod');
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
          return { adopted: true, cleanup: cleanupSpy };
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

      expect((startResult as Error)?.name).toBe('AbortError');
      expect(harness.fakeService.adoptRunningJob).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(harness.recoverPersistedDiscussFn).not.toHaveBeenCalled();
      expect(harness.workflowResumeHook).not.toHaveBeenCalled();
      // Under the 3-era boot, `writeBackendInfoFn` fires in Era I BEFORE
      // recovery — even an interrupted Era II startup has already
      // published backend info.
      expect(harness.writeBackendInfoFn).toHaveBeenCalledTimes(1);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('bars a late binding-failure commit when authority capture returns after shutdown', async () => {
    const modules = await loadModules();
    const runtime = createRealRuntime('prod');
    const pluginRoot = createProjectRoot('plugin-late-authority');
    const projectRoot = createProjectRoot('project-late-authority');
    let releaseCapture!: (value: { ok: false; failure: { reason: 'subject-mismatch'; provider: string } }) => void;
    const captureBlocked = new Promise<{
      ok: false;
      failure: { reason: 'subject-mismatch'; provider: string };
    }>((resolve) => {
      releaseCapture = resolve;
    });

    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        captureProviderRecoveryAuthority: vi.fn(async () => captureBlocked),
      },
    });
    harness.progressStore.appendRuntimeStarted('running-adoption-job', {
      transport: 'app-server',
      startTime: '2026-04-17T00:00:00.000Z',
      providerMeta: { provider: 'codex', leaseState: 'waiting' },
    });

    const startup = harness.controller.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.fakeService.captureProviderRecoveryAuthority).toHaveBeenCalledTimes(1));

    await harness.controller.shutdown('handoff');
    releaseCapture({ ok: false, failure: { reason: 'subject-mismatch', provider: 'codex' } });

    expect(((await startup) as Error).name).toBe('AbortError');
    expect(harness.fakeService.finalizeProviderRecoveryBindingFailure).not.toHaveBeenCalled();
    expect(harness.progressStore.readStatus('running-adoption-job')?.phase).toBe('running');
  });

  it('cleans up an adopted running job on shutdown after the recovery poller is live and suppresses late completion', async () => {
    const modules = await loadModules();
    const virtualRuntime = new SimulationRuntime();
    const runtime: Runtime = { ...createRealRuntime('prod'), time: virtualRuntime.time };
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
        adoptRunningJob: vi.fn(() => ({ adopted: true, cleanup: cleanupSpy })),
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

      expect((startResult as Error)?.name).toBe('AbortError');
      expect(harness.fakeService.adoptRunningJob).toHaveBeenCalledTimes(1);
      expect(recoveryPollHandle).not.toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalledWith(recoveryPollHandle);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(harness.workflowResumeHook).not.toHaveBeenCalled();
      // Under the 3-era boot, Era I writes backend info BEFORE recovery.
      expect(harness.writeBackendInfoFn).toHaveBeenCalledTimes(1);
      expect(harness.setLifecycle).not.toHaveBeenCalledWith('running');

      pidAlive = false;
      virtualRuntime.time.tick(recoveryPollMs + 1);

      expect(harness.fakeService.completeRecoveredJob).not.toHaveBeenCalled();
      // writeBackendInfoFn fires exactly once in Era I; the interrupted
      // recovery does not cause additional invocations.
      expect(harness.writeBackendInfoFn).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(harness.setLifecycle).not.toHaveBeenCalledWith('running');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('continues to the second workflow and lets start resolve after finalizing the first recovery failure', async () => {
    const modules = await loadModules();
    const runtime = createRealRuntime('prod');
    const pluginRoot = createProjectRoot('plugin-workflow-isolation');
    const failedProjectRoot = createProjectRoot('project-workflow-failure');
    const resumedProjectRoot = createProjectRoot('project-workflow-resumed');
    const backendNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const finalizeWorkflow = vi.fn<(intent: WorkflowFinalizationIntent) => void>();
    const recoveryLog = vi.fn<(message: string) => void>();
    const getExecutionService = vi.fn((ctx: { projectRoot: string }) => {
      if (ctx.projectRoot === failedProjectRoot) {
        throw new Error('failed workflow recovery');
      }
      return {} as WorkflowExecutionPort;
    });
    let resumedWorkflowIds: string[] = [];
    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot: failedProjectRoot,
      workflowResumeImpl: async () => {
        resumedWorkflowIds = await modules.workflowRecoverModule.resumeAll({
          db: harness.progressStore.getDb(),
          progressStore: harness.progressStore,
          loadJobDetails: modules.jobReadQueriesModule.loadJobProjectionDetails,
          getExecutionService,
          createInvocationContext: (projectRoot) => ({
            projectRoot,
            pluginRoot,
            coralEnv: {},
            principal: testProjectPrincipal(projectRoot),
          }),
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: () => [],
          log: recoveryLog,
          time: runtime.time,
        });
      },
    });
    stubRecoverableWorkflow(harness.progressStore, runtime, {
      workflowId: 'workflow-fails-recovery',
      projectRoot: failedProjectRoot,
      backendNamespace,
      completedAtom: false,
    });
    stubRecoverableWorkflow(harness.progressStore, runtime, {
      workflowId: 'workflow-resumes-after-failure',
      projectRoot: resumedProjectRoot,
      backendNamespace,
      completedAtom: true,
    });

    try {
      await harness.controller.start();
      expect(resumedWorkflowIds).toEqual(['workflow-fails-recovery', 'workflow-resumes-after-failure']);
      expect(getExecutionService).toHaveBeenCalledTimes(2);
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', workflowJobId: 'workflow-fails-recovery' }),
      );
      expect(finalizeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'completed', workflowJobId: 'workflow-resumes-after-failure' }),
      );
      expect(recoveryLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'Workflow recovery finalized workflow-fails-recovery after recovery failed: failed workflow recovery',
        ),
      );
    } finally {
      await stopLifecycleController(harness.controller);
    }
  });

  it('terminalizes the adopted job, releases its claim, cleans up, and leaves the launch fence open when finalization fails', async () => {
    const modules = await loadModules();
    const virtualRuntime = new SimulationRuntime();
    const runtime: Runtime = { ...createRealRuntime('prod'), time: virtualRuntime.time };
    const pluginRoot = createProjectRoot('plugin-finalization-failure');
    const projectRoot = createProjectRoot('project-finalization-failure');
    const cleanupSpy = vi.fn();
    const pid = 51_515;
    let pidAlive = true;
    vi.spyOn(runtime.process, 'isAlive').mockImplementation((candidatePid: number) => candidatePid === pid && pidAlive);

    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        adoptRunningJob: vi.fn(() => ({ adopted: true, cleanup: cleanupSpy })),
        finalizeInterruptedDurableJob: vi.fn(async () => {
          throw new Error('stale durable artifact CAS');
        }),
      },
    });
    stubRuntimeRecord(harness.progressStore, runtime, {
      jobId: 'running-adoption-job',
      pid,
    });

    try {
      await harness.controller.start();
      expect(harness.runtimeState.getLaunchFenceActive()).toBe(false);

      pidAlive = false;
      virtualRuntime.time.tick(501);

      await vi.waitFor(() => {
        expect(harness.fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledTimes(1);
        expect(harness.progressStore.readStatus('running-adoption-job')?.phase).toBe('error');
        expect(cleanupSpy).toHaveBeenCalledTimes(1);
      });
      const recoveredSession = modules.sessionQueriesModule
        .createProjectionSessionLookup(harness.progressStore.getDb())
        .readProviderSession('running-adoption-session');
      expect(recoveredSession?.activeJobId).toBeUndefined();
      expect(harness.runtimeState.getLaunchFenceActive()).toBe(false);
      expect(harness.controller.getRecoveryRegistry()).toBeNull();
    } finally {
      await stopLifecycleController(harness.controller);
    }
  });

  it('does not wait for provider work that remains pre-commit when shutdown aborts recovery', async () => {
    const modules = await loadModules();
    const virtualRuntime = new SimulationRuntime();
    const runtime: Runtime = { ...createRealRuntime('prod'), time: virtualRuntime.time };
    const pluginRoot = createProjectRoot('plugin-precommit-finalization');
    const projectRoot = createProjectRoot('project-precommit-finalization');
    const pid = 60_606;
    let pidAlive = true;
    let providerSignal: AbortSignal | null = null;
    vi.spyOn(runtime.process, 'isAlive').mockImplementation((candidatePid: number) => candidatePid === pid && pidAlive);

    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        finalizeInterruptedDurableJob: vi.fn(
          async (_authority, _runtimeRecord, _observation, fence: RecoveryCommitFence) => {
            providerSignal = fence.signal;
            return new Promise<void>(() => {});
          },
        ),
      },
    });
    stubRuntimeRecord(harness.progressStore, runtime, {
      jobId: 'running-adoption-job',
      pid,
    });

    await harness.controller.start();
    pidAlive = false;
    virtualRuntime.time.tick(501);
    await vi.waitFor(() => expect(harness.fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledTimes(1));

    await harness.controller.shutdown('handoff');
    expect(providerSignal).not.toBeNull();
    expect((providerSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('waits for in-flight durable finalization before shutdown releases daemon authority', async () => {
    const modules = await loadModules();
    const virtualRuntime = new SimulationRuntime();
    const runtime: Runtime = { ...createRealRuntime('prod'), time: virtualRuntime.time };
    const pluginRoot = createProjectRoot('plugin-finalization-drain');
    const projectRoot = createProjectRoot('project-finalization-drain');
    const pid = 61_616;
    let pidAlive = true;
    let releaseFinalizer!: () => void;
    const finalizerBlocked = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    vi.spyOn(runtime.process, 'isAlive').mockImplementation((candidatePid: number) => candidatePid === pid && pidAlive);

    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        finalizeInterruptedDurableJob: vi.fn(
          async (_authority, _runtimeRecord, _observation, fence: RecoveryCommitFence) => {
            fence.onCommitStart();
            return finalizerBlocked;
          },
        ),
      },
    });
    stubRuntimeRecord(harness.progressStore, runtime, {
      jobId: 'running-adoption-job',
      pid,
    });

    await harness.controller.start();
    pidAlive = false;
    virtualRuntime.time.tick(501);
    await vi.waitFor(() => expect(harness.fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledTimes(1));

    let shutdownSettled = false;
    const shutdown = harness.controller.shutdown('handoff').finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseFinalizer();
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  it('waits for startup app-server finalization before shutdown releases daemon authority', async () => {
    const modules = await loadModules();
    const runtime = createRealRuntime('prod');
    const pluginRoot = createProjectRoot('plugin-app-finalization-drain');
    const projectRoot = createProjectRoot('project-app-finalization-drain');
    let releaseFinalizer!: () => void;
    const finalizerBlocked = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    const harness = createCoordinatorShutdownHarness({
      modules,
      runtime,
      pluginRoot,
      projectRoot,
      serviceOverrides: {
        finalizeInterruptedAppServerJob: vi.fn(async (_authority, _runtimeRecord, fence: RecoveryCommitFence) => {
          fence.onCommitStart();
          return finalizerBlocked;
        }),
      },
    });
    harness.progressStore.appendRuntimeStarted('running-adoption-job', {
      transport: 'app-server',
      startTime: '2026-04-17T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'waiting',
      },
    });

    const startup = harness.controller.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledTimes(1));

    let shutdownSettled = false;
    const shutdown = harness.controller.shutdown('handoff').finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseFinalizer();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(((await startup) as Error).name).toBe('AbortError');
  });
});
import { seedTestJobSession, seedTestSessionProjection } from '#tests/helpers/session.js';
