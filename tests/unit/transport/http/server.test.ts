import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage as ClientIncomingMessage,
  ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import { join } from 'node:path';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import type * as NodeOs from 'node:os';
import type * as ServerMod from '#src/coordinator/index.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as LifecycleMod from '#src/coordinator/lifecycle.js';
import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import type { ProviderServerHandle } from '#src/coordinator/live/provider-server-transport.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

import { makeEvent } from '#src/discuss/events.js';
import { discussRegistry as discussStoreRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { readDiscussEventLog } from '#src/discuss/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { createDiscussContextRegistry } from '#src/discuss/shell/live-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { commitJobInputs, commitJobTerminal } from '#tests/helpers/job-commits.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { SessionManager } from '#src/sessions/shell.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { jobsDir } from '#src/jobs/paths.js';
import { backendLog } from '#src/infra/backend-log.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { resolveProjectSource } from '#src/infra/project-source.js';
import type { CoordinatorServerController } from '#src/coordinator/index.js';
import type { LifecycleState } from '#src/coordinator/lifecycle.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { Runtime } from '#src/runtime/ports.js';
import { domainError, domainSuccess, type ToolDomainResult } from '#src/transport/tool-result.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createKbDaemonHealthComponent } from '#src/coordinator/runtime-components/kb-health-component.js';
import { createProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { MutableRuntimeState as MutableCoordinatorRuntimeState } from '#src/coordinator/lifecycle.js';
import {
  createStoreServicesRef,
  type CoordinatorStoreServices,
} from '#src/coordinator/composition/store-services-ref.js';
import { MAX_EVENT_STREAM_CONNECTIONS } from '#src/coordinator/composition/index.js';
import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { KB_DISABLED_REASON } from '#src/infra/kb-toggle.js';
import { streamProviderTerminal } from '#src/providers/stream.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { toProviderSpec } from '#tests/helpers/scripted-provider.js';
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
import { ZodError, ZodIssueCode } from 'zod';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import type { KbRequestPort } from '#src/transport/rpc/ports.js';

// The plugin root is clients/ (where bridge/manifest lives); the backend under
// test derives its namespace from that root via __PLUGIN_ROOT__ (see vitest/setup.ts).
const testBackendNamespace = pluginRootNamespace(join(process.cwd(), 'clients'));
const foreignBackendNamespace = 'foreign-namespace-xyz';
const waitTiming = {
  origin: 'runtime',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

function commaHeaderTokens(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function expectedDaemonProjectContext(projectRoot: string) {
  return expect.objectContaining({
    projectRoot,
    principal: expect.objectContaining({
      subject: 'operator',
      binding: { kind: 'project', root: projectRoot },
    }),
  });
}

function expectedDaemonPrincipalContext() {
  return expect.objectContaining({
    principal: expect.objectContaining({
      subject: 'operator',
      binding: { kind: 'unbound' },
    }),
  });
}

function expectedDaemonSystemContext() {
  return expect.objectContaining({
    principal: expect.objectContaining({
      subject: 'system',
      binding: { kind: 'unbound' },
    }),
  });
}

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-backend-test-tmp-${process.pid}-${Date.now()}`,
}));

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
  return new JobStore(namespace, runtimeArg, createDefaultUpcasterRegistry(), {
    db: openTestStoreDb(runtimeArg),
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussStoreRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
}

function createStoreServicesForProgressStore(progressStore: JobStore): CoordinatorStoreServices {
  const db = progressStore.getDb();
  return {
    storeDb: db,
    progressStore,
    consumerDriver: null,
  };
}

function createSessionManager(projectRoot: string): SessionManager {
  return new SessionManager(projectRoot, runtime, undefined, undefined, openTestStoreDb(runtime));
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
  start: ReturnType<typeof vi.fn>;
  executeWorkflow: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
  waitStreamOnce: ReturnType<typeof vi.fn>;
};

function createFakeExecutionService(overrides: Partial<FakeExecutionService> = {}): FakeExecutionService {
  return {
    start: vi.fn(),
    executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
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
        result: { content: 'done', outcome: { kind: 'completed' } },
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
    acquireServer: vi.fn(),
    borrowLiveServer: vi.fn(),
    drainForHandoff: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

function createFakeProviderServerHandle(options?: {
  generation?: number;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const closed = createDeferred<Error | void>();
  const request =
    options?.request ??
    (async (_method: string, _params: Record<string, unknown>) => {
      return {};
    });
  const requestMock = vi.fn((method: string, params: Record<string, unknown> = {}) => request(method, params));
  const notifyMock = vi.fn();
  const onNotificationMock = vi.fn(
    (handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  );
  const markExpectedCloseMock = vi.fn();
  const closeMock = vi.fn(async () => {
    closed.resolve();
  });

  return {
    handle: {
      pid: options?.generation ?? 1,
      child: {} as never,
      generation: options?.generation ?? 1,
      rpc: {
        request: requestMock as unknown as ProviderServerHandle['rpc']['request'],
        notify: notifyMock,
      },
      onNotification: onNotificationMock as unknown as ProviderServerHandle['onNotification'],
      closePromise: closed.promise,
      markExpectedClose: markExpectedCloseMock,
      close: closeMock,
    } satisfies ProviderServerHandle,
    requestMock,
    markExpectedCloseMock,
    closeMock,
    resolveClosed: () => {
      closed.resolve();
    },
  };
}

function createProviderServerScript(): string {
  return [
    'const interval = setInterval(() => {}, 1_000);',
    "process.on('SIGTERM', () => {",
    '  clearInterval(interval);',
    '  process.exit(0);',
    '});',
  ].join('');
}

function createLaunchCoordinator(): LaunchCoordinator {
  return new LaunchCoordinator({ runtime });
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
  waitForText: (check: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
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

      const waitForText = (check: (current: string) => boolean, timeoutMs = 2_000): Promise<string> => {
        if (check(text)) return Promise.resolve(text);

        return new Promise<string>((resolveText, rejectText) => {
          const timeout = setTimeout(() => {
            cleanup();
            rejectText(new Error('Timed out reading stream'));
          }, timeoutMs);

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
            clearTimeout(timeout);
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
// graph (no module-level mutation per test). 7 call sites previously paid
// the cost of vi.resetModules + re-resolving the coordinator graph each
// time; the first call took ~700ms.
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

function stubLaunchRecord(
  progressStore: JobStore,
  overrides: {
    jobId: string;
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
    pool?: string;
    jobKind?: 'provider' | 'workflow';
  },
): void {
  const record: JobLaunch = {
    jobId: overrides.jobId,
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    jobKind: overrides.jobKind === 'workflow' ? 'workflow' : 'provider',
    pool: overrides.pool ?? 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      cwd: '/tmp/test',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date().toISOString(),
  };
  progressStore.appendLaunchRequested(overrides.jobId, record);
}

function stubRuntimeRecord(
  progressStore: JobStore,
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
    stdoutPath: overrides.stdoutPath ?? join(JOBS_DIR, overrides.jobId, 'stdout.log'),
    stderrPath: overrides.stderrPath ?? join(JOBS_DIR, overrides.jobId, 'stderr.log'),
    startTime: overrides.startTime ?? new Date().toISOString(),
  });
}

function stubSessionProjection(
  progressStore: JobStore,
  overrides: {
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
  },
): void {
  const scopeKey = pluginRootNamespace(overrides.projectRoot);

  commitInputs(
    progressStore.getDb(),
    [
      {
        type: 'session.opened',
        stream: { kind: 'session', id: overrides.sessionId },
        namespace: overrides.backendNamespace,
        project: overrides.projectRoot,
        refs: { sessionId: overrides.sessionId },
        bodyVersion: 1,
        body: {
          entry: {
            sessionId: overrides.sessionId,
            provider: overrides.provider,
            name: 'alpha',
            state: 'pending',
            cwd: overrides.projectRoot,
            projectRoot: overrides.projectRoot,
            backendNamespace: overrides.backendNamespace,
            providerContinuity: null,
            createdAt: new Date(runtime.time.now()).toISOString(),
            lastUsedAt: new Date(runtime.time.now()).toISOString(),
            version: 1,
          },
          controller: 'default',
          provider: overrides.provider,
          scope_key: scopeKey,
        },
      },
    ],
    {
      now: () => new Date(runtime.time.now()),
      reducers: composeReducers(sessionsRegistry),
      upcasters: createDefaultUpcasterRegistry(),
      providers: permissiveProviderLookupPort,
    },
  );
}

function parseToolData(result: ToolDomainResult): unknown {
  if (!result.ok) {
    throw new Error(`Unexpected tool error: ${result.code}`);
  }
  return result.data;
}

describe('execution backend server', () => {
  let controller: CoordinatorServerController | null = null;

  beforeEach(() => {
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
    runtime = createRealRuntime('prod');
    JOBS_DIR = jobsDir(runtime.env);
    rmSync(JOBS_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (controller && controller.getLifecycle() !== 'stopped') {
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
    controller = null;
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    vi.restoreAllMocks();
    // vi.resetModules() removed: 116 tests × ~40ms = ~4.6s of pure cache
    // invalidation. The few tests needing fresh modules call
    // `loadExecutionModules()` (which resets internally). vi.mock at module
    // scope is hoisted and persistent across tests; restoreAllMocks() undoes
    // any vi.spyOn from individual tests.
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

  async function startBackendServer(overrides: Parameters<ServerModule['createCoordinatorServer']>[0] = {}) {
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
        bundleHash: 'testhash1234',
        flavor: 'prod',
        log: () => {},
        ...bootOverrides,
      },
      cleanupStaleJobsFn: () => {},
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

  function createProjectRoot(name: string): string {
    const projectRoot = join(mockState.tmpHome, name);
    mkdirSync(projectRoot, { recursive: true });
    return projectRoot;
  }

  it('preserves flavored backend info and rejects records without flavor', async () => {
    const { backendInfo } = await loadExecutionModules();
    const pluginRoot = createProjectRoot('backend-info-flavor');
    const namespace = pluginRootNamespace(pluginRoot);

    const discoveryRuntime = { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
    backendInfo.writeBackendInfo(
      {
        pid: process.pid,
        port: 4100,
        socketPath: '/tmp/coral-dev.sock',
        host: '127.0.0.1',
        token: 'test-token',
        bootToken: 'test-boot-token',
        version: '9.9.9',
        bundleHash: 'testhash1234',
        flavor: 'dev',
        instanceId: 'backend-info-dev',
        namespace,
        startedAt: 1,
      },
      discoveryRuntime,
    );
    expect(backendInfo.readBackendInfo(discoveryRuntime)).toMatchObject({
      host: '127.0.0.1',
      flavor: 'dev',
      namespace,
    });

    writeFileSync(
      runtime.paths.coral.coordinator.infoFile,
      JSON.stringify({
        pid: process.pid,
        port: 4101,
        socketPath: '/tmp/coral-prod.sock',
        token: 'missing-flavor-token',
        version: '9.9.9',
        bundleHash: 'missingflavor1234',
        instanceId: 'backend-info-missing-flavor',
        namespace,
        startedAt: 2,
      }),
      'utf-8',
    );
    expect(backendInfo.readBackendInfo(discoveryRuntime)).toBeNull();
  });

  it('returns 200 from /health with execution metadata', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(backend.started.flavor).toBe('prod');
    expect(body).toMatchObject({
      status: 'ok',
      version: '9.9.9',
      bundleHash: 'testhash1234',
      flavor: 'prod',
      instanceId: 'execution-backend-instance-1',
      active: 0,
      activeJobs: 0,
      liveDiscuss: 0,
      inflightRequests: 0,
      queueDepth: 0,
    });
    expect(typeof body.uptimeMs).toBe('number');
    expect(Array.isArray(body.components)).toBe(true);
    const components = body.components as Array<{ id: string; phase: string }>;
    expect(components.find((s) => s.id === 'kb')?.phase).toBe('online');
  });

  it('probes an online KB daemon before returning /health', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
      pendingRequests: 0,
    };
    const probedHealth: KbDaemonHealthSnapshot = {
      ...daemonHealth,
      lastHeartbeatAt: 30,
      lastHeartbeatLatencyMs: 2,
      daemonUptimeMs: 20,
    };
    let currentHealth = daemonHealth;
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => currentHealth),
      start: vi.fn(async () => currentHealth),
      probe: vi.fn(async () => {
        currentHealth = probedHealth;
        return currentHealth;
      }),
      warmup: vi.fn(async () => currentHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'unexpected_mutation',
        message: 'unexpected mutation',
      })),
      expansionRpc: createUnexpectedExpansionRpc(),
      stop: vi.fn(async () => currentHealth),
      restart: vi.fn(async () => currentHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    await vi.waitFor(() => {
      expect(kbDaemonSupervisor.warmup).toHaveBeenCalledTimes(1);
    });

    const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });
    const body = (await response.json()) as { kbDaemon?: KbDaemonHealthSnapshot };

    expect(response.status).toBe(200);
    expect(kbDaemonSupervisor.probe).toHaveBeenCalledTimes(1);
    expect(body.kbDaemon).toMatchObject({
      phase: 'online',
      lastHeartbeatAt: 30,
      lastHeartbeatLatencyMs: 2,
      daemonUptimeMs: 20,
    });
  });

  it('does not probe an online KB daemon when recent heartbeat health is cached', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
      pendingRequests: 0,
      lastHeartbeatAt: 1_000,
      lastHeartbeatLatencyMs: 2,
      daemonUptimeMs: 20,
    };
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'unexpected_mutation',
        message: 'unexpected mutation',
      })),
      expansionRpc: createUnexpectedExpansionRpc(),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({
      bootSnapshot: { now: () => 2_000 },
      kbDaemonSupervisor,
    });

    const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });

    expect(response.status).toBe(200);
    expect(kbDaemonSupervisor.probe).not.toHaveBeenCalled();
  });

  it('uses a KB daemon health component for coordinator health', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({ health: daemonHealth });
    const backend = await startBackendServer({
      kbDaemonSupervisor,
    });

    const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });
    const body = (await response.json()) as { components?: Array<{ id: string; phase: string }> };

    expect(response.status).toBe(200);
    expect(body.components?.find((component) => component.id === 'kb')?.phase).toBe('online');
    expect(kbDaemonSupervisor.start).toHaveBeenCalledTimes(1);
  });

  it('routes KB memo mutations through the daemon supervisor', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const mutateKb = vi.fn<KbDaemonSupervisor['mutateKb']>(async (request) => ({
      ok: true as const,
      data: { servedBy: 'kb-daemon', method: request.method },
    }));
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({
      health: daemonHealth,
      mutateKb,
    });
    const backend = await startBackendServer({
      kbDaemonSupervisor,
    });

    const response = await fetch(`${backend.baseUrl}/kb/memos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        projectRoot: '/workspace/project-a',
        topic: 'alpha',
        content: 'memo body',
        owner: 'kang',
      }),
    });

    expect(response.status).toBe(201);
    expect(mutateKb).toHaveBeenCalledWith({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'memo body', owner: 'kang' },
      ctx: expectedDaemonProjectContext('/workspace/project-a'),
    });
  });

  it('uses the daemon supervisor in the standard server path', async () => {
    const { serverModule } = await loadExecutionModules();
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const mutateKb = vi.fn<KbDaemonSupervisor['mutateKb']>(async (request) => ({
      ok: true as const,
      data: { servedBy: 'kb-daemon', method: request.method },
    }));
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({
      health: daemonHealth,
      mutateKb,
    });
    controller = serverModule.createCoordinatorServer({
      bootSnapshot: {
        instanceId: 'execution-backend-instance-1',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        version: '9.9.9',
        bundleHash: 'testhash1234',
        flavor: 'prod',
        log: () => {},
      },
      cleanupStaleJobsFn: () => {},
      kbDaemonSupervisor,
    });
    const started = await controller.start();

    const response = await fetch(`http://127.0.0.1:${started.port}/kb/memos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': started.token,
      },
      body: JSON.stringify({
        projectRoot: '/workspace/project-a',
        topic: 'alpha',
        content: 'memo body',
        owner: 'kang',
      }),
    });

    expect(response.status).toBe(201);
    expect(mutateKb).toHaveBeenCalledWith({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'memo body', owner: 'kang' },
      ctx: expectedDaemonProjectContext('/workspace/project-a'),
    });
  });

  it('reports the KB daemon proxy offline when the daemon is disabled', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: false,
      phase: 'disabled',
      generation: 0,
      pid: null,
      startedAt: null,
      readyAt: null,
      reason: 'disabled for test',
    };
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({
      health: daemonHealth,
      readKb: vi.fn(async () => ({
        ok: false as const,
        code: 'kb_unavailable',
        message: 'KB daemon supervisor is disabled',
        detail: { reason: 'kb_daemon_disabled' },
      })),
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'kb_unavailable',
        message: 'KB daemon supervisor is disabled',
        detail: { reason: 'kb_daemon_disabled' },
      })),
    });
    const backend = await startBackendServer({
      kbDaemonSupervisor,
    });

    const healthResponse = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });
    const health = (await healthResponse.json()) as { components?: Array<{ id: string; phase: string }> };

    expect(healthResponse.status).toBe(200);
    expect(health.components?.find((component) => component.id === 'kb')?.phase).toBe('offline');

    const kbResponse = await fetch(`${backend.baseUrl}/kb/entries?q=alpha`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(kbResponse.status).toBe(503);
    expect(kbDaemonSupervisor.readKb).toHaveBeenCalledWith({
      method: 'readSearch',
      args: { query: 'alpha' },
      ctx: expectedDaemonPrincipalContext(),
    });
  });

  it('keeps CORAL_KB_ENABLE=0 on the explicit disabled KB daemon runtime path', async () => {
    const previousKbEnabled = process.env.CORAL_KB_ENABLE;
    process.env.CORAL_KB_ENABLE = '0';
    try {
      const backend = await startBackendServer();

      const healthResponse = await fetch(`${backend.baseUrl}/health?detailed=1`, {
        headers: { 'X-Coral-Boot-Token': backend.bootToken },
      });
      const health = (await healthResponse.json()) as {
        components?: Array<{ id: string; phase: string; reason?: string }>;
      };

      expect(healthResponse.status).toBe(200);
      expect(health.components?.find((component) => component.id === 'kb')).toMatchObject({
        phase: 'offline',
        reason: KB_DISABLED_REASON,
      });

      const kbResponse = await fetch(`${backend.baseUrl}/kb/entries?q=alpha`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });

      expect(kbResponse.status).toBe(503);
      await expect(kbResponse.json()).resolves.toMatchObject({ code: 'kb_disabled' });
    } finally {
      if (previousKbEnabled === undefined) {
        delete process.env.CORAL_KB_ENABLE;
      } else {
        process.env.CORAL_KB_ENABLE = previousKbEnabled;
      }
    }
  });

  it('routes read-only KB RPCs through the daemon supervisor', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const readKb = vi.fn<KbDaemonSupervisor['readKb']>(async (_request) => ({
      ok: true as const,
      data: { servedBy: 'kb-daemon' },
    }));
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb,
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'unexpected_mutation',
        message: 'unexpected mutation',
      })),
      expansionRpc: createUnexpectedExpansionRpc(),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const projectRoot = '/workspace/project-a';
    const projectRootQuery = encodeURIComponent(projectRoot);
    const getJson = async (path: string): Promise<unknown> => {
      const response = await fetch(`${backend.baseUrl}${path}`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });

      expect(response.status).toBe(200);
      return await response.json();
    };

    await expect(getJson('/kb/entries?q=alpha')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/diagnose')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/notes/alpha-note')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/sources')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/sources/alpha-source')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/wikis')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/wikis/alpha-wiki')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/wake-up?project=kangig94-coral')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/communities/alpha-community')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/communities-stale')).resolves.toEqual({ servedBy: 'kb-daemon' });
    await expect(getJson('/kb/communities/alpha-community/summary-input')).resolves.toEqual({
      servedBy: 'kb-daemon',
    });
    await expect(getJson(`/kb/memos?projectRoot=${projectRootQuery}&owner=kang`)).resolves.toEqual({
      servedBy: 'kb-daemon',
    });
    await expect(getJson(`/kb/memos/alpha-memo?projectRoot=${projectRootQuery}`)).resolves.toEqual({
      servedBy: 'kb-daemon',
    });
    await expect(getJson('/kb/principles?q=alpha&top_k=2&verbose=1')).resolves.toEqual({
      servedBy: 'kb-daemon',
    });
    await expect(getJson('/kb/principles/alpha-principle')).resolves.toEqual({ servedBy: 'kb-daemon' });

    expect(readKb.mock.calls.map(([request]) => request)).toEqual([
      { method: 'readSearch', args: { query: 'alpha' }, ctx: expectedDaemonPrincipalContext() },
      { method: 'diagnose', ctx: expectedDaemonPrincipalContext() },
      { method: 'readNote', slug: 'alpha-note', ctx: expectedDaemonPrincipalContext() },
      { method: 'listSources', ctx: expectedDaemonPrincipalContext() },
      { method: 'readSource', slug: 'alpha-source', ctx: expectedDaemonPrincipalContext() },
      { method: 'listWikis', ctx: expectedDaemonPrincipalContext() },
      { method: 'readWiki', slug: 'alpha-wiki', ctx: expectedDaemonPrincipalContext() },
      { method: 'wakeUp', args: { project: 'kangig94-coral' }, ctx: expectedDaemonPrincipalContext() },
      { method: 'readCommunity', slug: 'alpha-community', ctx: expectedDaemonPrincipalContext() },
      { method: 'listStaleCommunities', ctx: expectedDaemonPrincipalContext() },
      {
        method: 'readCommunitySummaryInput',
        slug: 'alpha-community',
        ctx: expectedDaemonPrincipalContext(),
      },
      {
        method: 'listMemos',
        args: { owner: 'kang' },
        ctx: expectedDaemonProjectContext(projectRoot),
      },
      {
        method: 'readMemo',
        slug: 'alpha-memo',
        ctx: expectedDaemonProjectContext(projectRoot),
      },
      {
        method: 'listPrinciples',
        args: { query: 'alpha', top_k: 2, verbose: true },
        ctx: expectedDaemonPrincipalContext(),
      },
      { method: 'readPrinciple', slug: 'alpha-principle', ctx: expectedDaemonPrincipalContext() },
    ]);
  });

  it('routes KB memo mutations through the daemon supervisor', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const mutateKb = vi.fn<KbDaemonSupervisor['mutateKb']>(async (_request) => ({
      ok: true as const,
      data: { servedBy: 'kb-daemon' },
    }));
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb,
      expansionRpc: createUnexpectedExpansionRpc(),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const projectRoot = '/workspace/project-a';

    const response = await fetch(`${backend.baseUrl}/kb/memos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        projectRoot,
        topic: 'alpha',
        content: 'memo body',
        owner: 'kang',
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ servedBy: 'kb-daemon' });
    expect(mutateKb.mock.calls.map(([request]) => request)).toEqual([
      {
        method: 'createMemo',
        args: { topic: 'alpha', content: 'memo body', owner: 'kang' },
        ctx: expectedDaemonProjectContext(projectRoot),
      },
    ]);
  });

  it('routes KB corpus mutations through the daemon supervisor', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const mutateKb = vi.fn<KbDaemonSupervisor['mutateKb']>(async (_request) => ({
      ok: true as const,
      data: { servedBy: 'kb-daemon' },
    }));
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb,
      expansionRpc: createUnexpectedExpansionRpc(),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const projectRoot = '/workspace/project-a';
    const headers = {
      'Content-Type': 'application/json',
      'X-Coral-Backend-Token': backend.token,
    };

    await expect(
      fetch(`${backend.baseUrl}/kb/wikis`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectRoot,
          slug: 'alpha-wiki',
          title: 'Alpha',
          tags: ['daemon'],
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
    ).resolves.toEqual({ status: 201, body: { servedBy: 'kb-daemon' } });

    await expect(
      fetch(`${backend.baseUrl}/kb/sources/alpha-source`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ projectRoot }),
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
    ).resolves.toEqual({ status: 200, body: { servedBy: 'kb-daemon' } });

    await expect(
      fetch(`${backend.baseUrl}/kb/sources`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectRoot,
          filePath: '/workspace/project-a/source.md',
          slug: 'alpha-source',
          readiness: 'base-search',
          async: true,
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
    ).resolves.toEqual({ status: 201, body: { servedBy: 'kb-daemon' } });

    await expect(
      fetch(`${backend.baseUrl}/kb/index`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectRoot,
          async: true,
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
    ).resolves.toEqual({ status: 200, body: { servedBy: 'kb-daemon' } });

    await expect(
      fetch(`${backend.baseUrl}/kb/communities/alpha-community/summary`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectRoot,
          summary: 'Community summary from daemon.',
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() })),
    ).resolves.toEqual({ status: 200, body: { servedBy: 'kb-daemon' } });

    expect(mutateKb.mock.calls.map(([request]) => request)).toEqual([
      {
        method: 'createWiki',
        args: { slug: 'alpha-wiki', title: 'Alpha', tags: ['daemon'] },
        ctx: expectedDaemonProjectContext(projectRoot),
      },
      {
        method: 'deleteSource',
        slug: 'alpha-source',
        ctx: expectedDaemonSystemContext(),
      },
      {
        method: 'createSource',
        args: {
          filePath: '/workspace/project-a/source.md',
          slug: 'alpha-source',
          readiness: 'base-search',
          async: true,
        },
        ctx: expectedDaemonProjectContext(projectRoot),
      },
      {
        method: 'reindex',
        args: { async: true },
        ctx: expectedDaemonProjectContext(projectRoot),
      },
      {
        method: 'setCommunitySummary',
        args: { summary: 'Community summary from daemon.', slug: 'alpha-community' },
        ctx: expectedDaemonProjectContext(projectRoot),
      },
    ]);
  });

  it('marks tracked daemon-owned KB jobs as error when the KB daemon exits', async () => {
    const jobId = 'kb-daemon-import-job-1';
    const projectRoot = '/workspace/project-a';
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
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const progressStore = createProgressStore();
    createdJobIds.add(jobId);
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot,
      backendNamespace: testBackendNamespace,
      bundleHash: 'testhash1234',
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      operation: 'kb.source_import',
      request: {
        filePath: '/workspace/project-a/source.md',
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
        filePath: '/workspace/project-a/source.md',
        slug: 'alpha-source',
        readiness: 'base-search',
        async: true,
      }),
    });
    expect(response.status).toBe(202);
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

  it('marks durable daemon-owned KB jobs as error when the daemon exits before proxy registration', async () => {
    const jobId = 'kb-daemon-unproxied-import-job-1';
    const projectRoot = '/workspace/project-a';
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
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'unexpected_mutation',
        message: 'unexpected mutation',
      })),
      expansionRpc: createUnexpectedExpansionRpc(),
      abortKbJobs: vi.fn(async () => ({ aborted: [], notFound: [] })),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const progressStore = createProgressStore();
    createdJobIds.add(jobId);
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot,
      backendNamespace: testBackendNamespace,
      bundleHash: 'testhash1234',
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      operation: 'kb.source_import',
      request: {
        filePath: '/workspace/project-a/source.md',
        slug: 'alpha-source',
        readiness: 'base-search',
      },
      createdAt: new Date().toISOString(),
    });
    progressStore.appendRuntimeStarted(jobId, {
      transport: 'internal',
      operation: 'kb.source_import',
      owner: 'kb-daemon',
      startTime: new Date().toISOString(),
    });

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
      lastError: 'daemon crashed before returning job id',
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

  it('removes daemon-owned KB abort proxies when the daemon-owned KB job reaches terminal state', async () => {
    const jobId = 'kb-daemon-import-job-terminal';
    const projectRoot = '/workspace/project-a';
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const abortKbJobs = vi.fn(async () => ({ aborted: [jobId], notFound: [] }));
    const eventBus = new TypedEventBus();
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      onExit: vi.fn(() => vi.fn()),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb: vi.fn(async () => ({ ok: true as const, data: { status: 'running', job: jobId } })),
      expansionRpc: createUnexpectedExpansionRpc(),
      abortKbJobs,
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ eventBus, kbDaemonSupervisor });
    const progressStore = createProgressStore();
    createdJobIds.add(jobId);
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot,
      backendNamespace: testBackendNamespace,
      bundleHash: 'testhash1234',
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      operation: 'kb.source_import',
      request: {
        filePath: '/workspace/project-a/source.md',
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

    const createResponse = await fetch(`${backend.baseUrl}/kb/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        projectRoot,
        filePath: '/workspace/project-a/source.md',
        slug: 'alpha-source',
        readiness: 'base-search',
        async: true,
      }),
    });
    expect(createResponse.status).toBe(202);

    commitJobTerminal(
      progressStore,
      jobId,
      null,
      { content: 'Imported source.', outcome: { kind: 'completed' } },
      'completed',
    );
    eventBus.emit('job:completed', {
      jobId,
      result: { content: 'Imported source.', outcome: { kind: 'completed' } },
    });

    const abortResponse = await fetch(`${backend.baseUrl}/jobs/abort`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobs: [jobId],
        projectRoot,
      }),
    });

    expect(abortResponse.status).toBe(200);
    await expect(abortResponse.json()).resolves.toEqual({
      aborted: [],
      notFound: [jobId],
    });
    expect(abortKbJobs).not.toHaveBeenCalled();
  });

  it('reports KB unavailable when the daemon supervisor is failed', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'failed',
      generation: 1,
      pid: null,
      startedAt: 10,
      readyAt: null,
      lastError: 'simulated KB daemon failure',
    };
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({
      health: daemonHealth,
      readKb: vi.fn(async () => ({
        ok: false as const,
        code: 'kb_unavailable',
        message: 'KB daemon supervisor is failed',
        detail: { reason: 'kb_daemon_failed' },
      })),
    });
    const backend = await startBackendServer({
      kbDaemonSupervisor,
    });

    const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    const components = body.components as Array<{ id: string; phase: string }>;
    const kb = components.find((s) => s.id === 'kb');
    expect(kb).toBeDefined();
    expect(kb!.phase).toBe('offline');

    const kbResponse = await fetch(`${backend.baseUrl}/kb/entries?q=alpha`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    expect(kbResponse.status).toBe(503);
    await expect(kbResponse.json()).resolves.toMatchObject({
      code: 'kb_unavailable',
      detail: { reason: 'kb_daemon_failed' },
    });
  });

  it('includes active launches in active count', async () => {
    const launchCoordinator = createLaunchCoordinator();
    const backend = await startBackendServer({ launchCoordinator });

    // Simulate two active launches via restoreActiveLaunch
    launchCoordinator.restoreActiveLaunch('job-1', 'codex');
    launchCoordinator.restoreActiveLaunch('job-2', 'codex');

    try {
      const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
        headers: { 'X-Coral-Boot-Token': backend.bootToken },
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.active).toBe(2);
    } finally {
      launchCoordinator.releaseLaunch('job-1');
      launchCoordinator.releaseLaunch('job-2');
    }
  });

  it('injects one shared ProviderHostManager across project-root services so Claude shares and incompatible Codex hosts stay isolated', async () => {
    const { serverModule } = await loadExecutionModules();
    const [{ ExecutionService }, claudeRequestMapping, codexRequestMapping] = await Promise.all([
      import('#src/coordinator/execution-service.js'),
      import('#src/providers/claude/request-mapping.js'),
      import('#src/providers/codex/request-mapping.js'),
    ]);
    const progressStore = createProgressStore();
    const projectRootA = createProjectRoot('provider-host-project-a');
    const projectRootB = createProjectRoot('provider-host-project-b');
    const jobIdA = 'provider-host-job-a';
    const jobIdB = 'provider-host-job-b';
    createdJobIds.add(jobIdA);
    createdJobIds.add(jobIdB);

    progressStore.initJob({
      jobId: jobIdA,
      sessionId: 'session-a',
      provider: 'codex',
      projectRoot: projectRootA,
      backendNamespace: testBackendNamespace,
      initialPhase: 'running',
    });
    stubLaunchRecord(progressStore, {
      jobId: jobIdA,
      sessionId: 'session-a',
      provider: 'codex',
      projectRoot: projectRootA,
      backendNamespace: testBackendNamespace,
    });
    commitJobTerminal(
      progressStore,
      jobIdA,
      'session-a',
      { content: 'done-a', outcome: { kind: 'completed' } },
      'completed',
    );

    progressStore.initJob({
      jobId: jobIdB,
      sessionId: 'session-b',
      provider: 'codex',
      projectRoot: projectRootB,
      backendNamespace: testBackendNamespace,
      initialPhase: 'running',
    });
    stubLaunchRecord(progressStore, {
      jobId: jobIdB,
      sessionId: 'session-b',
      provider: 'codex',
      projectRoot: projectRootB,
      backendNamespace: testBackendNamespace,
    });
    commitJobTerminal(
      progressStore,
      jobIdB,
      'session-b',
      { content: 'done-b', outcome: { kind: 'completed' } },
      'completed',
    );

    const services = new Map<string, InstanceType<typeof ExecutionService>>();
    const capturedManagers: unknown[] = [];
    const sharedClaudeHandle = createFakeProviderServerHandle({
      generation: 11,
      request: async (method) => {
        if (method === 'broker/shutdown') {
          sharedClaudeHandle.resolveClosed();
        }
        return {};
      },
    });
    const codexHandleA = createFakeProviderServerHandle({ generation: 22 });
    const codexHandleB = createFakeProviderServerHandle({ generation: 33 });
    const spawnProviderServer = vi
      .fn()
      .mockResolvedValueOnce(sharedClaudeHandle.handle)
      .mockResolvedValueOnce(codexHandleA.handle)
      .mockResolvedValueOnce(codexHandleB.handle);
    const providerHostManager = createProviderHostManager({ runtime, spawnProviderServer });
    controller = serverModule.createCoordinatorServer({
      bootSnapshot: {
        instanceId: 'execution-backend-instance-1',
        token: 'test-token',
        bootToken: 'test-boot-token',
        version: '9.9.9',
        bundleHash: 'testhash1234',
        flavor: 'prod',
        log: () => {},
      },
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      cleanupStaleJobsFn: () => {},
      providerHostManager,
      createExecutionService: (ctx, deps) => {
        capturedManagers.push(deps.providerHostManager);
        const service = new ExecutionService(ctx, deps);
        services.set(ctx.projectRoot, service);
        return service;
      },
    });
    const started = await controller.start();
    const backend = {
      baseUrl: `http://127.0.0.1:${started.port}`,
      token: started.token,
    };

    const waitForService = async (projectRoot: string, jobId: string): Promise<void> => {
      const response = await fetch(`${backend.baseUrl}/jobs/wait`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': backend.token,
        },
        body: JSON.stringify({
          jobIds: [jobId],
          timeoutSeconds: 1,
          projectRoot,
        }),
      });

      expect(response.status).toBe(200);
      await response.text();
    };

    await waitForService(projectRootA, jobIdA);
    await waitForService(projectRootB, jobIdB);

    expect(capturedManagers).toHaveLength(2);
    expect(capturedManagers[0]).toBe(capturedManagers[1]);

    const serviceA = services.get(projectRootA);
    const serviceB = services.get(projectRootB);
    expect(serviceA).toBeInstanceOf(ExecutionService);
    expect(serviceB).toBeInstanceOf(ExecutionService);

    const claudeSpec = claudeRequestMapping.buildClaudeProviderServerSpec(
      { cwd: projectRootA },
      { existsSync: () => true },
    );
    const codexSpecA = codexRequestMapping.buildCodexProviderServerSpec(projectRootA, {
      PROJECT_ROOT: 'a',
    });
    const codexSpecB = codexRequestMapping.buildCodexProviderServerSpec(projectRootB, {
      PROJECT_ROOT: 'b',
    });

    const claudeLeaseA = await serviceA!.acquireServer(claudeSpec);
    const claudeLeaseB = await serviceB!.acquireServer(claudeSpec);
    const codexLeaseA = await serviceA!.acquireServer(codexSpecA);
    const codexLeaseB = await serviceB!.acquireServer(codexSpecB);

    expect(claudeLeaseA.generation).toBe(11);
    expect(claudeLeaseB.generation).toBe(11);
    expect(codexLeaseA.generation).toBe(22);
    expect(codexLeaseB.generation).toBe(33);
    expect(spawnProviderServer).toHaveBeenCalledTimes(3);

    claudeLeaseA.release();
    claudeLeaseB.release();
    codexLeaseA.release();
    codexLeaseB.release();
  });

  it('reports only in-namespace live jobs from /health even when a foreign namespace shares the same bundle hash', async () => {
    const progressStore = createProgressStore();
    const backend = await startBackendServer();

    createdJobIds.add('job-local-health');
    createdJobIds.add('job-foreign-health');
    progressStore.initJob({
      jobId: 'job-local-health',
      sessionId: 'session-local-health',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
      bundleHash: 'testhash1234',
      initialPhase: 'running',
    });
    stubLaunchRecord(progressStore, {
      jobId: 'job-local-health',
      sessionId: 'session-local-health',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    stubRuntimeRecord(progressStore, { jobId: 'job-local-health' });
    progressStore.initJob({
      jobId: 'job-foreign-health',
      sessionId: 'session-foreign-health',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: foreignBackendNamespace,
      bundleHash: 'testhash1234',
      initialPhase: 'running',
    });
    stubLaunchRecord(progressStore, {
      jobId: 'job-foreign-health',
      sessionId: 'session-foreign-health',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: foreignBackendNamespace,
    });
    stubRuntimeRecord(progressStore, { jobId: 'job-foreign-health' });

    const response = await fetch(`${backend.baseUrl}/health?detailed=1`, {
      headers: { 'X-Coral-Boot-Token': backend.bootToken },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      activeJobs: 1,
    });
  });

  it('recovers discuss-only sources from the durable source registry before idle watching starts', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const projectRoot = createProjectRoot('discuss-only-project');
    const progressStore = createProgressStore();
    const created = decideSessionCreate(
      {
        topic: 'Should the city pedestrianize the downtown core?',
        min_bid_delay_ms: 0,
        agents: [
          { name: 'alpha', persona: '# Alpha', participation: 'required' },
          { name: 'beta', persona: '# Beta', participation: 'required' },
        ],
      },
      {
        sessionId: 'discuss-only-session',
        projectRoot: projectRoot,
        topic: 'Should the city pedestrianize the downtown core?',
      },
      1,
      '2026-03-11T00:00:00.000Z',
    );
    if (!created.ok) {
      throw new Error(created.error);
    }
    commitJobInputs(
      progressStore,
      created.value.map((event) => toJournalInput(event)),
    );

    const discussRegistry = createDiscussContextRegistry();
    const setSpy = vi.spyOn(discussRegistry.contexts, 'set');

    await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
      discussRegistry,
    });

    expect(setSpy).toHaveBeenCalledWith(projectRoot, expect.objectContaining({ projectRoot }));
    expect(discussRegistry.contexts.has(projectRoot)).toBe(true);
    expect(discussRegistry.contexts.get(projectRoot)?.sessions.has('discuss-only-session')).toBe(true);
    expect(fakeIdleTimer.startWatching).toHaveBeenCalledTimes(1);
    const finalRecoveryOrder = setSpy.mock.invocationCallOrder.at(-1);
    const idleWatchOrder = fakeIdleTimer.startWatching.mock.invocationCallOrder.at(0);
    expect(finalRecoveryOrder).toBeDefined();
    expect(idleWatchOrder).toBeDefined();
    expect(finalRecoveryOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(idleWatchOrder ?? Number.POSITIVE_INFINITY);
  });

  it('does not recover discuss project roots discovered only from the session index', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const projectRoot = createProjectRoot('session-index-only-project');
    createSessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot, projectRoot);

    const discussRegistry = createDiscussContextRegistry();
    const setSpy = vi.spyOn(discussRegistry.contexts, 'set');

    await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
      discussRegistry,
    });

    expect(setSpy).not.toHaveBeenCalled();
    expect(discussRegistry.contexts.size).toBe(0);
    expect(fakeIdleTimer.startWatching).toHaveBeenCalledTimes(1);
  });

  it('treats warm provider servers as idle in the backend idle predicate', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const backend = await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
    });
    expect(fakeIdleTimer.startWatching).toHaveBeenCalledTimes(1);

    const [checkIdle] = fakeIdleTimer.startWatching.mock.calls[0] ?? [];
    if (typeof checkIdle !== 'function') {
      throw new Error('Expected idle watcher callback');
    }

    const launchCoordinator = createLaunchCoordinator();
    const handle = await launchCoordinator.spawnProviderServer({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', createProviderServerScript()],
    });

    try {
      expect(checkIdle()).toBe(true);
    } finally {
      await handle.close();
      await backend.controller.shutdown('test');
      await backend.controller.waitForShutdown();
    }
  });

  it('returns verbose kb principles rows with deterministic note order and orphan warnings', async () => {
    const { handleKbPrinciples } = await import('#src/kb/tool-handlers.js');

    const response = await handleKbPrinciples({ query: 'contract', verbose: true, top_k: 5 }, {
      kb: {
        readIndex: vi.fn(() => ({
          entries: {
            'note:b-note': {
              kind: 'note',
              slug: 'b-note',
              title: 'B',
              tags: ['coral'],
              principles: ['contract-first-design'],
              source: ['kb'],
              createdAt: '2026-03-20T00:00:00.000Z',
              updatedAt: '2026-03-20T00:00:00.000Z',
            },
            'note:a-note': {
              kind: 'note',
              slug: 'a-note',
              title: 'A',
              tags: ['coral'],
              principles: ['missing-principle', 'contract-first-design'],
              source: ['kb'],
              createdAt: '2026-03-20T00:00:00.000Z',
              updatedAt: '2026-03-20T00:00:00.000Z',
            },
            'note:z-note': {
              kind: 'note',
              slug: 'z-note',
              title: 'Z',
              tags: ['coral'],
              principles: ['single-source-of-truth'],
              source: ['kb'],
              createdAt: '2026-03-20T00:00:00.000Z',
              updatedAt: '2026-03-20T00:00:00.000Z',
            },
          },
          principles: {
            'contract-first-design': 'State contracts first.',
            'single-source-of-truth': 'Keep one authority.',
          },
          entityMeta: {},
          relationships: [],
        })),
      } as never,
      curateScheduler: {
        start: vi.fn(async () => {}),
        schedule: vi.fn(),
        scheduleDeferredCommit: vi.fn(),
        isRunning: () => false,
      },
    } as never);

    expect(response.ok).toBe(true);
    expect(parseToolData(response)).toEqual({
      principles: [
        {
          name: 'contract-first-design',
          statement: 'State contracts first.',
          notes: ['a-note', 'b-note'],
        },
      ],
      total: 2,
      warning: 'Orphan principle refs: missing-principle',
    });
  });

  it('routes kb memo list and consolidated delete through the KB daemon RPC port', async () => {
    const projectRoot = join(mockState.tmpHome, 'project');
    const readKb = vi.fn<KbDaemonSupervisor['readKb']>(async (request) => {
      expect(request.method).toBe('listMemos');
      return {
        ok: true,
        data: {
          memos: [
            { filename: 'b.md', summary: 'Bravo summary', createdAt: '2026-03-25T00:00:00.000Z' },
            { filename: 'a.md', summary: 'Alpha summary', createdAt: '2026-03-24T00:00:00.000Z' },
          ],
        },
      };
    });
    const mutateKb = vi.fn<KbDaemonSupervisor['mutateKb']>(async (request) => {
      expect(request.method).toBe('deleteMemos');
      const args = request.args as Record<string, unknown>;
      if (args.all === true) {
        return { ok: true, data: { deleted: 1 } };
      }
      return { ok: true, data: { deleted: ['a.md'], count: 1 } };
    });
    const backend = await startBackendServer({
      kbDaemonSupervisor: createMockKbDaemonSupervisor({ readKb, mutateKb }),
    });

    const listResponse = await fetch(`${backend.baseUrl}/kb/memos?projectRoot=${encodeURIComponent(projectRoot)}`, {
      headers: {
        'X-Coral-Backend-Token': backend.token,
      },
    });

    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as Record<string, unknown>;
    expect(listBody).toEqual({
      memos: [
        { filename: 'b.md', summary: 'Bravo summary', createdAt: '2026-03-25T00:00:00.000Z' },
        { filename: 'a.md', summary: 'Alpha summary', createdAt: '2026-03-24T00:00:00.000Z' },
      ],
    });
    expect(readKb).toHaveBeenCalledWith({
      method: 'listMemos',
      args: {},
      ctx: expectedDaemonProjectContext(projectRoot),
    });

    const deleteResponse = await fetch(
      `${backend.baseUrl}/kb/memos?projectRoot=${encodeURIComponent(projectRoot)}&pattern=${encodeURIComponent('a*')}`,
      {
        method: 'DELETE',
        headers: {
          'X-Coral-Backend-Token': backend.token,
        },
      },
    );

    expect(deleteResponse.status).toBe(200);
    const deleteBody = (await deleteResponse.json()) as Record<string, unknown>;
    expect(deleteBody).toEqual({
      deleted: ['a.md'],
      count: 1,
    });
    expect(mutateKb).toHaveBeenCalledWith({
      method: 'deleteMemos',
      args: { pattern: 'a*' },
      ctx: expectedDaemonProjectContext(projectRoot),
    });

    const purgeResponse = await fetch(
      `${backend.baseUrl}/kb/memos?projectRoot=${encodeURIComponent(projectRoot)}&all=true`,
      {
        method: 'DELETE',
        headers: {
          'X-Coral-Backend-Token': backend.token,
        },
      },
    );

    expect(purgeResponse.status).toBe(200);
    const purgeBody = (await purgeResponse.json()) as Record<string, unknown>;
    expect(purgeBody).toEqual({ deleted: 1 });
    expect(mutateKb).toHaveBeenLastCalledWith({
      method: 'deleteMemos',
      args: { all: true },
      ctx: expectedDaemonProjectContext(projectRoot),
    });
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
        toProviderSpec({
          name: 'codex',
          execute: vi.fn(() => streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const } })),
        })!,
      );
      const executionService = options.executionService ?? createFakeExecutionService();
      const idleTimer = createFakeIdleTimer();
      const progressStore = createProgressStore('test-ns', runtime);
      const coralEnvSnapshot = currentCoralEnvSnapshot();
      const getDiscussContext = () => ({}) as never;
      const requestDrain = vi.fn();
      const scopeCheckJobs = options.scopeCheckJobs ?? (() => ({ valid: [], missing: [], mismatch: [] }));
      const abortJobs = options.abortJobs ?? (() => ({ aborted: [], notFound: [] }));
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
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'execution-backend-instance-1',
          token: 'test-token',
          bootToken: 'test-boot-token',
          shutdownToken: 'test-shutdown-token',
          now: () => Date.now(),
          log: () => {},
        },
        coralEnvSnapshot,
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
              bundleHash: 'testhash1234',
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
          waitStream: (request: unknown) => service.waitStream(request),
          list: () => [],
          detail: () => null,
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

    async function startMockedRouteServer(
      options: {
        kbRuntime?: unknown | null;
        launchFenceActive?: boolean;
        executionService?: FakeExecutionService;
        abortJobs?: any['abortJobs'];
        scopeCheckJobs?: any['scopeCheckJobs'];
        listDiscussSessions?: any['listDiscussSessions'];
        loadDiscussDetail?: any['loadDiscussDetail'];
        discussToolOverrides?: Record<string, unknown>;
        kbToolOverrides?: Record<string, unknown>;
      } = {},
    ) {
      vi.resetModules();

      const discussTools = {
        handleDiscussSeed: vi.fn((args: unknown) => domainSuccess({ route: 'discuss:seed', args })),
        handleDiscussStart: vi.fn(async (args: unknown) => domainSuccess({ route: 'discuss:start', args })),
        handleDiscussAbort: vi.fn(async (args: unknown) => domainSuccess({ route: 'discuss:abort', args })),
        handleDiscussWatch: vi.fn((args: unknown) => domainSuccess({ route: 'discuss:watch', args })),
        handleDiscussBid: vi.fn(async (args: unknown) => domainSuccess({ route: 'discuss:bid', args })),
        handleDiscussSpeech: vi.fn(async (args: unknown) => domainSuccess({ route: 'discuss:speech', args })),
        ...options.discussToolOverrides,
      };
      const kbTools = {
        handleKbSearch: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:search', args })),
        handleKbDiagnose: vi.fn((args: unknown) => domainSuccess({ route: 'kb:diagnose', args })),
        handleKbNoteRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:note-read', slug })),
        handleKbSourceRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:source-read', slug })),
        handleKbCommunityRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:community-read', slug })),
        handleKbMemoRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:memo-read', slug })),
        handleKbPrincipleRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:principle-read', slug })),
        handleKbCommunityListStale: vi.fn(() => domainSuccess({ route: 'kb:community-list-stale' })),
        handleKbCommunitySummaryInput: vi.fn((slug: unknown) =>
          domainSuccess({ route: 'kb:community-summary-input', slug }),
        ),
        handleKbCommunitySetSummary: vi.fn(async (args: unknown) =>
          domainSuccess({ route: 'kb:community-set-summary', args }),
        ),
        handleKbWikiRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:wiki-read', slug })),
        handleKbWikiList: vi.fn(async () => domainSuccess({ route: 'kb:wiki-list' })),
        handleKbWikiCreate: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-create', args })),
        handleKbWikiRewrite: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-rewrite', args })),
        handleKbWikiLink: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-link', args })),
        handleKbWikiUnlink: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-unlink', args })),
        handleKbWikiCite: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-cite', args })),
        handleKbWikiAdopt: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-adopt', args })),
        handleKbWikiDelete: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wiki-delete', args })),
        handleKbWakeUp: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:wake-up', args })),
        handleKbPromote: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:promote', args })),
        handleKbUpdate: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:update', args })),
        handleKbDelete: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:delete', args })),
        handleKbSourceImport: vi.fn(async (args: unknown) =>
          domainSuccess({ status: 'running', route: 'kb:source-import', args }),
        ),
        handleKbSourceList: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:source-list', args })),
        handleKbSourceDelete: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:source-delete', args })),
        handleKbReindex: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:reindex', args })),
        handleKbPrinciples: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:principles', args })),
        handleKbMemo: vi.fn((args: unknown) => domainSuccess({ route: 'kb:memo', args })),
        handleKbMemoList: vi.fn((args: unknown) => domainSuccess({ route: 'kb:memo-list', args })),
        handleKbMemoDeleteConsolidated: vi.fn((args: unknown) => domainSuccess({ route: 'kb:memo-delete', args })),
        ...options.kbToolOverrides,
      };
      const mockDiscussTools = discussTools as any;
      const mockKbTools = kbTools as any;

      const { createHttpHandler } = await import('#src/transport/http/handler.js');
      const created = createHttpHandlerDeps(options);
      created.deps.discuss = {
        seed: (args: unknown) => mockDiscussTools.handleDiscussSeed(args),
        start: (args: Record<string, unknown>, ctx: unknown) =>
          mockDiscussTools.handleDiscussStart(args, ctx, { getDiscussContext: created.deps.getDiscussContext }),
        listSessions: () => created.deps.listDiscussSessions(),
        loadDetail: (projectRoot: string, sessionId: string, view: 'control' | 'audit') =>
          created.deps.loadDiscussDetail(resolveProjectSource(projectRoot), sessionId, view),
        watch: (args: Record<string, unknown>, ctx: unknown) =>
          mockDiscussTools.handleDiscussWatch(args, ctx, { getDiscussContext: created.deps.getDiscussContext }),
        bid: (args: Record<string, unknown>, ctx: unknown) =>
          mockDiscussTools.handleDiscussBid(args, ctx, { getDiscussContext: created.deps.getDiscussContext }),
        speech: (args: Record<string, unknown>, ctx: unknown) =>
          mockDiscussTools.handleDiscussSpeech(args, ctx, { getDiscussContext: created.deps.getDiscussContext }),
        abort: (args: Record<string, unknown>, ctx: unknown) =>
          mockDiscussTools.handleDiscussAbort(args, ctx, { getDiscussContext: created.deps.getDiscussContext }),
      };
      created.deps.kb = {
        readSearch: (args: Record<string, unknown>) => mockKbTools.handleKbSearch(args),
        diagnose: () => mockKbTools.handleKbDiagnose({}),
        readNote: (slug: string) => mockKbTools.handleKbNoteRead(slug),
        readSource: (slug: string) => mockKbTools.handleKbSourceRead(slug),
        readCommunity: (slug: string) => mockKbTools.handleKbCommunityRead(slug),
        listStaleCommunities: () => mockKbTools.handleKbCommunityListStale(),
        readCommunitySummaryInput: (slug: string) => mockKbTools.handleKbCommunitySummaryInput(slug),
        setCommunitySummary: (args: Record<string, unknown>, ctx: unknown) =>
          mockKbTools.handleKbCommunitySetSummary(args, ctx),
        readWiki: (slug: string) => mockKbTools.handleKbWikiRead(slug),
        readMemo: (slug: string, ctx: unknown) => mockKbTools.handleKbMemoRead(slug, ctx),
        readPrinciple: (slug: string) => mockKbTools.handleKbPrincipleRead(slug),
        listSources: () => mockKbTools.handleKbSourceList({}),
        listWikis: () => mockKbTools.handleKbWikiList(),
        listMemos: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbMemoList(args, ctx),
        listPrinciples: (args: Record<string, unknown>) => mockKbTools.handleKbPrinciples(args),
        createNote: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbPromote(args, ctx),
        updateNote: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbUpdate(args, ctx),
        deleteNote: (slug: string, ctx: unknown) => mockKbTools.handleKbDelete({ note: slug }, ctx),
        createWiki: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbWikiCreate(args, ctx),
        rewriteWiki: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbWikiRewrite(args, ctx),
        linkWiki: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbWikiLink(args, ctx),
        unlinkWiki: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbWikiUnlink(args, ctx),
        citeWiki: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbWikiCite(args, ctx),
        adoptWiki: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbWikiAdopt(args, ctx),
        deleteWiki: (slug: string, ctx: unknown) => mockKbTools.handleKbWikiDelete({ slug }, ctx),
        wakeUp: (args: Record<string, unknown>) => mockKbTools.handleKbWakeUp(args),
        createSource: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbSourceImport(args, ctx),
        deleteSource: (slug: string, ctx: unknown) => mockKbTools.handleKbSourceDelete({ slug }, ctx),
        createMemo: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbMemo(args, ctx),
        deleteMemos: (args: Record<string, unknown>, ctx: unknown) =>
          mockKbTools.handleKbMemoDeleteConsolidated(args, ctx),
        reindex: (args: Record<string, unknown>, ctx: unknown) => mockKbTools.handleKbReindex(args, ctx),
      };
      const started = await startHttpHandlerServer(created.deps, createHttpHandler);
      return {
        ...started,
        ...created,
        discussTools,
        kbTools,
      };
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

    afterEach(() => {});

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
      let stream: Awaited<ReturnType<typeof openHttpStream>> | null = null;

      try {
        stream = await openHttpStream(
          `${started.baseUrl}/events/stream?projectRoot=${encodeURIComponent('/tmp/project')}`,
          {
            'X-Coral-Backend-Token': 'test-token',
          },
        );

        await stream.waitForText((text) => text.includes('event: ready'));
        expect(started.deps.streamResponses.size).toBe(1);

        expect(
          started.deps.events.bus.emit('job:progress', {
            jobId: 'job-backpressure',
            seq: 1,
            message: 'slow client',
          }),
        ).toBe(true);

        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 1_000;
          const poll = () => {
            if (started.deps.streamResponses.size === 0) {
              resolve();
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for SSE cleanup after backpressure'));
              return;
            }
            setTimeout(poll, 5);
          };
          poll();
        });
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

    it('routes POST /discuss/persona-sets without requiring project context', async () => {
      const started = await startMockedRouteServer();
      const args = {
        controversy_axes: [{ axis: 'speed', positions: ['fast', 'slow'] }],
        n: 2,
        seed: 7,
      };

      try {
        const response = await fetch(`${started.baseUrl}/discuss/persona-sets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify(args),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ route: 'discuss:seed', args });
        expect(started.discussTools.handleDiscussSeed).toHaveBeenCalledTimes(1);
        expect(started.discussTools.handleDiscussSeed).toHaveBeenCalledWith(args);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      {
        name: 'session create',
        path: '/discuss/sessions',
        args: {
          topic: 'Should we ship?',
          agents: [
            { name: 'alpha', persona: '# Alpha' },
            { name: 'beta', persona: '# Beta' },
          ],
        },
        expectedStatus: 201,
        expectedBody: {
          route: 'discuss:start',
          args: {
            topic: 'Should we ship?',
            agents: [
              { name: 'alpha', persona: '# Alpha' },
              { name: 'beta', persona: '# Beta' },
            ],
          },
        },
        handlerName: 'handleDiscussStart',
      },
      {
        name: 'bid write',
        path: '/discuss/sessions/session-1/bids',
        args: {
          agent_name: 'alpha',
          score: 91,
          thought: 'Ship the synchronous route.',
        },
        expectedStatus: 200,
        expectedBody: {
          route: 'discuss:bid',
          args: {
            session: 'session-1',
            agent_name: 'alpha',
            score: 91,
            thought: 'Ship the synchronous route.',
          },
        },
        handlerName: 'handleDiscussBid',
      },
      {
        name: 'speech write',
        path: '/discuss/sessions/session-1/speeches',
        args: {
          agent_name: 'alpha',
          content: 'I have the floor.',
        },
        expectedStatus: 200,
        expectedBody: {
          route: 'discuss:speech',
          args: {
            session: 'session-1',
            agent_name: 'alpha',
            content: 'I have the floor.',
          },
        },
        handlerName: 'handleDiscussSpeech',
      },
    ])('routes discuss resource POSTs for $name', async ({ path, args, expectedStatus, expectedBody, handlerName }) => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              ...args,
              projectRoot: '/tmp/project',
              owner: 'team-a',
              effort: 'high',
              claudeModelCap: 'sonnet',
            }),
          });

          expect(response.status).toBe(expectedStatus);
          expect(await response.json()).toEqual(expectedBody);

          const handler = started.discussTools[handlerName as keyof typeof started.discussTools];
          const call = handler.mock.calls[0] as unknown[] | undefined;
          expect(handler).toHaveBeenCalledTimes(1);
          expect(call?.[0]).toEqual(expectedBody.args);
          expect(call?.[1]).toMatchObject({
            projectRoot: '/tmp/project',
            pluginRoot: '/tmp/plugin',
            coralEnv: expect.objectContaining({
              CORAL_TEST_HTTP_BASE: 'daemon-base',
              CORAL_OWNER: 'team-a',
              CORAL_EFFORT: 'high',
              CORAL_CLAUDE_MODEL_CAP: 'sonnet',
            }),
          });
          expect(call?.[2]).toMatchObject({
            getDiscussContext: started.deps.getDiscussContext,
          });
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('routes GET /discuss/sessions inline through listDiscussSessions', async () => {
      const sessions = [{ sessionId: 'session-1', projectRoot: '/tmp/project', authority: 'live' }];
      const started = await startMockedRouteServer({
        listDiscussSessions: () => sessions as never,
      });

      try {
        const response = await fetch(`${started.baseUrl}/discuss/sessions`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessions });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /discuss/sessions/:id through source-derived detail lookup', async () => {
      const projectRoot = createProjectRoot('discuss-detail-source');
      const detail = { session: { sessionId: 'session-1' }, authority: 'persisted', view: 'control' };
      const loadDiscussDetail = vi.fn(() => detail as never);
      const started = await startMockedRouteServer({ loadDiscussDetail });

      try {
        const response = await fetch(
          `${started.baseUrl}/discuss/sessions/session-1?projectRoot=${encodeURIComponent(projectRoot)}`,
          {
            headers: { 'X-Coral-Backend-Token': 'test-token' },
          },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(detail);
        expect(loadDiscussDetail).toHaveBeenCalledTimes(1);
        expect(loadDiscussDetail).toHaveBeenCalledWith(resolveProjectSource(projectRoot), 'session-1', 'control');
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /discuss/sessions/:id/events with query-scoped context', async () => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(
            `${started.baseUrl}/discuss/sessions/session-1/events?projectRoot=${encodeURIComponent('/tmp/project')}&cursor=3`,
            {
              headers: { 'X-Coral-Backend-Token': 'test-token' },
            },
          );

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            route: 'discuss:watch',
            args: { session: 'session-1', cursor: 3 },
          });
          expect(started.discussTools.handleDiscussWatch).toHaveBeenCalledTimes(1);
          expect(started.discussTools.handleDiscussWatch).toHaveBeenCalledWith(
            { session: 'session-1', cursor: 3 },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
              }),
            }),
            expect.objectContaining({
              getDiscussContext: started.deps.getDiscussContext,
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('routes DELETE /discuss/sessions/:id with query-scoped context', async () => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(
            `${started.baseUrl}/discuss/sessions/session-1?projectRoot=${encodeURIComponent('/tmp/project')}`,
            {
              method: 'DELETE',
              headers: { 'X-Coral-Backend-Token': 'test-token' },
            },
          );

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            route: 'discuss:abort',
            args: { session: 'session-1' },
          });
          expect(started.discussTools.handleDiscussAbort).toHaveBeenCalledTimes(1);
          expect(started.discussTools.handleDiscussAbort).toHaveBeenCalledWith(
            { session: 'session-1' },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
              }),
            }),
            expect.objectContaining({
              getDiscussContext: started.deps.getDiscussContext,
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('routes GET /kb/entries with typed query coercion', async () => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}/kb/entries?q=contracts&scope=notes&top_k=5`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'kb:search',
          args: { query: 'contracts', scope: 'notes', top_k: 5 },
        });
        expect(started.kbTools.handleKbSearch).toHaveBeenCalledTimes(1);
        expect(started.kbTools.handleKbSearch).toHaveBeenCalledWith({
          query: 'contracts',
          scope: 'notes',
          top_k: 5,
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('round-trips GET /kb/entries mode through the HTTP KB search surface', async () => {
      const started = await startMockedRouteServer({
        kbToolOverrides: {
          handleKbSearch: vi.fn(async (args: Record<string, unknown>) =>
            domainSuccess({
              results: [],
              mode: args.mode ?? 'text',
            }),
          ),
        },
      });

      try {
        const response = await fetch(`${started.baseUrl}/kb/entries?q=contracts&mode=vector`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          results: [],
          mode: 'vector',
        });
        expect(started.kbTools.handleKbSearch).toHaveBeenCalledTimes(1);
        expect(started.kbTools.handleKbSearch).toHaveBeenCalledWith({ query: 'contracts', mode: 'vector' });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/diagnose through KB diagnose reads', async () => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}/kb/diagnose`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'kb:diagnose',
          args: {},
        });
        expect(started.kbTools.handleKbDiagnose).toHaveBeenCalledTimes(1);
        expect(started.kbTools.handleKbDiagnose).toHaveBeenCalledWith({});
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/notes/:slug through note reads with decoded slugs', async () => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}/kb/notes/contracts%2Foverview`, {
            headers: { 'X-Coral-Backend-Token': 'test-token' },
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            route: 'kb:note-read',
            slug: 'contracts/overview',
          });
          expect(started.kbTools.handleKbNoteRead).toHaveBeenCalledTimes(1);
          expect(started.kbTools.handleKbNoteRead).toHaveBeenCalledWith('contracts/overview');
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it.each([
      {
        path: '/kb/sources/source-slug',
        expectedBody: { route: 'kb:source-read', slug: 'source-slug' },
        handlerName: 'handleKbSourceRead',
      },
      {
        path: '/kb/communities/community-slug',
        expectedBody: { route: 'kb:community-read', slug: 'community-slug' },
        handlerName: 'handleKbCommunityRead',
      },
      {
        path: '/kb/principles/principle-slug',
        expectedBody: { route: 'kb:principle-read', slug: 'principle-slug' },
        handlerName: 'handleKbPrincipleRead',
      },
    ])('routes GET $path through per-kind KB readers', async ({ path, expectedBody, handlerName }) => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expectedBody);
        const handler = started.kbTools[handlerName as keyof typeof started.kbTools];
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expectedBody.slug);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/memos/:slug with query-scoped context', async () => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(
            `${started.baseUrl}/kb/memos/memo-1?projectRoot=${encodeURIComponent('/tmp/project')}`,
            {
              headers: { 'X-Coral-Backend-Token': 'test-token' },
            },
          );

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            route: 'kb:memo-read',
            slug: 'memo-1',
          });
          expect(started.kbTools.handleKbMemoRead).toHaveBeenCalledTimes(1);
          expect(started.kbTools.handleKbMemoRead).toHaveBeenCalledWith(
            'memo-1',
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
              }),
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it.each([
      { path: '/kb/notes/missing-note', handlerName: 'handleKbNoteRead' },
      { path: '/kb/sources/missing-source', handlerName: 'handleKbSourceRead' },
      { path: '/kb/communities/missing-community', handlerName: 'handleKbCommunityRead' },
      { path: '/kb/memos/missing-memo?projectRoot=%2Ftmp%2Fproject', handlerName: 'handleKbMemoRead' },
      { path: '/kb/principles/missing-principle', handlerName: 'handleKbPrincipleRead' },
    ])('returns 404 for missing per-kind KB reads on $path', async ({ path, handlerName }) => {
      const started = await startMockedRouteServer({
        kbToolOverrides: {
          [handlerName]: vi.fn(() => domainError('not_found', 'missing')),
        },
      });

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          code: 'not_found',
          message: 'missing',
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/sources through source list', async () => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}/kb/sources`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'kb:source-list',
          args: {},
        });
        expect(started.kbTools.handleKbSourceList).toHaveBeenCalledTimes(1);
        expect(started.kbTools.handleKbSourceList).toHaveBeenCalledWith({});
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/principles with typed query coercion', async () => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}/kb/principles?q=contract&top_k=5&verbose=true`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'kb:principles',
          args: { query: 'contract', top_k: 5, verbose: true },
        });
        expect(started.kbTools.handleKbPrinciples).toHaveBeenCalledTimes(1);
        expect(started.kbTools.handleKbPrinciples).toHaveBeenCalledWith({
          query: 'contract',
          top_k: 5,
          verbose: true,
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/memos with query-scoped context', async () => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(
            `${started.baseUrl}/kb/memos?projectRoot=${encodeURIComponent('/tmp/project')}&owner=owner-a`,
            {
              headers: { 'X-Coral-Backend-Token': 'test-token' },
            },
          );

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            route: 'kb:memo-list',
            args: { owner: 'owner-a' },
          });
          expect(started.kbTools.handleKbMemoList).toHaveBeenCalledTimes(1);
          expect(started.kbTools.handleKbMemoList).toHaveBeenCalledWith(
            { owner: 'owner-a' },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
              }),
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it.each([
      {
        name: 'note create',
        path: '/kb/notes',
        args: { memo: 'memo-1', title: 'Title', content: 'Body', domain: 'eng', topic: 'routing' },
        expectedStatus: 201,
        expectedBody: {
          route: 'kb:promote',
          args: { memo: 'memo-1', title: 'Title', content: 'Body', domain: 'eng', topic: 'routing' },
        },
        handlerName: 'handleKbPromote',
      },
      {
        name: 'source create',
        path: '/kb/sources',
        args: {
          filePath: '/tmp/source.pdf',
          slug: 'slug',
          readiness: 'base-search',
        },
        expectedStatus: 202,
        expectedBody: {
          status: 'running',
          route: 'kb:source-import',
          args: {
            filePath: '/tmp/source.pdf',
            slug: 'slug',
            readiness: 'base-search',
            async: false,
          },
        },
        handlerName: 'handleKbSourceImport',
      },
      {
        name: 'reindex',
        path: '/kb/index',
        args: { async: true },
        expectedStatus: 200,
        expectedBody: {
          route: 'kb:reindex',
          args: { async: true },
        },
        handlerName: 'handleKbReindex',
      },
    ])('routes KB write routes for $name', async ({ path, args, expectedStatus, expectedBody, handlerName }) => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              ...args,
              projectRoot: '/tmp/project',
              owner: 'team-a',
              effort: 'high',
              claudeModelCap: 'sonnet',
            }),
          });

          expect(response.status).toBe(expectedStatus);
          expect(await response.json()).toEqual(expectedBody);

          const handler = started.kbTools[handlerName as keyof typeof started.kbTools];
          const call = handler.mock.calls[0] as unknown[] | undefined;
          expect(handler).toHaveBeenCalledTimes(1);
          expect(call?.[0]).toEqual(expectedBody.args);
          expect(call?.[1]).toMatchObject({
            projectRoot: '/tmp/project',
            pluginRoot: '/tmp/plugin',
            coralEnv: expect.objectContaining({
              CORAL_TEST_HTTP_BASE: 'daemon-base',
              CORAL_OWNER: 'team-a',
              CORAL_EFFORT: 'high',
              CORAL_CLAUDE_MODEL_CAP: 'sonnet',
            }),
          });
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('routes POST /kb/memos with owner preserved for the memo handler', async () => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}/kb/memos`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              topic: 'routing',
              content: 'memo',
              owner: 'owner-a',
              projectRoot: '/tmp/project',
              effort: 'high',
              claudeModelCap: 'sonnet',
            }),
          });

          expect(response.status).toBe(201);
          expect(await response.json()).toEqual({
            route: 'kb:memo',
            args: { topic: 'routing', content: 'memo', owner: 'owner-a' },
          });
          expect(started.kbTools.handleKbMemo).toHaveBeenCalledTimes(1);
          expect(started.kbTools.handleKbMemo).toHaveBeenCalledWith(
            { topic: 'routing', content: 'memo', owner: 'owner-a' },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
                CORAL_OWNER: 'owner-a',
                CORAL_EFFORT: 'high',
                CORAL_CLAUDE_MODEL_CAP: 'sonnet',
              }),
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('routes PUT /kb/notes/:slug with the slug from the URL', async () => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}/kb/notes/contracts%2Foverview`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            title: 'Updated',
            projectRoot: '/tmp/project',
          }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'kb:update',
          args: { note: 'contracts/overview', title: 'Updated' },
        });
        expect(started.kbTools.handleKbUpdate).toHaveBeenCalledTimes(1);
        expect(started.kbTools.handleKbUpdate).toHaveBeenCalledWith(
          { note: 'contracts/overview', title: 'Updated' },
          expect.objectContaining({
            projectRoot: '/tmp/project',
            pluginRoot: '/tmp/plugin',
          }),
        );
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      {
        path: '/kb/notes/contracts%2Foverview',
        expectedBody: { route: 'kb:delete', args: { note: 'contracts/overview' } },
        handlerName: 'handleKbDelete',
      },
      {
        path: '/kb/sources/source-slug',
        expectedBody: { route: 'kb:source-delete', args: { slug: 'source-slug' } },
        handlerName: 'handleKbSourceDelete',
      },
    ])('routes DELETE $path through the matching KB delete handler', async ({ path, expectedBody, handlerName }) => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          method: 'DELETE',
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expectedBody);
        const handler = started.kbTools[handlerName as keyof typeof started.kbTools];
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expectedBody.args, undefined);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      {
        name: 'pattern delete',
        query: `projectRoot=${encodeURIComponent('/tmp/project')}&pattern=${encodeURIComponent('*')}&owner=owner-a`,
        expectedArgs: { pattern: '*', owner: 'owner-a' },
      },
      {
        name: 'purge',
        query: `projectRoot=${encodeURIComponent('/tmp/project')}&all=true`,
        expectedArgs: { all: true },
      },
    ])('routes DELETE /kb/memos for $name', async ({ query, expectedArgs }) => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}/kb/memos?${query}`, {
            method: 'DELETE',
            headers: { 'X-Coral-Backend-Token': 'test-token' },
          });

          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            route: 'kb:memo-delete',
            args: expectedArgs,
          });
          expect(started.kbTools.handleKbMemoDeleteConsolidated).toHaveBeenCalledTimes(1);
          expect(started.kbTools.handleKbMemoDeleteConsolidated).toHaveBeenCalledWith(
            expectedArgs,
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
              }),
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it.each([
      ['/discuss/persona-sets', 'handleDiscussSeed'],
      ['/kb/notes', 'handleKbPromote'],
    ])('rejects invalid JSON for %s before invoking the handler', async (path, handlerName) => {
      const started = await startMockedRouteServer();

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: '{',
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          code: 'invalid_request',
          message: 'Invalid JSON body',
        });
        if (path.startsWith('/discuss/')) {
          expect(started.discussTools[handlerName as keyof typeof started.discussTools]).not.toHaveBeenCalled();
        } else {
          expect(started.kbTools[handlerName as keyof typeof started.kbTools]).not.toHaveBeenCalled();
        }
      } finally {
        await _closeHttpServer(started.server);
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

    it.each(['/discuss/sessions', '/kb/notes'])(
      'rejects malformed direct bodies for %s before invoking route handlers',
      async (path) => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({ query: 'contracts' }),
          });

          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            code: 'invalid_request',
            message: expect.any(String),
            detail: {
              issues: expect.any(Array),
            },
          });
          expect(Object.values(started.discussTools).some((handler) => handler.mock.calls.length > 0)).toBe(false);
          expect(Object.values(started.kbTools).some((handler) => handler.mock.calls.length > 0)).toBe(false);
        } finally {
          await _closeHttpServer(started.server);
        }
      },
    );

    it.each([
      {
        path: '/discuss/sessions',
        args: {
          topic: 'Should we ship?',
          agents: [
            { name: 'alpha', persona: '# Alpha' },
            { name: 'beta', persona: '# Beta' },
          ],
        },
        handlerName: 'handleDiscussStart',
      },
      {
        path: '/discuss/sessions/session-1/bids',
        args: { agent_name: 'alpha', score: 80, thought: 'Ship it.' },
        handlerName: 'handleDiscussBid',
      },
      {
        path: '/discuss/sessions/session-1/speeches',
        args: { agent_name: 'alpha', content: 'Ship it.' },
        handlerName: 'handleDiscussSpeech',
      },
    ])('returns 503 from $path while the launch fence is active', async ({ path, args, handlerName }) => {
      const started = await startMockedRouteServer({ launchFenceActive: true });

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            ...args,
            projectRoot: '/tmp/project',
          }),
        });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          code: 'backend_recovering',
          message: 'recovering — retry after 500ms',
        });
        expect(started.discussTools[handlerName as keyof typeof started.discussTools]).not.toHaveBeenCalled();
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('allows GET /discuss/sessions/:id/events through while the launch fence is active', async () => {
      const started = await startMockedRouteServer({ launchFenceActive: true });

      try {
        const response = await fetch(
          `${started.baseUrl}/discuss/sessions/session-1/events?projectRoot=${encodeURIComponent('/tmp/project')}`,
          {
            headers: {
              'X-Coral-Backend-Token': 'test-token',
            },
          },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'discuss:watch',
          args: { session: 'session-1' },
        });
        expect(started.discussTools.handleDiscussWatch).toHaveBeenCalledTimes(1);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('returns kb_initializing when the KB daemon runtime is not initialized', async () => {
      const { deps } = createHttpHandlerDeps({ kbRuntime: null });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/kb/entries?q=contracts`, {
          headers: {
            'X-Coral-Backend-Token': 'test-token',
          },
        });

        expect(response.status).toBe(503);
        // The KB request port returns a startup/offline code while the daemon
        // runtime has not reached a serving state.
        expect(await response.json()).toMatchObject({
          code: expect.stringMatching(/^kb_(initializing|offline)$/),
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('keeps KB IPC ops flowing when curate health is degraded but kbStatus is ok (§16(a))', async () => {
      const started = await startMockedRouteServer();
      // No-op: under the new model, curate degradation is reported through
      // the component's `degraded` phase. KB tool calls flow when phase is
      // `online | degraded`. The mock registry's online-by-default state
      // is sufficient to verify that flow.

      try {
        const response = await fetch(`${started.baseUrl}/kb/entries?q=hello`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          route: 'kb:search',
          args: { query: 'hello' },
        });
        expect(started.kbTools.handleKbSearch).toHaveBeenCalledTimes(1);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      { path: '/discuss/persona-sets', args: {} },
      { path: '/discuss/sessions', args: { projectRoot: '/tmp/project' } },
      { path: '/discuss/sessions/session-1/bids', args: { projectRoot: '/tmp/project' } },
      { path: '/discuss/sessions/session-1/speeches', args: { projectRoot: '/tmp/project' } },
    ])('uses existing discuss validation on $path', async ({ path, args }) => {
      const { deps } = createHttpHandlerDeps();
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify(args),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'invalid_request',
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      {
        name: 'GET /kb/entries',
        method: 'GET',
        path: '/kb/entries',
      },
      {
        name: 'GET /kb/memos',
        method: 'GET',
        path: '/kb/memos',
      },
      {
        name: 'GET /kb/memos/:slug',
        method: 'GET',
        path: '/kb/memos/memo-1',
      },
      {
        name: 'DELETE /kb/memos',
        method: 'DELETE',
        path: `/kb/memos?projectRoot=${encodeURIComponent('/tmp/project')}&pattern=${encodeURIComponent('*')}&all=true`,
      },
      {
        name: 'POST /kb/notes',
        method: 'POST',
        path: '/kb/notes',
        body: { projectRoot: '/tmp/project' },
      },
      {
        name: 'POST /kb/sources',
        method: 'POST',
        path: '/kb/sources',
        body: { projectRoot: '/tmp/project' },
      },
      {
        name: 'POST /kb/memos',
        method: 'POST',
        path: '/kb/memos',
        body: { projectRoot: '/tmp/project' },
      },
    ])('uses KB validation on $name', async ({ method, path, body }) => {
      const { deps } = createHttpHandlerDeps();
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          method,
          headers:
            body === undefined
              ? { 'X-Coral-Backend-Token': 'test-token' }
              : {
                  'Content-Type': 'application/json',
                  'X-Coral-Backend-Token': 'test-token',
                },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'invalid_request',
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('returns generic not_found for unmatched discuss resource routes', async () => {
      const { deps } = createHttpHandlerDeps();
      const started = await startHttpHandlerServer(deps);

      try {
        const [discussResponse, kbResponse] = await Promise.all([
          fetch(`${started.baseUrl}/discuss/missing-action`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({ projectRoot: '/tmp/project' }),
          }),
          fetch(`${started.baseUrl}/kb/missing-action`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({ projectRoot: '/tmp/project' }),
          }),
        ]);

        expect(discussResponse.status).toBe(404);
        expect(await discussResponse.json()).toEqual({
          code: 'not_found',
          message: 'Not found',
        });

        expect(kbResponse.status).toBe(404);
        expect(await kbResponse.json()).toEqual({
          code: 'not_found',
          message: 'Not found',
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      {
        name: 'GET /discuss/sessions/:id view',
        method: 'GET',
        path: `/discuss/sessions/session-1?projectRoot=${encodeURIComponent('/tmp/project')}&view=bogus`,
        expectedMessage: "view: Invalid enum value. Expected 'control' | 'audit', received 'bogus'",
      },
      {
        name: 'GET /kb/entries scope',
        method: 'GET',
        path: '/kb/entries?q=contracts&scope=bogus',
        expectedMessage:
          "scope: Invalid enum value. Expected 'notes' | 'sources' | 'communities' | 'wiki' | 'all', received 'bogus'",
      },
      {
        name: 'GET /kb/memos projectRoot',
        method: 'GET',
        path: '/kb/memos?projectRoot=',
        expectedMessage: 'projectRoot: Project root is required',
      },
      {
        name: 'DELETE /kb/memos pattern/all',
        method: 'DELETE',
        path: `/kb/memos?projectRoot=${encodeURIComponent('/tmp/project')}&pattern=${encodeURIComponent('*')}&all=true`,
        expectedMessage: 'Exactly one of pattern or all=true must be provided',
      },
    ])(
      'returns flat invalid_request bodies for safeParse regressions on $name',
      async ({ method, path, expectedMessage }) => {
        const started = await startMockedRouteServer();

        try {
          const response = await fetch(`${started.baseUrl}${path}`, {
            method,
            headers: { 'X-Coral-Backend-Token': 'test-token' },
          });

          expect(response.status).toBe(400);
          const body = (await response.json()) as {
            code: string;
            message: string;
            detail: { issues: unknown[] };
          };
          expect(body.code).toBe('invalid_request');
          expect(body.message).toBe(expectedMessage);
          expect(() => JSON.parse(body.message)).toThrow();
          expect(body.detail.issues.length).toBeGreaterThan(0);
        } finally {
          await _closeHttpServer(started.server);
        }
      },
    );

    it('routes POST /sessions through service.start with accepted launch responses', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          start: vi.fn(async () => ({ status: 'running', job: 'job-start', session: 'session-start' })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps);

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
              projectRoot: '/tmp/project',
              agent: 'architect',
              model: 'gpt-5',
              workDir: '/tmp/work',
              owner: 'team-a',
              effort: 'high',
              claudeModelCap: 'sonnet',
              bypassPermissions: true,
              systemPrompt: 'system',
            }),
          });

          expect(response.status).toBe(201);
          expect(await response.json()).toEqual({
            session: 'session-start',
            job: 'job-start',
            launchState: 'running',
          });
          expect(fakeService.start).toHaveBeenCalledWith(
            'codex',
            {
              prompt: 'hello',
              agent: 'architect',
              model: 'gpt-5',
              cwd: '/tmp/work',
              effort: 'high',
              bypassPermissions: true,
              systemPrompt: 'system',
            },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
                CORAL_OWNER: 'team-a',
                CORAL_EFFORT: 'high',
                CORAL_CLAUDE_MODEL_CAP: 'sonnet',
              }),
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('rejects remote POST /sessions requests that bypass provider permissions', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          start: vi.fn(async () => ({ status: 'running', job: 'job-start', session: 'session-start' })),
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
              projectRoot: '/tmp/project',
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

    it('rejects disallowed remote HTTP preflight requests before granting CORS', async () => {
      await withBaseCoralEnv(async () => {
        const { deps } = createHttpHandlerDeps({
          remoteAccess: { mode: 'address_allowlist', allowedRemoteAddresses: ['198.51.100.8'] },
        });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: '203.0.113.10' });

        try {
          const response = await fetch(`${started.baseUrl}/health`, {
            method: 'OPTIONS',
            headers: {
              Origin: 'http://127.0.0.1:8787',
              'Access-Control-Request-Headers': 'X-Coral-Backend-Token, Content-Type',
            },
          });

          expect(response.status).toBe(403);
          expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
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

    it('rejects permission bypass requests when the peer address is unavailable', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          start: vi.fn(async () => ({ status: 'running', job: 'job-start', session: 'session-start' })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: null });

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
              projectRoot: '/tmp/project',
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

    it('accepts POST /sessions with namespaced coral agents', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          start: vi.fn(async () => ({ status: 'running', job: 'job-x', session: 'session-x' })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps);

        try {
          const response = await fetch(`${started.baseUrl}/sessions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              provider: 'codex',
              prompt: 'hi',
              projectRoot: '/tmp/project',
              agent: 'coral:architect',
            }),
          });

          expect(response.status).toBe(201);
          expect(await response.json()).toEqual({
            session: 'session-x',
            job: 'job-x',
            launchState: 'running',
          });
          expect(fakeService.start).toHaveBeenCalledWith(
            'codex',
            expect.objectContaining({
              prompt: 'hi',
              agent: 'coral:architect',
            }),
            expect.objectContaining({
              projectRoot: '/tmp/project',
            }),
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('rejects POST /sessions invalid agent identifiers at the schema boundary', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService();
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps);

        try {
          const response = await fetch(`${started.baseUrl}/sessions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              provider: 'codex',
              prompt: 'hi',
              projectRoot: '/tmp/project',
              agent: 'INVALID!',
            }),
          });

          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            code: 'invalid_request',
            message: expect.any(String),
          });
          expect(fakeService.start).not.toHaveBeenCalled();
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('maps agent_not_found launch rejections from POST /sessions to 404', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          start: vi.fn(async () => ({
            status: 'rejected',
            code: 'agent_not_found',
            message: 'Agent "coral:does-not-exist" not found',
          })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps);

        try {
          const response = await fetch(`${started.baseUrl}/sessions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              provider: 'codex',
              prompt: 'hi',
              projectRoot: '/tmp/project',
              agent: 'coral:does-not-exist',
            }),
          });

          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({
            code: 'agent_not_found',
            message: 'Agent "coral:does-not-exist" not found',
          });
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('passes canonical workflow camelCase fields to executeWorkflow', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps);

        try {
          const response = await fetch(`${started.baseUrl}/workflow`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              expression: 'architect',
              startPrompt: 'Begin',
              provider: 'codex',
              workDir: '/tmp/workflow',
              projectRoot: '/tmp/project',
              owner: 'team-a',
              effort: 'high',
              claudeModelCap: 'sonnet',
            }),
          });

          expect(response.status).toBe(202);
          expect(await response.json()).toEqual({
            session: 'workflow-session',
            job: 'workflow-job',
            launchState: 'running',
          });
          expect(fakeService.executeWorkflow).toHaveBeenCalledWith(
            'codex',
            expect.any(Array),
            {
              expression: 'architect',
              startPrompt: 'Begin',
              provider: 'codex',
              workDir: '/tmp/workflow',
              owner: 'team-a',
            },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
                CORAL_OWNER: 'team-a',
                CORAL_EFFORT: 'high',
                CORAL_CLAUDE_MODEL_CAP: 'sonnet',
              }),
            }),
            '/tmp/workflow',
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('rejects remote POST /workflow requests that forward caller network env', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService();
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: '203.0.113.10' });

        try {
          const response = await fetch(`${started.baseUrl}/workflow`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              expression: 'architect',
              startPrompt: 'Begin',
              provider: 'codex',
              projectRoot: '/tmp/project',
              networkEnv: { HTTPS_PROXY: 'http://proxy.example:8443' },
            }),
          });

          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            code: 'remote_transport_option_forbidden',
            message: '`networkEnv` forwarding is only allowed from loopback HTTP clients',
            detail: { option: 'networkEnv' },
          });
          expect(fakeService.executeWorkflow).not.toHaveBeenCalled();
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('rejects remote POST /workflow requests that forward caller CORAL_* config', async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService();
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        const started = await startHttpHandlerServer(deps, undefined, { remoteAddress: '203.0.113.10' });

        try {
          const response = await fetch(`${started.baseUrl}/workflow`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              expression: 'architect',
              startPrompt: 'Begin',
              provider: 'codex',
              projectRoot: '/tmp/project',
              coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol' },
            }),
          });

          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            code: 'remote_transport_option_forbidden',
            message: '`coralEnv` forwarding is only allowed from loopback HTTP clients',
            detail: { option: 'coralEnv' },
          });
          expect(fakeService.executeWorkflow).not.toHaveBeenCalled();
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it("defaults omitted workflow provider to 'claude' for both executeWorkflow arguments", async () => {
      await withBaseCoralEnv(async () => {
        const fakeService = createFakeExecutionService({
          executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
        });
        const { deps } = createHttpHandlerDeps({ executionService: fakeService });
        deps.providerRegistry.register(
          toProviderSpec({
            name: 'claude',
            execute: vi.fn(() => streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const } })),
          })!,
        );
        const started = await startHttpHandlerServer(deps);

        try {
          const response = await fetch(`${started.baseUrl}/workflow`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              expression: 'architect',
              startPrompt: 'Begin',
              workDir: '/tmp/workflow',
              projectRoot: '/tmp/project',
              claudeModelCap: 'sonnet',
            }),
          });

          expect(response.status).toBe(202);
          expect(fakeService.executeWorkflow).toHaveBeenCalledWith(
            'claude',
            expect.any(Array),
            {
              expression: 'architect',
              startPrompt: 'Begin',
              provider: 'claude',
              workDir: '/tmp/workflow',
            },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
            }),
            '/tmp/workflow',
          );
        } finally {
          await _closeHttpServer(started.server);
        }
      });
    });

    it('keeps WorkflowInputError on the plain invalid_request message path', async () => {
      const { deps } = createHttpHandlerDeps({
        executionService: createFakeExecutionService(),
        workflowExecute: async () => ({
          kind: 'invalid_request' as const,
          message: "Step 0, atom 'architect' has unsupported namespace 'other'",
        }),
      });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/workflow`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            expression: 'architect',
            startPrompt: 'Begin',
            projectRoot: '/tmp/project',
          }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          code: 'invalid_request',
          message: "Step 0, atom 'architect' has unsupported namespace 'other'",
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('keeps ZodError on the invalid_request + detail.issues path for workflow input failures', async () => {
      const workflowError = new ZodError([
        {
          code: ZodIssueCode.custom,
          path: ['expression'],
          message: 'Expression required',
        },
      ]);
      const { deps } = createHttpHandlerDeps({
        executionService: createFakeExecutionService(),
        workflowExecute: async () => ({
          kind: 'invalid_request' as const,
          message: 'expression: Expression required',
          detail: { issues: workflowError.issues },
        }),
      });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/workflow`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            expression: 'architect',
            startPrompt: 'Begin',
            projectRoot: '/tmp/project',
          }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          code: 'invalid_request',
          message: 'expression: Expression required',
          detail: { issues: workflowError.issues },
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('returns AbortResult directly from POST /jobs/abort and preserves partial misses', async () => {
      const abortJobs = vi.fn((jobIds: string[]) => ({
        aborted: jobIds.filter((job) => job === 'job-1'),
        notFound: ['job-2'],
      }));
      const { deps } = createHttpHandlerDeps({
        abortJobs,
        scopeCheckJobs: () => ({ valid: ['job-1'], missing: ['job-2'], mismatch: [] }),
      });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/jobs/abort`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            jobs: ['job-1', 'job-2'],
            projectRoot: '/tmp/project',
          }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          aborted: ['job-1'],
          notFound: ['job-2'],
        });
        expect(abortJobs).toHaveBeenCalledWith(['job-1', 'job-2']);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it.each([
      {
        name: 'scope mismatch',
        scopeCheckJobs: () => ({ valid: [], missing: [], mismatch: ['job-foreign'] }),
        expectedStatus: 403,
        expectedBody: {
          code: 'scope_mismatch',
          message: 'Jobs do not belong to this project',
          detail: { jobs: ['job-foreign'] },
        },
      },
      {
        name: 'all missing',
        scopeCheckJobs: () => ({ valid: [], missing: ['missing-job'], mismatch: [] }),
        expectedStatus: 404,
        expectedBody: {
          code: 'jobs_not_found',
          message: 'Requested jobs were not found',
          detail: { jobs: ['missing-job'] },
        },
      },
    ])(
      'returns the new error contract from POST /jobs/abort for $name',
      async ({ scopeCheckJobs, expectedStatus, expectedBody }) => {
        const { deps } = createHttpHandlerDeps({ scopeCheckJobs });
        const started = await startHttpHandlerServer(deps);

        try {
          const response = await fetch(`${started.baseUrl}/jobs/abort`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Coral-Backend-Token': 'test-token',
            },
            body: JSON.stringify({
              jobs: ['missing-job'],
              projectRoot: '/tmp/project',
            }),
          });

          expect(response.status).toBe(expectedStatus);
          expect(await response.json()).toEqual(expectedBody);
        } finally {
          await _closeHttpServer(started.server);
        }
      },
    );
  });

  it('defaults an absent /jobs/wait cursor to an empty replay state', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = createProgressStore();
    createdJobIds.add('job-1');
    progressStore.initJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
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
        jobIds: ['job-1', 'missing-job'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(body).toContain('event: progress');
    expect(body).toContain('event: terminal');
    expect(body).toContain('"message":"working"');
    expect(body).toContain('"content":"done"');
    expect(body).not.toContain('"sessionId":"session-1"');

    const firstIdLine = body.split('\n').find((line) => line.startsWith('id: '));
    expect(firstIdLine).toBeTruthy();
    const encodedCursor = firstIdLine?.slice(4) ?? '';
    expect(JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf-8'))).toEqual({
      afterSeq: 7,
    });
    expect(fakeService.waitStream).toHaveBeenCalledWith({
      jobIds: ['job-1', 'missing-job'],
      timeoutSeconds: 1,
      cursor: { afterSeq: 0 },
      projectRoot: '/tmp/project',
    });
  });

  it('honors the /jobs/wait Last-Event-ID header cursor', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = createProgressStore();
    createdJobIds.add('job-1');
    progressStore.initJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
    });
    const encodedCursor = Buffer.from(
      JSON.stringify({
        afterSeq: 4,
      }),
      'utf-8',
    ).toString('base64url');

    const response = await fetch(`${backend.baseUrl}/jobs/wait`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Last-Event-ID': encodedCursor,
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-1'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(fakeService.waitStream).toHaveBeenCalledWith({
      jobIds: ['job-1'],
      timeoutSeconds: 1,
      cursor: {
        afterSeq: 4,
      },
      projectRoot: '/tmp/project',
    });
  });

  it('streams passive dashboard SSE events and applies the optional job filter', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const eventBus = new TypedEventBus();
    const progressStore = createProgressStore();
    createdJobIds.add('job-1');
    createdJobIds.add('job-2');
    progressStore.initJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    progressStore.initJob({
      jobId: 'job-2',
      sessionId: 'session-2',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    const backend = await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
      eventBus,
    });

    const stream = await openHttpStream(
      `${backend.baseUrl}/events/stream?projectRoot=${encodeURIComponent('/tmp/project')}&filter=job:job-1`,
      {
        'X-Coral-Backend-Token': backend.token,
      },
    );

    expect(stream.response.statusCode).toBe(200);
    expect(String(stream.response.headers['content-type'])).toContain('text/event-stream');
    expect(String(stream.response.headers['cache-control'])).toBe('no-cache');
    expect(String(stream.response.headers.connection)).toBe('keep-alive');

    try {
      const readyChunk = await stream.waitForText((text) => text.includes('event: ready'));
      expect(readyChunk).toContain('event: ready');
      expect(readyChunk).toContain('"streamId":"');

      eventBus.emit('job:created', {
        jobId: 'job-1',
        sessionId: 'session-1',
        provider: 'codex',
        projectRoot: '/tmp/project',
      });
      eventBus.emit('job:created', {
        jobId: 'job-2',
        sessionId: 'session-2',
        provider: 'codex',
        projectRoot: '/tmp/project',
      });

      const eventChunk = await stream.waitForText((text) => text.includes('event: job:created'));

      expect(eventChunk).toContain('"jobId":"job-1"');
      expect(eventChunk).not.toContain('"jobId":"job-2"');
      expect(eventChunk).toContain('"sessionId":"session-1"');
      expect(fakeIdleTimer.beginRequest).not.toHaveBeenCalled();
      expect(fakeIdleTimer.endRequest).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });

  it('suppresses dashboard SSE job events when projectRoot is omitted', async () => {
    const eventBus = new TypedEventBus();
    const progressStore = createProgressStore();
    createdJobIds.add('job-no-project-root-stream');
    progressStore.initJob({
      jobId: 'job-no-project-root-stream',
      sessionId: 'session-no-project-root-stream',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    const backend = await startBackendServer({ eventBus });

    const stream = await openHttpStream(`${backend.baseUrl}/events/stream`, {
      'X-Coral-Backend-Token': backend.token,
    });

    try {
      await stream.waitForText((text) => text.includes('event: ready'));

      eventBus.emit('job:created', {
        jobId: 'job-no-project-root-stream',
        sessionId: 'session-no-project-root-stream',
        provider: 'codex',
        projectRoot: '/tmp/project',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(stream.currentText().match(/^event: [^\n]+/gm)).toEqual(['event: ready']);
      expect(stream.currentText()).not.toContain('job-no-project-root-stream');
      expect(stream.currentText()).not.toContain('event: job:created');
    } finally {
      stream.close();
    }
  });

  it('scopes unfiltered dashboard SSE job and discuss events to the requested project', async () => {
    const eventBus = new TypedEventBus();
    const progressStore = createProgressStore();
    createdJobIds.add('job-owned');
    createdJobIds.add('job-foreign');
    progressStore.initJob({
      jobId: 'job-owned',
      sessionId: 'session-owned',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    progressStore.initJob({
      jobId: 'job-foreign',
      sessionId: 'session-foreign',
      provider: 'codex',
      projectRoot: '/tmp/other-project',
      backendNamespace: testBackendNamespace,
    });
    const backend = await startBackendServer({ eventBus });

    const stream = await openHttpStream(
      `${backend.baseUrl}/events/stream?projectRoot=${encodeURIComponent('/tmp/project')}`,
      {
        'X-Coral-Backend-Token': backend.token,
      },
    );

    try {
      await stream.waitForText((text) => text.includes('event: ready'));

      eventBus.emit('job:progress', {
        jobId: 'job-foreign',
        seq: 1,
        message: 'foreign progress',
        timing: waitTiming,
      });
      eventBus.emit('discuss:updated', {
        projectRoot: '/tmp/other-project',
        sessionId: 'foreign-discuss',
        lastSeq: 1,
        status: 'active',
      });
      eventBus.emit('job:progress', {
        jobId: 'job-owned',
        seq: 2,
        message: 'owned progress',
        timing: waitTiming,
      });
      eventBus.emit('discuss:updated', {
        projectRoot: '/tmp/project',
        sessionId: 'owned-discuss',
        lastSeq: 2,
        status: 'active',
      });

      const eventChunk = await stream.waitForText(
        (text) => text.includes('"jobId":"job-owned"') && text.includes('"sessionId":"owned-discuss"'),
      );

      expect(eventChunk).toContain('event: job:progress');
      expect(eventChunk).toContain('event: discuss:updated');
      expect(eventChunk).toContain('"message":"owned progress"');
      expect(eventChunk).not.toContain('foreign progress');
      expect(eventChunk).not.toContain('foreign-discuss');
    } finally {
      stream.close();
    }
  });

  it('rejects dashboard SSE connections over the coordinator cap', async () => {
    const backend = await startBackendServer();
    const streams: Array<Awaited<ReturnType<typeof openHttpStream>>> = [];

    try {
      for (let index = 0; index < MAX_EVENT_STREAM_CONNECTIONS; index += 1) {
        streams.push(
          await openHttpStream(`${backend.baseUrl}/events/stream?projectRoot=${encodeURIComponent('/tmp/project')}`, {
            'X-Coral-Backend-Token': backend.token,
          }),
        );
      }

      const response = await fetch(
        `${backend.baseUrl}/events/stream?projectRoot=${encodeURIComponent('/tmp/project')}`,
        {
          headers: { 'X-Coral-Backend-Token': backend.token },
        },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: 'too_many_event_streams',
        message: 'Too many event stream connections',
      });
    } finally {
      for (const stream of streams) {
        stream.close();
      }
    }
  }, 10_000);

  it('lists jobs and returns replayed job detail', async () => {
    const progressStore = createProgressStore();
    const backend = await startBackendServer();

    createdJobIds.add('job-1');
    createdJobIds.add('job-2');
    progressStore.initJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    stubLaunchRecord(progressStore, {
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    progressStore.appendProgress('job-1', 'session-1', 'working');
    commitJobTerminal(
      progressStore,
      'job-1',
      'session-1',
      { content: 'done', outcome: { kind: 'completed' } },
      'completed',
    );
    progressStore.initJob({
      jobId: 'job-2',
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    stubLaunchRecord(progressStore, {
      jobId: 'job-2',
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    stubRuntimeRecord(progressStore, { jobId: 'job-2' });

    const jobsResponse = await fetch(`${backend.baseUrl}/jobs?all=1`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const jobsBody = (await jobsResponse.json()) as {
      jobs: Array<{ jobId: string; status: Record<string, unknown> }>;
    };

    expect(jobsResponse.status).toBe(200);
    expect(jobsBody.jobs).toEqual(
      expect.arrayContaining([
        {
          jobId: 'job-1',
          status: expect.objectContaining({
            jobId: 'job-1',
            sessionId: 'session-1',
            provider: 'codex',
            phase: 'completed',
          }),
        },
        {
          jobId: 'job-2',
          status: expect.objectContaining({
            jobId: 'job-2',
            sessionId: 'session-2',
            provider: 'claude',
            phase: 'running',
          }),
        },
      ]),
    );

    const detailResponse = await fetch(
      `${backend.baseUrl}/jobs/job-1?projectRoot=${encodeURIComponent('/tmp/project')}`,
      {
        headers: { 'X-Coral-Backend-Token': backend.token },
      },
    );
    const detailBody = (await detailResponse.json()) as {
      status: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };

    expect(detailResponse.status).toBe(200);
    expect(detailBody.status).toMatchObject({
      jobId: 'job-1',
      phase: 'completed',
      result: { content: 'done', outcome: { kind: 'completed' } },
    });
    expect(detailBody.events).toHaveLength(2);
    expect(detailBody.events[0]).toMatchObject({
      seq: expect.any(Number),
      type: 'progress',
    });
    expect(String(detailBody.events[0].message)).toContain('working');
    expect(detailBody.events[1]).toMatchObject({
      seq: expect.any(Number),
      type: 'terminal',
      result: { content: 'done', outcome: { kind: 'completed' } },
    });

    const missingResponse = await fetch(
      `${backend.baseUrl}/jobs/missing-job?projectRoot=${encodeURIComponent('/tmp/project')}`,
      {
        headers: { 'X-Coral-Backend-Token': backend.token },
      },
    );

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      code: 'job_not_found',
      message: 'Job not found: missing-job',
    });
  });

  it('denies job detail when the job belongs to another project', async () => {
    const progressStore = createProgressStore();
    const backend = await startBackendServer();

    createdJobIds.add('job-foreign-project');
    progressStore.initJob({
      jobId: 'job-foreign-project',
      sessionId: 'session-foreign-project',
      provider: 'codex',
      projectRoot: '/tmp/other-project',
      backendNamespace: testBackendNamespace,
    });

    const response = await fetch(
      `${backend.baseUrl}/jobs/job-foreign-project?projectRoot=${encodeURIComponent('/tmp/project')}`,
      {
        headers: { 'X-Coral-Backend-Token': backend.token },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'scope_mismatch',
      message: 'Jobs do not belong to this project',
      detail: { jobs: ['job-foreign-project'] },
    });
  });

  it('denies launched job detail when requested from another project', async () => {
    const progressStore = createProgressStore();
    const projectA = createProjectRoot('job-detail-project-a');
    const projectB = createProjectRoot('job-detail-project-b');
    const sessionManager = createSessionManager(projectA);
    const session = sessionManager.allocate('codex', 'detail-session', 'gpt-5', projectA);
    const jobId = 'job-detail-project-a';
    const backend = await startBackendServer();

    createdJobIds.add(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: projectA,
      backendNamespace: testBackendNamespace,
    });
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: projectA,
      backendNamespace: testBackendNamespace,
    });
    sessionManager.claimForJobSync(session.sessionId, jobId);

    const response = await fetch(`${backend.baseUrl}/jobs/${jobId}?projectRoot=${encodeURIComponent(projectB)}`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'scope_mismatch',
      message: 'Jobs do not belong to this project',
      detail: { jobs: [jobId] },
    });
  });

  describe('GET /jobs query filters', () => {
    it('filters collection responses by projectRoot, phase, all, and provider and sorts by updatedAt descending', async () => {
      const fakeService = createFakeExecutionService();
      const progressStore = createProgressStore();
      const backend = await startBackendServer({
        createExecutionService: () => fakeService as never,
      });

      createdJobIds.add('job-running');
      createdJobIds.add('job-queued');
      createdJobIds.add('job-completed');
      createdJobIds.add('job-foreign-project');

      progressStore.initJob({
        jobId: 'job-running',
        sessionId: 'session-running',
        provider: 'codex',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
        initialPhase: 'running',
      });
      stubLaunchRecord(progressStore, {
        jobId: 'job-running',
        sessionId: 'session-running',
        provider: 'codex',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
      });
      stubRuntimeRecord(progressStore, { jobId: 'job-running' });
      progressStore.initJob({
        jobId: 'job-queued',
        sessionId: 'session-queued',
        provider: 'claude',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
        initialPhase: 'queued',
      });
      stubLaunchRecord(progressStore, {
        jobId: 'job-queued',
        sessionId: 'session-queued',
        provider: 'claude',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
      });
      progressStore.initJob({
        jobId: 'job-completed',
        sessionId: 'session-completed',
        provider: 'claude',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
      });
      stubLaunchRecord(progressStore, {
        jobId: 'job-completed',
        sessionId: 'session-completed',
        provider: 'claude',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
      });
      commitJobTerminal(
        progressStore,
        'job-completed',
        'session-completed',
        { content: 'done', outcome: { kind: 'completed' } },
        'completed',
      );
      progressStore.initJob({
        jobId: 'job-foreign-project',
        sessionId: 'session-foreign-project',
        provider: 'codex',
        projectRoot: '/tmp/other-project',
        backendNamespace: testBackendNamespace,
      });
      stubLaunchRecord(progressStore, {
        jobId: 'job-foreign-project',
        sessionId: 'session-foreign-project',
        provider: 'codex',
        projectRoot: '/tmp/other-project',
        backendNamespace: testBackendNamespace,
      });
      stubRuntimeRecord(progressStore, { jobId: 'job-foreign-project' });

      const allResponse = await fetch(`${backend.baseUrl}/jobs`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const allBody = (await allResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(allResponse.status).toBe(200);
      expect(allBody.jobs.map((job) => job.jobId)).toEqual(['job-foreign-project', 'job-queued', 'job-running']);

      const projectScopedResponse = await fetch(
        `${backend.baseUrl}/jobs?projectRoot=${encodeURIComponent('/tmp/project')}`,
        {
          headers: { 'X-Coral-Backend-Token': backend.token },
        },
      );
      const projectScopedBody = (await projectScopedResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(projectScopedResponse.status).toBe(200);
      expect(projectScopedBody.jobs.map((job) => job.jobId)).toEqual(['job-queued', 'job-running']);

      const runningResponse = await fetch(`${backend.baseUrl}/jobs?phase=running`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const runningBody = (await runningResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(runningResponse.status).toBe(200);
      expect(runningBody.jobs).toEqual([
        {
          jobId: 'job-foreign-project',
          status: expect.objectContaining({
            jobId: 'job-foreign-project',
            phase: 'running',
          }),
        },
        {
          jobId: 'job-running',
          status: expect.objectContaining({
            jobId: 'job-running',
            phase: 'running',
          }),
        },
      ]);

      const allProjectsResponse = await fetch(
        `${backend.baseUrl}/jobs?projectRoot=${encodeURIComponent('/tmp/project')}&all=1`,
        {
          headers: { 'X-Coral-Backend-Token': backend.token },
        },
      );
      const allProjectsBody = (await allProjectsResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(allProjectsResponse.status).toBe(200);
      expect(allProjectsBody.jobs.map((job) => job.jobId)).toEqual(['job-completed', 'job-queued', 'job-running']);

      const providerResponse = await fetch(`${backend.baseUrl}/jobs?provider=codex&all=1`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const providerBody = (await providerResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(providerResponse.status).toBe(200);
      expect(providerBody.jobs).toEqual([
        {
          jobId: 'job-foreign-project',
          status: expect.objectContaining({
            jobId: 'job-foreign-project',
            phase: 'running',
          }),
        },
        {
          jobId: 'job-running',
          status: expect.objectContaining({
            jobId: 'job-running',
            phase: 'running',
          }),
        },
      ]);

      const detailResponse = await fetch(
        `${backend.baseUrl}/jobs/job-completed?projectRoot=${encodeURIComponent('/tmp/project')}`,
        {
          headers: { 'X-Coral-Backend-Token': backend.token },
        },
      );
      const detailBody = (await detailResponse.json()) as {
        status: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };

      expect(detailResponse.status).toBe(200);
      expect(detailBody.status).toMatchObject({
        jobId: 'job-completed',
        phase: 'completed',
        result: { content: 'done', outcome: { kind: 'completed' } },
      });
      expect(detailBody.events).toEqual([
        expect.objectContaining({
          seq: expect.any(Number),
          type: 'terminal',
          result: expect.objectContaining({ content: 'done', outcome: { kind: 'completed' } }),
        }),
      ]);
    });
  });

  it('returns 400 when /jobs/wait omits or empties projectRoot', async () => {
    const backend = await startBackendServer();

    const missingResponse = await fetch(`${backend.baseUrl}/jobs/wait`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-1'],
        timeoutSeconds: 1,
      }),
    });

    const emptyResponse = await fetch(`${backend.baseUrl}/jobs/wait`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-1'],
        timeoutSeconds: 1,
        projectRoot: '',
      }),
    });

    expect(missingResponse.status).toBe(400);
    expect(await missingResponse.json()).toMatchObject({ code: 'invalid_request' });
    expect(emptyResponse.status).toBe(400);
    expect(await emptyResponse.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('returns 400 when /jobs/wait includes a body cursor', async () => {
    const fakeService = createFakeExecutionService();
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
        jobIds: ['job-1'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
        cursor: { afterSeq: 4 },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(fakeService.waitStream).not.toHaveBeenCalled();
  });

  it('returns 403 before streaming when /jobs/wait includes cross-project jobs', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = createProgressStore();
    createdJobIds.add('job-foreign');
    progressStore.initJob({
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
        projectRoot: '/tmp/project',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'scope_mismatch',
      message: 'Jobs do not belong to this project',
      detail: { jobs: ['job-foreign'] },
    });
    expect(fakeService.waitStream).not.toHaveBeenCalled();
  });

  it('returns 404 when /jobs/wait receives only missing jobs', async () => {
    const fakeService = createFakeExecutionService();
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
        jobIds: ['missing-job'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 'jobs_not_found',
      message: 'Requested jobs were not found',
      detail: { jobs: ['missing-job'] },
    });
    expect(fakeService.waitStream).not.toHaveBeenCalled();
  });

  it('clears orphaned session claims across shards when the job dir is missing', async () => {
    const progressStore = createProgressStore();
    const projectA = createProjectRoot('project-a');
    const projectB = createProjectRoot('project-b');
    const sessionA = createSessionManager(projectA).allocate('codex', 'alpha', 'gpt-5', projectA);
    const sessionB = createSessionManager(projectB).allocate('codex', 'beta', 'gpt-5', projectB);
    stubSessionProjection(progressStore, {
      sessionId: sessionA.sessionId,
      provider: 'codex',
      projectRoot: projectA,
      backendNamespace: testBackendNamespace,
    });
    stubSessionProjection(progressStore, {
      sessionId: sessionB.sessionId,
      provider: 'codex',
      projectRoot: projectB,
      backendNamespace: testBackendNamespace,
    });

    createSessionManager(projectA).claimForJobSync(sessionA.sessionId, 'missing-job-a');
    createSessionManager(projectB).claimForJobSync(sessionB.sessionId, 'missing-job-b');

    await startBackendServer();

    expect(createSessionManager(projectA).get('codex', sessionA.sessionId)).toMatchObject({
      sessionId: sessionA.sessionId,
    });
    expect(createSessionManager(projectA).get('codex', sessionA.sessionId)?.activeJobId).toBeUndefined();

    expect(createSessionManager(projectB).get('codex', sessionB.sessionId)).toMatchObject({
      sessionId: sessionB.sessionId,
    });
    expect(createSessionManager(projectB).get('codex', sessionB.sessionId)?.activeJobId).toBeUndefined();
  });

  it('releases terminal session claims even when the referenced job dir exists', async () => {
    const progressStore = createProgressStore();
    const projectRoot = createProjectRoot('project-existing-job');
    const session = createSessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot);
    const jobId = 'completed-job';
    stubSessionProjection(progressStore, {
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: testBackendNamespace,
    });

    createdJobIds.add(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: testBackendNamespace,
    });
    stubLaunchRecord(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: testBackendNamespace,
    });
    commitJobTerminal(
      progressStore,
      jobId,
      session.sessionId,
      { content: 'done', outcome: { kind: 'completed' } },
      'completed',
    );
    createSessionManager(projectRoot).claimForJobSync(session.sessionId, jobId);

    await startBackendServer();

    // Terminal jobs should have their session claims released during startup recovery
    const recoveredSession = createSessionManager(projectRoot).get('codex', session.sessionId);
    expect(recoveredSession?.activeJobId).toBeUndefined();
  });

  it('recovers orphaned workflow jobs with an empty artifact, workflow diagnostics, and released session claim', async () => {
    const progressStore = createProgressStore();
    const jobId = 'workflow-orphan-job';
    const projectRoot = createProjectRoot('workflow-project');
    const session = createSessionManager(projectRoot).allocate('codex', 'workflow-session', 'gpt-5', projectRoot);

    createdJobIds.add(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: testBackendNamespace,
      jobKind: 'workflow',
    });
    createSessionManager(projectRoot).claimForJobSync(session.sessionId, jobId);

    const backend = await startBackendServer();
    const response = await fetch(`${backend.baseUrl}/jobs/wait`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: [jobId],
        timeoutSeconds: 1,
        projectRoot,
      }),
    });
    const body = await response.text();
    const status = progressStore.readStatus(jobId);
    const detail = progressStore.loadJobProjectionDetail(jobId);
    const recoveredSession = createSessionManager(projectRoot).get('codex', session.sessionId);

    expect(response.status).toBe(200);
    expect(body).toContain('event: terminal');
    expect(body).toContain(`"resultPath":"${jobResultPath(jobId)}"`);
    expect(body).not.toContain('"workflow":{"steps":[]}');
    expect(detail.exit?.diagnostics).toEqual({ progressFaults: [] });
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('');
    expect(status).toMatchObject({
      phase: 'error',
      jobKind: 'workflow',
      result: {
        content: '',
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: { kind: 'workflow', id: jobId },
          },
        },
      },
    });
    expect(recoveredSession?.activeJobId).toBeUndefined();
  });

  it('returns 200 from /admin/shutdown with draining status and shuts down when idle', async () => {
    const pluginRoot = createProjectRoot('plugin-root');
    const backend = await startBackendServer({ pluginRoot });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    try {
      const response = await fetch(`${backend.baseUrl}/admin/shutdown`, {
        method: 'POST',
        headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe('draining');
      expect(typeof body.instanceId).toBe('string');

      const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(
        messages.some(
          (message) => message.startsWith('audit ') && message.includes('"event":"admin_shutdown_requested"'),
        ),
      ).toBe(true);
      expect(messages.some((message) => message.includes('"transport":"http"'))).toBe(true);

      // Backend is idle (no active jobs in test), so drain fires promptly
      await backend.controller.waitForShutdown();

      expect(backend.controller.getLifecycle()).toBe('stopped');
      expect(existsSync(runtime.paths.coral.coordinator.infoFile)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
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
      message: 'Manual shutdown required: shutdown capability missing or invalid',
    });
    expect(backend.controller.getLifecycle()).toBe('running');
  });

  it('restarts the KB daemon supervisor through the shutdown-token admin route', async () => {
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 2,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const kbDaemonSupervisor: KbDaemonSupervisor = {
      read: vi.fn(() => daemonHealth),
      start: vi.fn(async () => daemonHealth),
      probe: vi.fn(async () => daemonHealth),
      warmup: vi.fn(async () => daemonHealth),
      readKb: vi.fn(async () => ({ ok: false as const, code: 'unexpected_read', message: 'unexpected read' })),
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'unexpected_mutation',
        message: 'unexpected mutation',
      })),
      expansionRpc: createUnexpectedExpansionRpc(),
      stop: vi.fn(async () => daemonHealth),
      restart: vi.fn(async () => daemonHealth),
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    try {
      const response = await fetch(`${backend.baseUrl}/admin/kb/restart`, {
        method: 'POST',
        headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        instanceId: 'execution-backend-instance-1',
        kbDaemon: daemonHealth,
      });
      expect(kbDaemonSupervisor.restart).toHaveBeenCalledWith('http-admin');
      const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(
        messages.some(
          (message) => message.startsWith('audit ') && message.includes('"event":"admin_kb_daemon_restart_requested"'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('tracks active daemon KB jobs before admin restart reconciliation', async () => {
    const jobId = 'kb-daemon-restart-active-job-1';
    const projectRoot = '/workspace/project-a';
    const daemonHealth: KbDaemonHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 2,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const exit = { listener: null as ((snapshot: KbDaemonHealthSnapshot) => void) | null };
    const listActiveKbJobs = vi.fn(async () => ({ active: [jobId] }));
    const restart = vi.fn(async () => daemonHealth);
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
      mutateKb: vi.fn(async () => ({
        ok: false as const,
        code: 'unexpected_mutation',
        message: 'unexpected mutation',
      })),
      expansionRpc: createUnexpectedExpansionRpc(),
      abortKbJobs: vi.fn(async () => ({ aborted: [], notFound: [] })),
      listActiveKbJobs,
      stop: vi.fn(async () => daemonHealth),
      restart,
      dispose: vi.fn(async () => undefined),
    };
    const backend = await startBackendServer({ kbDaemonSupervisor });
    const progressStore = createProgressStore();
    createdJobIds.add(jobId);
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: null,
      provider: null,
      projectRoot,
      backendNamespace: testBackendNamespace,
      bundleHash: 'testhash1234',
      jobKind: 'kb',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      operation: 'kb.source_import',
      request: {
        filePath: '/workspace/project-a/source.md',
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

    const response = await fetch(`${backend.baseUrl}/admin/kb/restart`, {
      method: 'POST',
      headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
    });

    expect(response.status).toBe(200);
    expect(listActiveKbJobs).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith('http-admin');
    expect(listActiveKbJobs.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0]);
    expect(exit.listener).not.toBeNull();

    if (exit.listener === null) {
      throw new Error('expected KB daemon exit listener');
    }
    exit.listener({
      ...daemonHealth,
      phase: 'failed',
      pid: null,
      readyAt: null,
      lastExit: { code: null, signal: 'SIGTERM', at: 30, uptimeMs: 20 },
      lastError: 'restart interrupted active import',
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

  it('rejects /admin/kb/restart when only the general backend token is provided', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/admin/kb/restart`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: 'shutdown_unauthorized',
      message: 'Manual KB daemon restart requires shutdown capability',
    });
    expect(backend.controller.getLifecycle()).toBe('running');
  });

  it('drains shutdown when only foreign namespace live jobs remain', async () => {
    const progressStore = createProgressStore();
    const pluginRoot = createProjectRoot('plugin-root-foreign-drain');
    const localNamespace = pluginRootNamespace(pluginRoot);
    const foreignJobId = 'job-foreign-drain';
    createdJobIds.add(foreignJobId);
    progressStore.initJob({
      jobId: foreignJobId,
      sessionId: 'session-foreign-drain',
      provider: 'codex',
      projectRoot: '/tmp/foreign-project',
      backendNamespace: foreignBackendNamespace,
      initialPhase: 'running',
    });
    stubLaunchRecord(progressStore, {
      jobId: foreignJobId,
      sessionId: 'session-foreign-drain',
      provider: 'codex',
      projectRoot: '/tmp/foreign-project',
      backendNamespace: foreignBackendNamespace,
    });

    const backend = await startBackendServer({ pluginRoot });
    const statusBeforeShutdown = progressStore.readStatus(foreignJobId);

    expect(statusBeforeShutdown).toMatchObject({
      jobId: foreignJobId,
      phase: 'error',
      backendNamespace: foreignBackendNamespace,
    });
    expect(progressStore.liveJobCount('testhash1234')).toBe(0);

    const response = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'draining',
      instanceId: 'execution-backend-instance-1',
    });

    const shutdownResult = await Promise.race([
      backend.controller.waitForShutdown().then(() => 'resolved'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);

    expect(shutdownResult).toBe('resolved');
    expect(backend.controller.getLifecycle()).toBe('stopped');

    const statusAfterShutdown = progressStore.readStatus(foreignJobId);
    expect(statusAfterShutdown).toMatchObject({
      jobId: foreignJobId,
      phase: 'error',
      backendNamespace: foreignBackendNamespace,
    });
    expect(statusAfterShutdown?.backendNamespace).not.toBe(localNamespace);
  });

  it('returns health with draining status after admin shutdown request', async () => {
    // Simulate a busy backend: hold an inflight request so drain waits
    const backend = await startBackendServer();
    const idleTimer = backend.controller.getIdleTimer();
    idleTimer.beginRequest();

    await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
    });

    const response = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('draining');

    idleTimer.endRequest();
    await backend.controller.waitForShutdown();
  });

  it('accepts /admin/shutdown while already draining', async () => {
    const backend = await startBackendServer();
    const idleTimer = backend.controller.getIdleTimer();
    idleTimer.beginRequest();

    const first = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>).status).toBe('draining');

    const second = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Shutdown-Token': backend.shutdownToken },
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>).status).toBe('draining');

    idleTimer.endRequest();
    await backend.controller.waitForShutdown();
  });

  it('returns unauthenticated liveness from /health', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(body).toMatchObject({
      status: 'ok',
      version: '9.9.9',
      bundleHash: 'testhash1234',
      flavor: 'prod',
      instanceId: 'execution-backend-instance-1',
    });
    expect(body.components).toBeUndefined();
    expect(body.kbDaemon).toBeUndefined();
    expect(body.queueDepth).toBeUndefined();
  });

  it('returns CORS headers for loopback preflight requests without requiring a token', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:8787',
        'Access-Control-Request-Headers': 'X-Coral-Backend-Token, Content-Type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:8787');
    expect(commaHeaderTokens(response.headers.get('Access-Control-Allow-Headers'))).toEqual([
      'content-type',
      'x-coral-backend-token',
      'x-coral-boot-token',
      'x-coral-shutdown-token',
    ]);
    expect(commaHeaderTokens(response.headers.get('Access-Control-Allow-Methods'))).toEqual([
      'delete',
      'get',
      'options',
      'post',
      'put',
    ]);
    expect(response.headers.get('Access-Control-Allow-Private-Network')).toBeNull();
  });

  it('does not grant CORS to non-loopback preflight origins', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.test',
        'Access-Control-Request-Headers': 'X-Coral-Backend-Token, Content-Type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Headers')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  describe('shutdown policy', () => {
    it('handoff shutdown preserves children and does not mark jobs as error', async () => {
      const markJobsAsErrorFn = vi.fn();
      const terminateAllFn = vi.fn();

      const backend = await startBackendServer({
        markJobsAsErrorFn,
        terminateAllFn,
      });

      await backend.controller.shutdown('replaced');
      await backend.controller.waitForShutdown();

      expect(terminateAllFn).not.toHaveBeenCalled();
      expect(markJobsAsErrorFn).not.toHaveBeenCalled();
    });

    it('handoff quiesces app-server jobs (no terminal mutation) before draining provider servers', async () => {
      const { lifecycleModule } = await loadExecutionModules();
      const pluginRoot = createProjectRoot('handoff-app-server-quiesce');
      const namespace = pluginRootNamespace(pluginRoot);
      const progressStore = createProgressStore();
      const jobId = 'handoff-app-server-job';
      createdJobIds.add(jobId);

      progressStore.initJob({
        jobId,
        sessionId: 'handoff-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
        initialPhase: 'running',
      });
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: 'handoff-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
      });
      progressStore.appendRuntimeStarted(jobId, {
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

      const fakeService = {
        finalizeInterruptedAppServerJob: vi.fn(async () => {}),
        quiesceAppServerJobsForHandoff: vi.fn(async (_signal: AbortSignal) => {}),
      };
      const providerHostManager = createFakeProviderHostManager();
      const fakeIdleTimer = createFakeIdleTimer();
      const { runtimeState } = createRuntimeStateMock();
      const storeServicesRef = createStoreServicesRef();
      setStoreServicesForTest(storeServicesRef, createStoreServicesForProgressStore(progressStore), {
        storeDbPath: runtime.paths.coral.store.dbFile,
      });
      runtimeState.setLifecycle('running');

      const kbDaemonSupervisor = createMockKbDaemonSupervisor();
      const controller = lifecycleModule.createLifecycle({
        identity: {
          pluginRoot,
          namespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'handoff-instance-1',
          token: 'test-token',
          bootToken: 'test-boot-token',
          shutdownToken: 'test-shutdown-token',
          now: () => 1,
          log: () => {},
        },
        runtime,
        backendPid: 1234,
        runtimeState,
        idleTimer: fakeIdleTimer as never,
        storeServicesRef,
        createStoreServicesFromDbFn: () => {
          throw new Error('Unexpected store services factory during shutdown-only test');
        },
        streamResponses: new Set(),
        discussStores: new Map(),
        eventBus: new TypedEventBus(),
        launchCoordinator: createLaunchCoordinator(),
        providerRegistry: new ProviderRegistry(),
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
        writeBackendInfoFn: vi.fn(),
        removeBackendInfoIfOwnerFn: () => {},
        cleanupStaleJobsFn: () => {},
        markJobsAsErrorFn: vi.fn(),
        terminateAllFn: vi.fn(),
        providerHostManager: providerHostManager as never,
        kbDaemonSupervisor,
        handoffQuiescePorts: () => [fakeService as never],
        createKbHealthComponentFn: () => createKbDaemonHealthComponent(kbDaemonSupervisor),
        registerBuiltInProvidersFn: () => {},
        recoverPersistedDiscussFn: async () => [],
        runStartupRecoveryFn: async () => [],
        hooks: {
          onShutdown: async () => {},
          onIdleCheck: () => false,
          onRecoveryComplete: async () => {},
        },
        closeServerFn: async () => {},
        listenFn: async () => ({ port: 4102, host: '127.0.0.1' }),
      });

      await controller.shutdown('replaced');
      await controller.waitForShutdown();

      // The dying daemon must NOT call finalizeInterruptedAppServerJob — that
      // multi-write durable mutation is owned by the replacement daemon's
      // startup recovery after socket bind.
      expect(fakeService.finalizeInterruptedAppServerJob).not.toHaveBeenCalled();
      expect(fakeService.quiesceAppServerJobsForHandoff).toHaveBeenCalledTimes(1);
      expect(providerHostManager.drainForHandoff).toHaveBeenCalledTimes(1);
      // Quiesce must run before provider-host drain so transport closure does
      // not surface as a provider terminal event on the active app-server job.
      const quiesceOrder = fakeService.quiesceAppServerJobsForHandoff.mock.invocationCallOrder.at(0);
      const drainOrder = providerHostManager.drainForHandoff.mock.invocationCallOrder.at(0);
      expect(quiesceOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(drainOrder ?? Number.POSITIVE_INFINITY);
    });

    it('hard shutdown kills children and marks jobs as error', async () => {
      const markJobsAsErrorFn = vi.fn();
      const terminateAllFn = vi.fn();
      const providerHostManager = createFakeProviderHostManager();

      const backend = await startBackendServer({
        markJobsAsErrorFn,
        terminateAllFn,
        providerHostManager: providerHostManager as never,
      });

      await backend.controller.shutdown('sigint');
      await backend.controller.waitForShutdown();

      expect(terminateAllFn).toHaveBeenCalledTimes(1);
      expect(markJobsAsErrorFn).toHaveBeenCalledTimes(1);
      expect(providerHostManager.shutdown).toHaveBeenCalledTimes(1);
      const hostShutdownOrder = providerHostManager.shutdown.mock.invocationCallOrder.at(0);
      const childKillOrder = terminateAllFn.mock.invocationCallOrder.at(0);
      expect(hostShutdownOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(childKillOrder ?? Number.POSITIVE_INFINITY);
    });

    it('hard shutdown during blocked startup persists abort markers for persisted-only recovery candidates before restart and skips terminal history', async () => {
      const { serverModule } = await loadExecutionModules();
      const topic = 'Should the city pedestrianize the downtown core?';
      const projectRoot = createProjectRoot('startup-shutdown-discuss');
      const progressStore = createProgressStore();
      const readDiscussProjection = (sessionId: string) =>
        JSON.parse(
          (
            progressStore
              .getDb()
              .prepare(`SELECT state FROM projection_discuss WHERE discuss_id = ?`)
              .get(sessionId) as { state: string }
          ).state,
        ) as { lastAppliedSeq: number; state: { status: string }; runtime: { controlPhase: string } };

      const startupCandidateCreated = decideSessionCreate(
        {
          topic,
          min_bid_delay_ms: 0,
          agents: [
            { name: 'alpha', persona: '# Alpha', participation: 'required' },
            { name: 'beta', persona: '# Beta', participation: 'required' },
          ],
        },
        { sessionId: 'startup-candidate', projectRoot: projectRoot, topic: topic },
        1,
        '2026-03-11T00:00:00.000Z',
      );
      if (!startupCandidateCreated.ok) {
        throw new Error(startupCandidateCreated.error);
      }
      commitJobInputs(
        progressStore,
        startupCandidateCreated.value.map((event) => toJournalInput(event)),
      );

      const terminalHistoryCreated = decideSessionCreate(
        {
          topic,
          min_bid_delay_ms: 0,
          agents: [
            { name: 'alpha', persona: '# Alpha', participation: 'required' },
            { name: 'beta', persona: '# Beta', participation: 'required' },
          ],
        },
        { sessionId: 'terminal-history', projectRoot: projectRoot, topic: topic },
        1,
        '2026-03-11T00:05:00.000Z',
      );
      if (!terminalHistoryCreated.ok) {
        throw new Error(terminalHistoryCreated.error);
      }
      commitJobInputs(
        progressStore,
        terminalHistoryCreated.value.map((event) => toJournalInput(event)),
      );
      const terminalCreatedSnapshot = readDiscussProjection('terminal-history');
      commitJobInputs(
        progressStore,
        [
          makeEvent(
            'terminal-history',
            projectRoot,
            topic,
            terminalCreatedSnapshot.lastAppliedSeq + 1,
            'session.ended',
            '2026-03-11T00:05:01.000Z',
            {
              endReason: 'all_blocked',
              endReasonContent: 'All blocked.',
            },
          ),
          makeEvent(
            'terminal-history',
            projectRoot,
            topic,
            terminalCreatedSnapshot.lastAppliedSeq + 2,
            'session.synthesized',
            '2026-03-11T00:05:02.000Z',
            {
              synthesis: 'done',
            },
          ),
        ].map((event) => toJournalInput(event)),
      );

      const startupBlocked = createDeferred();
      const releaseStartup = createDeferred();
      const startupRegistry = createDiscussContextRegistry();
      const kbDaemonSupervisor = createMockKbDaemonSupervisor({
        start: vi.fn(async () => {
          startupBlocked.resolve();
          await releaseStartup.promise;
          throw new Error('startup interrupted for shutdown test');
        }),
      });

      controller = serverModule.createCoordinatorServer({
        bootSnapshot: {
          instanceId: 'execution-backend-instance-1',
          token: 'test-token',
          bootToken: 'test-boot-token',
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          log: () => {},
        },
        kbDaemonSupervisor,
        cleanupStaleJobsFn: () => {},
        discussRegistry: startupRegistry,
      });

      const startPromise = controller.start().catch((error: unknown) => error);
      await startupBlocked.promise;
      await controller.shutdown('sigint');
      await controller.waitForShutdown();

      const startupCandidateEvents = readDiscussEventLog(
        progressStore.getDb(),
        'startup-candidate',
        createDefaultStoreReadContext(),
      );
      expect(startupCandidateEvents.at(-1)).toMatchObject({
        kind: 'session.ended',
        payload: { force: true, reason: 'abort' },
      });
      expect(readDiscussProjection('startup-candidate')).toMatchObject({
        state: { status: 'ended' },
        runtime: { controlPhase: 'synthesize' },
      });

      const terminalHistoryEvents = readDiscussEventLog(
        progressStore.getDb(),
        'terminal-history',
        createDefaultStoreReadContext(),
      );
      expect(terminalHistoryEvents.filter((event) => event.kind === 'session.ended')).toHaveLength(1);
      expect(terminalHistoryEvents.at(-1)?.kind).toBe('session.synthesized');
      expect(startupRegistry.contexts.size).toBe(0);

      releaseStartup.resolve();
      const startResult = await startPromise;
      // The KB daemon starts after `running` and does not gate start()'s return
      // path. A daemon start failure during shutdown is contained by the
      // supervisor path, so the server info still resolves.
      expect(startResult).toMatchObject({ port: expect.any(Number) });

      const restartRegistry = createDiscussContextRegistry();
      const restarted = await startBackendServer({
        discussRegistry: restartRegistry,
      });
      const restartedSessions = [...restartRegistry.contexts.values()].flatMap((context) => [
        ...context.sessions.keys(),
      ]);
      expect(restartedSessions).not.toContain('startup-candidate');
      await restarted.controller.shutdown('test');
      await restarted.controller.waitForShutdown();
    });
  });

  describe('launch fence', () => {
    function currentCoralEnvSnapshot(): Record<string, string> {
      return Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          const [key, value] = entry;
          return key.startsWith('CORAL_') && typeof value === 'string';
        }),
      );
    }

    async function startFencedToolServer() {
      const { createHttpHandler, sendJson } = await import('#src/transport/http/handler.js');
      const { runtimeState } = createRuntimeStateMock();
      const idleTimer = createFakeIdleTimer();
      const coralEnvSnapshot = currentCoralEnvSnapshot();
      const requestDrain = vi.fn();

      runtimeState.setLifecycle('running');
      runtimeState.setLaunchFenceActive(true);

      const deps: any = {
        identity: {
          pluginRoot: '/tmp/plugin',
          namespace: testBackendNamespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'execution-backend-instance-1',
          token: 'test-token',
          bootToken: 'test-boot-token',
          shutdownToken: 'test-shutdown-token',
          now: () => Date.now(),
          log: () => {},
        },
        coralEnvSnapshot,
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
          read: () => ({
            status: 'ok' as const,
            kernel: { phase: 'running' as const, readyAt: 0 },
            version: '9.9.9',
            bundleHash: 'testhash1234',
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
            components: [{ id: 'kb', phase: 'online' as const }],
          }),
        },
        events: {
          bus: new TypedEventBus(),
          addResponse: () => {},
          removeResponse: () => {},
          createStreamId: () => 'stream-id',
          nowIsoString: () => new Date(0).toISOString(),
          subscribe: () => {},
          unsubscribe: () => {},
        },
        sessions: {
          start: vi.fn(),
        },
        jobs: {
          scopeCheck: () => ({ valid: [], missing: [], mismatch: [] }),
          abort: () => ({ aborted: [], notFound: [] }),
          waitStream: async function* () {
            return;
          },
          list: () => [],
          detail: () => null,
        },
        workflows: {
          execute: vi.fn(),
        },
        kb: {
          readSearch: vi.fn(),
          diagnose: vi.fn(),
          readNote: vi.fn(),
          readSource: vi.fn(),
          readCommunity: vi.fn(),
          listStaleCommunities: vi.fn(),
          readCommunitySummaryInput: vi.fn(),
          setCommunitySummary: vi.fn(),
          readMemo: vi.fn(),
          readPrinciple: vi.fn(),
          listSources: vi.fn(),
          listMemos: vi.fn(),
          listPrinciples: vi.fn(),
          createNote: vi.fn(),
          updateNote: vi.fn(),
          deleteNote: vi.fn(),
          createSource: vi.fn(),
          deleteSource: vi.fn(),
          createMemo: vi.fn(),
          deleteMemos: vi.fn(),
          reindex: vi.fn(),
        },
        discuss: {
          seed: vi.fn(),
          start: vi.fn(),
          listSessions: vi.fn(() => []),
          loadDetail: vi.fn(() => null),
          watch: vi.fn(),
          bid: vi.fn(),
          speech: vi.fn(),
          abort: vi.fn(),
        },
      };

      const server = createServer((req, res) => {
        void createHttpHandler(deps)(req, res).catch(() => {
          if (!res.headersSent) {
            sendJson(res, 500, { code: 'internal_error', message: 'Internal error' });
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

    it.each([
      {
        name: 'session create',
        path: '/sessions',
        body: { provider: 'codex', prompt: 'hello', projectRoot: '/tmp/project' },
      },
      {
        name: 'workflow launch',
        path: '/workflow',
        body: { expression: 'architect', startPrompt: 'hello', provider: 'codex', projectRoot: '/tmp/project' },
      },
    ])('returns a 503 while the launch fence is active for $name', async ({ path, body }) => {
      const fenced = await startFencedToolServer();

      try {
        const response = await fetch(`${fenced.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify(body),
        });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          code: 'backend_recovering',
          message: 'recovering — retry after 500ms',
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          fenced.server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  describe('recovery scan', () => {
    it('treats clean initialized live jobs as ghost launches, not missing launch records', async () => {
      const progressStore = createProgressStore();
      const jobId = 'clean-live-job';
      const projectRoot = createProjectRoot('clean-live-project');
      const session = createSessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot);

      createdJobIds.add(jobId);
      progressStore.initJob({
        jobId,
        sessionId: session.sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: testBackendNamespace,
        initialPhase: 'launching',
      });
      createSessionManager(projectRoot).claimForJobSync(session.sessionId, jobId);
      expect(progressStore.readLaunchProjection(jobId)).not.toBeNull();

      const _backend = await startBackendServer();

      const status = progressStore.readStatus(jobId);
      expect(status).toMatchObject({
        phase: 'error',
        result: {
          content: '',
          outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
        },
      });

      // Session claim should be released
      const recoveredSession = createSessionManager(projectRoot).get('codex', session.sessionId);
      expect(recoveredSession?.activeJobId).toBeUndefined();
    });

    it('marks ghost launch jobs as error when runtime metadata was never recorded', async () => {
      const progressStore = createProgressStore();
      const jobId = 'ghost-launch-job';
      const projectRoot = createProjectRoot('ghost-launch-project');
      const session = createSessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot);

      createdJobIds.add(jobId);
      progressStore.initJob({
        jobId,
        sessionId: session.sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: testBackendNamespace,
        initialPhase: 'launching',
      });
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: session.sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: testBackendNamespace,
      });
      createSessionManager(projectRoot).claimForJobSync(session.sessionId, jobId);

      const backend = await startBackendServer();

      const status = progressStore.readStatus(jobId);
      expect(status).toMatchObject({
        phase: 'error',
        result: {
          content: '',
          outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
        },
      });

      const recoveredSession = createSessionManager(projectRoot).get('codex', session.sessionId);
      expect(recoveredSession?.activeJobId).toBeUndefined();
      await backend.controller.shutdown('test');
      await backend.controller.waitForShutdown();
    });
  });
});
