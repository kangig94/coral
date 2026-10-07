import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage as ClientIncomingMessage,
  ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import { join } from 'node:path';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type * as NodeOs from 'node:os';
import type * as ServerMod from '#src/coordinator/index.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as LifecycleMod from '#src/coordinator/lifecycle.js';
import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { discussRegistry as discussStoreRegistry } from '#src/discuss/event-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openSettledTestStoreDb, openTestStoreDb } from '#tests/helpers/store-db.js';
import { resolveCurrentStore } from '#src/store/epoch/index.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { jobsDir } from '#src/jobs/paths.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { resolveProjectSource } from '#src/infra/project-source.js';
import type { CoordinatorServerController } from '#src/coordinator/index.js';
import type { ExecutionService } from '#src/coordinator/execution-service.js';
import type { LifecycleState } from '#src/coordinator/lifecycle.js';
import type { Runtime } from '#src/runtime/ports.js';
import { domainError, domainSuccess } from '#src/transport/tool-result.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { MutableRuntimeState as MutableCoordinatorRuntimeState } from '#src/coordinator/lifecycle.js';
import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { streamProviderTerminal } from '#src/providers/stream.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { toProviderDefinition } from '#tests/helpers/scripted-provider.js';
import { isWorkflowInputFailure, workflowCompiler } from '#src/workflow/compile.js';
import { workflowCommands } from '#src/workflow/dispatch.js';
import {
  handleDiscussAbort,
  handleDiscussBid,
  handleDiscussSeed,
  handleDiscussSpeech,
  handleDiscussStart,
  handleDiscussWatch,
} from '#src/discuss/shell/tools.js';
import { ZodError } from 'zod';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import type { KbRequestPort } from '#src/transport/rpc/ports.js';
import { lifecycleRefusalResult } from '#src/transport/lifecycle-refusal.js';
import { IdleTimer } from '#src/coordinator/live/idle.js';

