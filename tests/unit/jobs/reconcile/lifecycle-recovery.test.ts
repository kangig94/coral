import { currentCoralStoreFormat } from '#src/store-format.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateTestSession } from '../../../helpers/session.js';
import { TEST_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

import type { JobLaunch } from '#src/jobs/records.js';
import type { LaunchPool } from '#src/jobs/contracts/admission.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { SessionManager } from '#src/sessions/shell.js';
import { reduceSessionOpened } from '#src/sessions/projections.js';
import type { CoralEvent } from '#src/store/envelope.js';
import { getEvent } from '#src/store/event-queries.js';
import type { JobStore } from '#src/jobs/store.js';
import type { SessionOpenedBody } from '#src/sessions/event-bodies.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbDaemonHealthComponent } from '#src/coordinator/runtime-components/kb-health-component.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { commitJobInput } from '#tests/helpers/job-commits.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import type { RunStartupRecoveryFn } from '#src/coordinator/lifecycle.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { none } from '#src/providers/capability.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { prepareFixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';

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
    workflowEventsModule,
    jobsEventsModule,
    reducersModule,
    recoveryCoordinatorModule,
    jobsStartupModule,
    workflowRecoverModule,
    jobsReadQueriesModule,
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
    import('#src/workflow/events.js'),
    import('#src/jobs/events.js'),
    import('#src/store/reducers.js'),
    import('#src/coordinator/services/recovery/index.js'),
    import('#src/jobs/startup.js'),
    import('#src/workflow/recover.js'),
    import('#src/jobs/read-queries.js'),
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
    workflowEventsModule,
    jobsEventsModule,
    reducersModule,
    recoveryCoordinatorModule,
    jobsStartupModule,
    workflowRecoverModule,
    jobsReadQueriesModule,
  };
}

function createRecoveryProviderRegistry(modules: LoadedModules) {
  const registry = new modules.providerRegistryModule.ProviderRegistry();
  registry.register(
    modules.providerRegistryModule
      .defineProvider({
        name: 'codex',
        transport: 'standalone',
        run: async function* noopProvider() {},
        prepareExecutionPlan: prepareFixtureExecutionPlan,
      })
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

function createControllableTimeoutRuntime(baseRuntime: ReturnType<typeof createRealRuntime>) {
  const scheduled: Array<{ callback: () => void; handle: TimerHandle; ms: number }> = [];
  const setTimeout = vi.fn((callback: () => void, ms: number): TimerHandle => {
    const handle: TimerHandle = { unref: vi.fn() };
    scheduled.push({ callback, handle, ms });
    return handle;
  });
  const clearTimeout = vi.fn((handle: TimerHandle | null): void => {
    const index = scheduled.findIndex((timer) => timer.handle === handle);
    if (index !== -1) scheduled.splice(index, 1);
  });

  return {
    runtime: {
      ...baseRuntime,
      time: { ...baseRuntime.time, setTimeout, clearTimeout },
    },
    setTimeout,
    runNextTimeout(): number {
      const timer = scheduled.shift();
      if (!timer) throw new Error('No controlled timeout is scheduled.');
      timer.callback();
      return timer.ms;
    },
    pendingTimeoutCount: () => scheduled.length,
    discardScheduledTimeouts: () => scheduled.splice(0),
  };
}

function createFakeExecutionAndRecoveryService(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => ({ status: 'running', job: 'started-job', session: 'started-session' })),
    executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job' })),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(async () => ({ type: 'waiting', waitingJobIds: [] })),
    adoptRunningJob: vi.fn(async () => ({ adopted: true, cleanup: vi.fn() })),
    captureProviderRecoveryAuthority: vi.fn(
      async (launchRecord: JobLaunch) =>
        ({
          ok: true,
          authority: {
            launchRecord,
            session: { sessionId: launchRecord.sessionId },
            boundProvider: { name: launchRecord.provider },
          },
        }) as never,
    ),
    finalizeProviderRecoveryBindingFailure: vi.fn(() => 'released' as const),
    recoverQueuedJob: vi.fn(async () => 'recovered-job'),
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
    jobKind?: 'provider' | 'workflow';
  },
): void {
  if (overrides.jobKind !== 'workflow') {
    ensureTestSession(progressStore, {
      jobId: overrides.jobId,
      sessionId: overrides.sessionId,
      provider: overrides.provider,
      projectRoot: overrides.projectRoot,
      backendNamespace: overrides.backendNamespace,
    });
  }
  const workflow = overrides.jobKind === 'workflow';
  if (workflow) {
    progressStore.commit((c) => {
      c.append(
        workflowPlanDeclaredEvent(
          overrides.jobId,
          {
            slots: [
              {
                slotId: `${overrides.jobId}:0:0`,
                dependencies: [],
                provider: overrides.provider,
                instruction: 'recovery fixture',
              },
            ],
          },
          TEST_PROVIDER_SCOPE,
        ),
      );
      return undefined;
    });
  }
  const common = {
    jobId: overrides.jobId,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    pool: overrides.pool ?? 'default',
    enqueueSequence: overrides.enqueueSequence ?? 0,
    createdAt: new Date().toISOString(),
  } as const;
  const request = {
    prompt: '',
    cwd: overrides.projectRoot,
    bypassPermissions: false,
    coralEnv: {},
  };
  const record: JobLaunch = workflow
    ? {
        ...common,
        owner: { kind: 'workflow', id: overrides.jobId },
        sessionId: null,
        provider: null,
        jobKind: 'workflow',
        request,
      }
    : {
        ...common,
        owner: { kind: 'provider-session', id: overrides.sessionId },
        sessionId: overrides.sessionId,
        provider: overrides.provider,
        jobKind: 'provider',
        providerAction: 'exec',
        request,
      };
  progressStore.appendLaunchRequested(overrides.jobId, record);
}

