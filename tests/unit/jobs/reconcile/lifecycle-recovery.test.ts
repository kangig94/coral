import { currentCoralStoreFormat } from '#src/store-format.js';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateTestSession } from '../../../helpers/session.js';
import { fixtureCanonicalWorkDir } from '../../../helpers/canonical-work-dir.js';
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
import {
  KB_COMPONENT_ID,
  RECOVERY_COMPONENT_ID,
  type RuntimeComponent,
} from '#src/coordinator/runtime-components/contract.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { commitJobInput, commitJobInputs } from '#tests/helpers/job-commits.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import type {
  RecoverPersistedDiscussFn,
  RunStartupRecoveryFn,
  StartupRecoveryInputs,
} from '#src/coordinator/lifecycle.js';
import type { RunJobsStartupFn } from '#src/jobs/startup.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { createBoundIpcLifecycleDeps } from '#tests/helpers/bound-ipc-lifecycle.js';
import { createBoundJobsRecoveryHarness } from '#tests/helpers/bound-jobs-recovery.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { none } from '#src/providers/capability.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { prepareFixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { toJournalInput as toDiscussJournalInput } from '#src/discuss/event-registry.js';
import { resolveProjectSource } from '#src/infra/project-source.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { createFailedWorkflowDescendantReleaser } from '#src/coordinator/services/workflow-recovery-descendants.js';
import type { AtomicFailedWorkflowDescendantReleaser } from '#src/workflow/recover.js';
import type { WorkflowPlan } from '#src/workflow/plan.js';
import { awaitRecoveryCursorBarrier } from '#src/coordinator/index.js';

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

type HarnessStartupRecoveryFn = (
  inputs: StartupRecoveryInputs,
  runJobsStartup: RunJobsStartupFn,
) => ReturnType<RunStartupRecoveryFn>;

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
    handoffModule,
    recoveryCoordinatorModule,
    jobsStartupModule,
    workflowRecoverModule,
    jobsReadQueriesModule,
    discussRuntimeServicesModule,
    discussRecoveryModule,
    discussLiveRegistryModule,
    discussLoopModule,
    discussEventRegistryModule,
    sessionLifecycleReactorModule,
    sessionsEventsModule,
    providerCapabilityModule,
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
    import('#src/coordinator/handoff.js'),
    import('#src/coordinator/services/recovery/index.js'),
    import('#src/jobs/startup.js'),
    import('#src/workflow/recover.js'),
    import('#src/jobs/read-queries.js'),
    import('#src/discuss/shell/runtime-services.js'),
    import('#src/discuss/shell/recovery.js'),
    import('#src/discuss/shell/live-registry.js'),
    import('#src/discuss/shell/loop.js'),
    import('#src/discuss/event-registry.js'),
    import('#src/sessions/lifecycle-reactor.js'),
    import('#src/sessions/events.js'),
    import('#src/providers/capability.js'),
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
    handoffModule,
    recoveryCoordinatorModule,
    jobsStartupModule,
    workflowRecoverModule,
    jobsReadQueriesModule,
    discussRuntimeServicesModule,
    discussRecoveryModule,
    discussLiveRegistryModule,
    discussLoopModule,
    discussEventRegistryModule,
    sessionLifecycleReactorModule,
    sessionsEventsModule,
    providerCapabilityModule,
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

