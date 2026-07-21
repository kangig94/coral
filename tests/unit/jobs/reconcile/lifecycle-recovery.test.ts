import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateTestSession } from '../../../helpers/session.js';
import { TEST_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

import type { JobLaunch } from '#src/jobs/records.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { reduceSessionOpened } from '#src/sessions/projections.js';
import type { CoralEvent } from '#src/store/envelope.js';
import type { SessionOpenedBody } from '#src/sessions/event-bodies.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import type { ProviderRecoveryContract } from '#src/providers/contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbDaemonHealthComponent } from '#src/coordinator/runtime-components/kb-health-component.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { commitJobInput } from '#tests/helpers/job-commits.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import type { RunStartupRecoveryFn } from '#src/coordinator/lifecycle.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { TEST_CODEX_BINDING, TEST_CODEX_SOURCE } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { none } from '#src/providers/capability.js';

let runtime: ReturnType<typeof createRealRuntime>;

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: '',
  baseTmp: `${process.env.TMPDIR ?? '/tmp'}/coral-lifecycle-recovery-${process.pid}-${Date.now()}`,
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

async function loadModules() {
  vi.resetModules();
  const [
    progressStoreModule,
    sessionManagerModule,
    lifecycleModule,
    serviceModule,
    engineModule,
    eventBusModule,
    pathsModule,
    sessionLookupModule,
    sessionQueriesModule,
    providerRegistryModule,
    recoveryActionsModule,
    transportDispatchModule,
    rpcCatalogModule,
  ] = await Promise.all([
    import('#src/jobs/store.js'),
    import('#src/sessions/shell.js'),
    import('#src/coordinator/lifecycle.js'),
    import('#src/coordinator/execution-service.js'),
    import('#src/coordinator/live/admission.js'),
    import('#src/coordinator/event-bus.js'),
    import('#src/infra/plugin-identity.js'),
    import('#src/sessions/lookup.js'),
    import('#src/sessions/read-queries.js'),
    import('#src/providers/registry.js'),
    import('#src/coordinator/services/recovery/actions.js'),
    import('#src/transport/dispatch.js'),
    import('#src/transport/rpc/catalog.js'),
  ]);

  return {
    progressStoreModule,
    sessionManagerModule,
    lifecycleModule,
    serviceModule,
    engineModule,
    eventBusModule,
    pathsModule,
    sessionLookupModule,
    sessionQueriesModule,
    providerRegistryModule,
    recoveryActionsModule,
    transportDispatchModule,
    rpcCatalogModule,
  };
}

function createRecoveryProviderRegistry(modules: LoadedModules) {
  const registry = new modules.providerRegistryModule.ProviderRegistry();
  registry.register(
    modules.providerRegistryModule
      .defineProvider({ name: 'codex', run: async function* noopProvider() {} })
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts(none('recovery fixture owns no provider artifacts'))
      .build(),
  );
  return registry;
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
  let launchFenceActive = false;
  // Stub component registry: tests in this file don't exercise KB-routed
  // calls; an always-initializing registry is sufficient.
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

  return { runtimeState };
}

function createFakeExecutionAndRecoveryService(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => ({ status: 'running', job: 'started-job', session: 'started-session' })),
    executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(async () => ({ type: 'waiting', waitingJobIds: [] })),
    adoptRunningJob: vi.fn(async () => ({ adopted: true, cleanup: vi.fn() })),
    validateProviderRecoveryAuthority: vi.fn(async () => true),
    providerCredentialSourceForRecovery: vi.fn(async () => TEST_CODEX_SOURCE),
    recoverQueuedJob: vi.fn(async () => 'recovered-job'),
    completeRecoveredJob: vi.fn(),
    finalizeInterruptedAppServerJob: vi.fn(async () => {}),
    interruptAppServerJob: vi.fn(async () => {}),
    recordRecoveredArtifactHandles: vi.fn(async () => ({ ok: true as const, nextVersion: 1 })),
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
    pool?: string;
    jobKind?: 'provider' | 'workflow';
  },
): void {
  ensureTestSession(progressStore, {
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    orchestration: overrides.jobKind === 'workflow',
  });
  const record: JobLaunch = {
    jobId: overrides.jobId,
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    jobKind: overrides.jobKind === 'workflow' ? 'workflow' : 'provider',
    pool: overrides.pool ?? 'default',
    enqueueSequence: overrides.enqueueSequence ?? 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: overrides.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
      ...(overrides.jobKind === 'workflow' ? { providerScope: TEST_PROVIDER_SCOPE } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  progressStore.appendLaunchRequested(overrides.jobId, record);
}

function ensureTestSession(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  options: {
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
    orchestration?: boolean;
  },
): void {
  const exists = progressStore
    .getDb()
    .prepare<[string], { found: number }>('SELECT 1 AS found FROM projection_sessions WHERE session_id = ?')
    .get(options.sessionId);
  if (exists !== undefined) return;
  if (!options.orchestration && options.provider !== 'codex') {
    throw new Error(`Test provider session '${options.provider}' has no credential source fixture.`);
  }
  const now = new Date().toISOString();
  const entry: SessionEntry = {
    sessionId: options.sessionId,
    provider: options.provider,
    sessionAuthority: options.orchestration
      ? { kind: 'orchestration' }
      : { kind: 'provider', binding: TEST_CODEX_BINDING },
    name: options.sessionId,
    state: 'ready',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: options.projectRoot,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
    createdAt: now,
    lastUsedAt: now,
    version: 1,
  };
  const body: SessionOpenedBody = {
    entry,
    controller: 'default',
    provider: options.provider,
    scope_key: pluginRootNamespace(options.projectRoot),
  };
  const event: CoralEvent<SessionOpenedBody> = {
    seq: 0,
    ts: now,
    type: 'session.opened',
    stream: { kind: 'session', id: options.sessionId },
    namespace: options.backendNamespace,
    project: options.projectRoot,
    refs: { sessionId: options.sessionId },
    bodyVersion: 1,
    body,
  };
  reduceSessionOpened(progressStore.getDb(), event);
}

function appendQueuedEvent(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  jobId: string,
  sessionId: string,
  backendNamespace: string,
  projectRoot: string,
  queuePosition = 1,
): void {
  commitJobInput(progressStore, {
    type: 'job.queue.queued',
    stream: { kind: 'job', id: jobId },
    namespace: backendNamespace,
    project: projectRoot,
    refs: { jobId, sessionId },
    bodyVersion: 1,
    body: {
      queuePosition,
      runningJobIds: [],
    },
  });
}

function stubRuntimeRecord(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  overrides: {
    jobId: string;
    pid?: number;
    stdoutPath?: string;
    stderrPath?: string;
    startTime?: string;
  },
): void {
  progressStore.appendRuntimeStarted(overrides.jobId, {
    pid: overrides.pid ?? process.pid,
    stdoutPath: overrides.stdoutPath ?? join(progressStore.jobDir(overrides.jobId), 'stdout'),
    stderrPath: overrides.stderrPath ?? join(progressStore.jobDir(overrides.jobId), 'stderr'),
    startTime: overrides.startTime ?? new Date().toISOString(),
  });
}

function stubAppServerRuntime(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  jobId: string,
  provider: string,
  startTime = '2026-04-12T00:00:00.000Z',
): void {
  progressStore.appendRuntimeStarted(jobId, {
    transport: 'app-server',
    startTime,
    providerMeta: {
      provider,
      leaseState: 'acquired',
    },
  });
}

function commitTerminalEvent(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  overrides: {
    jobId: string;
    sessionId: string;
    backendNamespace: string;
    projectRoot: string;
    outcome: Record<string, unknown>;
    content?: string;
  },
): void {
  commitJobInput(progressStore, {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: overrides.jobId },
    namespace: overrides.backendNamespace,
    project: overrides.projectRoot,
    refs: { jobId: overrides.jobId, sessionId: overrides.sessionId },
    bodyVersion: 1,
    body: {
      terminal: {
        outcome: overrides.outcome,
        durationMs: 0,
        content: overrides.content ?? '',
      },
    },
  });
}

function createLifecycleHarness(
  modules: LoadedModules,
  options: {
    pluginRoot: string;
    progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>;
    eventBus: InstanceType<LoadedModules['eventBusModule']['TypedEventBus']>;
    launchCoordinator?: InstanceType<LoadedModules['engineModule']['LaunchCoordinator']>;
    providerRegistry?: InstanceType<LoadedModules['providerRegistryModule']['ProviderRegistry']>;
    servicesByProjectRoot?: Map<string, unknown>;
    getExecutionService?: (ctx: { projectRoot: string }) => unknown;
    getRecoveryService?: (ctx: { projectRoot: string }) => unknown;
    runStartupRecoveryFn?: RunStartupRecoveryFn;
    interruptedAppServerReason?: 'restart' | 'handoff';
  },
) {
  const namespace = modules.pathsModule.pluginRootNamespace(options.pluginRoot);
  const { runtimeState } = createRuntimeStateMock();
  const idleTimer = createFakeIdleTimer();
  const providerRegistry = options.providerRegistry ?? createRecoveryProviderRegistry(modules);
  const launchCoordinator = options.launchCoordinator ?? createLaunchCoordinator(modules);
  const servicesByProjectRoot = options.servicesByProjectRoot ?? new Map<string, unknown>();
  const getExecutionService =
    options.getExecutionService ??
    ((ctx: { projectRoot: string }) => {
      const service = servicesByProjectRoot.get(ctx.projectRoot);
      if (!service) {
        throw new Error(`Unexpected execution service projectRoot: ${ctx.projectRoot}`);
      }
      return service;
    });
  const getRecoveryService = options.getRecoveryService ?? getExecutionService;
  const storeServices = createStoreServicesHarness(options.progressStore);

  const kbDaemonSupervisor = createMockKbDaemonSupervisor();
  const controller = modules.lifecycleModule.createLifecycle({
    identity: {
      pluginRoot: options.pluginRoot,
      namespace,
      version: '9.9.9',
      bundleHash: 'testhash1234',
      flavor: 'prod',
      instanceId: `lifecycle-${Math.random()}`,
      token: 'test-token',
      bootToken: 'test-boot-token',
      shutdownToken: 'test-shutdown-token',
      now: () => 1,
      log: () => {},
    },
    runtime: createRealRuntime('prod'),
    backendPid: 1234,
    runtimeState: runtimeState as never,
    idleTimer: idleTimer as never,
    storeServicesRef: storeServices.storeServicesRef,
    createStoreServicesFromDbFn: storeServices.createStoreServicesFromDbFn,
    streamResponses: new Set(),
    discussStores: new Map(),
    eventBus: options.eventBus,
    launchCoordinator,
    providerRegistry,
    server: createServer(),
    getExecutionService: getExecutionService as never,
    getRecoveryService: getRecoveryService as never,
    listExecutionServices: () => [...new Set(servicesByProjectRoot.values())] as never[],
    getDiscussStoreForSource: (() => {
      throw new Error('Unexpected discuss store lookup');
    }) as never,
    knownDiscussSources: () => new Set<string>(),
    getDiscussContext: () => {
      throw new Error('Unexpected discuss context lookup');
    },
    writeBackendInfoFn: () => {},
    removeBackendInfoIfOwnerFn: () => {},
    cleanupStaleJobsFn: () => {},
    markJobsAsErrorFn: () => {},
    terminateAllFn: () => {},
    providerHostManager: createFakeProviderHostManager() as never,
    kbDaemonSupervisor,
    handoffQuiescePorts: () => [],
    createKbHealthComponentFn: () => createKbDaemonHealthComponent(kbDaemonSupervisor),
    registerBuiltInProvidersFn: () => {},
    recoverPersistedDiscussFn: async () => [],
    runStartupRecoveryFn:
      options.runStartupRecoveryFn ??
      (async ({
        identity,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        recoveryCoordinator,
        signal,
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
          signal,
          log: identity.log,
          cleanupStaleJobs,
          sessionLookup: modules.sessionLookupModule.createProjectionSessionLookup(options.progressStore.getDb()),
          coordinatorCommit: createTestJobJournalDeps(options.progressStore, runtime).coordinatorCommit,
          interruptedAppServerReason: options.interruptedAppServerReason,
        });
        return [];
      }),
    hooks: {
      onShutdown: async () => {},
      onIdleCheck: () => false,
      onRecoveryComplete: async () => {},
    },
    closeServerFn: async () => {},
    listenFn: async () => ({ port: 4100, host: '127.0.0.1' }),
  });

  return {
    controller,
    runtimeState,
    launchCoordinator,
  };
}