// The plugin root is clients/ (where bridge/manifest lives); the backend under
// test derives its namespace from that root via __PLUGIN_ROOT__ (see vitest/setup.ts).
const testBackendNamespace = pluginRootNamespace(join(process.cwd(), 'clients'));
const waitTiming = {
  origin: 'runtime',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-backend-test-tmp-${process.pid}-${Date.now()}`,
}));
const ingressFixtureRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'coral-http-ingress-'));
const DEFAULT_PROJECT_ROOT = join(ingressFixtureRoot, 'project');
const DEFAULT_WORK_DIR = join(DEFAULT_PROJECT_ROOT, 'work');
const ALTERNATE_PROJECT_ROOT = join(ingressFixtureRoot, 'alternate-project');
mkdirSync(DEFAULT_WORK_DIR, { recursive: true });
mkdirSync(ALTERNATE_PROJECT_ROOT, { recursive: true });

afterAll(() => {
  rmSync(ingressFixtureRoot, { recursive: true, force: true });
});

const createdJobIds = new Set<string>();
let runtime: ReturnType<typeof createRealRuntime>;
let JOBS_DIR = '';

function jobResultPath(jobId: string): string {
  return join(runtime.paths.coral.exports.jobsRoot, jobId, 'result.md');
}

function createProgressStore(
  namespace = 'test-ns',
  runtimeArg: Pick<Runtime, 'storage' | 'paths' | 'time' | 'env'> = runtime,
): JobStore {
  return new JobStore(namespace, runtimeArg, createEventBodyCodec(), {
    db: openTestStoreDb(runtimeArg, resolveCurrentStore(runtimeArg).path),
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussStoreRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
}

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
  };
});

type ServerModule = typeof ServerMod;
type BackendInfoModule = typeof BackendDiscoveryMod;
type LifecycleModule = typeof LifecycleMod;

type FakeExecutionService = {
  start: ReturnType<typeof vi.fn<ExecutionService['start']>>;
  executeWorkflow: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
  waitStreamOnce: ReturnType<typeof vi.fn>;
};

function createFakeExecutionService(overrides: Partial<FakeExecutionService> = {}): FakeExecutionService {
  return {
    start: vi.fn(),
    executeWorkflow: vi.fn(async () => ({
      kind: 'workflow',
      status: 'running',
      workflowId: 'workflow-job',
      jobId: 'workflow-job',
    })),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    waitStream: vi.fn(async function* (): AsyncGenerator<WaitStreamEvent> {
      yield {
        type: 'progress',
        jobId: 'job-1',
        seq: 7,
        message: 'working',
        timing: waitTiming,
      };
      yield {
        type: 'terminal',
        jobId: 'job-1',
        seq: 8,
        remainingJobIds: [],
        resultPath: jobResultPath('job-1'),
        availability: { kind: 'available', resultPath: jobResultPath('job-1') },
        result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
        cursor: null,
        exitCode: 0,
      };
    }),
    waitStreamOnce: vi.fn(async () => ({
      type: 'running',
      runningJobIds: [],
    })),
    ...overrides,
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

function createFakeProviderHostManager(overrides: Record<string, unknown> = {}) {
  return {
    openSession: vi.fn(),
    attachSession: vi.fn(async () => null),
    drainForHandoff: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

async function _closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function openHttpStream(
  url: string,
  headers: Record<string, string>,
): Promise<{
  response: ClientIncomingMessage;
  waitForText: (check: (text: string) => boolean) => Promise<string>;
  currentText: () => string;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers });
    req.once('error', reject);
    req.once('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });

      const waitForText = (check: (current: string) => boolean): Promise<string> => {
        if (check(text)) return Promise.resolve(text);

        return new Promise<string>((resolveText, rejectText) => {
          const onData = () => {
            if (!check(text)) return;
            cleanup();
            resolveText(text);
          };
          const onEnd = () => {
            cleanup();
            rejectText(new Error('Stream ended before expected data arrived'));
          };
          const onError = (error: Error) => {
            cleanup();
            rejectText(error);
          };
          const cleanup = () => {
            response.off('data', onData);
            response.off('end', onEnd);
            response.off('error', onError);
          };

          response.on('data', onData);
          response.once('end', onEnd);
          response.once('error', onError);
        });
      };

      resolve({
        response,
        waitForText,
        currentText: () => text,
        close: () => {
          req.destroy();
          response.destroy();
        },
      });
    });
    req.end();
  });
}

// Cache modules across tests: these are pure imports from the coordinator
// graph (no module-level mutation per test).
let cachedExecutionModules: {
  serverModule: ServerModule;
  backendInfo: BackendInfoModule;
  lifecycleModule: LifecycleModule;
} | null = null;
async function loadExecutionModules(): Promise<{
  serverModule: ServerModule;
  backendInfo: BackendInfoModule;
  lifecycleModule: LifecycleModule;
}> {
  if (cachedExecutionModules === null) {
    const [serverModule, backendInfo, lifecycleModule] = await Promise.all([
      import('#src/coordinator/index.js'),
      import('#src/infra/backend-discovery.js'),
      import('#src/coordinator/lifecycle.js'),
    ]);
    cachedExecutionModules = { serverModule, backendInfo, lifecycleModule };
  }
  return cachedExecutionModules;
}

describe('execution backend server', () => {
  let controller: CoordinatorServerController | null = null;

  beforeEach(() => {
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
    runtime = createRealRuntime('prod');
    openSettledTestStoreDb(runtime).close();
    JOBS_DIR = jobsDir(runtime.env);
    rmSync(JOBS_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (controller && controller.getLifecycle() !== 'stopped') {
      try {
        await controller.shutdown('test-teardown');
      } catch {
        /* best effort */
      }
      try {
        await controller.waitForShutdown();
      } catch {
        /* best effort */
      }
    }
    controller = null;
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    vi.restoreAllMocks();
    // vi.mock at module scope is hoisted and persistent across tests;
    // restoreAllMocks() undoes any vi.spyOn from individual tests.
    try {
      rmSync(mockState.tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    rmSync(JOBS_DIR, { recursive: true, force: true });
    mockState.tmpHome = '';
  });

  function createRuntimeStateMock(): {
    runtimeState: MutableCoordinatorRuntimeState;
    setLifecycle: ReturnType<typeof vi.fn>;
    setKbOnline: (online: boolean) => void;
  } {
    let lifecycle: LifecycleState = 'starting';
    let startedAt = 0;
    let kbOnline = true;
    let launchFenceActive = false;

    const components = {
      register: vi.fn(),
      initAll: vi.fn(),
      disposeAll: vi.fn(async () => {}),
      list: vi.fn(() => (kbOnline ? [{ id: 'kb' as never, phase: 'online' as const }] : [])),
      status: vi.fn(() =>
        !kbOnline
          ? { id: 'kb' as never, phase: 'initializing' as const, attempt: 0 }
          : { id: 'kb' as never, phase: 'online' as const },
      ),
    };

    const runtimeState = {
      getLifecycle: () => lifecycle,
      getStartedAt: () => startedAt,
      getLaunchFenceActive: () => launchFenceActive,
      components: components as never,
      setLifecycle: vi.fn((state: LifecycleState) => {
        lifecycle = state;
      }),
      setStartedAt: vi.fn((ts: number) => {
        startedAt = ts;
      }),
      setLaunchFenceActive: vi.fn((active: boolean) => {
        launchFenceActive = active;
      }),
    } satisfies MutableCoordinatorRuntimeState;

    return {
      runtimeState,
      setLifecycle: runtimeState.setLifecycle,
      setKbOnline: (online) => {
        kbOnline = online;
      },
    };
  }

  function createUnexpectedExpansionRpc(): KbDaemonSupervisor['expansionRpc'] {
    return vi.fn(async () => ({
      ok: false as const,
      code: 'unexpected_expansion_rpc',
      message: 'unexpected expansion RPC',
    }));
  }

  async function startBackendServer(
    overrides: Omit<Parameters<ServerModule['createCoordinatorServer']>[0], 'onFatalShutdownError'> = {},
  ) {
    const { serverModule, backendInfo } = await loadExecutionModules();
    const { bootSnapshot: bootOverrides, ...restOverrides } = overrides;
    const defaultKbDaemonSupervisor =
      process.env.CORAL_KB_ENABLE === '0' || restOverrides.kbDaemonSupervisor !== undefined
        ? {}
        : { kbDaemonSupervisor: createMockKbDaemonSupervisor() };
    controller = serverModule.createCoordinatorServer({
      bootSnapshot: {
        instanceId: 'execution-backend-instance-1',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        version: '9.9.9',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        log: () => {},
        ...bootOverrides,
      },
      cleanupStaleJobsFn: () => {},
      onFatalShutdownError: vi.fn(),
      systemProviderScope: TEST_SYSTEM_PROVIDER_SCOPE,
      ...defaultKbDaemonSupervisor,
      ...restOverrides,
    });
    const started = await controller.start();
    return {
      controller,
      backendInfo,
      started,
      baseUrl: `http://127.0.0.1:${started.port}`,
      token: started.token,
      bootToken: started.bootToken,
      shutdownToken: started.shutdownToken,
    };
  }

  it('marks tracked daemon-owned KB jobs as error when the KB daemon exits', async () => {
    const jobId = 'kb-daemon-import-job-1';
    const projectRoot = ALTERNATE_PROJECT_ROOT;
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const exit = { listener: null as ((snapshot: KbDaemonHealthSnapshot) => void) | null };
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      onExit: vi.fn((listener) => {
        exit.listener = listener;
        return vi.fn();
      }),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb: vi.fn(async () => ({ ok: true as const, data: { status: 'running', job: jobId } })),
      expansionRpc: createUnexpectedExpansionRpc(),
      abortKbJobs: vi.fn(async () => ({ aborted: [], notFound: [] })),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => ({ kind: 'confirmed-absent' as const, snapshot: daemonHealth })),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const progressStore = createProgressStore();
    createdJobIds.add(jobId);
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      owner: { kind: 'system-task', id: `kb.source_import:${jobId}` },
      sessionId: null,
      provider: null,
      projectRoot,
      backendNamespace: testBackendNamespace,
      bundleHash: '0123456789abcdef',
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      operation: 'kb.source_import',
      request: {
        filePath: join(ALTERNATE_PROJECT_ROOT, 'source.md'),
        slug: 'alpha-source',
        readiness: 'base-search',
      },
      createdAt: new Date().toISOString(),
    });
    progressStore.appendRuntimeStarted(jobId, {
      transport: 'internal',
      operation: 'kb.source_import',
      startTime: new Date().toISOString(),
    });

    const response = await fetch(`${backend.baseUrl}/kb/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        projectRoot,
        filePath: join(ALTERNATE_PROJECT_ROOT, 'source.md'),
        slug: 'alpha-source',
        readiness: 'base-search',
        async: true,
      }),
    });
    expect(response.status).toBe(202);
    const activeDetail = await fetch(
      `${backend.baseUrl}/jobs/${jobId}?projectRoot=${encodeURIComponent(projectRoot)}`,
      { headers: { 'X-Coral-Backend-Token': backend.token } },
    );
    expect(activeDetail.status).toBe(200);
    await activeDetail.json();
    expect(exit.listener).not.toBeNull();

    if (exit.listener === null) {
      throw new Error('expected KB daemon exit listener');
    }
    exit.listener({
      ...daemonHealth,
      phase: 'failed',
      pid: null,
      readyAt: null,
      lastExit: { code: 1, signal: null, at: 30, uptimeMs: 20 },
      lastError: 'marker worker crashed',
    });

    const detailResponse = await fetch(
      `${backend.baseUrl}/jobs/${jobId}?projectRoot=${encodeURIComponent(projectRoot)}`,
      {
        headers: { 'X-Coral-Backend-Token': backend.token },
      },
    );
    const detailBody = (await detailResponse.json()) as {
      status: { phase?: string };
      events: Array<{ type?: string; result?: { outcome?: { kind?: string; fault?: { kind?: string } } } }>;
    };

    expect(detailResponse.status).toBe(200);
    expect(detailBody.status.phase).toBe('error');
    expect(detailBody.events).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        result: expect.objectContaining({
          outcome: expect.objectContaining({
            kind: 'job_fault',
            fault: expect.objectContaining({ kind: 'wrapper_crashed' }),
          }),
        }),
      }),
    );
  });

  describe('resource-oriented HTTP routes', () => {
    function currentCoralEnvSnapshot(): Record<string, string> {
      return Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          const [key, value] = entry;
          return key.startsWith('CORAL_') && typeof value === 'string';
        }),
      );
    }

    function createKbInitializingPort(): KbRequestPort {
      const unavailable = () => domainError('kb_initializing', 'Knowledge base is starting up');
      return {
        readSearch: async () => unavailable(),
        diagnose: unavailable,
        readNote: unavailable,
        readSource: unavailable,
        readCommunity: unavailable,
        listStaleCommunities: unavailable,
        readCommunitySummaryInput: unavailable,
        setCommunitySummary: async () => unavailable(),
        readWiki: unavailable,
        readMemo: unavailable,
        readPrinciple: unavailable,
        listSources: async () => unavailable(),
        listWikis: async () => unavailable(),
        listMemos: unavailable,
        listPrinciples: async () => unavailable(),
        createNote: async () => unavailable(),
        updateNote: async () => unavailable(),
        deleteNote: async () => unavailable(),
        createWiki: async () => unavailable(),
        rewriteWiki: async () => unavailable(),
        linkWiki: async () => unavailable(),
        unlinkWiki: async () => unavailable(),
        citeWiki: async () => unavailable(),
        adoptWiki: async () => unavailable(),
        deleteWiki: async () => unavailable(),
        wakeUp: async () => unavailable(),
        createSource: async () => unavailable(),
        deleteSource: async () => unavailable(),
        createMemo: unavailable,
        deleteMemos: unavailable,
        reindex: async () => unavailable(),
      };
    }

    function createDefaultKbPort(): KbRequestPort {
      return {
        readSearch: async (args) => domainSuccess({ route: 'kb:search', args }),
        diagnose: () => domainSuccess({ route: 'kb:diagnose', args: {} }),
        readNote: (slug) => domainSuccess({ route: 'kb:note-read', slug }),
        readSource: (slug) => domainSuccess({ route: 'kb:source-read', slug }),
        readCommunity: (slug) => domainSuccess({ route: 'kb:community-read', slug }),
        listStaleCommunities: () => domainSuccess({ route: 'kb:community-list-stale' }),
        readCommunitySummaryInput: (slug) => domainSuccess({ route: 'kb:community-summary-input', slug }),
        setCommunitySummary: async (args) => domainSuccess({ route: 'kb:community-set-summary', args }),
        readWiki: (slug) => domainSuccess({ route: 'kb:wiki-read', slug }),
        readMemo: (slug) => domainSuccess({ route: 'kb:memo-read', slug }),
        readPrinciple: (slug) => domainSuccess({ route: 'kb:principle-read', slug }),
        listSources: async () => domainSuccess({ route: 'kb:source-list', args: {} }),
        listWikis: async () => domainSuccess({ route: 'kb:wiki-list' }),
        listMemos: (args) => domainSuccess({ route: 'kb:memo-list', args }),
        listPrinciples: async (args) => domainSuccess({ route: 'kb:principles', args }),
        createNote: async (args) => domainSuccess({ route: 'kb:promote', args }),
        updateNote: async (args) => domainSuccess({ route: 'kb:update', args }),
        deleteNote: async (slug) => domainSuccess({ route: 'kb:delete', args: { note: slug } }),
        createWiki: async (args) => domainSuccess({ route: 'kb:wiki-create', args }),
        rewriteWiki: async (args) => domainSuccess({ route: 'kb:wiki-rewrite', args }),
        linkWiki: async (args) => domainSuccess({ route: 'kb:wiki-link', args }),
        unlinkWiki: async (args) => domainSuccess({ route: 'kb:wiki-unlink', args }),
        citeWiki: async (args) => domainSuccess({ route: 'kb:wiki-cite', args }),
        adoptWiki: async (args) => domainSuccess({ route: 'kb:wiki-adopt', args }),
        deleteWiki: async (slug) => domainSuccess({ route: 'kb:wiki-delete', args: { slug } }),
        wakeUp: async (args) => domainSuccess({ route: 'kb:wake-up', args }),
        createSource: async (args) => domainSuccess({ status: 'running', route: 'kb:source-import', args }),
        deleteSource: async (slug) => domainSuccess({ route: 'kb:source-delete', args: { slug } }),
        createMemo: (args) => domainSuccess({ route: 'kb:memo', args }),
        deleteMemos: (args) => domainSuccess({ route: 'kb:memo-delete', args }),
        reindex: async (args) => domainSuccess({ route: 'kb:reindex', args }),
      };
    }

    function createHttpHandlerDeps(
      options: {
        kbRuntime?: unknown | null;
        launchFenceActive?: boolean;
        executionService?: FakeExecutionService;
        abortJobs?: any['abortJobs'];
        scopeCheckJobs?: any['scopeCheckJobs'];
        listDiscussSessions?: any['listDiscussSessions'];
        loadDiscussDetail?: any['loadDiscussDetail'];
        workflowExecute?: any['workflowExecute'];
        remoteAccess?: any['remoteAccess'];
      } = {},
    ) {
      const { runtimeState, setKbOnline } = createRuntimeStateMock();
      const providerRegistry = new ProviderRegistry();
      providerRegistry.register(
        toProviderDefinition({
          name: 'codex',
          execute: vi.fn(() =>
            streamProviderTerminal({ content: 'ok', durationMs: 1_000, outcome: { kind: 'completed' as const } }),
          ),
        })!,
      );
      const executionService = options.executionService ?? createFakeExecutionService();
      const idleTimer = createFakeIdleTimer();
      const progressStore = createProgressStore('test-ns', runtime);
      const coralEnvSnapshot = currentCoralEnvSnapshot();
      const getDiscussContext = () => ({}) as never;
      const requestDrain = vi.fn();
      const scopeCheckJobs = options.scopeCheckJobs ?? (() => ({ valid: [], missing: [], mismatch: [] }));
      const abortJobs = options.abortJobs ?? (() => ({ kind: 'answered', result: { aborted: [], notFound: [] } }));
      const listDiscussSessions = options.listDiscussSessions ?? (() => []);
      const loadDiscussDetail = options.loadDiscussDetail ?? (() => null);
      const subscribeBackendEvents = vi.fn();
      const unsubscribeBackendEvents = vi.fn();

      runtimeState.setLifecycle('running');
      runtimeState.setLaunchFenceActive(options.launchFenceActive ?? false);
      const kbAvailable = options.kbRuntime !== null;
      setKbOnline(kbAvailable);
      const service = executionService as any;

      const deps: any = {
        identity: {
          pluginRoot: '/tmp/plugin',
          namespace: testBackendNamespace,
          version: '9.9.9',
          bundleHash: '0123456789abcdef',
          flavor: 'prod',
          instanceId: 'execution-backend-instance-1',
          token: 'test-token',
          bootToken: 'test-boot-token',
          shutdownToken: 'test-shutdown-token',
          now: () => Date.now(),
          log: () => {},
        },
        coralEnvSnapshot,
        systemProviderScope: TEST_SYSTEM_PROVIDER_SCOPE,
        remoteAccess: options.remoteAccess,
        runtime: { ids: runtime.ids, time: runtime.time, storage: runtime.storage },
        runtimeState,
        idleTimer: idleTimer as never,
        progressStore,
        activeLaunchCount: () => 0,
        queueDepth: () => 0,
        streamResponses: new Set(),
        resolveProjectSource: resolveProjectSource,
        isDrainRequested: () => false,
        requestDrain,
        getExecutionService: () => executionService as never,
        getDiscussContext,
        providerRegistry,
        abortJobs,
        scopeCheckJobs,
        subscribeBackendEvents,
        unsubscribeBackendEvents,
        liveDiscussCount: () => 0,
        listDiscussSessions,
        loadDiscussDetail,
        admin: {
          isLifecycleRunning: () => runtimeState.getLifecycle() === 'running',
          isDrainRequested: () => false,
          isLaunchFenceActive: () => runtimeState.getLaunchFenceActive(),
          beginRequest: () => {
            idleTimer.beginRequest();
          },
          endRequest: () => {
            idleTimer.endRequest();
          },
          requestDrain,
        },
        health: {
          read: () => {
            const kb = runtimeState.components.status('kb' as never);
            return {
              status: 'ok' as const,
              kernel: { phase: 'running' as const, readyAt: 0 },
              version: '9.9.9',
              bundleHash: '0123456789abcdef',
              flavor: 'prod' as const,
              namespace: testBackendNamespace,
              instanceId: 'execution-backend-instance-1',
              pid: 1,
              uptimeMs: 0,
              active: 0,
              activeJobs: 0,
              liveDiscuss: 0,
              queueDepth: 0,
              inflightRequests: idleTimer.inflightRequests,
              env: coralEnvSnapshot,
              components: kb === null ? [] : [{ ...kb, id: kb.id as string }],
            };
          },
        },
        events: {
          bus: new TypedEventBus(),
          addResponse: (res: unknown) => {
            deps.streamResponses.add(res);
          },
          removeResponse: (res: unknown) => {
            deps.streamResponses.delete(res);
          },
          createStreamId: () => 'stream-id',
          nowIsoString: () => new Date(0).toISOString(),
          subscribe: subscribeBackendEvents,
          unsubscribe: unsubscribeBackendEvents,
        },
        sessions: {
          start: (providerName: string, input: unknown, ctx: unknown) => service.start(providerName, input, ctx),
        },
        jobs: {
          scopeCheck: scopeCheckJobs,
          abort: abortJobs,
          admitWait: (request: { jobIds: string[] }) =>
            request.jobIds.map((jobId) => ({ jobId, disposition: 'admitted' as const })),
          validateWait: () => null,
          waitHandoverSignal: () => new AbortController().signal,
          waitStream: (request: unknown) => service.waitStream(request),
          list: () => [],
          detail: () => null,
          unknownJobDisposition: () => 'not-found' as const,
        },
        workflows: {
          execute:
            options.workflowExecute ??
            (async (request: any, ctx: any) => {
              try {
                const compiled = workflowCompiler.compile(request, providerRegistry);
                if ('status' in compiled) {
                  return { kind: 'decision' as const, decision: compiled };
                }
                return {
                  kind: 'decision' as const,
                  decision: await workflowCommands.execute(service as never, compiled, ctx),
                };
              } catch (error: unknown) {
                if (isWorkflowInputFailure(error)) {
                  if (error instanceof ZodError) {
                    const first = error.issues[0];
                    const path = first?.path.join('.') ?? '';
                    const message = first
                      ? path.length > 0
                        ? `${path}: ${first.message}`
                        : first.message
                      : error.message;
                    return { kind: 'invalid_request' as const, message, detail: { issues: error.issues } };
                  }
                  return { kind: 'invalid_request' as const, message: error.message };
                }
                throw error;
              }
            }),
        },
        kb: kbAvailable ? createDefaultKbPort() : createKbInitializingPort(),
        discuss: {
          seed: handleDiscussSeed,
          start: (args: Record<string, unknown>, ctx: unknown) =>
            handleDiscussStart(args, ctx as never, { getDiscussContext }),
          listSessions: () => listDiscussSessions(),
          loadDetail: (projectRoot: string, sessionId: string, view: 'control' | 'audit') =>
            loadDiscussDetail(resolveProjectSource(projectRoot), sessionId, view),
          watch: (args: Record<string, unknown>, ctx: unknown) =>
            handleDiscussWatch(args, ctx as never, { getDiscussContext }),
          bid: (args: Record<string, unknown>, ctx: unknown) =>
            handleDiscussBid(args, ctx as never, { getDiscussContext }),
          speech: (args: Record<string, unknown>, ctx: unknown) =>
            handleDiscussSpeech(args, ctx as never, { getDiscussContext }),
          abort: (args: Record<string, unknown>, ctx: unknown) =>
            handleDiscussAbort(args, ctx as never, { getDiscussContext }),
        },
      };

      return { deps, runtimeState, executionService };
    }

    async function startHttpHandlerServer(
      deps: any,
      createHttpHandlerFn?: typeof HttpHandlerMod.createHttpHandler,
      options: { remoteAddress?: string | null } = {},
    ) {
      const importedHandlerModule = await import('#src/transport/http/handler.js');
      const importedCreateHttpHandler = createHttpHandlerFn ?? importedHandlerModule.createHttpHandler;
      const handler = importedCreateHttpHandler(deps);
      const server = createServer((req, res) => {
        if (Object.prototype.hasOwnProperty.call(options, 'remoteAddress')) {
          Object.defineProperty(req.socket, 'remoteAddress', {
            configurable: true,
            value: options.remoteAddress ?? undefined,
          });
        }
        void handler(req, res).catch(() => {
          if (!res.headersSent) {
            importedHandlerModule.sendJson(res, 500, {
              code: 'internal_error',
              message: 'Internal error',
            });
            return;
          }
          res.destroy();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected listening address');
      }

      return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    }

    async function startMockedRouteServer() {
      const created = createHttpHandlerDeps();
      const handleDiscussSeed = vi.fn();
      created.deps.discuss.seed = handleDiscussSeed;
      const started = await startHttpHandlerServer(created.deps);
      return { ...started, ...created, discussTools: { handleDiscussSeed } };
    }

    async function withBaseCoralEnv<T>(fn: () => Promise<T>): Promise<T> {
      const previous = process.env.CORAL_TEST_HTTP_BASE;
      process.env.CORAL_TEST_HTTP_BASE = 'daemon-base';
      try {
        return await fn();
      } finally {
        if (previous === undefined) {
          delete process.env.CORAL_TEST_HTTP_BASE;
        } else {
          process.env.CORAL_TEST_HTTP_BASE = previous;
        }
      }
    }

    it('holds an explicit drain until an HTTP unary response settles', async () => {
      const entered = createDeferred();
      const release = createDeferred();
      const { deps } = createHttpHandlerDeps();
      const idleTimer = new IdleTimer({ time: runtime.time });
      const onIdle = vi.fn();
      deps.admin.beginRequest = () => idleTimer.beginRequest();
      deps.admin.endRequest = () => idleTimer.endRequest();
      deps.kb.readSearch = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return domainSuccess({ results: [] });
      });
      idleTimer.startWatching(() => false, onIdle);

      const started = await startHttpHandlerServer(deps);
      const request = fetch(`${started.baseUrl}/kb/entries?q=held`, {
        headers: { 'X-Coral-Backend-Token': 'test-token' },
      });

      try {
        await entered.promise;
        idleTimer.requestDrain('test-teardown');

        expect(onIdle).not.toHaveBeenCalled();

        release.resolve();
        const response = await request;
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ results: [] });
        expect(onIdle).toHaveBeenCalledExactlyOnceWith('test-teardown');
      } finally {
        release.resolve();
        await request.catch(() => undefined);
        idleTimer.stopWatching();
        await _closeHttpServer(started.server);
      }
    });

    it('ends a passive SSE response when its ready frame hits backpressure', async () => {
      const originalWrite = ServerResponse.prototype.write;
      const responses: ServerResponse[] = [];
      vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
        this: ServerResponse,
        ...args: unknown[]
      ) {
        if (String(args[0]).startsWith('event: ready')) {
          responses.push(this);
          return false;
        }
        return Reflect.apply(originalWrite, this, args) as boolean;
      } as typeof originalWrite);
      const { deps } = createHttpHandlerDeps();
      const started = await startHttpHandlerServer(deps);
      try {
        const result = await fetch(`${started.baseUrl}/events/stream`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });
        expect(responses[0]?.writableEnded).toBe(true);
        expect(deps.streamResponses.size).toBe(0);
        await result.text();
      } finally {
        responses[0]?.destroy();
        await _closeHttpServer(started.server);
      }
    });

    it('cleans up passive SSE subscriptions when an event write hits backpressure', async () => {
      type TestServerResponseWrite = (this: ServerResponse, ...args: unknown[]) => boolean;
      const originalWrite = ServerResponse.prototype.write as TestServerResponseWrite;
      const writeSpy = vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
        this: ServerResponse,
        ...args: unknown[]
      ) {
        const chunk = args[0];
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        if (text.startsWith('event: job:progress')) {
          return false;
        }
        return originalWrite.call(this, ...args);
      } as TestServerResponseWrite);
      const started = await startMockedRouteServer();
      const cleanedUp = createDeferred<void>();
      const removeResponse = started.deps.events.removeResponse;
      started.deps.events.removeResponse = (response: unknown) => {
        removeResponse(response);
        cleanedUp.resolve();
      };
      let stream: Awaited<ReturnType<typeof openHttpStream>> | null = null;

      try {
        stream = await openHttpStream(
          `${started.baseUrl}/events/stream?projectRoot=${encodeURIComponent(DEFAULT_PROJECT_ROOT)}`,
          {
            'X-Coral-Backend-Token': 'test-token',
          },
        );

        await stream.waitForText((text) => text.includes('event: ready'));
        expect(started.deps.streamResponses.size).toBe(1);
        const response = [...started.deps.streamResponses][0] as ServerResponse;

        expect(
          started.deps.events.bus.emit('job:progress', {
            jobId: 'job-backpressure',
            seq: 1,
            message: 'slow client',
          }),
        ).toBe(true);

        await cleanedUp.promise;
        expect(response.destroyed).toBe(true);
        expect(started.deps.streamResponses.size).toBe(0);
        expect(
          started.deps.events.bus.emit('job:progress', {
            jobId: 'job-backpressure',
            seq: 2,
            message: 'should be unsubscribed',
          }),
        ).toBe(false);
        expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('event: job:progress'));
      } finally {
        stream?.close();
        await _closeHttpServer(started.server);
        writeSpy.mockRestore();
      }
    });

    it('returns a typed 413 response for oversized request bodies before closing the connection', async () => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}/discuss/persona-sets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: 'x'.repeat(10 * 1024 * 1024 + 1),
        });

        expect(response.status).toBe(413);
        expect(response.headers.get('connection')).toBe('close');
        expect(await response.json()).toEqual({
          code: 'request_body_too_large',
          message: 'Request body too large',
        });
        expect(started.discussTools.handleDiscussSeed).not.toHaveBeenCalled();
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('rejects remote POST /sessions requests that bypass provider permissions', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          start: vi.fn(async () => ({
            kind: 'provider-session',
            status: 'running',
            jobId: 'job-start',
            sessionId: 'session-start',
          })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: '203.0.113.10' });

        try {
          const response = await fetch(`${started.baseUrl}/sessions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              provider: 'codex',
              prompt: 'hello',
              projectRoot: DEFAULT_PROJECT_ROOT,
              bypassPermissions: true,
            }),
          });

          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            code: 'remote_transport_option_forbidden',
            message: '`bypassPermissions` is only allowed from loopback HTTP clients',
            detail: { option: 'bypassPermissions' },
          });
          expect(fakeService.start).not.toHaveBeenCalled();
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('rejects authenticated remote HTTP requests outside the configured address allowlist', async () => {
      await withBaseCoralEnv(async () => {
        const { deps } = createHttpHandlerDeps({
          remoteAccess: { mode: 'address_allowlist', allowedRemoteAddresses: ['198.51.100.8'] },
        });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: '203.0.113.10' });

        try {
          const response = await fetch(`${started.baseUrl}/health`, {
            headers: { 'X-Coral-Backend-Token': 'test-token' },
          });

          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            code: 'remote_address_forbidden',
            message: 'Remote address is not allowed',
            detail: { remoteAddress: '203.0.113.10' },
          });
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('accepts authenticated remote HTTP requests from the configured address allowlist', async () => {
      await withBaseCoralEnv(async () => {
        const { deps } = createHttpHandlerDeps({
          remoteAccess: {
            mode: 'address_allowlist',
            allowedRemoteAddresses: ['::ffff:203.0.113.10', '2001:0db8:0000:0000:0000:ff00:0042:8329'],
          },
        });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: '203.0.113.10' });

        try {
          const response = await fetch(`${started.baseUrl}/health`, {
            headers: { 'X-Coral-Backend-Token': 'test-token' },
          });

          expect(response.status).toBe(200);
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('maps a post-dispatch lifecycle refusal to the canonical HTTP 503 body', async () => {
      const abortJobs = vi.fn(() => ({ kind: 'successor-owned' as const, jobIds: ['job-1'] }));
      const { deps } = createHttpHandlerDeps({
        abortJobs,
        scopeCheckJobs: () => ({ valid: ['job-1'], missing: [], mismatch: [] }),
      });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/jobs/abort`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({ jobs: ['job-1'], projectRoot: DEFAULT_PROJECT_ROOT }),
        });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(lifecycleRefusalResult);
        expect(abortJobs).toHaveBeenCalledWith(['job-1']);
      } finally {
        await _closeHttpServer(started.server);
      }
    });
  });

  it('denies job detail when the job belongs to another project', async () => {
    const progressStore = createProgressStore();
    const backend = await startBackendServer();

    createdJobIds.add('job-foreign-project');
    initTestJob(progressStore, {
      jobId: 'job-foreign-project',
      sessionId: 'session-foreign-project',
      provider: 'codex',
      projectRoot: '/tmp/other-project',
      backendNamespace: testBackendNamespace,
    });

    const response = await fetch(
      `${backend.baseUrl}/jobs/job-foreign-project?projectRoot=${encodeURIComponent(DEFAULT_PROJECT_ROOT)}`,
      {
        headers: { 'X-Coral-Backend-Token': backend.token },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'scope_mismatch',
      message: "Jobs are outside the caller's work directory scope",
      remediation:
        "Change cwd to the job's work directory, or a directory that contains it, then rerun. Use `coral-cli jobs --all` to find its work directory, including terminal jobs.",
      detail: { jobs: ['job-foreign-project'] },
    });
  });

  it('answers a cross-project /jobs/wait member with a scope-mismatch disposition and exit 1', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = createProgressStore();
    createdJobIds.add('job-foreign');
    initTestJob(progressStore, {
      jobId: 'job-foreign',
      sessionId: 'session-foreign',
      provider: 'codex',
      projectRoot: '/tmp/other-project',
      backendNamespace: testBackendNamespace,
    });

    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
    });

    const response = await fetch(`${backend.baseUrl}/jobs/wait`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-foreign'],
        timeoutSeconds: 1,
        projectRoot: DEFAULT_PROJECT_ROOT,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: disposition');
    expect(body).toContain('"disposition":"scope-mismatch"');
    expect(body).toMatch(/event: waiting\n(?:id: .*\n)?data: .*"exitCode":1/);
    expect(fakeService.waitStream).not.toHaveBeenCalled();
  });

  it('rejects /admin/shutdown when only the general backend token is provided', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: 'shutdown_unauthorized',
      message:
        'Shutdown refused: the shutdown capability is missing or invalid. The incumbent keeps serving, and any upgrade is deferred.',
    });
    expect(backend.controller.getLifecycle()).toBe('running');
  });

  describe('shutdown policy', () => {
    it('handoff shutdown preserves children and does not mark jobs as error', async () => {
      const markJobsAsErrorFn = vi.fn();
      const settlePendingLaunchesFn = vi.fn(() => ({ kind: 'all-pending-launches-settled' }) as const);
      const terminateRegisteredChildrenFn = vi.fn(() => ({ kind: 'all-children-observed-absent' }) as const);

      const backend = await startBackendServer({
        markJobsAsErrorFn,
        settlePendingLaunchesFn,
        terminateRegisteredChildrenFn,
      });

      await backend.controller.shutdown('replaced');
      await backend.controller.waitForShutdown();

      expect(settlePendingLaunchesFn).not.toHaveBeenCalled();
      expect(terminateRegisteredChildrenFn).not.toHaveBeenCalled();
      expect(markJobsAsErrorFn).not.toHaveBeenCalled();
    });

    it('hard shutdown completes after child absence is confirmed and marks jobs as error', async () => {
      const markJobsAsErrorFn = vi.fn();
      const settlePendingLaunchesFn = vi.fn(async () => ({ kind: 'all-pending-launches-settled' }) as const);
      const terminateRegisteredChildrenFn = vi.fn(async () => ({ kind: 'all-children-observed-absent' }) as const);
      const providerHostManager = createFakeProviderHostManager();

      const backend = await startBackendServer({
        markJobsAsErrorFn,
        settlePendingLaunchesFn,
        terminateRegisteredChildrenFn,
        providerHostManager: providerHostManager as never,
      });

      await backend.controller.shutdown('sigint');
      await backend.controller.waitForShutdown();

      expect(settlePendingLaunchesFn).toHaveBeenCalledOnce();
      expect(terminateRegisteredChildrenFn).toHaveBeenCalledOnce();
      expect(settlePendingLaunchesFn.mock.invocationCallOrder.at(0) ?? Number.POSITIVE_INFINITY).toBeLessThan(
        terminateRegisteredChildrenFn.mock.invocationCallOrder.at(0) ?? Number.POSITIVE_INFINITY,
      );
      expect(markJobsAsErrorFn).toHaveBeenCalledTimes(1);
      expect(providerHostManager.shutdown).toHaveBeenCalledTimes(1);
      const hostShutdownOrder = providerHostManager.shutdown.mock.invocationCallOrder.at(0);
      const childKillOrder = terminateRegisteredChildrenFn.mock.invocationCallOrder.at(0);
      const terminalizationOrder = markJobsAsErrorFn.mock.invocationCallOrder.at(0);
      expect(hostShutdownOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(childKillOrder ?? Number.POSITIVE_INFINITY);
      expect(childKillOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(terminalizationOrder ?? Number.POSITIVE_INFINITY);
    });
  });
});
import { initTestJob } from '#tests/helpers/session.js';