function createPluginRoot(name: string): string {
  const pluginRoot = createProjectRoot(name);
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  return pluginRoot;
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

function createRuntimeStateMock(registerRuntimeComponentFn?: (component: RuntimeComponent) => void) {
  let lifecycle = 'starting';
  let startedAt = 0;
  let launchFenceActive = false;
  // Stub component registry: tests in this file don't exercise KB-routed
  // calls; an always-initializing registry is sufficient.
  const components = {
    register: vi.fn((component: RuntimeComponent) => registerRuntimeComponentFn?.(component)),
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

function seedWorkflowRecoveryRoot(
  progressStore: JobStore,
  options: {
    workflowId: string;
    projectRoot: string;
    backendNamespace: string;
    plan: WorkflowPlan;
  },
): void {
  progressStore.commit((c) => {
    c.append(workflowPlanDeclaredEvent(options.workflowId, options.plan, TEST_PROVIDER_SCOPE));
    return undefined;
  });
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
}

function seedWorkflowDescendantClaim(
  progressStore: JobStore,
  options: {
    workflowId: string;
    slotId: string;
    sessionId: string;
    projectRoot: string;
    backendNamespace: string;
  },
): void {
  ensureTestSession(progressStore, {
    jobId: options.slotId,
    sessionId: options.sessionId,
    provider: 'codex',
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
  });
  progressStore.appendLaunchRequested(options.slotId, {
    jobId: options.slotId,
    owner: { kind: 'workflow', id: options.workflowId },
    sessionId: options.sessionId,
    provider: 'codex',
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: progressStore.nextEnqueueSequence(),
    providerAction: 'exec',
    parentWorkflowJobId: options.workflowId,
    workflowSlotId: options.slotId,
    workflowSlotGeneration: 0,
    request: {
      prompt: '',
      cwd: options.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date(runtime.time.now()).toISOString(),
  });
  progressStore.getDb().prepare("UPDATE projection_jobs SET phase = 'running' WHERE job_id = ?").run(options.slotId);
}

function seedCompletedWorkflowRecovery(
  progressStore: JobStore,
  options: {
    workflowId: string;
    projectRoot: string;
    backendNamespace: string;
  },
): void {
  const slotId = `${options.workflowId}:0:0`;
  const sessionId = `${options.workflowId}-session`;
  seedWorkflowRecoveryRoot(progressStore, {
    ...options,
    plan: {
      slots: [
        {
          slotId,
          dependencies: [],
          provider: 'codex',
          instruction: 'completed recovery fixture',
        },
      ],
    },
  });
  seedWorkflowDescendantClaim(progressStore, {
    ...options,
    slotId,
    sessionId,
  });
  commitTerminalEvent(progressStore, {
    jobId: slotId,
    sessionId,
    backendNamespace: options.backendNamespace,
    projectRoot: options.projectRoot,
    outcome: { kind: 'completed' },
    content: `${options.workflowId} completed`,
  });
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
    runStartupRecoveryFn?: HarnessStartupRecoveryFn;
    cleanupStaleJobsFn?: (currentBundleHash: string, signal: AbortSignal) => void | Promise<void>;
    markJobsAsErrorFn?: (message: string, signal: AbortSignal) => void | Promise<void>;
    registerRuntimeComponentFn?: (component: RuntimeComponent) => void;
    interruptedAppServerReason?: 'restart' | 'handoff';
    runtime?: ReturnType<typeof createRealRuntime>;
    log?: (message: string) => void;
    discussion?: {
      getDiscussStoreForSource: (source: string) => unknown;
      knownDiscussSources: () => Set<string>;
      getDiscussContext: (ctx: unknown) => unknown;
      recoverPersistedDiscussFn: RecoverPersistedDiscussFn;
      hooks?: {
        onShutdown(mode: 'handoff' | 'hard', signal: AbortSignal): Promise<void>;
        onIdleCheck(): boolean;
        onRecoveryComplete(resumes: never[]): Promise<void>;
      };
    };
  },
) {
  const namespace = modules.pathsModule.pluginRootNamespace(options.pluginRoot);
  const { runtimeState } = createRuntimeStateMock(options.registerRuntimeComponentFn);
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
  const controller = modules.lifecycleModule.createLifecycle(
    {
      storeFormat: currentCoralStoreFormat(),
      identity: {
        pluginRoot: options.pluginRoot,
        namespace,
        version: '9.9.9',
        buildSetId: '00000000-0000-4000-8000-000000000000',
        bundleHash: '1111111111111111',
        cliBundleHash: '2222222222222222',
        claudeAppserverBundleHash: '3333333333333333',
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
      ...createBoundIpcLifecycleDeps(),
      getExecutionService: getExecutionService as never,
      getRecoveryService: getRecoveryService as never,
      listExecutionServices: () => [...new Set(servicesByProjectRoot.values())] as never[],
      getDiscussStoreForSource:
        (options.discussion?.getDiscussStoreForSource as never) ??
        ((() => {
          throw new Error('Unexpected discuss store lookup');
        }) as never),
      knownDiscussSources: options.discussion?.knownDiscussSources ?? (() => new Set<string>()),
      getDiscussContext:
        (options.discussion?.getDiscussContext as never) ??
        (() => {
          throw new Error('Unexpected discuss context lookup');
        }),
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn: () => {},
      cleanupStaleJobsFn: options.cleanupStaleJobsFn ?? (() => {}),
      markJobsAsErrorFn: options.markJobsAsErrorFn ?? (() => {}),
      terminateAllFn: () => {},
      kbDaemonSupervisor,
      handoffQuiescePorts: () => [],
      createKbHealthComponentFn: () => createKbDaemonHealthComponent(kbDaemonSupervisor),
      registerBuiltInProvidersFn: () => {},
      recoverPersistedDiscussFn: options.discussion?.recoverPersistedDiscussFn ?? (async () => []),
      hooks:
        (options.discussion?.hooks as never) ??
        ({
          onShutdown: async () => {},
          onIdleCheck: () => false,
          onRecoveryComplete: async () => {},
        } as never),
      closeServerFn: async () => {},
      listenFn: async () => ({ port: 4100, host: '127.0.0.1' }),
    },
    async (inputs, runJobsStartup) => {
      if (options.runStartupRecoveryFn !== undefined) {
        return options.runStartupRecoveryFn(inputs, runJobsStartup);
      }
      const {
        identity,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        providerOperationStartupOwnership,
        signal,
        recoverPersistedDiscussFn,
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
      } = inputs;
      await runJobsStartup({
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        signal,
        log: identity.log,
        coordinatorCommit: createTestJobJournalDeps(options.progressStore, runtime).coordinatorCommit,
        providerOperationStartupOwnership,
        interruptedAppServerReason: options.interruptedAppServerReason,
      });
      return recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createInvocationContext,
        signal,
      });
    },
  );

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
      projectRoot: fixtureCanonicalWorkDir(options.projectRoot),
      pluginRoot: options.pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(options.projectRoot),
    },
    {
      runtime,
      childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
      progressStore: options.progressStore,
      bundleHash: '1111111111111111',
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

  it('P5 cursor barrier failure prevents recovery and never reaches running', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-p5-cursor-barrier');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const barrierFailure = new Error('cursor registration is inconsistent');
    const waitFreshUntil = vi.fn(async (_authority, _target, consumerId: string) => {
      if (consumerId === 'sessions') {
        throw barrierFailure;
      }
    });
    const runRecovery = vi.fn(async () => []);
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      runStartupRecoveryFn: async () => {
        await awaitRecoveryCursorBarrier({ waitFreshUntil } as never, 42, 1_000);
        return runRecovery();
      },
    });

    try {
      await expect(controller.start()).rejects.toBe(barrierFailure);
      expect(waitFreshUntil).toHaveBeenCalledTimes(4);
      expect(runRecovery).not.toHaveBeenCalled();
      expect(runtimeState.setLifecycle).not.toHaveBeenCalledWith('running');
      expect(runtimeState.getLifecycle()).toBe('stopped');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('aborts startup before running when recovery component registration fails', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-recovery-component-registration-failure');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const registrationFailure = new Error('recovery component registration failed');
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      registerRuntimeComponentFn: (component) => {
        if (component.id === RECOVERY_COMPONENT_ID) throw registrationFailure;
      },
    });

    try {
      await expect(controller.start()).rejects.toBe(registrationFailure);
      expect(runtimeState.setLifecycle).not.toHaveBeenCalledWith('running');
      expect(runtimeState.getLifecycle()).toBe('stopped');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('keeps KB component registration best-effort after recovery registration succeeds', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-kb-component-registration-failure');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      registerRuntimeComponentFn: (component) => {
        if (component.id === KB_COMPONENT_ID) throw new Error('KB component registration failed');
      },
    });

    try {
      await expect(controller.start()).resolves.toBeDefined();
      expect(runtimeState.getLifecycle()).toBe('running');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('P3 discussion boundary keeps lifecycle running while a valid sibling resumes', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-p3-discussion-boundary');
    const projectRoot = createProjectRoot('project-p3-discussion-boundary');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
      reducers: modules.reducersModule.composeReducers(
        modules.jobsEventsModule.jobsRegistry,
        modules.discussEventRegistryModule.discussRegistry,
      ),
    });
    const registry = modules.discussLiveRegistryModule.createDiscussContextRegistry();
    const executionService = createFakeExecutionAndRecoveryService({
      resume: vi.fn(async () => ({ status: 'running', job: 'resumed-job', session: 'resumed-session' })),
    });
    const resumeLoop = vi.spyOn(modules.discussLoopModule, 'resumeLoop').mockImplementation(() => {});
    const discussion = modules.discussRuntimeServicesModule.createDiscussRuntime({
      world: {
        identity: { pluginRoot },
        discussRegistry: registry,
        resolveProjectSource,
        providerRegistry,
        eventBus,
      },
      runtime,
      getProgressStore: () => progressStore,
      getExecutionService: () => executionService as never,
    });
    const created = decideSessionCreate(
      {
        topic: 'P3 valid recovery sibling',
        min_bid_delay_ms: 0,
        agents: [
          { name: 'bot', persona: '# Bot', participation: 'required' },
          { name: 'observer', persona: '# Observer', participation: 'observer' },
        ],
      },
      {
        sessionId: 'p3-valid-discussion',
        projectRoot,
        topic: 'P3 valid recovery sibling',
      },
      1,
      '2026-08-03T00:00:00.000Z',
      {
        providerScope: TEST_PROVIDER_SCOPE,
        agentExecution: {
          bot: { manual: false, provider: 'codex', model: 'gpt-5' },
          observer: { manual: true },
        },
      },
    );
    if (!created.ok) throw new Error(created.error);
    commitJobInputs(
      progressStore,
      created.value.map((event) => toDiscussJournalInput(event)),
    );
    progressStore
      .getDb()
      .prepare(`INSERT INTO projection_discuss (discuss_id, state, last_seq) VALUES (?, ?, ?)`)
      .run('p3-malformed-discussion', '{malformed-json', 10_000);

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      providerRegistry,
      runtime,
      discussion: {
        getDiscussStoreForSource: discussion.getDiscussStoreForSource,
        knownDiscussSources: () => new Set(),
        getDiscussContext: discussion.getDiscussContext as never,
        recoverPersistedDiscussFn: modules.discussRecoveryModule.runStartup,
        hooks: discussion.hooks as never,
      },
    });

    try {
      await controller.start();
      expect(runtimeState.getLifecycle()).toBe('running');
      expect(resumeLoop).toHaveBeenCalledTimes(1);
      expect(resumeLoop.mock.calls[0]?.[1]).toBe('p3-valid-discussion');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('P4 session boundary keeps lifecycle running while a valid retention sibling settles', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-p4-session-boundary');
    const projectRoot = createProjectRoot('project-p4-session-boundary');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const bodyCodec = createEventBodyCodec();
    const reducers = modules.reducersModule.composeReducers(
      modules.jobsEventsModule.jobsRegistry,
      modules.sessionsEventsModule.sessionsRegistry,
    );
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, bodyCodec, {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
      reducers,
    });
    const providerActions: string[][] = [];
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry();
    providerRegistry.register(
      modules.providerRegistryModule
        .defineProvider({
          name: 'codex',
          transport: 'standalone',
          run: async function* noopProvider() {},
          prepareExecutionPlan: prepareFixtureExecutionPlan,
        })
        .binding(fixtureProviderBindingCodec('codex'))
        .artifacts(
          modules.providerCapabilityModule.managed({
            discardArtifacts: async ({ handles }) => {
              providerActions.push([...handles]);
              return { kind: 'discarded' };
            },
          }),
        )
        .build(),
    );
    const coordinatorCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const sessionManager = new modules.sessionManagerModule.SessionManager(
      projectRoot,
      runtime,
      coordinatorCommit,
      undefined,
      progressStore.getDb(),
    );

    const seedRetentionSession = async (name: string) => {
      const jobId = `p4-${name}-job`;
      const handle = join(projectRoot, `${name}.jsonl`);
      const entry = sessionManager.allocate({
        binding: TEST_CODEX_BINDING,
        name,
        cwd: projectRoot,
        projectRoot,
        backendNamespace: namespace,
        retention: 'discard_provider_artifacts_on_terminal',
      });
      await sessionManager.claimForJobAtomic(entry.sessionId, jobId, entry.version);
      const claimed = sessionManager.readById(entry.sessionId, { forceFresh: true });
      if (claimed === null) throw new Error(`Expected claimed P4 session '${name}'.`);
      await sessionManager.recordArtifactHandleAtomic(entry.sessionId, {
        expectedActiveJobId: jobId,
        expectedVersion: claimed.version,
        handle,
        identity: { kind: 'p4-fixture', name },
        sourceJobId: jobId,
      });
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: entry.sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: namespace,
      });
      commitTerminalEvent(progressStore, {
        jobId,
        sessionId: entry.sessionId,
        backendNamespace: namespace,
        projectRoot,
        outcome: { kind: 'completed' },
      });
      sessionManager.releaseJob(entry.sessionId, jobId);
      return { sessionId: entry.sessionId, jobId, handle };
    };

    const malformed = await seedRetentionSession('malformed');
    const valid = await seedRetentionSession('valid');
    progressStore
      .getDb()
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run('{malformed-session', malformed.sessionId);
    let sessionReactor:
      | ReturnType<LoadedModules['sessionLifecycleReactorModule']['createLifecycleReactor']>
      | undefined;
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      providerRegistry,
      runtime,
      runStartupRecoveryFn: (async ({ signal }) => {
        sessionReactor = modules.sessionLifecycleReactorModule.createLifecycleReactor({
          db: () => progressStore.getDb(),
          readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
          providers: providerRegistry,
          runtime,
          time: runtime.time,
          commitEvents: coordinatorCommit,
          signal,
        });
        await sessionReactor.scanStartup(signal);
        return [];
      }) as RunStartupRecoveryFn,
    });

    try {
      await controller.start();
      expect(runtimeState.getLifecycle()).toBe('running');
      expect(providerActions).toEqual([[valid.handle]]);
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT boundary_id, subject_key, state, stage
               FROM recovery_quarantine
              WHERE boundary_id = 'session-projection'
                AND subject_key = ?`,
          )
          .get(malformed.sessionId),
      ).toEqual({
        boundary_id: 'session-projection',
        subject_key: malformed.sessionId,
        state: 'active',
        stage: 'hydrate',
      });
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT COUNT(*) AS count
               FROM events
              WHERE stream_id = ?
                AND type LIKE 'session.retention.discard.%'`,
          )
          .get(malformed.sessionId),
      ).toEqual({ count: 0 });
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT COUNT(*) AS count
               FROM events
              WHERE stream_id = ?
                AND type = 'session.retention.discard.completed'`,
          )
          .get(valid.sessionId),
      ).toEqual({ count: 1 });
    } finally {
      await sessionReactor?.dispose();
      await stopLifecycleController(controller);
    }
  });

  it('P6 workflow settlement keeps lifecycle running, holds faulted claims, and finalizes a sibling', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-p6-workflow-settlement');
    const faultProjectRoot = createProjectRoot('project-p6-workflow-fault');
    const validProjectRoot = createProjectRoot('project-p6-workflow-valid');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const faultWorkflowId = 'p6-fault-workflow';
    const validWorkflowId = 'p6-valid-workflow';
    const faultSlotId = `${faultWorkflowId}:0:0`;
    const faultSessionId = 'p6-fault-session';
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
      reducers: modules.reducersModule.composeReducers(
        modules.jobsEventsModule.jobsRegistry,
        modules.workflowEventsModule.workflowRegistry,
        modules.sessionsEventsModule.sessionsRegistry,
      ),
    });
    seedWorkflowRecoveryRoot(progressStore, {
      workflowId: faultWorkflowId,
      projectRoot: faultProjectRoot,
      backendNamespace: namespace,
      plan: {
        slots: [
          {
            slotId: faultSlotId,
            dependencies: [],
            provider: 'codex',
            instruction: 'faulting descendant',
          },
        ],
      },
    });
    seedWorkflowDescendantClaim(progressStore, {
      workflowId: faultWorkflowId,
      slotId: faultSlotId,
      sessionId: faultSessionId,
      projectRoot: faultProjectRoot,
      backendNamespace: namespace,
    });
    seedCompletedWorkflowRecovery(progressStore, {
      workflowId: validWorkflowId,
      projectRoot: validProjectRoot,
      backendNamespace: namespace,
    });
    const originalClaim = progressStore
      .getDb()
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(faultSessionId)?.entry;
    if (originalClaim === undefined) throw new Error('Expected the P6 descendant claim.');

    const coordinatorCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const executionService = { abort: vi.fn(() => ({ aborted: [], notFound: [] })) };
    const exactReleaser = createFailedWorkflowDescendantReleaser({
      progressStore,
      runtime,
      coordinatorCommit,
      getExecutionService: () => executionService,
      createInvocationContext: (projectRoot) => ({
        projectRoot: fixtureCanonicalWorkDir(projectRoot),
        pluginRoot,
        coralEnv: {},
        principal: testProjectPrincipal(projectRoot),
      }),
      releaseAdoptedJob: vi.fn(),
      emitSessionReleased: vi.fn(),
      log: vi.fn(),
    });
    const faultingReleaser = (() => []) as unknown as AtomicFailedWorkflowDescendantReleaser;
    faultingReleaser.composeAtomic = (commit, descendants) => {
      if (descendants.some(({ jobId }) => jobId === faultSlotId)) {
        throw new Error('injected P6 descendant-release fault');
      }
      return exactReleaser.composeAtomic(commit, descendants);
    };
    faultingReleaser.cleanup = (descendants) => exactReleaser.cleanup(descendants);
    const finalizeWorkflow = createWorkflowRecoveryFinalizer({
      runtime,
      progressStore,
      coordinatorCommit,
    });
    const createInvocationContext = (projectRoot: string) => ({
      projectRoot: fixtureCanonicalWorkDir(projectRoot),
      pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    });
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      runtime,
      runStartupRecoveryFn: (async ({ signal }) => {
        await modules.workflowRecoverModule.resumeAll({
          db: progressStore.getDb(),
          progressStore,
          loadJobDetails: modules.jobsReadQueriesModule.loadJobProjectionDetails,
          getExecutionService: (ctx) => {
            if (ctx.projectRoot === faultProjectRoot) {
              throw new Error('decoded P6 workflow recovery fault');
            }
            return executionService as never;
          },
          createInvocationContext,
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: faultingReleaser,
          signal,
          ids: runtime.ids,
          time: runtime.time,
        });
        return [];
      }) as RunStartupRecoveryFn,
    });

    try {
      await controller.start();
      expect(runtimeState.getLifecycle()).toBe('running');
      expect(progressStore.readStatus(faultWorkflowId)?.phase).toBe('running');
      expect(progressStore.readStatus(validWorkflowId)?.phase).toBe('completed');
      expect(
        progressStore
          .getDb()
          .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
          .get(faultSessionId)?.entry,
      ).toBe(originalClaim);
      const continuation = progressStore
        .getDb()
        .prepare<[string], { continuation_kind: string; continuation_key: string; state: string }>(
          `SELECT continuation_kind, continuation_key, state
             FROM recovery_quarantine
            WHERE boundary_id = 'workflow-recovery'
              AND subject_key = ?`,
        )
        .get(faultWorkflowId);
      expect(continuation).toMatchObject({
        continuation_kind: 'workflow-recovery.v1',
        state: 'continuation',
      });
      expect(JSON.parse(continuation?.continuation_key ?? '{}')).toMatchObject({
        stage: 'ready-to-close',
        intendedFinalization: {
          kind: 'intent',
          intent: { workflowJobId: faultWorkflowId, outcome: 'failed' },
        },
      });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('P7 workflow hydration keeps lifecycle running while a valid sibling finalizes', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-p7-workflow-hydration');
    const projectRoot = createProjectRoot('project-p7-workflow-hydration');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const malformedWorkflowId = 'p7-malformed-workflow';
    const validWorkflowId = 'p7-valid-workflow';
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
      reducers: modules.reducersModule.composeReducers(
        modules.jobsEventsModule.jobsRegistry,
        modules.workflowEventsModule.workflowRegistry,
        modules.sessionsEventsModule.sessionsRegistry,
      ),
    });
    seedWorkflowRecoveryRoot(progressStore, {
      workflowId: malformedWorkflowId,
      projectRoot,
      backendNamespace: namespace,
      plan: {
        slots: [
          {
            slotId: `${malformedWorkflowId}:0:0`,
            dependencies: [],
            provider: 'codex',
            instruction: 'malformed recovery fixture',
          },
        ],
      },
    });
    seedCompletedWorkflowRecovery(progressStore, {
      workflowId: validWorkflowId,
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore
      .getDb()
      .prepare('UPDATE projection_jobs SET phase = ? WHERE job_id = ?')
      .run('malformed-phase', malformedWorkflowId);

    const coordinatorCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const executionService = { abort: vi.fn(() => ({ aborted: [], notFound: [] })) };
    const createInvocationContext = (root: string) => ({
      projectRoot: fixtureCanonicalWorkDir(root),
      pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(root),
    });
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      runtime,
      runStartupRecoveryFn: (async ({ signal }) => {
        await modules.workflowRecoverModule.resumeAll({
          db: progressStore.getDb(),
          progressStore,
          loadJobDetails: modules.jobsReadQueriesModule.loadJobProjectionDetails,
          getExecutionService: () => executionService as never,
          createInvocationContext,
          finalizeWorkflow: createWorkflowRecoveryFinalizer({
            runtime,
            progressStore,
            coordinatorCommit,
          }),
          releaseFailedWorkflowDescendants: createFailedWorkflowDescendantReleaser({
            progressStore,
            runtime,
            coordinatorCommit,
            getExecutionService: () => executionService,
            createInvocationContext,
            releaseAdoptedJob: vi.fn(),
            emitSessionReleased: vi.fn(),
            log: vi.fn(),
          }),
          signal,
          ids: runtime.ids,
          time: runtime.time,
        });
        return [];
      }) as RunStartupRecoveryFn,
    });

    try {
      await controller.start();
      expect(runtimeState.getLifecycle()).toBe('running');
      expect(progressStore.readStatus(validWorkflowId)?.phase).toBe('completed');
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT boundary_id, subject_key, state, stage
               FROM recovery_quarantine
              WHERE boundary_id = 'workflow-recovery'
                AND subject_key = ?`,
          )
          .get(malformedWorkflowId),
      ).toEqual({
        boundary_id: 'workflow-recovery',
        subject_key: malformedWorkflowId,
        state: 'active',
        stage: 'hydrate',
      });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('AC13 artifact prune quarantines one failure while its sibling settles and lifecycle reaches running', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-ac13-artifact-prune');
    const projectRoot = createProjectRoot('project-ac13-artifact-prune');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const faultJobId = 'ac13-artifact-fault';
    const siblingJobId = 'ac13-artifact-sibling';
    for (const jobId of [faultJobId, siblingJobId]) {
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: `${jobId}-session`,
        provider: 'codex',
        projectRoot,
        backendNamespace: namespace,
      });
      commitTerminalEvent(progressStore, {
        jobId,
        sessionId: `${jobId}-session`,
        backendNamespace: namespace,
        projectRoot,
        outcome: { kind: 'completed' },
      });
      progressStore
        .getDb()
        .prepare(`UPDATE projection_jobs SET bundle_hash = ? WHERE job_id = ?`)
        .run('previous-bundle', jobId);
    }

    const removedArtifacts: string[] = [];
    const storage = {
      ...runtime.storage,
      rmSync: (path: string) => {
        if (path === progressStore.jobDir(faultJobId)) throw new Error('injected artifact prune failure');
        removedArtifacts.push(path);
      },
    };
    const lifecycleRuntime = { ...runtime, storage };
    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      runtime: lifecycleRuntime,
      cleanupStaleJobsFn: async (currentBundleHash, signal) => {
        await modules.lifecycleModule.cleanupStaleJobs(
          progressStore,
          currentBundleHash,
          () => {},
          storage,
          lifecycleRuntime.time.now(),
          Number.MAX_SAFE_INTEGER,
          signal,
        );
      },
    });

    try {
      await controller.start();
      expect(runtimeState.getLifecycle()).toBe('running');
      expect(removedArtifacts).toEqual([progressStore.jobDir(siblingJobId)]);
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT boundary_id, subject_key, state, stage
               FROM recovery_quarantine
              WHERE boundary_id = 'stale-job-cleanup'
                AND subject_key = ?`,
          )
          .get(faultJobId),
      ).toEqual({
        boundary_id: 'stale-job-cleanup',
        subject_key: faultJobId,
        state: 'active',
        stage: 'settle',
      });
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT COUNT(*) AS count
               FROM recovery_quarantine
              WHERE boundary_id = 'stale-job-cleanup'
                AND subject_key = ?`,
          )
          .get(siblingJobId),
      ).toEqual({ count: 0 });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('AC13 crash terminalization quarantines one job while its sibling settles and lifecycle reaches running', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-ac13-crash-terminalization');
    const projectRoot = createProjectRoot('project-ac13-crash-terminalization');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const reducers = modules.reducersModule.composeReducers(
      modules.jobsEventsModule.jobsRegistry,
      modules.workflowEventsModule.workflowRegistry,
    );
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime, ':memory:'),
      eventBus,
      providers: permissiveProviderLookupPort,
      reducers,
    });
    const faultJobId = 'ac13-terminal-fault';
    const foreignFaultJobId = 'ac13-terminal-foreign-fault';
    const siblingJobId = 'ac13-terminal-sibling';
    stubLaunchRecord(progressStore, {
      jobId: faultJobId,
      sessionId: `${faultJobId}-session`,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    stubLaunchRecord(progressStore, {
      jobId: foreignFaultJobId,
      sessionId: `${foreignFaultJobId}-session`,
      provider: 'codex',
      projectRoot,
      backendNamespace: 'foreign-namespace',
    });
    stubLaunchRecord(progressStore, {
      jobId: siblingJobId,
      sessionId: `${siblingJobId}-session`,
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      jobKind: 'workflow',
    });
    progressStore
      .getDb()
      .prepare(`DELETE FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'`)
      .run(faultJobId);
    progressStore
      .getDb()
      .prepare(`DELETE FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'`)
      .run(foreignFaultJobId);

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      runStartupRecoveryFn: async () => [],
      markJobsAsErrorFn: async (message, signal) => {
        await modules.lifecycleModule.markJobsAsError(
          progressStore,
          message,
          runtime.time.now(),
          signal,
          createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
        );
      },
    });

    try {
      await controller.start();
      expect(runtimeState.getLifecycle()).toBe('running');
      await controller.shutdown('test');
      expect(progressStore.readStatus(faultJobId)?.phase).toBe('launching');
      expect(progressStore.readStatus(foreignFaultJobId)?.phase).toBe('launching');
      expect(progressStore.readStatus(siblingJobId)).toMatchObject({
        phase: 'error',
        result: {
          outcome: {
            kind: 'job_fault',
            fault: { kind: 'wrapper_crashed', cause: { message: 'Backend shutting down' } },
          },
        },
      });
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT boundary_id, subject_key, state, stage
               FROM recovery_quarantine
              WHERE boundary_id = 'crashed-job-terminalization'
                AND subject_key = ?`,
          )
          .get(faultJobId),
      ).toEqual({
        boundary_id: 'crashed-job-terminalization',
        subject_key: faultJobId,
        state: 'active',
        stage: 'settle',
      });
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT COUNT(*) AS count
               FROM recovery_quarantine
              WHERE boundary_id = 'crashed-job-terminalization'
                AND subject_key = ?`,
          )
          .get(siblingJobId),
      ).toEqual({ count: 0 });
      expect(
        progressStore
          .getDb()
          .prepare(
            `SELECT COUNT(*) AS count
               FROM recovery_quarantine
              WHERE boundary_id = 'crashed-job-terminalization'
                AND subject_key = ?`,
          )
          .get(foreignFaultJobId),
      ).toEqual({ count: 1 });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('fences mutating RPCs as soon as kernel-ready is visible', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-kernel-ready-fence');
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
              bundleHash: '1111111111111111',
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
    const pluginRoot = createPluginRoot('plugin-recovered-handles');
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
    const pluginRoot = createPluginRoot('plugin-queued');
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
    const pluginRoot = createPluginRoot('plugin-queued-abort');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-queued-abort');
    const barrierProjectRoot = createProjectRoot('project-queued-abort-barrier');
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
    const barrierService = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot: barrierProjectRoot,
    });
    const recoverQueuedSpy = vi.spyOn(service, 'recoverQueuedJob');
    const jobId = 'queued-recovery-abort';
    const barrierJobId = 'queued-recovery-abort-barrier';
    let abortResult: { aborted: string[]; notFound: string[] } | null = null;
    let targetRegisteredBeforeAbort = false;

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'queued-recovery-abort-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 1,
    });
    appendQueuedEvent(progressStore, jobId, 'queued-recovery-abort-session', namespace, projectRoot, 1);
    stubLaunchRecord(progressStore, {
      jobId: barrierJobId,
      sessionId: 'queued-recovery-abort-barrier-session',
      provider: 'codex',
      projectRoot: barrierProjectRoot,
      backendNamespace: namespace,
      enqueueSequence: 2,
    });
    appendQueuedEvent(
      progressStore,
      barrierJobId,
      'queued-recovery-abort-barrier-session',
      namespace,
      barrierProjectRoot,
      2,
    );

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([
        [projectRoot, service],
        [barrierProjectRoot, barrierService],
      ]),
      runStartupRecoveryFn: async (
        {
          identity,
          runtime,
          progressStore,
          providerRegistry,
          getRecoveryService,
          createInvocationContext,
          recoveryCoordinator,
          providerOperationStartupOwnership,
          signal,
        },
        runJobsStartup,
      ) => {
        const captureBarrierAuthority = barrierService.captureProviderRecoveryAuthority.bind(barrierService);
        vi.spyOn(barrierService, 'captureProviderRecoveryAuthority').mockImplementation(async (launchRecord) => {
          // FIFO registration makes the second queued item's authority capture a deterministic
          // production seam: the target is already classified, while adoption has not started yet.
          const registry = recoveryCoordinator.getRecoveryRegistry();
          targetRegisteredBeforeAbort = registry?.has(jobId) ?? false;
          abortResult ??= registry?.abort([jobId]) ?? null;
          return captureBarrierAuthority(launchRecord);
        });
        await runJobsStartup({
          namespace: identity.namespace,
          bundleHash: identity.bundleHash,
          runtime,
          progressStore,
          providerRegistry,
          getRecoveryService,
          createInvocationContext,
          signal,
          log: identity.log,
          coordinatorCommit: createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
          providerOperationStartupOwnership,
        });
        return [];
      },
    });

    try {
      await controller.start();
      expect(targetRegisteredBeforeAbort).toBe(true);
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
    const pluginRoot = createPluginRoot('plugin-running');
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
    const pluginRoot = createPluginRoot('plugin-running-adopted-abort');
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
    const pluginRoot = createPluginRoot(`plugin-ghost-${phase}`);
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
    ['5. inherited queued jobs enter ordinary queued recovery', 'queued', false, false, false],
    ['6. inherited launching jobs without runtime finalize as ghost_launch', 'launching', false, false, false],
    ['7. inherited running durable jobs with dead PIDs use the durable finalizer', 'running', true, false, false],
    ['8. inherited running app-server jobs use the app-server finalizer', 'running', false, true, false],
    ['9. inherited running durable jobs with live PIDs are adopted', 'running', true, false, true],
  ])('%s', async (_label, phase, durableRuntime, appServerRuntime, livePid) => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot(
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
        pid: livePid ? process.pid : 999_991,
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
      expect(progressStore.readStatus(jobId)?.backendNamespace).toBe(foreignNamespace);
      expect(progressStore.readJobEvents(jobId)).not.toContainEqual(
        expect.objectContaining({
          type: 'terminal',
          result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
        }),
      );
      if (phase === 'queued') {
        expect(progressStore.readStatus(jobId)?.phase).toBe('queued');
        expect(fakeService.recoverQueuedJob).toHaveBeenCalledWith(
          expect.objectContaining({ launchRecord: expect.objectContaining({ jobId }) }),
        );
      } else if (phase === 'launching') {
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: { outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } } },
        });
      } else {
        expect(progressStore.readStatus(jobId)?.phase).toBe('running');
      }
      if (durableRuntime && livePid) {
        expect(fakeService.adoptRunningJob).toHaveBeenCalledWith(
          expect.objectContaining({ launchRecord: expect.objectContaining({ jobId }) }),
          expect.objectContaining({ transport: 'durable-cli', pid: process.pid }),
        );
      } else if (durableRuntime) {
        expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledWith(
          expect.objectContaining({ launchRecord: expect.objectContaining({ jobId }) }),
          expect.objectContaining({ transport: 'durable-cli', pid: 999_991 }),
          expect.objectContaining({ exit: null, terminal: null, cancelled: false }),
          expect.objectContaining({ signal: expect.any(AbortSignal), onCommitStart: expect.any(Function) }),
        );
      } else if (appServerRuntime) {
        expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
          expect.objectContaining({ launchRecord: expect.objectContaining({ jobId }) }),
          expect.objectContaining({ transport: 'app-server' }),
          expect.objectContaining({ reason: 'restart' }),
        );
      }
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('inherited workflow parents remain available for workflow resume ownership', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-foreign-workflow-parent');
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
        phase: 'running',
      });
      expect(progressStore.readJobEvents('foreign-workflow-parent')).not.toContainEqual(
        expect.objectContaining({
          type: 'terminal',
          result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
        }),
      );
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
      expect(fakeService.waitStream).not.toHaveBeenCalled();
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('10. queued jobs enter ordinary recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-local-queued');
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
    const pluginRoot = createPluginRoot('plugin-dead-running');
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
    const pluginRoot = createPluginRoot('plugin-dead-finalizer-blocked');
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
    const pluginRoot = createPluginRoot('plugin-terminal-claim');
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
    const pluginRoot = createPluginRoot('plugin-orphan-claim');
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
    const pluginRoot = createPluginRoot('plugin-app-server');
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
    const pluginRoot = createPluginRoot('plugin-app-server-handoff');
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
    const pluginRoot = createPluginRoot('plugin-app-server-blocked');
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

  it('14c1. a carrier reap that cannot confirm absence leaves the job quarantined, not finalized', async () => {
    const modules = await loadModules();
    // `loadModules()` calls `vi.resetModules()`, so `index.ts` (loaded transitively below) sees a fresh
    // `process-containment.js` instance distinct from this file's own top-level import. Constructing the
    // thrown error through that same post-reset module keeps `instanceof` meaningful in `index.ts`'s catch.
    const { ProcessContainmentError: PostResetProcessContainmentError } =
      await import('#src/infra/process-containment.js');
    const pluginRoot = createPluginRoot('plugin-app-server-carrier-detached');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-app-server-carrier-detached');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const fakeService = createFakeExecutionAndRecoveryService({
      finalizeInterruptedAppServerJob: vi.fn(async () => {
        throw new PostResetProcessContainmentError(
          'process_containment_reap_failed',
          'Recorded containment absence could not be confirmed before the exit deadline.',
        );
      }),
    });
    const jobId = 'app-server-carrier-detached-job';

    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'app-server-carrier-detached-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: namespace,
    });
    progressStore.appendRuntimeStarted(jobId, {
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

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      runtime,
    });

    try {
      await controller.start();
      // The launch fence still lifts and the registry still releases this attempt: quarantine is a per-item
      // outcome of the coordinator-job-recovery walk, not a boot-level failure.
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);

      const terminalRow = db
        .prepare<
          [string],
          { seq: number }
        >("SELECT seq FROM events WHERE stream_id = ? AND type = 'job.terminal.recorded' ORDER BY seq DESC LIMIT 1")
        .get(jobId);
      expect(terminalRow).toBeUndefined();

      expect(
        db
          .prepare(
            `SELECT stage
               FROM recovery_quarantine
              WHERE boundary_id = 'coordinator-job-recovery'
                AND subject_key = ?`,
          )
          .get(jobId),
      ).toEqual({ stage: 'settle' });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  // This case covers isolation inside the adoption loop. Register-stage isolation is
  // exercised separately because it has a different exception boundary.
  it('14c2. one unresolvable job does not abandon the recovery of another', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-app-server-isolation');
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

  it('does not use safe or eager job enumeration during workflow recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-safe-workflow-enumeration');
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
    progressStore.commit((c) => {
      c.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: workflowId },
        namespace,
        project: projectRoot,
        refs: { jobId: workflowId, workflowId },
        body: { transport: 'workflow', startedAt: new Date(runtime.time.now()).toISOString() },
      });
      return undefined;
    });
    const listJobIds = vi.spyOn(progressStore, 'listJobIds').mockImplementation(() => {
      throw new Error('coordinator recovery must enumerate the raw source');
    });
    const service = createFakeExecutionAndRecoveryService();
    const log = vi.fn<(message: string) => void>();
    const coordinatorCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const signal = new AbortController().signal;
    const providerRegistry = createRecoveryProviderRegistry(modules);
    const identity = {
      pluginRoot,
      namespace,
      version: 'test-version',
      buildSetId: '00000000-0000-4000-8000-000000000000',
      bundleHash: 'test-bundle',
      cliBundleHash: 'test-cli-bundle',
      claudeAppserverBundleHash: 'test-claude-bundle',
      flavor: 'prod' as const,
      instanceId: 'raw-source-recovery',
      token: 'test-token',
      bootToken: 'test-boot-token',
      shutdownToken: 'test-shutdown-token',
      now: () => runtime.time.now(),
      log,
    };
    const boundRecovery = await createBoundJobsRecoveryHarness({
      identity,
      runtime,
      progressStore,
      providerRegistry,
      getRecoveryService: () => service as never,
      createInvocationContext: (root: string) => ({
        projectRoot: fixtureCanonicalWorkDir(root),
        pluginRoot,
        coralEnv: {},
        principal: testProjectPrincipal(root),
      }),
      signal,
      coordinatorCommit,
      bindWithHandoffFn: modules.handoffModule.bindWithHandoff,
    });
    const recoveryCoordinator = modules.recoveryCoordinatorModule.createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState: { setLaunchFenceActive: vi.fn() },
        eventBus,
        getRecoveryService: () => service as never,
        createInvocationContext: (root: string) => ({
          projectRoot: fixtureCanonicalWorkDir(root),
          pluginRoot,
          coralEnv: {},
          principal: testProjectPrincipal(root),
        }),
        log,
      },
      boundRecovery.bound,
    );

    try {
      await boundRecovery.run(recoveryCoordinator);
      const recoveryProgressStore = progressStore;
      expect(listJobIds).not.toHaveBeenCalled();
      const rawWorkflowId = 'workflow-raw-source';
      seedCompletedWorkflowRecovery(progressStore, {
        workflowId: rawWorkflowId,
        projectRoot,
        backendNamespace: namespace,
      });
      const finalizeWorkflow = vi.fn();
      await expect(
        modules.workflowRecoverModule.resumeAll({
          db,
          progressStore: recoveryProgressStore,
          loadJobDetails: modules.jobsReadQueriesModule.loadJobProjectionDetails,
          getExecutionService: () => service as never,
          createInvocationContext: (root: string) => ({
            projectRoot: fixtureCanonicalWorkDir(root),
            pluginRoot,
            coralEnv: {},
            principal: testProjectPrincipal(root),
          }),
          finalizeWorkflow,
          releaseFailedWorkflowDescendants: () => [],
          signal,
          ids: runtime.ids,
          time: runtime.time,
        }),
      ).resolves.toEqual([rawWorkflowId]);
      expect(listJobIds).not.toHaveBeenCalled();
      expect(finalizeWorkflow).toHaveBeenCalledWith(expect.objectContaining({ workflowJobId: rawWorkflowId }));
      expect(log.mock.calls.flat().join('')).not.toContain(`Skipped hydrating workflow job ${rawWorkflowId}`);
    } finally {
      await recoveryCoordinator.teardown();
      db.close();
    }
  });

  it('recovers a valid job while a different session projection is malformed', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-session-enumeration-isolation');
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
      expect(log.mock.calls.flat().join('')).not.toContain('malformed-recovery-session');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('quarantines an attributable malformed job revision while recovering its valid sibling', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-job-hydration-isolation');
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
      expect(terminalRow).toBeUndefined();

      const sessionReader = new modules.sessionManagerModule.SessionManager(
        projectRoot,
        runtime,
        undefined,
        undefined,
        db,
        permissiveProviderLookupPort,
      );
      expect(sessionReader.get('codex', `${malformedJobId}-session`)?.activeJobId).toBe(malformedJobId);
      expect(
        db
          .prepare(
            `SELECT stage
               FROM recovery_quarantine
              WHERE boundary_id = 'coordinator-job-recovery'
                AND subject_key = ?`,
          )
          .get(malformedJobId),
      ).toEqual({ stage: 'hydrate' });
      const messages = log.mock.calls.flat().join('');
      expect(messages).toContain('Coordinator recovery snapshot hydration: quarantined 1 item');
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
    const pluginRoot = createPluginRoot('plugin-app-server-claim');
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
      const pluginRoot = createPluginRoot(`plugin-${recoveryKind}-registration-throws`);
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
        expect(log.mock.calls.flat().join('')).toContain(
          `${recoveryKind === 'queued' ? 'Queued' : 'Running'} recovery registration failed for ${jobId}`,
        );

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
      const pluginRoot = createPluginRoot(`plugin-${recoveryKind}-adoption-throws`);
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

  it.each(['queued', 'running'] as const)(
    '14c6. an unreadable %s record is quarantined, not terminalized',
    async (recoveryKind) => {
      const modules = await loadModules();
      const pluginRoot = createPluginRoot(`plugin-${recoveryKind}-unreadable-record`);
      const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
      const projectRoot = createProjectRoot(`project-${recoveryKind}-unreadable-record`);
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
      const jobId = `${recoveryKind}-unreadable-record-job`;
      const sessionId = `${jobId}-session`;

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
      // What a build that cannot read a newer durable shape actually throws. The provider's session
      // outlives this coordinator, so adoption must be deferred rather than spent.
      vi.spyOn(progressStore, 'rebindNamespace').mockImplementationOnce(() => {
        throw new ZodError([
          { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['turnId'], message: 'Required' },
        ]);
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

        expect(progressStore.readStatus(jobId)?.phase).not.toBe('error');
        expect(
          progressStore.getDb().prepare(`SELECT state FROM recovery_quarantine WHERE subject_key = ?`).get(jobId),
        ).toMatchObject({ state: 'active' });
      } finally {
        await stopLifecycleController(controller);
      }
    },
  );

  it('14c7. registration fallback settles from its contained raw item without a secondary status read', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-registration-status-decode-fails');
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot);
    const projectRoot = createProjectRoot('project-registration-status-decode-fails');
    const eventBus = new modules.eventBusModule.TypedEventBus();
    const db = openTestStoreDb(runtime, ':memory:');
    const progressStore = new modules.progressStoreModule.JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const jobId = 'registration-status-decode-fails-job';
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

    // `readStatus` decodes the persisted projection, so a malformed row makes it
    // throw for exactly the job whose recovery already failed. That read used to
    // sit outside the containment frame, so it abandoned the whole batch.
    const readStatusDirect = progressStore.readStatus.bind(progressStore);
    const readStatus = vi.spyOn(progressStore, 'readStatus').mockImplementation((id: string) => {
      if (id === jobId) {
        throw new Error('projection row decode failed');
      }
      return readStatusDirect(id);
    });

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      log,
    });

    try {
      await controller.start();
      expect(readStatus).not.toHaveBeenCalledWith(jobId);
      readStatus.mockRestore();
      expectRecordedRecoveryFault(progressStore, jobId, 'authority capture failed first');
      expect(log.mock.calls.flat().join('')).toContain(`Queued recovery registration failed for ${jobId}`);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14c6. an atomic terminal-plus-claim failure rolls back both facts and quarantines the item', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-registration-terminal-write-fails');
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
    db.exec(`
      CREATE TRIGGER reject_coordinator_claim_release
      BEFORE INSERT ON events
      WHEN NEW.type = 'session.claim.released'
      BEGIN
        SELECT RAISE(ABORT, 'claim release journal unavailable');
      END;
    `);

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      log,
    });

    try {
      await controller.start();
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
      expect(
        db
          .prepare(
            `SELECT stage, error_message
               FROM recovery_quarantine
              WHERE boundary_id = 'coordinator-job-recovery'
                AND subject_key = ?`,
          )
          .get(jobId),
      ).toMatchObject({ stage: 'settle', error_message: expect.stringContaining('settlement commit failed') });
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14d. app-server binding failure terminalizes instead of failing the boot', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-provider-authority-blocked');
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
      expect(fakeService.finalizeProviderRecoveryBindingFailure).not.toHaveBeenCalled();
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'provider_binding' } } },
      });
      expect(log.mock.calls.flat().join('')).toContain('Rejected running recovery with invalid provider authority');
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('14e. live durable binding failure requests process stop and then terminalizes', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-durable-binding-blocked');
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
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((candidatePid) =>
      candidatePid === pid ? 'alive' : 'absent',
    );
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
      expect(runtime.process.observeLiveness).toHaveBeenCalledWith(pid);
      expect(kill.mock.calls).toEqual([[pid, 'SIGTERM']]);
      expect(controlledTime.setTimeout).toHaveBeenCalledTimes(1);
      expect(controlledTime.runNextTimeout()).toBe(5_000);
      expect(kill.mock.calls).toEqual([
        [pid, 'SIGTERM'],
        [pid, 'SIGKILL'],
      ]);
      expect(controlledTime.pendingTimeoutCount()).toBe(0);
      expect(fakeService.finalizeProviderRecoveryBindingFailure).not.toHaveBeenCalled();
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'provider_binding' } } },
      });
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
    } finally {
      await stopLifecycleController(controller);
      controlledTime.discardScheduledTimeouts();
    }
  });

  it('14e2. a failed required process stop is fatal after the durable rejection settlement', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-durable-kill-fails');
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
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((candidatePid) =>
      candidatePid === pid ? 'alive' : 'absent',
    );
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
      await expect(controller.start()).rejects.toThrow('EPERM: operation not permitted');
      expect(kill.mock.calls).toEqual([[pid, 'SIGTERM']]);
      expect(controlledTime.setTimeout).not.toHaveBeenCalled();
      expect(controlledTime.pendingTimeoutCount()).toBe(0);
      expect(fakeService.finalizeProviderRecoveryBindingFailure).not.toHaveBeenCalled();
      expect(progressStore.readStatus(jobId)?.phase).toBe('error');
      expect(runtimeState.getLaunchFenceActive()).toBe(true);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(true);
    } finally {
      await stopLifecycleController(controller);
      controlledTime.discardScheduledTimeouts();
    }
  });

  it('14f. dead durable binding failure terminalizes only after liveness is disproved', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-dead-durable-binding');
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
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('absent');
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
      expect(fakeService.finalizeProviderRecoveryBindingFailure).not.toHaveBeenCalled();
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        result: { outcome: { kind: 'job_fault', fault: { kind: 'provider_binding', ...failure } } },
      });
      expect(runtimeState.getLaunchFenceActive()).toBe(false);
      expect(controller.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('15. current-namespace live durable jobs stay running after startup recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-running-stays-running');
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

  it('16. inherited terminal jobs remain ignored by startup recovery', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-foreign-terminal');
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

  it('17. inherited running jobs do not append wrapper_lost into progress history', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-foreign-history');
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
      expect(history).not.toContainEqual(
        expect.objectContaining({
          type: 'terminal',
          result: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
        }),
      );
      expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledWith(
        expect.objectContaining({
          launchRecord: expect.objectContaining({ jobId: 'foreign-history' }),
        }),
        expect.objectContaining({ transport: 'durable-cli', pid: 999_992 }),
        expect.objectContaining({ exit: null, terminal: null, cancelled: false }),
        expect.objectContaining({ signal: expect.any(AbortSignal), onCommitStart: expect.any(Function) }),
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('18. ordinary recovery preserves the inherited backend namespace as provenance', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-foreign-namespace-preserved');
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
    const pluginRoot = createPluginRoot('plugin-local-queued-stays-queued');
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
    const pluginRoot = createPluginRoot('plugin-ghost-no-queued');
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

  it('21. inherited queued recovery calls recoverQueuedJob', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-foreign-no-queued');
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
      expect(fakeService.recoverQueuedJob).toHaveBeenCalledWith(
        expect.objectContaining({
          launchRecord: expect.objectContaining({ jobId: 'foreign-no-queued' }),
        }),
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('22. inherited running recovery with a dead PID uses the durable finalizer', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-foreign-no-adopt');
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
      expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledWith(
        expect.objectContaining({
          launchRecord: expect.objectContaining({ jobId: 'foreign-no-adopt' }),
        }),
        expect.objectContaining({ transport: 'durable-cli', pid: 999_993 }),
        expect.objectContaining({ exit: null, terminal: null, cancelled: false }),
        expect.objectContaining({ signal: expect.any(AbortSignal), onCommitStart: expect.any(Function) }),
      );
    } finally {
      await stopLifecycleController(controller);
    }
  });

  it('23. startup recovery toggles the launch fence on and then off', async () => {
    const modules = await loadModules();
    const pluginRoot = createPluginRoot('plugin-fence');
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