function ensureTestSession(
  progressStore: InstanceType<LoadedModules['progressStoreModule']['JobStore']>,
  options: {
    jobId: string;
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
  },
): void {
  const exists = progressStore
    .getDb()
    .prepare<[string], { found: number }>('SELECT 1 AS found FROM projection_sessions WHERE session_id = ?')
    .get(options.sessionId);
  if (exists !== undefined) {
    const existing = new SessionManager(
      options.projectRoot,
      runtime,
      undefined,
      undefined,
      progressStore.getDb(),
      permissiveProviderLookupPort,
    ).readById(options.sessionId, { forceFresh: true });
    if (existing?.activeJobId !== options.jobId) {
      throw new Error(`Test session '${options.sessionId}' is not claimed by '${options.jobId}'.`);
    }
    return;
  }
  if (options.provider !== 'codex') {
    throw new Error(`Test provider session '${options.provider}' has no credential source fixture.`);
  }
  const now = new Date().toISOString();
  const entry: ProviderSession = {
    sessionId: options.sessionId,
    binding: TEST_CODEX_BINDING,
    name: options.sessionId,
    state: 'pending',
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
    body,
  };
  reduceSessionOpened(progressStore.getDb(), event);
  const sessionManager = new SessionManager(
    options.projectRoot,
    runtime,
    undefined,
    undefined,
    progressStore.getDb(),
    permissiveProviderLookupPort,
  );
  if (!sessionManager.claimForJobSync(options.sessionId, options.jobId)) {
    throw new Error(`Failed to claim test session '${options.sessionId}' for '${options.jobId}'.`);
  }
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
    transport: 'durable-cli',
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
      hostRef: {
        provider: 'test',
        fingerprint: '0'.repeat(64),
        instanceId: 'instance-1',
        leaseMode: 'shared',
      },
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
    runtime?: ReturnType<typeof createRealRuntime>;
    log?: (message: string) => void;
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
    storeFormat: currentCoralStoreFormat(),
    identity: {
      pluginRoot: options.pluginRoot,
      namespace,
      version: '9.9.9',
      buildSetId: '00000000-0000-4000-8000-000000000000',
      bundleHash: 'testhash1234',
      cliBundleHash: 'testclihash1234',
      claudeAppserverBundleHash: 'testclaudehash12',
      flavor: 'prod',
      instanceId: `lifecycle-${Math.random()}`,
      token: 'test-token',
      bootToken: 'test-boot-token',
      shutdownToken: 'test-shutdown-token',
      now: () => 1,
      log: options.log ?? (() => {}),
    },
    runtime: options.runtime ?? createRealRuntime('prod'),
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
    providerHostManager: createFakeProviderHostManager() as never,
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
      coordinatorCommit: createTestJobJournalDeps(options.progressStore, runtime).coordinatorCommit,
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

/**
 * A `recovery_parse_failed` terminal records its reason on the job's own progress
 * stream and points at it with a causeRef, so asserting the terminal alone proves
 * nothing about the reason. Resolve the ref the way production does
 * (`src/workflow/recover.ts` uses the same `getEvent`) and assert the real message.
 */
function expectRecordedRecoveryFault(progressStore: JobStore, jobId: string, expectedMessage: string): void {
  const status = progressStore.readStatus(jobId);
  expect(status?.phase).toBe('error');
  const outcome = status?.result?.outcome;
  expect(outcome?.kind).toBe('failed');
  if (outcome?.kind !== 'failed') return;
  const { causeRef } = outcome;
  const cause = getEvent(progressStore.getDb(), causeRef.stream, causeRef.seq, progressStore);
  expect(cause?.body).toMatchObject({
    kind: 'recovery_parse_failed',
    cause: { message: expect.stringContaining(expectedMessage) },
  });
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

  it('awaits the durable recovery pipeline with an immutable death observation', async () => {
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
    const launchRecord: JobLaunch = {
      jobId,
      owner: { kind: 'provider-session', id: sessionId },
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
      },
      createdAt: new Date().toISOString(),
    };
    const runtimeRecord = {
      transport: 'durable-cli' as const,
      pid: 42,
      stdoutPath: '/tmp/recovered-stdout',
      stderrPath: '/tmp/recovered-stderr',
      startTime: '2026-04-12T00:00:00.000Z',
    };
    let releaseFinalizer!: () => void;
    const finalizerBlocked = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    const finalizeInterruptedDurableJob = vi.fn(async () => finalizerBlocked);
    const service = createFakeExecutionAndRecoveryService({
      finalizeInterruptedDurableJob,
    });

    ensureTestSession(progressStore, {
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
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

    const authority = {
      launchRecord: launchRecord as never,
      session: {
        sessionId,
        artifactHandles: [],
        conversationRef: 'fallback-thread',
        providerContinuity: null,
        projectRoot,
        version: 1,
      },
      boundProvider: { name: 'codex' },
    } as never;
    let settled = false;
    const finalization = modules.recoveryActionsModule
      .finalizeDeadAdoptedJob({
        jobId,
        runtimeRecord,
        service,
        authority,
        progressStore,
        cancelledJobIds: new Set([jobId]),
        fence: { signal: new AbortController().signal, onCommitStart: vi.fn() },
      })
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(finalizeInterruptedDurableJob).toHaveBeenCalled());
    expect(settled).toBe(false);
    expect(finalizeInterruptedDurableJob).toHaveBeenCalledWith(
      authority,
      runtimeRecord,
      {
        exit: {
          exitCode: 0,
          signal: null,
          endTime: '2026-04-12T00:01:00.000Z',
        },
        terminal: null,
        cancelled: true,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal), onCommitStart: expect.any(Function) }),
    );
    releaseFinalizer();
    await finalization;
    expect(settled).toBe(true);
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
      expect(recoverQueuedSpy.mock.calls.map(([authority]) => authority.launchRecord.jobId)).toEqual([
        'queued-low',
        'queued-high',
      ]);
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
        expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: 'running-live' }) }),
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
      reducers: modules.reducersModule.composeReducers(
        modules.jobsEventsModule.jobsRegistry,
        modules.workflowEventsModule.workflowRegistry,
      ),
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
      expect(fakeService.recoverQueuedJob).toHaveBeenCalledWith(
        expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: 'local-queued' }) }),
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('11. same-namespace provider jobs with dead pids use the BoundProvider durable finalizer', async () => {
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
      expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledWith(
        expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: 'dead-running' }) }),
        expect.objectContaining({ transport: 'durable-cli', pid: 999_999 }),
        expect.objectContaining({ exit: null, terminal: null, cancelled: false }),
        expect.objectContaining({ signal: expect.any(AbortSignal), onCommitStart: expect.any(Function) }),
      );
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('11b. dead-on-start durable finalization failure is a per-job fault, not a boot failure', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-dead-finalizer-blocked');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-dead-finalizer-blocked');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'dead-finalizer-blocked-job';
    const fakeService = createFakeExecutionAndRecoveryService({
      finalizeInterruptedDurableJob: vi.fn(async () => {
        throw new Error('exact session CAS went stale');
      }),
    });

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'dead-finalizer-blocked-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, { jobId, pid: 999_998 });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });

    try {
      await controller.start();
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
      // The terminal is `failed` with the reason on the job's own stream behind a
      // causeRef; resolve it so a wrong or unresolvable ref cannot pass.
      expectRecordedRecoveryFault(progressStore, jobId, 'exact session CAS went stale');
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
      permissiveProviderLookupPort,
    );
    const session = allocateTestSession(
      sessionManager,
      'codex',
      'alpha',
      undefined,
      projectRoot,
      projectRoot,
      namespace,
    );
    const fakeService = createFakeExecutionAndRecoveryService();

    expect(sessionManager.claimForJobSync(session.sessionId, 'terminal-job')).toBe(true);
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
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    });
    try {
      await controller.start();
      expect(
        new modules.sessionManagerModule.SessionManager(
          projectRoot,
          runtime,
          undefined,
          undefined,
          db,
          permissiveProviderLookupPort,
        ).get('codex', session.sessionId)?.activeJobId,
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
      permissiveProviderLookupPort,
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
        new modules.sessionManagerModule.SessionManager(
          projectRoot,
          runtime,
          undefined,
          undefined,
          db,
          permissiveProviderLookupPort,
        ).get('codex', session.sessionId)?.activeJobId,
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
      sessionId: 'recovered-provider-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore.appendRuntimeStarted('app-server-job', {
      transport: 'app-server',
      startTime: '2026-03-31T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        hostRef: {
          provider: 'test',
          fingerprint: '0'.repeat(64),
          instanceId: 'instance-1',
          leaseMode: 'shared',
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
        expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: 'app-server-job' }) }),
        expect.objectContaining({
          transport: 'app-server',
          providerMeta: expect.not.objectContaining({ providerContinuity: expect.anything() }),
        }),
        expect.objectContaining({
          reason: 'restart',
          signal: expect.any(AbortSignal),
          onCommitStart: expect.any(Function),
        }),
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
        hostRef: {
          provider: 'test',
          fingerprint: '0'.repeat(64),
          instanceId: 'instance-1',
          leaseMode: 'shared',
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
        expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: 'app-server-handoff-job' }) }),
        expect.objectContaining({
          transport: 'app-server',
          providerMeta: expect.not.objectContaining({ providerContinuity: expect.anything() }),
        }),
        expect.objectContaining({
          reason: 'handoff',
          signal: expect.any(AbortSignal),
          onCommitStart: expect.any(Function),
        }),
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14c. interrupted app-server finalization failure is a per-job fault, not a boot failure', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-app-server-blocked');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-app-server-blocked');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService({
      finalizeInterruptedAppServerJob: vi.fn(async () => {
        throw new Error('session CAS became stale');
      }),
    });
    const jobId = 'app-server-blocked-job';

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'app-server-blocked-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore.appendRuntimeStarted(jobId, {
      transport: 'app-server',
      startTime: '2026-03-31T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'waiting',
      },
    });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
    });

    try {
      await controller.start();
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
      // The terminal is `failed` with the reason on the job's own stream behind a
      // causeRef; resolve it so a wrong or unresolvable ref cannot pass.
      expectRecordedRecoveryFault(progressStore, jobId, 'session CAS became stale');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  // This case covers isolation inside the adoption loop. Register-stage isolation is
  // exercised separately because it has a different exception boundary.
  it('14c2. one unresolvable job does not abandon the recovery of another', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-app-server-isolation');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-app-server-isolation');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const blockedJobId = 'isolation-blocked-job';
    const healthyJobId = 'isolation-healthy-job';
    const fakeService = createFakeExecutionAndRecoveryService({
      finalizeInterruptedAppServerJob: vi.fn(async (authority: { launchRecord: { jobId: string } }) => {
        if (authority.launchRecord.jobId === blockedJobId) {
          throw new Error('replacement host could not be opened');
        }
      }),
    });

    for (const jobId of [blockedJobId, healthyJobId]) {
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: `${jobId}-session`,
        provider: 'codex',
        projectRoot,
        backendNamespace: namespace,
      });
      progressStore.appendRuntimeStarted(jobId, {
        transport: 'app-server',
        startTime: '2026-03-31T00:00:00.000Z',
        providerMeta: { provider: 'codex', leaseState: 'waiting' },
      });
    }

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
    });

    try {
      await controller.start();
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      // The healthy job's recovery ran even though the other one could not be resolved.
      expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledTimes(2);
      expectRecordedRecoveryFault(progressStore, blockedJobId, 'replacement host could not be opened');
      expect(controller.getRecoveryRegistry()?.has(healthyJobId) ?? false).toBe(false);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('passes safe job enumeration from job recovery into workflow recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-safe-workflow-enumeration');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-safe-workflow-enumeration');
    const workflowId = 'workflow-safe-enumeration';
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
      reducers: modules.reducersModule.composeReducers(
        modules.jobsEventsModule.jobsRegistry,
        modules.workflowEventsModule.workflowRegistry,
      ),
    });
    stubLaunchRecord(progressStore, {
      jobId: workflowId,
      sessionId: 'unused-workflow-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      jobKind: 'workflow',
    });
    db.prepare(
      `INSERT INTO projection_jobs (
         job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
         project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
         workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
       )
       SELECT
         '', execution_owner, phase, terminal, diagnostics, session_id, provider,
         project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
         workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
       FROM projection_jobs
       WHERE job_id = ?`,
    ).run(workflowId);
    const service = createFakeExecutionAndRecoveryService();
    const log = vi.fn<(message: string) => void>();
    const coordinatorCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const recoveryCoordinator = modules.recoveryCoordinatorModule.createRecoveryCoordinator({
      progressStore,
      runtime,
      runtimeState: { setLaunchFenceActive: vi.fn() },
      eventBus,
      getRecoveryService: () => service as never,
      createInvocationContext: (root: string) => ({
        projectRoot: root,
        pluginRoot,
        coralEnv: {},
        principal: testProjectPrincipal(root),
      }),
      log,
    });
    const signal = new AbortController().signal;

    try {
      const recoveryProgressStore = await modules.jobsStartupModule.jobsReconcile.runStartup({
        namespace,
        bundleHash: 'test-bundle',
        runtime,
        progressStore,
        providerRegistry: createRecoveryProviderRegistry(modules),
        getRecoveryService: () => service as never,
        createInvocationContext: (root: string) => ({
          projectRoot: root,
          pluginRoot,
          coralEnv: {},
          principal: testProjectPrincipal(root),
        }),
        signal,
        log,
        cleanupStaleJobs: () => {},
        sessionLookup: modules.sessionLookupModule.createProjectionSessionLookup(db),
        coordinatorCommit,
        recoveryCoordinator,
      });
      expect(() => progressStore.listJobIds()).toThrow();
      expect(recoveryProgressStore.listJobIds()).toContain(workflowId);
      const finalizeWorkflow = vi.fn();
      await expect(
        modules.workflowRecoverModule.resumeAll({
          db,
          progressStore: recoveryProgressStore,
          loadJobDetails: modules.jobsReadQueriesModule.loadJobProjectionDetails,
          getExecutionService: () => service as never,
          createInvocationContext: (root: string) => ({
            projectRoot: root,
            pluginRoot,
            coralEnv: {},
            principal: testProjectPrincipal(root),
          }),
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: () => [],
          signal,
          time: runtime.time,
        }),
      ).resolves.toEqual([workflowId]);
      expect(finalizeWorkflow).toHaveBeenCalledWith(expect.objectContaining({ workflowJobId: workflowId }));
      expect(log.mock.calls.flat().join('')).not.toContain(`Skipped hydrating workflow job ${workflowId}`);
    } finally {
      await recoveryCoordinator.teardown();
      db.close();
    }
  });

  it('recovers a valid job while a different session projection is malformed', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-session-enumeration-isolation');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-session-enumeration-isolation');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const healthyJobId = 'healthy-job-with-malformed-session-row';
    const healthySessionId = `${healthyJobId}-session`;
    stubLaunchRecord(progressStore, {
      jobId: healthyJobId,
      sessionId: healthySessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubAppServerRuntime(progressStore, healthyJobId, 'codex');
    db.prepare(
      `INSERT INTO projection_sessions (
         session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
       )
       SELECT ?, controller, resumable, conversation_ref, scope_key, '{', last_seq
       FROM projection_sessions
       WHERE session_id = ?`,
    ).run('malformed-recovery-session', healthySessionId);
    const finalizeInterruptedAppServerJob = vi.fn(async () => {});
    const fakeService = createFakeExecutionAndRecoveryService({ finalizeInterruptedAppServerJob });
    const log = vi.fn<(message: string) => void>();
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
      log,
    });

    try {
      await controller.start();
      expect(finalizeInterruptedAppServerJob).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().join('')).toContain(
        'Skipped malformed session projection for malformed-recovery-session during recovery snapshot',
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('recovers a valid job while containing attributable and unattributable malformed persisted records', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-job-hydration-isolation');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-job-hydration-isolation');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const malformedJobId = 'malformed-runtime-record-job';
    const healthyJobId = 'healthy-runtime-record-job';
    const finalizeInterruptedAppServerJob = vi.fn(async () => {});
    const fakeService = createFakeExecutionAndRecoveryService({ finalizeInterruptedAppServerJob });
    const log = vi.fn<(message: string) => void>();

    for (const jobId of [malformedJobId, healthyJobId]) {
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: `${jobId}-session`,
        provider: 'codex',
        projectRoot,
        backendNamespace: namespace,
      });
      progressStore.appendRuntimeStarted(jobId, {
        transport: 'app-server',
        startTime: '2026-03-31T00:00:00.000Z',
        providerMeta: { provider: 'codex', leaseState: 'waiting' },
      });
    }
    db.prepare("UPDATE events SET body = ? WHERE stream_id = ? AND type = 'job.runtime.started'").run(
      Buffer.from('not a stored event body'),
      malformedJobId,
    );
    db.prepare(
      `INSERT INTO projection_jobs (
         job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
         project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
         workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
       )
       SELECT
         '', execution_owner, phase, terminal, diagnostics, session_id, provider,
         project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
         workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
       FROM projection_jobs
       WHERE job_id = ?`,
    ).run(healthyJobId);

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
      log,
    });

    try {
      await controller.start();
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(malformedJobId) ?? false).toBe(false);
      expect(finalizeInterruptedAppServerJob).toHaveBeenCalledTimes(1);
      expect(finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
        expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: healthyJobId }) }),
        expect.anything(),
        expect.anything(),
      );

      const terminalRow = db
        .prepare<
          [string],
          { seq: number }
        >("SELECT seq FROM events WHERE stream_id = ? AND type = 'job.terminal.recorded' ORDER BY seq DESC LIMIT 1")
        .get(malformedJobId);
      expect(terminalRow).toBeDefined();
      if (terminalRow === undefined) return;
      const terminalEvent = getEvent(db, { kind: 'job', id: malformedJobId }, terminalRow.seq, progressStore);
      const terminalBody = terminalEvent?.body as
        | {
            terminal?: { outcome?: { kind?: string; causeRef?: { stream: { kind: 'job'; id: string }; seq: number } } };
          }
        | undefined;
      expect(terminalBody?.terminal?.outcome?.kind).toBe('failed');
      const causeRef = terminalBody?.terminal?.outcome?.causeRef;
      expect(causeRef).toBeDefined();
      if (causeRef === undefined) return;
      expect(getEvent(db, causeRef.stream, causeRef.seq, progressStore)?.body).toMatchObject({
        kind: 'recovery_parse_failed',
        cause: { message: expect.stringContaining('Failed to decode events.body JSON') },
      });

      const sessionReader = new modules.sessionManagerModule.SessionManager(
        projectRoot,
        runtime,
        undefined,
        undefined,
        db,
        permissiveProviderLookupPort,
      );
      expect(sessionReader.get('codex', `${malformedJobId}-session`)?.activeJobId).toBeUndefined();
      const messages = log.mock.calls.flat().join('');
      expect(messages).toContain(`Persisted job recovery hydration failed for ${malformedJobId}`);
      expect(messages).toContain('The persisted-detail decode failure is included in this log.');
      expect(messages).not.toContain(`Run coral-cli jobs detail ${malformedJobId}`);
      expect(messages).toContain('Skipped malformed persisted job projection with no decodable job id');
      expect(
        db
          .prepare<
            [string],
            { seq: number }
          >("SELECT seq FROM events WHERE stream_id = ? AND type = 'job.terminal.recorded' LIMIT 1")
          .get(''),
      ).toBeUndefined();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  // BLOCKING finding from tier review: terminalizing without releasing the claim left
  // `activeJobId` pointed at a terminal job, so every later launch on that session was
  // rejected `session_busy` ("wait for it to complete or abort it first" — both false)
  // until the next boot. 14c cannot catch it: it passes a bare sessionId string with no
  // session entry, so there is no claim to leak. This one uses a real claimed session.
  it('14c3. an unresolvable app-server job releases its session claim immediately', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-app-server-claim');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-app-server-claim');
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
      permissiveProviderLookupPort,
    );
    const session = allocateTestSession(
      sessionManager,
      'codex',
      'alpha',
      undefined,
      projectRoot,
      projectRoot,
      namespace,
    );
    const jobId = 'app-server-claim-job';
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
    const fakeService = createFakeExecutionAndRecoveryService({
      finalizeInterruptedAppServerJob: vi.fn(async () => {
        throw new Error('replacement host could not be opened');
      }),
    });

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore.appendRuntimeStarted(jobId, {
      transport: 'app-server',
      startTime: '2026-03-31T00:00:00.000Z',
      providerMeta: { provider: 'codex', leaseState: 'waiting' },
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
    });

    try {
      await controller.start();
      expectRecordedRecoveryFault(progressStore, jobId, 'replacement host could not be opened');
      // Released in this boot, not deferred to the next one: the session is immediately
      // claimable again, which is what keeps the conversation resumable.
      // Read and re-claim through a fresh manager, matching test 12: the release must be
      // durable, and `releaseJob` bumps the session version so a handle held from before
      // the release would fail its CAS for a reason unrelated to the fix.
      const reader = new modules.sessionManagerModule.SessionManager(
        projectRoot,
        runtime,
        undefined,
        undefined,
        db,
        permissiveProviderLookupPort,
      );
      expect(reader.get('codex', session.sessionId)?.activeJobId).toBeUndefined();
      expect(reader.claimForJobSync(session.sessionId, 'a-later-job')).toBe(true);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it.each(['queued', 'running'] as const)(
    '14c4. a thrown %s registration failure is terminalized without aborting startup',
    async (recoveryKind) => {
      const modules = await loadModules();
      const pluginRoot = createProjectRoot(`plugin-${recoveryKind}-registration-throws`);
      const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
      const projectRoot = createProjectRoot(`project-${recoveryKind}-registration-throws`);
      const eventBus = new modules.eventBusModule.TypedEventBus();
      const db = openTestStoreDb(runtime, ':memory:');
      const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
        db,
        eventBus,
        providers: permissiveProviderLookupPort,
      });
      const jobId = `${recoveryKind}-registration-throws-job`;
      const sessionId = `${jobId}-session`;
      const captureError = `${recoveryKind} authority capture rejected`;
      const fakeService = createFakeExecutionAndRecoveryService({
        captureProviderRecoveryAuthority: vi.fn(async () => {
          throw new Error(captureError);
        }),
      });
      const log = vi.fn<(message: string) => void>();

      stubLaunchRecord(progressStore, {
        jobId,
        sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: namespace,
      });
      if (recoveryKind === 'queued') {
        appendQueuedEvent(progressStore, jobId, sessionId, namespace, projectRoot);
      } else {
        stubRuntimeRecord(progressStore, { jobId, pid: process.pid });
      }

      const { controller, runtimeState } = createLifecycleHarness(modules, {
        pluginRoot,
        progressStore,
        eventBus,
        servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
        log,
      });

      try {
        await controller.start();
        expectRecordedRecoveryFault(progressStore, jobId, captureError);
        expect(runtimeState.getLaunchFenceActive()).toBe(false);
        expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
        expect(log.mock.calls.flat().join('')).toContain('session claim disposition: released');

        const reader = new modules.sessionManagerModule.SessionManager(
          projectRoot,
          runtime,
          undefined,
          undefined,
          db,
          permissiveProviderLookupPort,
        );
        expect(reader.get('codex', sessionId)?.activeJobId).toBeUndefined();
        expect(reader.claimForJobSync(sessionId, `${jobId}-later`)).toBe(true);
      } finally {
        await stopLifecycleController(controller);
      }
    },
  );

  it.each(['queued', 'running'] as const)(
    '14c5. a partial %s adoption is unwound before the session is made reusable',
    async (recoveryKind) => {
      const modules = await loadModules();
      const pluginRoot = createProjectRoot(`plugin-${recoveryKind}-adoption-throws`);
      const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
      const projectRoot = createProjectRoot(`project-${recoveryKind}-adoption-throws`);
      const eventBus = new modules.eventBusModule.TypedEventBus();
      const db = openTestStoreDb(runtime, ':memory:');
      const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
        db,
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
      const jobId = `${recoveryKind}-adoption-throws-job`;
      const sessionId = `${jobId}-session`;
      const adoptionError = `${recoveryKind} namespace rebind failed`;

      stubLaunchRecord(progressStore, {
        jobId,
        sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: namespace,
      });
      if (recoveryKind === 'queued') {
        appendQueuedEvent(progressStore, jobId, sessionId, namespace, projectRoot);
      } else {
        stubRuntimeRecord(progressStore, { jobId, pid: process.pid });
      }
      vi.spyOn(progressStore, 'rebindNamespace').mockImplementationOnce(() => {
        throw new Error(adoptionError);
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
        expectRecordedRecoveryFault(progressStore, jobId, adoptionError);
        expect(runtimeState.getLaunchFenceActive()).toBe(false);
        expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
        expect(launchCoordinator.queuePosition(jobId)).toBeNull();
        expect(launchCoordinator.getActiveJobIds()).not.toContain(jobId);

        const reader = new modules.sessionManagerModule.SessionManager(
          projectRoot,
          runtime,
          undefined,
          undefined,
          db,
          permissiveProviderLookupPort,
        );
        expect(reader.get('codex', sessionId)?.activeJobId).toBeUndefined();
        expect(reader.claimForJobSync(sessionId, `${jobId}-later`)).toBe(true);
      } finally {
        await stopLifecycleController(controller);
      }
    },
  );

  it('14c6. a terminal-write failure is logged and leaves the session claim in place', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-registration-terminal-write-fails');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-registration-terminal-write-fails');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'registration-terminal-write-fails-job';
    const sessionId = `${jobId}-session`;
    const fakeService = createFakeExecutionAndRecoveryService({
      captureProviderRecoveryAuthority: vi.fn(async () => {
        throw new Error('authority capture failed first');
      }),
    });
    const log = vi.fn<(message: string) => void>();

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    appendQueuedEvent(progressStore, jobId, sessionId, namespace, projectRoot);
    vi.spyOn(progressStore, 'commit').mockImplementationOnce(() => {
      throw new Error('terminal journal unavailable');
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      log,
    });

    try {
      await expect(controller.start()).rejects.toThrow('terminal journal unavailable');
      expect(progressStore.readStatus(jobId)?.phase).toBe('queued');
      expect(
        new modules.sessionManagerModule.SessionManager(
          projectRoot,
          runtime,
          undefined,
          undefined,
          db,
          permissiveProviderLookupPort,
        ).get('codex', sessionId)?.activeJobId,
      ).toBe(jobId);
      const messages = log.mock.calls.flat().join('');
      expect(messages).toContain('could not terminalize as recovery_parse_failed');
      expect(messages).toContain('session claim release was not attempted because terminalization failed');
      expect(messages).toContain('Recovery state disposition did not complete');
      expect(messages).toContain('Inspect the persisted state and coordinator log before restarting');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14d. app-server binding failure terminalizes instead of failing the boot', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-provider-authority-blocked');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-provider-authority-blocked');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'provider-authority-blocked-job';
    const fakeService = createFakeExecutionAndRecoveryService({
      captureProviderRecoveryAuthority: vi.fn(async () => ({
        ok: false,
        failure: { reason: 'subject-mismatch', provider: 'codex' },
      })),
      finalizeProviderRecoveryBindingFailure: vi.fn(() => 'owned_by_another_job' as const),
    });
    const log = vi.fn<(message: string) => void>();

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'provider-authority-blocked-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore.appendRuntimeStarted(jobId, {
      transport: 'app-server',
      startTime: '2026-03-31T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'waiting',
      },
    });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
      log,
    });

    try {
      // No process to stop and a structurally unresolvable persisted hostRef, so this
      // takes the same treatment as the dead-durable case rather than failing the boot.
      await controller.start();
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
      expect(fakeService.finalizeProviderRecoveryBindingFailure).toHaveBeenCalledWith(
        expect.objectContaining({ jobId }),
        { reason: 'subject-mismatch', provider: 'codex' },
      );
      expect(log.mock.calls.flat().join('')).toContain('session claim disposition: owned by another job');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14e. live durable binding failure requests process stop and then terminalizes', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-durable-binding-blocked');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-durable-binding-blocked');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'durable-binding-blocked-job';
    const pid = 73_737;
    const controlledTime = createControllableTimeoutRuntime(runtime);
    const kill = vi.spyOn(runtime.process, 'kill').mockReturnValue(true);
    vi.spyOn(runtime.process, 'isAlive').mockImplementation((candidatePid) => candidatePid === pid);
    const fakeService = createFakeExecutionAndRecoveryService({
      captureProviderRecoveryAuthority: vi.fn(async () => ({
        ok: false,
        failure: { reason: 'subject-mismatch', provider: 'codex' },
      })),
    });
    const log = vi.fn<(message: string) => void>();

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'durable-binding-blocked-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, { jobId, pid });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime: controlledTime.runtime,
      log,
    });

    try {
      expect(progressStore.readRuntimeProjection(jobId)).toMatchObject({ transport: 'durable-cli', pid });
      await controller.start();
      expect(fakeService.captureProviderRecoveryAuthority).toHaveBeenCalledTimes(1);
      expect(runtime.process.isAlive).toHaveBeenCalledWith(pid);
      expect(kill.mock.calls).toEqual([[pid, 'SIGTERM']]);
      expect(controlledTime.setTimeout).toHaveBeenCalledTimes(1);
      expect(controlledTime.runNextTimeout()).toBe(5_000);
      expect(kill.mock.calls).toEqual([
        [pid, 'SIGTERM'],
        [pid, 'SIGKILL'],
      ]);
      expect(controlledTime.pendingTimeoutCount()).toBe(0);
      expect(fakeService.finalizeProviderRecoveryBindingFailure).toHaveBeenCalledWith(
        expect.objectContaining({ jobId }),
        { reason: 'subject-mismatch', provider: 'codex' },
      );
      expect(log.mock.calls.flat().join('')).toContain('session claim disposition: released');
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
    } finally {
      await stopLifecycleController(controller);
      controlledTime.discardScheduledTimeouts();
    }
  });

  // A throwing process port exercises the synchronous failure boundary; the real port
  // reports signal failures as a false return value.
  it('14e2. a failed process stop is logged, not fatal', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-durable-kill-fails');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-durable-kill-fails');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'durable-kill-fails-job';
    const pid = 73_939;
    const controlledTime = createControllableTimeoutRuntime(runtime);
    const kill = vi.spyOn(runtime.process, 'kill').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    vi.spyOn(runtime.process, 'isAlive').mockImplementation((candidatePid) => candidatePid === pid);
    const fakeService = createFakeExecutionAndRecoveryService({
      captureProviderRecoveryAuthority: vi.fn(async () => ({
        ok: false,
        failure: { reason: 'subject-mismatch', provider: 'codex' },
      })),
    });

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'durable-kill-fails-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, { jobId, pid });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime: controlledTime.runtime,
    });

    try {
      await controller.start();
      expect(kill.mock.calls).toEqual([[pid, 'SIGTERM']]);
      expect(controlledTime.setTimeout).not.toHaveBeenCalled();
      expect(controlledTime.pendingTimeoutCount()).toBe(0);
      // The throw is absorbed and the job still reaches its terminal.
      expect(fakeService.finalizeProviderRecoveryBindingFailure).toHaveBeenCalledWith(
        expect.objectContaining({ jobId }),
        { reason: 'subject-mismatch', provider: 'codex' },
      );
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
    } finally {
      await stopLifecycleController(controller);
      controlledTime.discardScheduledTimeouts();
    }
  });

  it('14f. dead durable binding failure terminalizes only after liveness is disproved', async () => {
    const modules = await loadModules();
    const pluginRoot = createProjectRoot('plugin-dead-durable-binding');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-dead-durable-binding');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'dead-durable-binding-job';
    const pid = 74_747;
    const kill = vi.spyOn(runtime.process, 'kill');
    vi.spyOn(runtime.process, 'isAlive').mockReturnValue(false);
    const failure = { reason: 'subject-mismatch', provider: 'codex' } as const;
    const fakeService = createFakeExecutionAndRecoveryService({
      captureProviderRecoveryAuthority: vi.fn(async () => ({ ok: false, failure })),
    });

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'dead-durable-binding-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubRuntimeRecord(progressStore, { jobId, pid });

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
    });

    try {
      await controller.start();
      expect(kill).not.toHaveBeenCalled();
      expect(fakeService.finalizeProviderRecoveryBindingFailure).toHaveBeenCalledWith(
        expect.objectContaining({ jobId }),
        failure,
      );
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
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
