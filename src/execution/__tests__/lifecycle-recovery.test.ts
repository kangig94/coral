import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type * as NodeOs from 'node:os'
import { dirname, join } from 'node:path'
import type { JobLaunchRecord, JobProgressRecord, JobTerminalRecord, WaitStreamEvent } from '../../shared/types.js'
import type * as ProgressStoreModule from '../progress-store.js'
import type * as SessionManagerModule from '../session-manager.js'
import type * as LifecycleModule from '../lifecycle.js'
import type * as HttpHandlerModule from '../../transport/http/handler.js'
import type * as ServiceModule from '../service.js'
import type * as ServerModule from '../server.js'
import type * as EngineModule from '../../coordinator/live/admission.js'
import type * as EventBusModule from '../../coordinator/control.js'
import type * as PathsModule from '../../infra/paths.js'
import type * as ProviderRegistryModule from '../../providers/registry.js'
import type * as DiscussOperationsModule from '../../discuss/shell/operations.js'
import { createRealRuntime } from '../../runtime/real.js'
import { createDeferred } from '../../shared/test-deferred.js'

const runtime = createRealRuntime()

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: '',
  baseTmp: `${process.env.TMPDIR ?? '/tmp'}/coral-lifecycle-recovery-${process.pid}-${Date.now()}`,
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
  }
})

type LoadedModules = {
  progressStoreModule: typeof ProgressStoreModule
  sessionManagerModule: typeof SessionManagerModule
  lifecycleModule: typeof LifecycleModule
  httpHandlerModule: typeof HttpHandlerModule
  serviceModule: typeof ServiceModule
  serverModule: typeof ServerModule
  engineModule: typeof EngineModule
  eventBusModule: typeof EventBusModule
  pathsModule: typeof PathsModule
  providerRegistryModule: typeof ProviderRegistryModule
  discussOperationsModule: typeof DiscussOperationsModule
}

function createLaunchCoordinator(modules: LoadedModules): InstanceType<LoadedModules['engineModule']['LaunchCoordinator']> {
  return new modules.engineModule.LaunchCoordinator({ runtime })
}

async function loadModules(): Promise<LoadedModules> {
  vi.resetModules()
  const [
    progressStoreModule,
    sessionManagerModule,
    lifecycleModule,
    httpHandlerModule,
    serviceModule,
    serverModule,
    engineModule,
    eventBusModule,
    pathsModule,
    providerRegistryModule,
    discussOperationsModule,
  ] = await Promise.all([
    import('../progress-store.js'),
    import('../session-manager.js'),
    import('../lifecycle.js'),
    import('../../transport/http/handler.js'),
    import('../service.js'),
    import('../server.js'),
    import('../../coordinator/live/admission.js'),
    import('../../coordinator/control.js'),
    import('../../infra/paths.js'),
    import('../../providers/registry.js'),
    import('../../discuss/shell/operations.js'),
  ])

  return {
    progressStoreModule,
    sessionManagerModule,
    lifecycleModule,
    httpHandlerModule,
    serviceModule,
    serverModule,
    engineModule,
    eventBusModule,
    pathsModule,
    providerRegistryModule,
    discussOperationsModule,
  }
}

// PID poller has a 500 ms RECOVERY_POLL_MS interval and recovery completion can
// chain through several async hops. Under heavy parallel test contention the poll
// interval can stretch beyond a 2 s margin, so the default is generous (10 s) to
// keep these characterization tests deterministic across vitest worker layouts.
async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections?.()
  })
}