function createActualRecoveryService(
  modules: LoadedModules,
  options: {
    progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>;
    eventBus: InstanceType<LoadedModules['eventBusModule']['TypedEventBus']>;
    launchCoordinator: InstanceType<LoadedModules['engineModule']['LaunchCoordinator']>;
    providerRegistry: InstanceType<LoadedModules['providerRegistryModule']['ProviderRegistry']>;
    pluginRoot: string;
    projectRoot: string;
  },
) {
  return new modules.serviceModule.ExecutionService(
    {
      projectRoot: options.projectRoot,
      pluginRoot: options.pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(options.projectRoot),
    },
    {
      runtime,
      childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
      progressStore: options.progressStore,
      bundleHash: 'testhash1234',
      backendNamespace: modules.pathsModule.pluginRootNamespace(options.pluginRoot),
      providerHostManager: createFakeProviderHostManager() as never,
      launchCoordinator: options.launchCoordinator,
      eventBus: options.eventBus,
      providerRegistry: options.providerRegistry,
      pluginRegistry: {
        discoverPluginRoot: () => null,
      },
      loadJobProjectionDetail: (() => ({}) as never) as never,
      readJobEvents: (() => []) as never,
      aggregateWorkflowUsage: () => undefined,
      subscribeJobEvents: async function* () {} as never,
      getCurrentJournalSeq: () => 0,
    },
  );
}

async function stopLifecycleController(controller: {
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
}): Promise<void> {
  try {
    await controller.shutdown('test');
  } catch {
    /* best effort */
  }
  try {
    await controller.waitForShutdown();
  } catch {
    /* best effort */
  }
}

describe('lifecycle recovery', () => {
  beforeEach(() => {
    mkdirSync(mockState.baseTmp, { recursive: true });
    mockState.tmpRoot = mkdtempSync(join(mockState.baseTmp, 'run-'));
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
    runtime = createRealRuntime('prod');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // vi.resetModules() removed: loadModules() resets before each fresh
    // import; the afterEach copy was redundant cache invalidation across
    // 24 tests.
    if (mockState.tmpRoot) {
      rmSync(mockState.tmpRoot, { recursive: true, force: true });
    }
    mockState.tmpHome = '';
    mockState.tmpRoot = '';
  });

  it('fences mutating RPCs as soon as kernel-ready is visible', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-kernel-ready-fence');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-kernel-ready-fence');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const sessionStart = vi.fn(async () => ({ status: 'running', job: 'live-job', session: 'live-session' }));
    const sessionsCreateSpec = modules.rpcCatalogModule.rpcCatalog.find((entry) => entry.name === 'sessions.create');
    if (!sessionsCreateSpec) {
      throw new Error('sessions.create spec not found');
    }

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      runStartupRecoveryFn: async () => {
        expect(runtimeState.getLifecycle()).toBe('kernel-ready');
        expect(runtimeState.getLaunchFenceActive()).toBe(true);

        const result = await modules.transportDispatchModule.executeCatalogRequest(
          sessionsCreateSpec,
          { provider: 'codex', prompt: 'live mutation', projectRoot },
          {
            identity: {
              pluginRoot,
              token: 'test-token',
              bootToken: 'test-boot-token',
              shutdownToken: 'test-shutdown-token',
              version: '9.9.9',
              bundleHash: 'testhash1234',
              flavor: 'prod',
              namespace,
              instanceId: 'test-instance',
              now: () => 1,
              log: vi.fn(),
            },
            coralEnvSnapshot: {},
            admin: {
              getLifecycleState: () => runtimeState.getLifecycle(),
              isLifecycleRunning: () => runtimeState.getLifecycle() === 'running',
              isDrainRequested: () => false,
              isLaunchFenceActive: () => runtimeState.getLaunchFenceActive(),
              beginRequest: vi.fn(),
              endRequest: vi.fn(),
              requestDrain: vi.fn(),
            },
            sessions: {
              start: sessionStart,
            },
          } as never,
          testProjectPrincipal(projectRoot),
        );

        expect(result).toEqual({
          kind: 'unary',
          statusCode: 503,
          body: {
            code: 'backend_recovering',
            message: 'recovering — retry after 500ms',
          },
        });
        expect(sessionStart).not.toHaveBeenCalled();
        return [];
      },
    });

    try {
      await controller.start();
      expect(runtimeState.setLaunchFenceActive.mock.calls).toEqual([[true], [false]]);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('records recovered provider artifact handles before recovered terminal completion even when cancellation was observed', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-recovered-handles');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-recovered-handles');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'dead-recovered-handles';
    const sessionId = 'session-recovered-handles';
    const callOrder: string[] = [];
    const launchRecord: JobLaunch = {
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: {
        prompt: 'recover',
        cwd: projectRoot,
        bypassPermissions: false,
        coralEnv: {},
        conversationRef: 'fallback-thread',
      },
      createdAt: new Date().toISOString(),
    };
    const runtimeRecord = {
      pid: 42,
      stdoutPath: '/tmp/recovered-stdout',
      stderrPath: '/tmp/recovered-stderr',
      startTime: '2026-04-12T00:00:00.000Z',
      providerMeta: { threadId: 'thread-from-runtime-meta' },
    };
    const finalizeFromArtifacts = vi.fn<ProviderRecoveryContract['finalizeFromArtifacts']>(async () => ({
      terminal: {
        kind: 'terminal',
        terminal: {
          content: 'recovered content',
          outcome: { kind: 'completed' },
        },
        diagnostics: {},
      },
      artifactHandles: [
        {
          handle: '/tmp/provider-artifact.jsonl',
          identity: { kind: 'test-artifact', path: '/tmp/provider-artifact.jsonl' },
        },
      ],
      continuity: {
        conversationRef: 'thread-from-runtime-meta',
        resumable: true,
      },
    }));
    const provider = {
      finalizeFromArtifacts,
    } as unknown as ProviderRecoveryContract;
    const service = createFakeExecutionAndRecoveryService({
      recordRecoveredArtifactHandles: vi.fn(async () => {
        expect(progressStore.readTerminalProjection(jobId)).toBeNull();
        callOrder.push('handles');
        return { ok: true as const, nextVersion: 2 };
      }),
      completeRecoveredJob: vi.fn(() => {
        expect(progressStore.readTerminalProjection(jobId)).toMatchObject({
          content: 'recovered content',
          outcome: { kind: 'completed' },
        });
        callOrder.push('complete');
      }),
      validateProviderRecoveryAuthority: vi.fn(async () => true),
    });

    ensureTestSession(progressStore, { sessionId, provider: 'codex', projectRoot, backendNamespace: namespace });
    progressStore.initJob({
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    });
    vi.spyOn(progressStore, 'readExitProjection').mockReturnValue({
      exitCode: 0,
      signal: null,
      endTime: '2026-04-12T00:01:00.000Z',
    });

    await modules.recoveryActionsModule.finalizeDeadAdoptedJob({
      jobId,
      launchRecord,
      runtimeRecord,
      service,
      provider,
      progressStore,
      runtime,
      sessionLookup: {
        readSessionEntry: () => ({
          sessionId,
          provider: 'codex',
          sessionAuthority: { kind: 'provider', binding: TEST_CODEX_BINDING },
          name: 'alpha',
          state: 'ready',
          retention: 'retain',
          artifactHandles: [],
          retentionDiscard: { attempts: [] },
          providerContinuity: null,
          cwd: projectRoot,
          projectRoot,
          backendNamespace: namespace,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          version: 1,
        }),
      },
      cancelledJobIds: new Set([jobId]),
      log: () => {},
    });

    await vi.waitFor(() => {
      expect(service.completeRecoveredJob).toHaveBeenCalled();
    });
    expect(finalizeFromArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        stdoutPath: '/tmp/recovered-stdout',
        stderrPath: '/tmp/recovered-stderr',
        providerMeta: { threadId: 'thread-from-runtime-meta' },
        source: TEST_CODEX_SOURCE,
        storage: runtime.storage,
      }),
    );
    expect(service.recordRecoveredArtifactHandles).toHaveBeenCalledWith(sessionId, {
      jobId,
      provider: 'codex',
      handles: [
        {
          handle: '/tmp/provider-artifact.jsonl',
          identity: { kind: 'test-artifact', path: '/tmp/provider-artifact.jsonl' },
        },
      ],
    });
    expect(callOrder).toEqual(['handles', 'complete']);
  });

  it('1. queued recoverable jobs are restored in FIFO enqueueSequence order', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-queued');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-queued');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = createLaunchCoordinator(modules);
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    });
    const recoverQueuedSpy = vi.spyOn(service, 'recoverQueuedJob');

    stubLaunchRecord(progressStore, {
      jobId: 'queued-high',
      sessionId: 'session-high',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 20,
    });
    appendQueuedEvent(progressStore, 'queued-high', 'session-high', namespace, projectRoot, 2);

    stubLaunchRecord(progressStore, {
      jobId: 'queued-low',
      sessionId: 'session-low',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 10,
    });
    appendQueuedEvent(progressStore, 'queued-low', 'session-low', namespace, projectRoot, 1);

    const { controller, launchCoordinator: recoveredCoordinator } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    });

    try {
      await controller.start();
      expect(recoverQueuedSpy.mock.calls.map(([record]) => record.jobId)).toEqual(['queued-low', 'queued-high']);
      expect(recoveredCoordinator.queuePosition('queued-low')).toBe(1);
      expect(recoveredCoordinator.queuePosition('queued-high')).toBe(2);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('1b. aborting a queued recoverable job during startup recovery finalizes it without launching', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-queued-abort');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-queued-abort');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = createLaunchCoordinator(modules);
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    });
    const recoverQueuedSpy = vi.spyOn(service, 'recoverQueuedJob');
    const jobId = 'queued-recovery-abort';
    let abortResult: { aborted: string[]; notFound: string[] } | null = null;

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'queued-recovery-abort-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 1,
    });
    appendQueuedEvent(progressStore, jobId, 'queued-recovery-abort-session', namespace, projectRoot, 1);

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
      runStartupRecoveryFn: async ({
        identity,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        recoveryCoordinator,
        signal,
      }) => {
        await recoveryCoordinator.runStartupRecovery({
          namespace: identity.namespace,
          bundleHash: identity.bundleHash,
          runtime,
          progressStore,
          providerRegistry,
          getRecoveryService,
          createInvocationContext,
          signal,
          log: identity.log,
          cleanupStaleJobs: () => {
            abortResult = recoveryCoordinator.getRecoveryRegistry()?.abort([jobId]) ?? null;
          },
          sessionLookup: modules.sessionLookupModule.createProjectionSessionLookup(progressStore.getDb()),
          coordinatorCommit: createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
        });
        return [];
      },
    });

    try {
      await controller.start();
      expect(abortResult).toEqual({ aborted: [jobId], notFound: [] });
      expect(recoverQueuedSpy).not.toHaveBeenCalled();
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'aborted',
        result: { outcome: { kind: 'aborted', reason: 'user_abort' } },
      });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('2. running durable-cli job with a live PID is adopted before the launch fence lifts', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-running');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-running');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = createLaunchCoordinator(modules);
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    });
    const adoptSpy = vi.spyOn(service, 'adoptRunningJob');

    stubLaunchRecord(progressStore, {
      jobId: 'running-live',
      sessionId: 'session-running-live',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, {
      jobId: 'running-live',
      pid: process.pid,
      startTime: '2026-04-12T00:00:00.000Z',
    });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    });

    try {
      await controller.start();
      expect(adoptSpy).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'running-live' }),
        expect.objectContaining({ pid: process.pid }),
      );
      expect(launchCoordinator.getActiveJobIds()).toContain('running-live');
      const adoptOrder = adoptSpy.mock.invocationCallOrder[0];
      const fenceOffOrder = runtimeState.setLaunchFenceActive.mock.invocationCallOrder.find(
        (_call: number, index: number) => runtimeState.setLaunchFenceActive.mock.calls[index]?.[0] === false,
      );
      expect(adoptOrder).toBeDefined();
      expect(fenceOffOrder).toBeDefined();
      expect(adoptOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(fenceOffOrder ?? Number.POSITIVE_INFINITY);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('2b. aborting an adopted running durable job during recovery finalizes as aborted when it dies', async () => {
    const { spawn } = await import('node:child_process');
    const { createCoordinatorControl } = await import('#src/coordinator/composition/job-control.js');
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-running-adopted-abort');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-running-adopted-abort');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = createLaunchCoordinator(modules);
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    });
    const jobId = 'running-adopted-abort';
    // Real PID adoption/kill semantics require an actual child process here.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (child.pid === undefined) {
      throw new Error('Expected spawned child pid for adopted-running abort test');
    }

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'running-adopted-abort-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: child.pid,
      startTime: '2026-04-12T00:00:00.000Z',
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    });

    try {
      await controller.start();
      const control = createCoordinatorControl({
        world: { idleTimer: { requestDrain() {} } } as never,
        listExecutionServices: () => [service] as never,
        getLifecycleController: () => controller,
        backendNamespace: namespace,
        getProgressStore: () => progressStore,
        internalJobAbortRegistry: {
          abort: (jobIds: string[]) => ({ aborted: [], notFound: jobIds }),
        } as never,
      });

      expect(control.abortJobs([jobId])).toEqual({ aborted: [jobId], notFound: [] });

      await vi.waitFor(
        () => {
          expect(progressStore.readStatus(jobId)).toMatchObject({
            phase: 'aborted',
            result: { outcome: { kind: 'aborted', reason: 'user_abort' } },
          });
        },
        { timeout: 4_000 },
      );
    } finally {
      child.kill('SIGKILL');
      await stopLifecycleController(controller);
    }
  });

  it.each([['3. launching without runtime finalizes as ghost_launch', 'launching']])('%s', async (_label, phase) => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot(`plugin-ghost-${phase}`);
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot(`project-ghost-${phase}`);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: `ghost-${phase}`,
      sessionId: `session-${phase}`,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus(`ghost-${phase}`)).toMatchObject({
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } } },
      });
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it.each([
    ['5. foreign queued jobs finalize as wrapper_lost', 'queued', false, false],
    ['6. foreign launching jobs finalize as wrapper_lost', 'launching', false, false],
    ['7. foreign running durable jobs finalize as wrapper_lost', 'running', true, false],
    ['8. foreign running app-server jobs finalize as wrapper_lost', 'running', false, true],
    ['9. foreign live PIDs still finalize as wrapper_lost', 'running', true, false],
  ])('%s', async (_label, phase, durableRuntime, appServerRuntime) => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot(
      `plugin-foreign-${phase}-${durableRuntime ? 'durable' : appServerRuntime ? 'app' : 'none'}`,
    );
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot(`project-foreign-${phase}`);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();
    const jobId = `foreign-${phase}-${durableRuntime ? 'durable' : appServerRuntime ? 'app' : 'none'}`;
    const foreignNamespace = 'foreign-namespace';

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: `${jobId}-session`,
      provider: 'codex',
      projectRoot,
      backendNamespace: foreignNamespace,
    });
    if (phase === 'queued') {
      appendQueuedEvent(progressStore, jobId, `${jobId}-session`, foreignNamespace, projectRoot, 1);
    }
    if (durableRuntime) {
      stubRuntimeRecord(progressStore, {
        jobId,
        pid: jobId.endsWith('none') ? 999_991 : process.pid,
      });
    }
    if (appServerRuntime) {
      stubAppServerRuntime(progressStore, jobId, 'codex');
    }

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus(jobId)).toMatchObject({
        backendNamespace: foreignNamespace,
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
      });
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
      expect(fakeService.finalizeInterruptedAppServerJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('foreign workflow parent jobs finalize as wrapper_lost before workflow resume ownership', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-foreign-workflow-parent');
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-foreign-workflow-parent');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();
    const foreignNamespace = 'foreign-workflow-namespace';

    stubLaunchRecord(progressStore, {
      jobId: 'foreign-workflow-parent',
      sessionId: 'foreign-workflow-parent-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: foreignNamespace,
      jobKind: 'workflow',
    });
    stubRuntimeRecord(progressStore, {
      jobId: 'foreign-workflow-parent',
      pid: process.pid,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus('foreign-workflow-parent')).toMatchObject({
        backendNamespace: foreignNamespace,
        jobKind: 'workflow',
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
      });
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
      expect(fakeService.waitStream).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('10. current-namespace queued jobs are not finalized by the cross-namespace scan', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-local-queued');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-local-queued');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'local-queued',
      sessionId: 'local-queued-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 1,
    });
    appendQueuedEvent(progressStore, 'local-queued', 'local-queued-session', namespace, projectRoot, 1);

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus('local-queued')).toMatchObject({ backendNamespace: namespace, phase: 'queued' });
      expect(fakeService.recoverQueuedJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'local-queued' }));
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('11. same-namespace running jobs with dead pids finalize as wrapper_lost at planner time', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-dead-running');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-dead-running');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'dead-running',
      sessionId: 'dead-running-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, {
      jobId: 'dead-running',
      pid: 999_999,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      // Planner detects the dead pid and emits markError(wrapper_lost) directly,
      // so the runtime poll in finalizeDeadAdoptedJob never runs and
      // adoptRunningJob is never invoked.
      expect(progressStore.readStatus('dead-running')).toMatchObject({
        backendNamespace: namespace,
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
      });
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('12. terminal jobs release stale session claims', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-terminal-claim');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-terminal-claim');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const sessionManager = new modules.sessionManagerModule.SessionManager(
      projectRoot,
      runtime,
      undefined,
      undefined,
      db,
    );
    const session = allocateTestSession(sessionManager, 'codex', 'alpha', undefined, projectRoot);
    const fakeService = createFakeExecutionAndRecoveryService();

    progressStore.initJob({
      jobId: 'terminal-job',
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    });
    commitTerminalEvent(progressStore, {
      jobId: 'terminal-job',
      sessionId: session.sessionId,
      backendNamespace: namespace,
      projectRoot,
      outcome: { kind: 'completed' },
    });
    sessionManager.claimForJobSync(session.sessionId, 'terminal-job');

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });
    try {
      await controller.start();
      expect(
        new modules.sessionManagerModule.SessionManager(projectRoot, runtime, undefined, undefined, db).get(
          'codex',
          session.sessionId,
        )?.activeJobId,
      ).toBeUndefined();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('13. orphaned session claims release when the referenced job is missing', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-orphan-claim');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-orphan-claim');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const sessionManager = new modules.sessionManagerModule.SessionManager(
      projectRoot,
      runtime,
      undefined,
      undefined,
      db,
    );
    const session = allocateTestSession(sessionManager, 'codex', 'alpha', undefined, projectRoot);
    const fakeService = createFakeExecutionAndRecoveryService();

    sessionManager.claimForJobSync(session.sessionId, 'missing-job');

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(
        new modules.sessionManagerModule.SessionManager(projectRoot, runtime, undefined, undefined, db).get(
          'codex',
          session.sessionId,
        )?.activeJobId,
      ).toBeUndefined();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14. running app-server jobs route through finalizeInterruptedAppServerJob(restart)', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-app-server');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-app-server');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'app-server-job',
      sessionId: 'app-server-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    // Inline runtime-record write (vs. the shared stubAppServerRuntime helper) is required
    // here because the helper does not accept providerContinuity payload; this test verifies
    // that the threadId field propagates through finalizeInterruptedAppServerJob.
    progressStore.appendRuntimeStarted('app-server-job', {
      transport: 'app-server',
      startTime: '2026-03-31T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        providerContinuity: {
          provider: 'codex',
          threadId: 'thread-1',
        },
      },
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'app-server-job' }),
        expect.objectContaining({
          transport: 'app-server',
          providerMeta: expect.objectContaining({
            providerContinuity: expect.objectContaining({ threadId: 'thread-1' }),
          }),
        }),
        { reason: 'restart' },
      );
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14b. handoff startup recovery routes app-server jobs through finalizeInterruptedAppServerJob(handoff)', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-app-server-handoff');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-app-server-handoff');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'app-server-handoff-job',
      sessionId: 'app-server-handoff-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore.appendRuntimeStarted('app-server-handoff-job', {
      transport: 'app-server',
      startTime: '2026-03-31T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        providerContinuity: {
          provider: 'codex',
          threadId: 'handoff-thread-1',
        },
      },
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      interruptedAppServerReason: 'handoff',
    });

    try {
      await controller.start();
      expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'app-server-handoff-job' }),
        expect.objectContaining({
          transport: 'app-server',
          providerMeta: expect.objectContaining({
            providerContinuity: expect.objectContaining({ threadId: 'handoff-thread-1' }),
          }),
        }),
        { reason: 'handoff' },
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('15. current-namespace live durable jobs stay running after startup recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-running-stays-running');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-running-stays-running');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = createLaunchCoordinator(modules);
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    });

    stubLaunchRecord(progressStore, {
      jobId: 'still-running',
      sessionId: 'still-running-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, {
      jobId: 'still-running',
      pid: process.pid,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus('still-running')).toMatchObject({ phase: 'running' });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('16. foreign terminal jobs are ignored by the cross-namespace scan', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-foreign-terminal');
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-foreign-terminal');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'foreign-terminal',
      sessionId: 'foreign-terminal-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'foreign-terminal-namespace',
    });
    commitTerminalEvent(progressStore, {
      jobId: 'foreign-terminal',
      sessionId: 'foreign-terminal-session',
      backendNamespace: 'foreign-terminal-namespace',
      projectRoot,
      outcome: { kind: 'completed' },
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus('foreign-terminal')).toMatchObject({
        backendNamespace: 'foreign-terminal-namespace',
        phase: 'completed',
      });
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('17. foreign running jobs append wrapper_lost into progress history', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-foreign-history');
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-foreign-history');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'foreign-history',
      sessionId: 'foreign-history-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'foreign-history-namespace',
    });
    stubRuntimeRecord(progressStore, {
      jobId: 'foreign-history',
      pid: 999_992,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      const history = progressStore.readJobEvents('foreign-history');
      expect(history.at(-1)).toMatchObject({
        type: 'terminal',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
      });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('18. cross-namespace recovery preserves the foreign backend namespace in status', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-foreign-namespace-preserved');
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-foreign-namespace-preserved');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'foreign-preserved',
      sessionId: 'foreign-preserved-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'foreign-preserved-namespace',
    });
    appendQueuedEvent(
      progressStore,
      'foreign-preserved',
      'foreign-preserved-session',
      'foreign-preserved-namespace',
      projectRoot,
      1,
    );

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus('foreign-preserved')?.backendNamespace).toBe('foreign-preserved-namespace');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('19. current-namespace queued jobs remain queued after startup recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-local-queued-stays-queued');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-local-queued-stays-queued');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'queued-stays-queued',
      sessionId: 'queued-stays-queued-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 1,
    });
    appendQueuedEvent(progressStore, 'queued-stays-queued', 'queued-stays-queued-session', namespace, projectRoot, 1);

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(progressStore.readStatus('queued-stays-queued')).toMatchObject({ phase: 'queued' });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('20. ghost_launch recovery does not call recoverQueuedJob', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-ghost-no-queued');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-ghost-no-queued');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'ghost-no-queued',
      sessionId: 'ghost-no-queued-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('21. foreign queued recovery does not call recoverQueuedJob', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-foreign-no-queued');
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-foreign-no-queued');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'foreign-no-queued',
      sessionId: 'foreign-no-queued-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'foreign-no-queued-namespace',
    });
    appendQueuedEvent(
      progressStore,
      'foreign-no-queued',
      'foreign-no-queued-session',
      'foreign-no-queued-namespace',
      projectRoot,
      1,
    );

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('22. foreign running recovery does not call adoptRunningJob', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-foreign-no-adopt');
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-foreign-no-adopt');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(currentNamespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'foreign-no-adopt',
      sessionId: 'foreign-no-adopt-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'foreign-no-adopt-namespace',
    });
    stubRuntimeRecord(progressStore, {
      jobId: 'foreign-no-adopt',
      pid: 999_993,
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('23. startup recovery toggles the launch fence on and then off', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-fence');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-fence');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService();

    stubLaunchRecord(progressStore, {
      jobId: 'fence-job',
      sessionId: 'fence-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 1,
    });
    appendQueuedEvent(progressStore, 'fence-job', 'fence-session', namespace, projectRoot, 1);

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(runtimeState.setLaunchFenceActive.mock.calls).toEqual([[true], [true], [false]]);
    } finally {
      await stopLifecycleController(controller);
    }
  });
});