function createProjectRoot(name: string): string {
  const projectRoot = join(mockState.tmpHome, name)
  mkdirSync(projectRoot, { recursive: true })
  return projectRoot
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function appendProgressRecord(jobDir: string, entry: JobProgressRecord): void {
  appendFileSync(join(jobDir, 'progress.jsonl'), JSON.stringify(entry) + '\n')
}

function createMockKbSubsystem() {
  return {
    kb: {
      closeVectorStores: vi.fn(async () => {}),
    } as never,
    curateScheduler: {
      start: vi.fn(async () => {}),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      isRunning: () => false,
      stop: vi.fn(async () => {}),
    },
  }
}

function createFakeIdleTimer() {
  let inflight = 0
  return {
    beginRequest: vi.fn(() => {
      inflight += 1
    }),
    endRequest: vi.fn(() => {
      if (inflight > 0) inflight -= 1
    }),
    get inflightRequests() {
      return inflight
    },
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    requestDrain: vi.fn(),
    isDraining: false,
  }
}

function createFakeProviderHostManager(overrides: Record<string, unknown> = {}) {
  return {
    acquireServer: vi.fn(),
    borrowLiveServer: vi.fn(),
    drainForHandoff: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  }
}

function createRuntimeStateMock() {
  let lifecycle = 'starting'
  let startedAt = 0
  let kbSubsystem: ReturnType<typeof createMockKbSubsystem> | null = null
  let launchFenceActive = false

  const runtimeState = {
    getLifecycle: () => lifecycle,
    getStartedAt: () => startedAt,
    getKbSubsystem: () => kbSubsystem as never,
    getKbInitError: () => null,
    getLaunchFenceActive: () => launchFenceActive,
    setLifecycle: vi.fn((state: string) => {
      lifecycle = state
    }),
    setStartedAt: vi.fn((ts: number) => {
      startedAt = ts
    }),
    setKbSubsystem: vi.fn((kb: ReturnType<typeof createMockKbSubsystem> | null) => {
      kbSubsystem = kb
    }),
    setKbInitError: vi.fn(),
    setLaunchFenceActive: vi.fn((active: boolean) => {
      launchFenceActive = active
    }),
  }

  return { runtimeState }
}

function createFakeExecutionAndRecoveryService(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & {
  start: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  waitStream: ReturnType<typeof vi.fn>
  adoptRunningJob: ReturnType<typeof vi.fn>
  recoverQueuedJob: ReturnType<typeof vi.fn>
  completeRecoveredJob: ReturnType<typeof vi.fn>
  finalizeInterruptedAppServerJob: ReturnType<typeof vi.fn>
  interruptAppServerJob: ReturnType<typeof vi.fn>
} {
  return {
    start: vi.fn(async () => ({ status: 'running', job: 'started-job', session: 'started-session' })),
    resumeBySessionId: vi.fn(),
    forkBySessionId: vi.fn(),
    executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    waitStream: vi.fn(async function* (): AsyncGenerator<WaitStreamEvent> {
      yield { type: 'waiting', waitingJobIds: [] }
    }),
    waitStreamOnce: vi.fn(async () => ({ type: 'waiting', waitingJobIds: [] })),
    adoptRunningJob: vi.fn(() => ({ cleanup: vi.fn() })),
    recoverQueuedJob: vi.fn(() => 'recovered-job'),
    completeRecoveredJob: vi.fn(),
    finalizeInterruptedAppServerJob: vi.fn(async () => {}),
    interruptAppServerJob: vi.fn(async () => {}),
    ...overrides,
  }
}

function stubLaunchRecord(
  progressStore: any,
  overrides: {
    jobId: string
    sessionId: string
    provider: string
    projectRoot: string
    backendNamespace: string
    enqueueSequence?: number
    pool?: string
  },
): void {
  const record: JobLaunchRecord = {
    jobId: overrides.jobId,
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    pool: overrides.pool ?? 'default',
    enqueueSequence: overrides.enqueueSequence ?? 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: '/tmp/test',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date().toISOString(),
  }
  progressStore.writeLaunchRecord(overrides.jobId, record)
}

function stubRuntimeRecord(
  progressStore: any,
  overrides: {
    jobId: string
    pid?: number
    stdoutPath?: string
    stderrPath?: string
    startTime?: string
  },
): void {
  progressStore.writeRuntimeRecord(overrides.jobId, {
    pid: overrides.pid ?? process.pid,
    stdoutPath: overrides.stdoutPath ?? join(progressStore.jobDir(overrides.jobId), 'stdout.log'),
    stderrPath: overrides.stderrPath ?? join(progressStore.jobDir(overrides.jobId), 'stderr.log'),
    startTime: overrides.startTime ?? new Date().toISOString(),
  })
}

function createLifecycleHarness(
  modules: LoadedModules,
  options: {
    pluginRoot: string
    progressStore: any
    eventBus: any
    launchCoordinator?: any
    providerRegistry?: any
    servicesByProjectRoot?: Map<string, unknown>
    getExecutionService?: (ctx: { projectRoot: string }) => unknown
    getRecoveryService?: (ctx: { projectRoot: string }) => unknown
    knownDiscussSources?: Set<string>
    getDiscussStoreForSource?: (source: string) => unknown
  },
) {
  const namespace = modules.pathsModule.pluginRootNamespace(options.pluginRoot)
  const { runtimeState } = createRuntimeStateMock()
  const idleTimer = createFakeIdleTimer()
  const providerRegistry = options.providerRegistry ?? new modules.providerRegistryModule.ProviderRegistry()
  const launchCoordinator = options.launchCoordinator ?? createLaunchCoordinator(modules)
  const servicesByProjectRoot = options.servicesByProjectRoot ?? new Map<string, unknown>()
  const getExecutionService =
    options.getExecutionService ??
    ((ctx: { projectRoot: string }) => {
      const service = servicesByProjectRoot.get(ctx.projectRoot)
      if (!service) {
        throw new Error(`Unexpected execution service projectRoot: ${ctx.projectRoot}`)
      }
      return service
    })
  const getRecoveryService = options.getRecoveryService ?? getExecutionService
  const writeBackendInfoFn = vi.fn()

  const controller = modules.lifecycleModule.createLifecycle({
    identity: {
      pluginRoot: options.pluginRoot,
      namespace,
      version: '9.9.9',
      bundleHash: 'testhash1234',
      flavor: 'prod',
      instanceId: `lifecycle-${Math.random()}`,
      token: 'test-token',
      now: () => 1,
      log: () => {},
    },
    runtime: createRealRuntime(),
    backendPid: 1234,
    runtimeState: runtimeState as never,
    idleTimer: idleTimer as never,
    progressStore: options.progressStore,
    streamResponses: new Set(),
    discussStores: new Map(),
    eventBus: options.eventBus,
    launchCoordinator,
    providerRegistry,
    server: createServer(),
    getExecutionService: getExecutionService as never,
    getRecoveryService: getRecoveryService as never,
    listExecutionServices: () => [...new Set(servicesByProjectRoot.values())] as never[],
    getDiscussStoreForSource: (options.getDiscussStoreForSource ??
      (() => {
        throw new Error('Unexpected discuss store lookup')
      })) as never,
    knownDiscussSources: () => options.knownDiscussSources ?? new Set<string>(),
    getDiscussContext: () => {
      throw new Error('Unexpected discuss context lookup')
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
    recoverPersistedDiscussFn: async () => [],
    hooks: {
      onShutdown: async () => {},
      onIdleCheck: () => false,
      onRecoveryComplete: async () => {},
    },
    closeServerFn: async () => {},
    listenFn: async () => ({ port: 4100, host: '127.0.0.1' }),
  })

  return {
    controller,
    runtimeState,
    launchCoordinator,
    providerRegistry,
    writeBackendInfoFn,
  }
}

function createActualRecoveryService(
  modules: LoadedModules,
  options: {
    progressStore: any
    eventBus: any
    launchCoordinator: any
    providerRegistry: any
    pluginRoot: string
    projectRoot: string
  },
) {
  return new modules.serviceModule.ExecutionService(
    {
      projectRoot: options.projectRoot,
      pluginRoot: options.pluginRoot,
      coralEnv: {},
    },
    {
      runtime,
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
    },
  )
}

async function stopLifecycleController(controller: {
  shutdown: (reason: string) => Promise<void>
  waitForShutdown: () => Promise<void>
}): Promise<void> {
  try {
    await controller.shutdown('test')
  } catch {
    /* best effort */
  }
  try {
    await controller.waitForShutdown()
  } catch {
    /* best effort */
  }
}

function baseUrlForServer(server: HttpServer): string {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected a listening server address')
  }
  return `http://127.0.0.1:${address.port}`
}

function callOrderOf(mockFn: ReturnType<typeof vi.fn>, predicate: (...args: any[]) => boolean): number | undefined {
  const index = mockFn.mock.calls.findIndex((args) => predicate(...args))
  return index === -1 ? undefined : mockFn.mock.invocationCallOrder[index]
}

// CG6: rewritten at src/jobs/reconcile/__tests__/lifecycle-recovery.test.ts per AC8(a).
describe.skip('lifecycle recovery characterization', () => {
  beforeEach(() => {
    mkdirSync(mockState.baseTmp, { recursive: true })
    mockState.tmpRoot = mkdtempSync(join(mockState.baseTmp, 'run-'))
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    if (mockState.tmpRoot) {
      rmSync(mockState.tmpRoot, { recursive: true, force: true })
    }
    mockState.tmpHome = ''
    mockState.tmpRoot = ''
  })

  it('1. incomplete with launch.json and missing/corrupt status.json deletes the directory', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-incomplete')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)

    for (const mode of ['missing', 'corrupt'] as const) {
      const eventBus = new modules.eventBusModule.TypedEventBus()
      let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
      const projectRoot = createProjectRoot(`project-incomplete-${mode}`)
      const jobId = `incomplete-${mode}`

      progressStore.initJob({
        jobId,
        sessionId: `session-${mode}`,
        provider: 'fakeprovider',
        projectRoot,
        backendNamespace: namespace,
        initialPhase: 'launching',
      })
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: `session-${mode}`,
        provider: 'fakeprovider',
        projectRoot,
        backendNamespace: namespace,
      })

      const statusPath = join(progressStore.jobDir(jobId), 'status.json')
      if (mode === 'missing') {
        rmSync(statusPath, { force: true })
      } else {
        writeFileSync(statusPath, '{not-json', 'utf-8')
      }

      progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
      const fakeService = createFakeExecutionAndRecoveryService()
      const { controller } = createLifecycleHarness(modules, {
        pluginRoot,
        progressStore,
        eventBus,
        servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
      })

      try {
        await controller.start()
        expect(existsSync(progressStore.jobDir(jobId))).toBe(false)
        expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
        expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
      } finally {
        await stopLifecycleController(controller)
      }
    }
  })

  it('2. incompatible live job is marked stale_status_schema and releases its session claim', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-incompatible')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-incompatible')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'incompatible-job'
    const fakeService = createFakeExecutionAndRecoveryService()

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        result: {
          content: '',
          outcome: {
            kind: 'failed',
            causeRef: {
              stream: { kind: 'job', id: jobId },
              seq: 1,
            },
          },
        },
      })
      expect(new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)?.activeJobId).toBe(
        undefined,
      )
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('3. stale_running live job is marked ghost_launch and releases its session claim', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-ghost')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-ghost')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'ghost-job'
    const fakeService = createFakeExecutionAndRecoveryService()

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'launching',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        result: {
          content: '',
          outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
        },
      })
      expect(new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)?.activeJobId).toBe(
        undefined,
      )
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('4. queued recoverable jobs are restored in FIFO enqueueSequence order', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-queued')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-queued')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const recoverQueuedSpy = vi.spyOn(service, 'recoverQueuedJob')

    progressStore.initJob({
      jobId: 'queued-high',
      sessionId: 'session-high',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'queued',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'queued-high',
      sessionId: 'session-high',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 20,
    })

    progressStore.initJob({
      jobId: 'queued-low',
      sessionId: 'session-low',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'queued',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'queued-low',
      sessionId: 'session-low',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 10,
    })

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()

      expect(recoverQueuedSpy.mock.calls.map(([record]) => record.jobId)).toEqual(['queued-low', 'queued-high'])
      expect(launchCoordinator.queuePosition('queued-low')).toBe(1)
      expect(launchCoordinator.queuePosition('queued-high')).toBe(2)
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('5. running durable-cli job with a live PID is adopted and restores active launch ownership before the fence lifts', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-running')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-running')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const adoptSpy = vi.spyOn(service, 'adoptRunningJob')
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')

    progressStore.initJob({
      jobId: 'running-live',
      sessionId: 'session-running-live',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'running-live',
      sessionId: 'session-running-live',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId: 'running-live',
      pid: process.pid,
      startTime: '2026-04-12T00:00:00.000Z',
    })

    const { controller, runtimeState } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()

      expect(adoptSpy).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'running-live' }),
        expect.objectContaining({ pid: process.pid }),
      )
      expect(completeSpy).not.toHaveBeenCalled()
      expect(launchCoordinator.getActiveJobIds()).toContain('running-live')
      const adoptOrder = adoptSpy.mock.invocationCallOrder[0]
      const fenceOffOrder = callOrderOf(runtimeState.setLaunchFenceActive as ReturnType<typeof vi.fn>, (active) => active === false)
      expect(adoptOrder).toBeDefined()
      expect(fenceOffOrder).toBeDefined()
      expect(adoptOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(fenceOffOrder ?? Number.POSITIVE_INFINITY)
      expect(progressStore.readStatus('running-live')).toMatchObject({ phase: 'running' })
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('6. stale_dead with exitCode=0 and no terminal payload completes as completed with the fallback result', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-stale-dead-completed')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-stale-dead-completed')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')

    progressStore.initJob({
      jobId: 'stale-dead-completed',
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'stale-dead-completed',
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId: 'stale-dead-completed',
      pid: 999_999,
    })
    progressStore.writeExitRecord('stale-dead-completed', {
      exitCode: 0,
      signal: null,
      endTime: '2026-04-12T00:05:00.000Z',
    })
    sessionManager.claimForJobSync(session.sessionId, 'stale-dead-completed')

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus('stale-dead-completed')?.phase === 'completed')

      expect(completeSpy).toHaveBeenCalledWith(
        'stale-dead-completed',
        session.sessionId,
        { content: '', exitCode: 0, outcome: { kind: 'provider_exit', code: 0 } },
        'completed',
      )
      expect(progressStore.readStatus('stale-dead-completed')).toMatchObject({
        phase: 'completed',
        result: { content: '', exitCode: 0, outcome: { kind: 'provider_exit', code: 0 } },
      })
      expect(new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)?.activeJobId).toBe(
        undefined,
      )
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('7. stale_dead with exitCode!=0 and no terminal payload completes as error with the fallback result', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-stale-dead-error')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-stale-dead-error')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')

    progressStore.initJob({
      jobId: 'stale-dead-error',
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'stale-dead-error',
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId: 'stale-dead-error',
      pid: 999_998,
    })
    progressStore.writeExitRecord('stale-dead-error', {
      exitCode: 7,
      signal: null,
      endTime: '2026-04-12T00:05:00.000Z',
    })
    sessionManager.claimForJobSync(session.sessionId, 'stale-dead-error')

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus('stale-dead-error')?.phase === 'error')

      expect(completeSpy).toHaveBeenCalledWith(
        'stale-dead-error',
        session.sessionId,
        { content: '', exitCode: 7, outcome: { kind: 'provider_exit', code: 7 } },
        'error',
      )
      expect(progressStore.readStatus('stale-dead-error')).toMatchObject({
        phase: 'error',
        result: { content: '', exitCode: 7, outcome: { kind: 'provider_exit', code: 7 } },
      })
      expect(new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)?.activeJobId).toBe(
        undefined,
      )
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('8. dead PID with missing or corrupt exit.json finalizes as error with the missing-exit notice', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-missing-exit')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)

    for (const mode of ['missing', 'corrupt'] as const) {
      const projectRoot = createProjectRoot(`project-missing-exit-${mode}`)
      const eventBus = new modules.eventBusModule.TypedEventBus()
      let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
      const launchCoordinator = createLaunchCoordinator(modules)
      const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
      const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
      const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
      const jobId = `missing-exit-${mode}`

      progressStore.initJob({
        jobId,
        sessionId: session.sessionId,
        provider: 'fakeprovider',
        projectRoot,
        backendNamespace: namespace,
        initialPhase: 'running',
      })
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: session.sessionId,
        provider: 'fakeprovider',
        projectRoot,
        backendNamespace: namespace,
      })
      stubRuntimeRecord(progressStore, {
        jobId,
        pid: 999_997,
      })
      if (mode === 'corrupt') {
        writeFileSync(join(progressStore.jobDir(jobId), 'exit.json'), '{oops', 'utf-8')
      }
      sessionManager.claimForJobSync(session.sessionId, jobId)

      progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
      const service = createActualRecoveryService(modules, {
        progressStore,
        eventBus,
        launchCoordinator,
        providerRegistry,
        pluginRoot,
        projectRoot,
      })
      const completeSpy = vi.spyOn(service, 'completeRecoveredJob')
      const { controller } = createLifecycleHarness(modules, {
        pluginRoot,
        progressStore,
        eventBus,
        launchCoordinator,
        providerRegistry,
        servicesByProjectRoot: new Map([[projectRoot, service]]),
      })

      try {
        await controller.start()
        await waitForCondition(() => progressStore.readStatus(jobId)?.phase === 'error')

        expect(completeSpy).toHaveBeenCalledWith(
          jobId,
          session.sessionId,
          { content: '', outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
          'error',
        )
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: { content: '', outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } } },
        })
      } finally {
        await stopLifecycleController(controller)
      }
    }
  })

  it('9. stale_dead with exit.json and a terminal progress event preserves the persisted terminal payload', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-terminal-bug')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-terminal-bug')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'terminal-bug-job'

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: 999_996,
    })
    progressStore.writeExitRecord(jobId, {
      exitCode: 0,
      signal: null,
      endTime: '2026-04-12T00:05:00.000Z',
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)

    const persistedPayload: JobTerminalRecord = {
      content: 'persisted content that should be preserved later',
      workflow: { steps: [] },
      exitCode: 0,
      usage: { inputTokens: 12, outputTokens: 4 },
      outcome: { kind: 'completed' },
    }
    const persistedTerminal: JobProgressRecord = {
      jobId,
      sessionId: session.sessionId,
      eventId: 1,
      type: 'terminal',
      ts: '2026-04-12T00:05:00.000Z',
      result: persistedPayload,
    }
    appendProgressRecord(progressStore.jobDir(jobId), persistedTerminal)

    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus(jobId)?.phase === 'completed')

      expect(completeSpy).toHaveBeenCalledWith(jobId, session.sessionId, persistedPayload, 'completed', {
        nonResumable: false,
      })
      expect(progressStore.readStatus(jobId)?.result).toEqual(persistedPayload)
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('10. running app-server runtime routes through finalizeInterruptedAppServerJob(restart) and does not adopt a PID', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-app-server')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-app-server')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const fakeService = createFakeExecutionAndRecoveryService()

    progressStore.initJob({
      jobId: 'app-server-job',
      sessionId: 'app-server-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'app-server-job',
      sessionId: 'app-server-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    progressStore.writeRuntimeRecord('app-server-job', {
      transport: 'app-server',
      startTime: '2026-04-12T00:00:00.000Z',
      providerMeta: {
        provider: 'fakeprovider',
        leaseState: 'acquired',
        recoveryPolicy: 'session_continuity_only',
      },
    })

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'app-server-job' }),
        expect.objectContaining({ transport: 'app-server' }),
        { reason: 'restart' },
      )
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('11. terminal jobs that still hold a session claim release the stale claim without new recovery work', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-terminal-claim')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-terminal-claim')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const fakeService = createFakeExecutionAndRecoveryService()

    progressStore.initJob({
      jobId: 'terminal-job',
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    progressStore.updatePhase('terminal-job', 'completed')
    sessionManager.claimForJobSync(session.sessionId, 'terminal-job')

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      const recoveredSession = new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)
      expect(recoveredSession?.activeJobId).toBeUndefined()
      expect(recoveredSession?.lastJobId).toBe('terminal-job')
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('12. orphaned session claims whose activeJobId has no job directory are released', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-orphan-claim')
    const projectRoot = createProjectRoot('project-orphan-claim')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const fakeService = createFakeExecutionAndRecoveryService()

    sessionManager.claimForJobSync(session.sessionId, 'missing-job-dir')

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      const recoveredSession = new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)
      expect(recoveredSession?.activeJobId).toBeUndefined()
      expect(recoveredSession?.lastJobId).toBe('missing-job-dir')
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('13. foreign-namespace jobs are ignored by startup recovery', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-foreign')
    const projectRoot = createProjectRoot('project-foreign')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const fakeService = createFakeExecutionAndRecoveryService()
    const jobId = 'foreign-job'

    progressStore.initJob({
      jobId,
      sessionId: 'foreign-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: 'foreign-namespace',
      initialPhase: 'queued',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'foreign-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: 'foreign-namespace',
    })

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'queued', backendNamespace: 'foreign-namespace' })
      expect(existsSync(progressStore.jobDir(jobId))).toBe(true)
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
      expect(fakeService.completeRecoveredJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('13a. concurrent orphan adoption leaves a competing status writer intact', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-adoption-race')
    const projectRoot = createProjectRoot('project-adoption-race')
    const currentNamespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const foreignNamespace = 'foreign-adoption-race'
    const jobId = 'adoption-race-job'
    const jobDir = join(runtime.paths.jobsDir(), jobId)
    const statusPath = join(jobDir, 'status.json')
    const originalStatus = {
      jobId,
      sessionId: 'adoption-race-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: foreignNamespace,
      phase: 'running',
      launch: { state: 'pending', updatedAt: '2026-04-12T00:00:00.000Z' },
    }
    const competingStatus = {
      ...originalStatus,
      backendNamespace: 'competing-namespace',
    }

    writeJson(statusPath, originalStatus)

    let competingWriterInjected = false
    const storage = {
      ...runtime.storage,
      tryExclusiveWriteSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }) {
        if (path === statusPath && !competingWriterInjected) {
          competingWriterInjected = true
          runtime.storage.tryExclusiveWriteSync(statusPath, JSON.stringify(competingStatus, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
          })
        }
        return runtime.storage.tryExclusiveWriteSync(path, data, options)
      },
    }
    const adoptionRuntime = {
      ...runtime,
      storage,
      process: {
        ...runtime.process,
        isAlive: () => false,
      },
    }

    const adopted = modules.lifecycleModule.adoptOrphanedCrossNamespaceJobs(currentNamespace, adoptionRuntime, () => {})
    const residue = runtime.storage
      .readdirSync(jobDir, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('status.json.adopt'))

    expect(adopted).toBe(0)
    expect(competingWriterInjected).toBe(true)
    expect(JSON.parse(runtime.storage.readFileSync(statusPath, 'utf-8'))).toEqual(competingStatus)
    expect(residue).toEqual([])
  })

  it('14. missing-namespace live jobs are normalized to the current namespace and processed by recovery', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-missing-namespace')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-missing-namespace')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const jobId = 'missing-namespace-job'

    progressStore.initJob({
      jobId,
      sessionId: 'missing-namespace-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'missing-namespace-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: 999_995,
    })

    const statusPath = join(progressStore.jobDir(jobId), 'status.json')
    writeJson(statusPath, {
      jobId,
      sessionId: 'missing-namespace-session',
      provider: 'fakeprovider',
      projectRoot,
      phase: 'running',
      launch: { state: 'pending', updatedAt: '2026-04-12T00:00:00.000Z' },
    })
    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const adoptSpy = vi.spyOn(service, 'adoptRunningJob')

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus(jobId)?.phase === 'error')

      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        backendNamespace: namespace,
        result: {
          content: '',
          outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
        },
      })
      expect(adoptSpy).toHaveBeenCalledWith(
        expect.objectContaining({ jobId }),
        expect.objectContaining({ pid: 999_995 }),
      )
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('15. corrupt launch.json on an otherwise live queued fixture produces no recovery action', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-corrupt-launch')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-corrupt-launch')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const fakeService = createFakeExecutionAndRecoveryService()
    const jobId = 'corrupt-launch-job'

    progressStore.initJob({
      jobId,
      sessionId: 'corrupt-launch-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'queued',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'corrupt-launch-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    writeFileSync(join(progressStore.jobDir(jobId), 'launch.json'), '{not-json', 'utf-8')
    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'queued' })
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
      expect(fakeService.completeRecoveredJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('16. corrupt runtime.json on an otherwise live running fixture produces no recovery action', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-corrupt-runtime')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-corrupt-runtime')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const fakeService = createFakeExecutionAndRecoveryService()
    const jobId = 'corrupt-runtime-job'

    progressStore.initJob({
      jobId,
      sessionId: 'corrupt-runtime-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: 'corrupt-runtime-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: 999_994,
    })
    writeFileSync(join(progressStore.jobDir(jobId), 'runtime.json'), '{broken', 'utf-8')
    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)

    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'running' })
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.completeRecoveredJob).not.toHaveBeenCalled()
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('17. launch fence returns backend_recovering while active and lifts when the fence is cleared', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-launch-fence')
    const projectRoot = createProjectRoot('project-launch-fence')
    const fakeService = createFakeExecutionAndRecoveryService({
      start: vi.fn(async () => ({ status: 'running', job: 'new-job', session: 'new-session' })),
    })
    const runtimeState = {
      getLifecycle: () => 'running',
      getStartedAt: () => 0,
      getKbSubsystem: () => createMockKbSubsystem() as never,
      getKbInitError: () => null,
      getLaunchFenceActive: vi.fn(() => true),
      setLifecycle: vi.fn(),
      setStartedAt: vi.fn(),
      setKbSubsystem: vi.fn(),
      setKbInitError: vi.fn(),
      setLaunchFenceActive: vi.fn(),
    }
    const progressStore = new modules.progressStoreModule.ProgressStore(
      modules.pathsModule.pluginRootNamespace(pluginRoot),
      runtime,
    )
    const server = createServer((req, res) => {
      void modules.httpHandlerModule.createHttpHandler({
        identity: {
          pluginRoot,
          namespace: modules.pathsModule.pluginRootNamespace(pluginRoot),
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'backend-launch-fence',
          token: 'test-token',
          now: () => Date.now(),
          log: () => {},
        },
        runtime,
        runtimeState: runtimeState as never,
        idleTimer: createFakeIdleTimer() as never,
        progressStore,
        activeLaunchCount: () => 0,
        queueDepth: () => 0,
        streamResponses: new Set(),
        coralEnvSnapshot: {},
        resolveProjectSource: modules.pathsModule.resolveProjectSource,
        isDrainRequested: () => false,
        requestDrain: () => {},
        getExecutionService: () => fakeService as never,
        getDiscussContext: () => ({}) as never,
        providerRegistry: new modules.providerRegistryModule.ProviderRegistry(),
        abortJobs: () => ({ aborted: [], notFound: [] }),
        scopeCheckJobs: () => ({ valid: [], missing: [], mismatch: [] }),
        subscribeBackendEvents: () => {},
        unsubscribeBackendEvents: () => {},
        liveDiscussCount: () => 0,
        listDiscussSessions: () => [],
        loadDiscussDetail: () => null,
      } as never)(req, res)
    })

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const baseUrl = baseUrlForServer(server)

      const fencedResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'test-token',
        },
        body: JSON.stringify({
          provider: 'fakeprovider',
          prompt: 'hello',
          projectRoot,
        }),
      })

      expect(fencedResponse.status).toBe(503)
      expect(await fencedResponse.json()).toEqual({
        code: 'backend_recovering',
        message: 'recovering — retry after 500ms',
      })
      expect(fakeService.start).not.toHaveBeenCalled()

      runtimeState.getLaunchFenceActive.mockReturnValue(false)

      const unfencedResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'test-token',
        },
        body: JSON.stringify({
          provider: 'fakeprovider',
          prompt: 'hello again',
          projectRoot,
        }),
      })

      expect(unfencedResponse.status).toBe(201)
      expect(await unfencedResponse.json()).toEqual({
        launchState: 'running',
        job: 'new-job',
        session: 'new-session',
      })
      expect(fakeService.start).toHaveBeenCalledTimes(1)
    } finally {
      await closeHttpServer(server)
    }
  })

  it('18. createBackendServer blocks /jobs/abort and /jobs/wait during startup, then exposes recovered jobs after startup completes', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-recovery-window')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-recovery-window')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    const progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)

    progressStore.initJob({
      jobId: 'queued-visible',
      sessionId: 'queued-visible-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'queued',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'queued-visible',
      sessionId: 'queued-visible-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 1,
    })

    progressStore.initJob({
      jobId: 'running-visible',
      sessionId: 'running-visible-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId: 'running-visible',
      sessionId: 'running-visible-session',
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      enqueueSequence: 2,
    })
    progressStore.writeRuntimeRecord('running-visible', {
      transport: 'app-server',
      startTime: '2026-04-12T00:00:00.000Z',
      providerMeta: {
        provider: 'fakeprovider',
        leaseState: 'acquired',
        recoveryPolicy: 'session_continuity_only',
      },
    })

    const servicesByProjectRoot = new Map<string, ReturnType<typeof createFakeExecutionAndRecoveryService>>()
    const getOrCreateService = (root: string) => {
      const existing = servicesByProjectRoot.get(root)
      if (existing) return existing
      const created = createFakeExecutionAndRecoveryService({
        waitStream: vi.fn(async function* (): AsyncGenerator<WaitStreamEvent> {
          yield { type: 'waiting', waitingJobIds: ['queued-visible', 'running-visible'] }
        }),
      })
      servicesByProjectRoot.set(root, created)
      return created
    }

    writeJson(modules.pathsModule.discussSourcesPath(), { sources: ['test/source'] })
    const enteredDiscussRecovery = createDeferred<void>()
    const releaseDiscussRecovery = createDeferred<void>()
    vi.spyOn(modules.discussOperationsModule, 'recoverPersistedSessionsFromStore').mockImplementation(async () => {
      enteredDiscussRecovery.resolve()
      await releaseDiscussRecovery.promise
      return []
    })

    const controller = modules.serverModule.createBackendServer({
      pluginRoot,
      bootSnapshot: {
        instanceId: 'backend-recovery-window',
        token: 'test-token',
        version: '9.9.9',
        bundleHash: 'testhash1234',
        log: () => {},
      },
      progressStore,
      createExecutionService: (ctx) => getOrCreateService(ctx.projectRoot) as never,
      createKbSubsystemFn: async () => createMockKbSubsystem(),
      cleanupStaleJobsFn: () => {},
    })

    let startupSettled = false
    const startPromise = controller.start().finally(() => {
      startupSettled = true
    })

    try {
      await waitForCondition(() => controller.server.listening)
      await enteredDiscussRecovery.promise
      const baseUrl = baseUrlForServer(controller.server)
      expect(startupSettled).toBe(false)

      const abortResponse = await fetch(`${baseUrl}/jobs/abort`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'test-token',
        },
        body: JSON.stringify({
          jobs: ['queued-visible', 'running-visible'],
          projectRoot,
        }),
      })

      expect(abortResponse.status).toBe(503)
      expect(await abortResponse.json()).toEqual({
        code: 'backend_shutting_down',
        message: 'Backend shutting down',
      })

      const service = getOrCreateService(projectRoot)
      expect(service.abort).not.toHaveBeenCalled()

      const waitResponse = await fetch(`${baseUrl}/jobs/wait`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'test-token',
        },
        body: JSON.stringify({
          jobIds: ['queued-visible', 'running-visible'],
          timeoutSeconds: 1,
          projectRoot,
        }),
      })

      expect(waitResponse.status).toBe(503)
      expect(await waitResponse.json()).toEqual({
        code: 'backend_shutting_down',
        message: 'Backend shutting down',
      })
      expect(service.waitStream).not.toHaveBeenCalled()

      releaseDiscussRecovery.resolve()
      await startPromise

      const postStartAbortResponse = await fetch(`${baseUrl}/jobs/abort`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'test-token',
        },
        body: JSON.stringify({
          jobs: ['queued-visible', 'running-visible'],
          projectRoot,
        }),
      })

      expect(postStartAbortResponse.status).toBe(200)
      expect(await postStartAbortResponse.json()).toEqual({
        aborted: ['queued-visible', 'running-visible'],
        notFound: [],
      })
      expect(service.abort).toHaveBeenCalledWith(['queued-visible', 'running-visible'])

      const postStartWaitResponse = await fetch(`${baseUrl}/jobs/wait`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'test-token',
        },
        body: JSON.stringify({
          jobIds: ['queued-visible', 'running-visible'],
          timeoutSeconds: 1,
          projectRoot,
        }),
      })

      expect(postStartWaitResponse.status).toBe(200)
      expect(postStartWaitResponse.headers.get('content-type')).toContain('text/event-stream')
      expect(await postStartWaitResponse.text()).toContain('event: waiting')
      expect(service.waitStream).toHaveBeenCalledWith({
        jobIds: ['queued-visible', 'running-visible'],
        timeoutSeconds: 1,
        cursor: { jobs: {} },
        projectRoot,
      })
      expect(service.recoverQueuedJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'queued-visible' }))
      expect(service.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'running-visible' }),
        expect.objectContaining({ transport: 'app-server' }),
        { reason: 'restart' },
      )
    } finally {
      releaseDiscussRecovery.resolve()
      await startPromise.catch(() => {})
      await stopLifecycleController(controller)
    }
  })

  it('19. stale_dead with persisted aborted terminal payload recovers as aborted even when exit.json is 0', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-terminal-aborted')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-terminal-aborted')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'terminal-aborted-job'

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: 999_993,
    })
    progressStore.writeExitRecord(jobId, {
      exitCode: 0,
      signal: null,
      endTime: '2026-04-12T00:05:00.000Z',
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)

    const persistedPayload: JobTerminalRecord = {
      content: 'aborted payload',
      exitCode: 0,
      usage: { inputTokens: 9, outputTokens: 2 },
      outcome: { kind: 'aborted', reason: 'signal_abort' },
    }
    appendProgressRecord(progressStore.jobDir(jobId), {
      jobId,
      sessionId: session.sessionId,
      eventId: 1,
      type: 'terminal',
      ts: '2026-04-12T00:05:00.000Z',
      result: persistedPayload,
    })

    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus(jobId)?.phase === 'aborted')

      expect(completeSpy).toHaveBeenCalledWith(jobId, session.sessionId, persistedPayload, 'aborted', {
        nonResumable: false,
      })
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'aborted',
        result: persistedPayload,
      })
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('20. stale_dead with persisted non-aborted terminal payload and exit.json=0 recovers as completed', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-terminal-completed')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-terminal-completed')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'terminal-completed-job'

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: 999_992,
    })
    progressStore.writeExitRecord(jobId, {
      exitCode: 0,
      signal: null,
      endTime: '2026-04-12T00:05:00.000Z',
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)

    const persistedPayload: JobTerminalRecord = {
      content: 'completed payload',
      exitCode: 0,
      usage: { inputTokens: 8, outputTokens: 3 },
      outcome: { kind: 'completed' },
    }
    appendProgressRecord(progressStore.jobDir(jobId), {
      jobId,
      sessionId: session.sessionId,
      eventId: 1,
      type: 'terminal',
      ts: '2026-04-12T00:05:00.000Z',
      result: persistedPayload,
    })

    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus(jobId)?.phase === 'completed')

      expect(completeSpy).toHaveBeenCalledWith(jobId, session.sessionId, persistedPayload, 'completed', {
        nonResumable: false,
      })
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'completed',
        result: persistedPayload,
      })
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('21. stale_dead with persisted non-aborted terminal payload and exit.json!=0 recovers as error', async () => {
    const modules = await loadModules()
    const pluginRoot = createProjectRoot('plugin-terminal-error')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-terminal-error')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const launchCoordinator = createLaunchCoordinator(modules)
    const providerRegistry = new modules.providerRegistryModule.ProviderRegistry()
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'terminal-error-job'

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    stubRuntimeRecord(progressStore, {
      jobId,
      pid: 999_991,
    })
    progressStore.writeExitRecord(jobId, {
      exitCode: 1,
      signal: null,
      endTime: '2026-04-12T00:05:00.000Z',
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)

    const persistedPayload: JobTerminalRecord = {
      content: 'error payload',
      exitCode: 1,
      usage: { inputTokens: 7, outputTokens: 1 },
      outcome: { kind: 'provider_exit', code: 1 },
    }
    appendProgressRecord(progressStore.jobDir(jobId), {
      jobId,
      sessionId: session.sessionId,
      eventId: 1,
      type: 'terminal',
      ts: '2026-04-12T00:05:00.000Z',
      result: persistedPayload,
    })

    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const service = createActualRecoveryService(modules, {
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      pluginRoot,
      projectRoot,
    })
    const completeSpy = vi.spyOn(service, 'completeRecoveredJob')
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      launchCoordinator,
      providerRegistry,
      servicesByProjectRoot: new Map([[projectRoot, service]]),
    })

    try {
      await controller.start()
      await waitForCondition(() => progressStore.readStatus(jobId)?.phase === 'error')

      expect(completeSpy).toHaveBeenCalledWith(jobId, session.sessionId, persistedPayload, 'error', {
        nonResumable: false,
      })
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase: 'error',
        result: persistedPayload,
      })
    } finally {
      await stopLifecycleController(controller)
    }
  })

  it('3b. legacy status.json is warned once, skipped during hydration, preserved on disk, and releases its session claim', async () => {
    const modules = await loadModules()
    const { backendLog } = await import('../../shared/backend-log.js')
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => {})
    const pluginRoot = createProjectRoot('plugin-legacy-status')
    const namespace = modules.pathsModule.pluginRootNamespace(pluginRoot)
    const projectRoot = createProjectRoot('project-legacy-status')
    const eventBus = new modules.eventBusModule.TypedEventBus()
    let progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const sessionManager = new modules.sessionManagerModule.SessionManager(projectRoot, runtime)
    const session = sessionManager.allocate('fakeprovider', 'alpha', undefined, projectRoot)
    const jobId = 'legacy-status-job'
    const fakeService = createFakeExecutionAndRecoveryService()

    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      initialPhase: 'running',
    })
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
    })
    sessionManager.claimForJobSync(session.sessionId, jobId)
    writeJson(join(progressStore.jobDir(jobId), 'status.json'), {
      jobId,
      sessionId: session.sessionId,
      provider: 'fakeprovider',
      projectRoot,
      backendNamespace: namespace,
      phase: 'running',
      launch: {
        state: 'ready',
        updatedAt: '2026-04-12T00:00:00.000Z',
      },
      result: {
        content: '',
        notice: 'legacy notice',
        aborted: false,
      },
    })

    progressStore = new modules.progressStoreModule.ProgressStore(namespace, runtime, eventBus)
    const { controller } = createLifecycleHarness(modules, {
      pluginRoot,
      progressStore,
      eventBus,
      servicesByProjectRoot: new Map([[projectRoot, fakeService]]),
    })

    try {
      await controller.start()

      expect(progressStore.listJobIds()).not.toContain(jobId)
      expect(progressStore.readStatus(jobId)).toBeNull()
      expect(existsSync(progressStore.jobDir(jobId))).toBe(true)
      expect(fakeService.recoverQueuedJob).not.toHaveBeenCalled()
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled()
      expect(fakeService.completeRecoveredJob).not.toHaveBeenCalled()
      expect(new modules.sessionManagerModule.SessionManager(projectRoot, runtime).get('fakeprovider', session.sessionId)?.activeJobId).toBe(
        undefined,
      )

      progressStore.listJobIds()
      progressStore.readStatus(jobId)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Ignoring invalid status.json for ${jobId}`))
    } finally {
      await stopLifecycleController(controller)
      warnSpy.mockRestore()
    }
  })
})
