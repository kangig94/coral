import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage as ClientIncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import { join } from 'node:path';
import type { WaitStreamEvent } from '../../shared/types.js';
import type * as NodeOs from 'node:os';
import type * as ServerMod from '../server.js';
import type * as BackendInfoMod from '../../infra/backend-info.js';
import type * as BackendLockMod from '../backend-lock.js';
import type * as LifecycleMod from '../lifecycle.js';
import type { ProviderServerHandle } from '../engine.js';

import { readDiscussEventLog } from '../../client/readers.js';
import { makeEvent } from '../../discuss/events.js';
import { decideSessionCreate } from '../../discuss/state-machine.js';
import { createDiscussContextRegistry, getOrCreate as getOrCreateDiscussContext } from '../discuss/context-registry.js';
import { DiscussSessionStore } from '../discuss/session-store.js';
import { ProgressStore } from '../progress-store.js';
import { SessionIndex } from '../session-index.js';
import { SessionManager, listSessionShards } from '../session-manager.js';
import {
  discussEventLogPath,
  discussSourcesPath,
  pluginRootNamespace,
  projectDataDir,
  resolveProjectSource,
} from '../../infra/paths.js';
import type { BackendServerController } from '../server.js';
import type { HttpHandlerDeps, MutableBackendRuntimeState } from '../backend-contracts.js';
import type { LifecycleState } from '../server-types.js';
import type { PersistedLaunchRecord } from '../../shared/types.js';
import { domainError, domainSuccess, type ToolDomainResult } from '../tool-response.js';
import { LaunchCoordinator } from '../engine.js';
import { TypedEventBus } from '../event-bus.js';
import { createProviderHostManager } from '../host-manager.js';
import { createRealRuntime } from '../runtime.js';
import { ProviderRegistry } from '../../providers/registry.js';

const testBackendNamespace = pluginRootNamespace(process.cwd());
const foreignBackendNamespace = 'foreign-namespace-xyz';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-backend-test-tmp-${process.pid}-${Date.now()}`,
}));

const createdJobIds = new Set<string>();
let runtime: ReturnType<typeof createRealRuntime>;
let JOBS_DIR = '';

function jobResultPath(jobId: string): string {
  return join(JOBS_DIR, jobId, 'result.md');
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
type BackendInfoModule = typeof BackendInfoMod;
type BackendLockModule = typeof BackendLockMod;
type LifecycleModule = typeof LifecycleMod;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type FakeExecutionService = {
  start: ReturnType<typeof vi.fn>;
  resumeBySessionId: ReturnType<typeof vi.fn>;
  forkBySessionId: ReturnType<typeof vi.fn>;
  executeWorkflow: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
  waitStreamOnce: ReturnType<typeof vi.fn>;
};

function createFakeExecutionService(overrides: Partial<FakeExecutionService> = {}): FakeExecutionService {
  return {
    start: vi.fn(),
    resumeBySessionId: vi.fn(),
    forkBySessionId: vi.fn(),
    executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    waitStream: vi.fn(async function* (): AsyncGenerator<WaitStreamEvent> {
      yield {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 7,
        message: 'working',
      };
      yield {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: jobResultPath('job-1'),
        result: { content: 'done' },
      };
    }),
    waitStreamOnce: vi.fn(async () => ({
      type: 'timeout',
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

async function _waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function openHttpStream(
  url: string,
  headers: Record<string, string>,
): Promise<{
  response: ClientIncomingMessage;
  waitForText: (check: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
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
        close: () => {
          req.destroy();
          response.destroy();
        },
      });
    });
    req.end();
  });
}

async function loadExecutionModules(): Promise<{
  serverModule: ServerModule;
  backendInfo: BackendInfoModule;
  backendLock: BackendLockModule;
  lifecycleModule: LifecycleModule;
  infraPaths: typeof import('../../infra/paths.js');
}> {
  vi.resetModules();
  const [serverModule, backendInfo, backendLock, lifecycleModule, infraPaths] = await Promise.all([
    import('../server.js'),
    import('../../infra/backend-info.js'),
    import('../backend-lock.js'),
    import('../lifecycle.js'),
    import('../../infra/paths.js'),
  ]);
  return { serverModule, backendInfo, backendLock, lifecycleModule, infraPaths };
}

function stubLaunchRecord(
  progressStore: ProgressStore,
  overrides: {
    jobId: string;
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace: string;
    pool?: string;
  },
): void {
  const record: PersistedLaunchRecord = {
    jobId: overrides.jobId,
    sessionId: overrides.sessionId,
    provider: overrides.provider,
    projectRoot: overrides.projectRoot,
    backendNamespace: overrides.backendNamespace,
    pool: overrides.pool ?? 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: '',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date().toISOString(),
  };
  progressStore.writeLaunchRecord(overrides.jobId, record);
}

function stubRuntimeRecord(
  progressStore: ProgressStore,
  overrides: {
    jobId: string;
    pid?: number;
    stdoutPath?: string;
    stderrPath?: string;
    startTime?: string;
  },
): void {
  progressStore.writeRuntimeRecord(overrides.jobId, {
    pid: overrides.pid ?? process.pid,
    stdoutPath: overrides.stdoutPath ?? join(JOBS_DIR, overrides.jobId, 'stdout.log'),
    stderrPath: overrides.stderrPath ?? join(JOBS_DIR, overrides.jobId, 'stderr.log'),
    startTime: overrides.startTime ?? new Date().toISOString(),
  });
}

function parseToolData(result: ToolDomainResult): unknown {
  if (!result.ok) {
    throw new Error(`Unexpected tool error: ${result.code}`);
  }
  return result.data;
}

describe('execution backend server', () => {
  let controller: BackendServerController | null = null;
  const createdDiscussStores: DiscussSessionStore[] = [];

  beforeEach(() => {
    runtime = createRealRuntime();
    JOBS_DIR = runtime.storage.jobsDir();
    mkdirSync(mockState.tmpRoot, { recursive: true });
    rmSync(JOBS_DIR, { recursive: true, force: true });
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
  });

  afterEach(async () => {
    if (controller && controller.getLifecycle() !== 'stopped') {
      try {
        await controller.shutdown('test');
      } catch {
        /* best effort */
      }
    }
    controller = null;
    for (const store of createdDiscussStores.splice(0)) {
      store.dispose();
    }
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      rmSync(mockState.tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    rmSync(JOBS_DIR, { recursive: true, force: true });
    mockState.tmpHome = '';
  });

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
    };
  }

  function createRuntimeStateMock(): {
    runtimeState: MutableBackendRuntimeState;
    setLifecycle: ReturnType<typeof vi.fn>;
  } {
    let lifecycle: LifecycleState = 'starting';
    let startedAt = 0;
    let kbSubsystem: ReturnType<typeof createMockKbSubsystem> | null = null;
    let launchFenceActive = false;

    const runtimeState = {
      getLifecycle: () => lifecycle,
      getStartedAt: () => startedAt,
      getKbSubsystem: () => kbSubsystem as never,
      getLaunchFenceActive: () => launchFenceActive,
      setLifecycle: vi.fn((state: LifecycleState) => {
        lifecycle = state;
      }),
      setStartedAt: vi.fn((ts: number) => {
        startedAt = ts;
      }),
      setKbSubsystem: vi.fn((kb: ReturnType<typeof createMockKbSubsystem> | null) => {
        kbSubsystem = kb;
      }),
      getKbInitError: () => null,
      setKbInitError: vi.fn(),
      setLaunchFenceActive: vi.fn((active: boolean) => {
        launchFenceActive = active;
      }),
    } satisfies MutableBackendRuntimeState;

    return {
      runtimeState,
      setLifecycle: runtimeState.setLifecycle,
    };
  }

  async function startBackendServer(overrides: Parameters<ServerModule['createBackendServer']>[0] = {}) {
    const { serverModule, backendInfo, backendLock } = await loadExecutionModules();
    controller = serverModule.createBackendServer({
      instanceId: 'execution-backend-instance-1',
      token: 'test-token',
      version: '9.9.9',
      bundleHash: 'testhash1234',
      log: () => {},
      createKbSubsystemFn: async () => createMockKbSubsystem(),
      cleanupStaleJobsFn: () => {},
      ...overrides,
    });
    const started = await controller.start();
    return {
      controller,
      backendInfo,
      backendLock,
      started,
      baseUrl: `http://127.0.0.1:${started.port}`,
      token: started.token,
    };
  }

  function createProjectRoot(name: string): string {
    const projectRoot = join(mockState.tmpHome, name);
    mkdirSync(projectRoot, { recursive: true });
    return projectRoot;
  }

  function createDiscussStore(source: string): DiscussSessionStore {
    const store = new DiscussSessionStore(source);
    createdDiscussStores.push(store);
    return store;
  }

  it('defaults legacy backend info flavor to prod and preserves flavored writes', async () => {
    const { backendInfo } = await loadExecutionModules();
    const pluginRoot = createProjectRoot('backend-info-flavor');
    const namespace = pluginRootNamespace(pluginRoot);

    backendInfo.writeBackendInfo(pluginRoot, {
      pid: process.pid,
      port: 4100,
      host: '127.0.0.1',
      token: 'test-token',
      version: '9.9.9',
      bundleHash: 'testhash1234',
      flavor: 'dev',
      instanceId: 'backend-info-dev',
      namespace,
      startedAt: 1,
    });
    expect(backendInfo.readBackendInfo(pluginRoot)).toMatchObject({
      host: '127.0.0.1',
      flavor: 'dev',
      namespace,
    });

    writeFileSync(
      backendInfo.backendInfoPath(pluginRoot),
      JSON.stringify({
        pid: process.pid,
        port: 4101,
        token: 'legacy-token',
        version: '9.9.9',
        bundleHash: 'legacyhash1234',
        instanceId: 'backend-info-legacy',
        namespace,
        startedAt: 2,
      }),
      'utf-8',
    );
    expect(backendInfo.readBackendInfo(pluginRoot)).toMatchObject({
      host: '127.0.0.1',
      flavor: 'prod',
      namespace,
    });
  });

  it('returns 200 from /health with execution metadata', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
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
    expect((body as Record<string, unknown>).subsystems).toMatchObject({ kb: 'ok', discuss: 'ok' });
  });

  it('starts in degraded mode when KB init fails and reports kb unavailable in health', async () => {
    const backend = await startBackendServer({
      createKbSubsystemFn: async () => {
        throw new Error('simulated KB init failure');
      },
    });

    const response = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    const subsystems = body.subsystems as Record<string, unknown>;
    expect(subsystems.kb).toBe('unavailable');
    expect(subsystems.kbError).toBe('simulated KB init failure');
  });

  it('includes active launches in active count', async () => {
    const launchCoordinator = createLaunchCoordinator();
    const backend = await startBackendServer({ launchCoordinator });

    // Simulate two active launches via restoreActiveLaunch
    launchCoordinator.restoreActiveLaunch('job-1', 'codex');
    launchCoordinator.restoreActiveLaunch('job-2', 'codex');

    try {
      const response = await fetch(`${backend.baseUrl}/health`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
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
      import('../service.js'),
      import('../../providers/claude/request-mapping.js'),
      import('../../providers/codex/request-mapping.js'),
    ]);
    const progressStore = new ProgressStore('test-ns', runtime);
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
    progressStore.markTerminalStatus(jobIdA, { content: 'done-a' }, 'completed');

    progressStore.initJob({
      jobId: jobIdB,
      sessionId: 'session-b',
      provider: 'codex',
      projectRoot: projectRootB,
      backendNamespace: testBackendNamespace,
      initialPhase: 'running',
    });
    progressStore.markTerminalStatus(jobIdB, { content: 'done-b' }, 'completed');

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
    const providerHostManager = createProviderHostManager({ runtime,
      spawnProviderServer,
    });
    controller = serverModule.createBackendServer({
      instanceId: 'execution-backend-instance-1',
      token: 'test-token',
      version: '9.9.9',
      bundleHash: 'testhash1234',
      log: () => {},
      createKbSubsystemFn: async () => createMockKbSubsystem(),
      cleanupStaleJobsFn: () => {},
      progressStore,
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

    const claudeSpec = claudeRequestMapping.buildClaudeProviderServerSpec();
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
    const progressStore = new ProgressStore('test-ns', runtime);
    const backend = await startBackendServer({
      progressStore,
    });

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

    const response = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      activeJobs: 1,
    });
  });

  it('runs KB initialization during startup before idle watching begins', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const createKbSubsystemFn = vi.fn(async () => ({
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
    }));

    await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
      createKbSubsystemFn,
    });

    expect(createKbSubsystemFn).toHaveBeenCalledTimes(1);
    const initOrder = createKbSubsystemFn.mock.invocationCallOrder.at(0);
    const watchOrder = fakeIdleTimer.startWatching.mock.invocationCallOrder.at(0);
    expect(initOrder).toBeDefined();
    expect(watchOrder).toBeDefined();
    expect(initOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(watchOrder ?? Number.POSITIVE_INFINITY);
  });

  it('sets the settled build flavor before KB initialization starts', async () => {
    const { serverModule, infraPaths } = await loadExecutionModules();
    const pluginRoot = createProjectRoot('kb-init-build-flavor');
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'testhash1234', flavor: 'dev' }),
      'utf-8',
    );

    const createKbSubsystemFn = vi.fn(async () => {
      expect(infraPaths.currentBuildFlavor()).toBe('dev');
      return createMockKbSubsystem();
    });

    controller = serverModule.createBackendServer({
      pluginRoot,
      instanceId: 'execution-backend-instance-1',
      token: 'test-token',
      version: '9.9.9',
      bundleHash: 'testhash1234',
      log: () => {},
      createKbSubsystemFn,
      cleanupStaleJobsFn: () => {},
    });

    const started = await controller.start();

    expect(started.flavor).toBe('dev');
    expect(createKbSubsystemFn).toHaveBeenCalledTimes(1);
  });

  it('recovers discuss-only sources from the durable source registry before idle watching starts', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const projectRoot = createProjectRoot('discuss-only-project');
    const store = createDiscussStore(resolveProjectSource(projectRoot));
    const created = decideSessionCreate(
      {
        topic: 'Should the city pedestrianize the downtown core?',
        min_bid_delay_ms: 0,
        agents: [
          { name: 'alpha', persona: '# Alpha', participation: 'required' },
          { name: 'beta', persona: '# Beta', participation: 'required' },
        ],
      },
      'discuss-only-session',
      projectRoot,
      'Should the city pedestrianize the downtown core?',
      1,
      '2026-03-11T00:00:00.000Z',
    );
    if (!created.ok) {
      throw new Error(created.error);
    }
    await store.append('discuss-only-session', null, created.value);
    store.flushDirtyIndexes();
    expect(existsSync(discussSourcesPath())).toBe(true);

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
    new SessionManager(projectRoot, runtime).allocate('codex', 'alpha', 'gpt-5', projectRoot, projectRoot);

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

  it('routes KB tool calls through direct handlers and catches errors', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/kb/entries?q=test`, {
      headers: {
        'X-Coral-Backend-Token': backend.token,
      },
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    // Mock KB subsystem has no real runtime, so the handler catches the error
    expect(body).toMatchObject({
      code: 'kb_error',
    });
  });

  it('returns verbose kb principles rows with deterministic note order and orphan warnings', async () => {
    const { handleKbPrinciples } = await import('../kb-tools.js');

    const response = await handleKbPrinciples({ query: 'contract', verbose: true, top_k: 5 }, {
      kb: {
        ensureIndex: vi.fn(async () => ({
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

  it('routes kb memo list and consolidated delete through the backend tool handlers', async () => {
    const backend = await startBackendServer();
    const projectRoot = join(mockState.tmpHome, 'project');
    const memoRoot = join(projectDataDir(projectRoot), 'memo');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(memoRoot, { recursive: true });
    const aMemo = join(memoRoot, 'a.md');
    const bMemo = join(memoRoot, 'b.md');
    writeFileSync(aMemo, 'Alpha summary\n', 'utf-8');
    writeFileSync(bMemo, 'Bravo summary\n', 'utf-8');
    utimesSync(aMemo, new Date('2026-03-24T00:00:00.000Z'), new Date('2026-03-24T00:00:00.000Z'));
    utimesSync(bMemo, new Date('2026-03-25T00:00:00.000Z'), new Date('2026-03-25T00:00:00.000Z'));

    const listResponse = await fetch(`${backend.baseUrl}/kb/memos?projectRoot=${encodeURIComponent(projectRoot)}`, {
      headers: {
        'X-Coral-Backend-Token': backend.token,
      },
    });

    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as Record<string, unknown>;
    expect(listBody).toEqual({
      memos: [
        { filename: 'b.md', summary: 'Bravo summary', createdAt: expect.any(String) },
        { filename: 'a.md', summary: 'Alpha summary', createdAt: expect.any(String) },
      ],
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

    const purgeResponse = await fetch(`${backend.baseUrl}/kb/memos?projectRoot=${encodeURIComponent(projectRoot)}&all=true`, {
      method: 'DELETE',
      headers: {
        'X-Coral-Backend-Token': backend.token,
      },
    });

    expect(purgeResponse.status).toBe(200);
    const purgeBody = (await purgeResponse.json()) as Record<string, unknown>;
    expect(purgeBody).toEqual({ deleted: 1 });
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

    function createHttpHandlerDeps(
      options: {
        kbSubsystem?: ReturnType<typeof createMockKbSubsystem> | null;
        launchFenceActive?: boolean;
        executionService?: FakeExecutionService;
        abortJobs?: HttpHandlerDeps['abortJobs'];
        scopeCheckJobs?: HttpHandlerDeps['scopeCheckJobs'];
        listDiscussSessions?: HttpHandlerDeps['listDiscussSessions'];
        loadDiscussDetail?: HttpHandlerDeps['loadDiscussDetail'];
      } = {},
    ) {
      const { runtimeState } = createRuntimeStateMock();
      const providerRegistry = new ProviderRegistry();
      providerRegistry.register({
        name: 'codex',
        execute: vi.fn(async () => ({ content: 'ok' })),
      });
      const executionService = options.executionService ?? createFakeExecutionService();
      runtimeState.setLifecycle('running');
      runtimeState.setLaunchFenceActive(options.launchFenceActive ?? false);
      runtimeState.setKbSubsystem(options.kbSubsystem === undefined ? createMockKbSubsystem() : options.kbSubsystem);

      const deps: HttpHandlerDeps = {
        identity: {
          pluginRoot: '/tmp/plugin',
          namespace: testBackendNamespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'execution-backend-instance-1',
          token: 'test-token',
          now: () => Date.now(),
          log: () => {},
        },
        runtime: { ids: runtime.ids, time: runtime.time },
        runtimeState,
        idleTimer: createFakeIdleTimer() as never,
        progressStore: new ProgressStore('test-ns', runtime),
        sessionIndex: new SessionIndex(runtime),
        activeLaunchCount: () => 0,
        queueDepth: () => 0,
        streamResponses: new Set(),
        coralEnvSnapshot: currentCoralEnvSnapshot(),
        resolveProjectSource: resolveProjectSource,
        isDrainRequested: () => false,
        requestDrain: () => {},
        getExecutionService: () => executionService as never,
        getDiscussContext: () => ({}) as never,
        providerRegistry,
        abortJobs: options.abortJobs ?? (() => ({ aborted: [], notFound: [] })),
        scopeCheckJobs: options.scopeCheckJobs ?? (() => ({ valid: [], missing: [], mismatch: [] })),
        subscribeBackendEvents: () => {},
        unsubscribeBackendEvents: () => {},
        liveDiscussCount: () => 0,
        listDiscussSessions: options.listDiscussSessions ?? (() => []),
        loadDiscussDetail: options.loadDiscussDetail ?? (() => null),
      };

      return { deps, runtimeState, executionService };
    }

    async function startHttpHandlerServer(
      deps: HttpHandlerDeps,
      createHttpHandlerFn?: typeof import('../http-handler.js').createHttpHandler,
    ) {
      const importedCreateHttpHandler = createHttpHandlerFn ?? (await import('../http-handler.js')).createHttpHandler;
      const handler = importedCreateHttpHandler(deps);
      const server = createServer((req, res) => {
        void handler(req, res);
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
        kbSubsystem?: ReturnType<typeof createMockKbSubsystem> | null;
        launchFenceActive?: boolean;
        executionService?: FakeExecutionService;
        abortJobs?: HttpHandlerDeps['abortJobs'];
        scopeCheckJobs?: HttpHandlerDeps['scopeCheckJobs'];
        listDiscussSessions?: HttpHandlerDeps['listDiscussSessions'];
        loadDiscussDetail?: HttpHandlerDeps['loadDiscussDetail'];
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
        handleKbNoteRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:note-read', slug })),
        handleKbSourceRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:source-read', slug })),
        handleKbCommunityRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:community-read', slug })),
        handleKbMemoRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:memo-read', slug })),
        handleKbPrincipleRead: vi.fn((slug: unknown) => domainSuccess({ route: 'kb:principle-read', slug })),
        handleKbPromote: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:promote', args })),
        handleKbUpdate: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:update', args })),
        handleKbDelete: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:delete', args })),
        handleKbSourceImport: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:source-import', args })),
        handleKbSourceList: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:source-list', args })),
        handleKbSourceDelete: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:source-delete', args })),
        handleKbReindex: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:reindex', args })),
        handleKbPrinciples: vi.fn(async (args: unknown) => domainSuccess({ route: 'kb:principles', args })),
        handleKbMemo: vi.fn((args: unknown) => domainSuccess({ route: 'kb:memo', args })),
        handleKbMemoList: vi.fn((args: unknown) => domainSuccess({ route: 'kb:memo-list', args })),
        handleKbMemoDeleteConsolidated: vi.fn((args: unknown) =>
          domainSuccess({ route: 'kb:memo-delete', args }),
        ),
        ...options.kbToolOverrides,
      };

      vi.doMock('../discuss/tools.js', () => discussTools);
      vi.doMock('../kb-tools.js', () => kbTools);

      const { createHttpHandler } = await import('../http-handler.js');
      const created = createHttpHandlerDeps(options);
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

    afterEach(() => {
      vi.doUnmock('../discuss/tools.js');
      vi.doUnmock('../kb-tools.js');
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
      const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

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
        expect(started.kbTools.handleKbSearch).toHaveBeenCalledWith(
          { query: 'contracts', scope: 'notes', top_k: 5 },
          kbSubsystem,
        );
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
          expect(started.kbTools.handleKbNoteRead).toHaveBeenCalledWith(
            'contracts/overview',
            expect.objectContaining({
              projectRoot: '',
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
      const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expectedBody);
        const handler = started.kbTools[handlerName as keyof typeof started.kbTools];
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expectedBody.slug, kbSubsystem);
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
      const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

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
        expect(started.kbTools.handleKbSourceList).toHaveBeenCalledWith({}, kbSubsystem);
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes GET /kb/principles with typed query coercion', async () => {
      const started = await startMockedRouteServer();
      const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

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
        expect(started.kbTools.handleKbPrinciples).toHaveBeenCalledWith(
          { query: 'contract', top_k: 5, verbose: true },
          kbSubsystem,
        );
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
        callShape: 'args-kb-context',
      },
      {
        name: 'source create',
        path: '/kb/sources',
        args: { slug: 'slug', stagedPath: '/tmp/staged.md' },
        expectedStatus: 201,
        expectedBody: {
          route: 'kb:source-import',
          args: { slug: 'slug', stagedPath: '/tmp/staged.md' },
        },
        handlerName: 'handleKbSourceImport',
        callShape: 'args-kb',
      },
      {
        name: 'reindex',
        path: '/kb/index',
        args: {},
        expectedStatus: 200,
        expectedBody: {
          route: 'kb:reindex',
          args: {},
        },
        handlerName: 'handleKbReindex',
        callShape: 'args-kb',
      },
    ])('routes KB write routes for $name', async ({ path, args, expectedStatus, expectedBody, handlerName, callShape }) => {
      await withBaseCoralEnv(async () => {
        const started = await startMockedRouteServer();
        const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

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
          if (callShape === 'args-kb') {
            expect(call?.[1]).toBe(kbSubsystem);
            return;
          }
          expect(call?.[1]).toBe(kbSubsystem);
          expect(call?.[2]).toMatchObject({
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
      const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

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
          kbSubsystem,
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
      const kbSubsystem = started.deps.runtimeState.getKbSubsystem();

      try {
        const response = await fetch(`${started.baseUrl}${path}`, {
          method: 'DELETE',
          headers: { 'X-Coral-Backend-Token': 'test-token' },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expectedBody);
        const handler = started.kbTools[handlerName as keyof typeof started.kbTools];
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expectedBody.args, kbSubsystem);
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
          expect(await response.json()).toEqual({
            code: 'invalid_request',
            message: 'invalid request',
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
        args: { topic: 'Should we ship?', agents: [] },
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

    it('returns kb_unavailable when the KB subsystem is not initialized', async () => {
      const { deps } = createHttpHandlerDeps({ kbSubsystem: null });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/kb/entries?q=contracts`, {
          headers: {
            'X-Coral-Backend-Token': 'test-token',
          },
        });

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          code: 'kb_unavailable',
          message: 'Knowledge base is not available. Check backend health for details.',
        });
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
          headers: body === undefined
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
          error: 'not_found',
        });

        expect(kbResponse.status).toBe(404);
        expect(await kbResponse.json()).toEqual({
          error: 'not_found',
        });
      } finally {
        await _closeHttpServer(started.server);
      }
    });

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

    it('routes POST /sessions/:id/messages through service.resumeBySessionId', async () => {
      const fakeService = createFakeExecutionService({
        resumeBySessionId: vi.fn(async () => ({ status: 'queued', job: 'job-message', session: 'session-1' })),
      });
      const { deps } = createHttpHandlerDeps({ executionService: fakeService });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/sessions/session-1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            prompt: 'continue',
            projectRoot: '/tmp/project',
            model: 'gpt-5',
            workDir: '/tmp/work',
            bypassPermissions: true,
            systemPrompt: 'continue-system',
          }),
        });

        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({
          session: 'session-1',
          job: 'job-message',
          launchState: 'queued',
        });
        expect(fakeService.resumeBySessionId).toHaveBeenCalledWith(
          {
            sessionId: 'session-1',
            prompt: 'continue',
            model: 'gpt-5',
            cwd: '/tmp/work',
            bypassPermissions: true,
            systemPrompt: 'continue-system',
          },
          expect.objectContaining({
            projectRoot: '/tmp/project',
            pluginRoot: '/tmp/plugin',
          }),
        );
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('routes POST /sessions/:id/forks through service.forkBySessionId', async () => {
      const fakeService = createFakeExecutionService({
        forkBySessionId: vi.fn(async () => ({ status: 'running', job: 'job-fork', session: 'session-child' })),
      });
      const { deps } = createHttpHandlerDeps({ executionService: fakeService });
      const started = await startHttpHandlerServer(deps);

      try {
        const response = await fetch(`${started.baseUrl}/sessions/session-parent/forks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test-token',
          },
          body: JSON.stringify({
            prompt: 'branch',
            projectRoot: '/tmp/project',
            model: 'gpt-5',
            workDir: '/tmp/work',
            bypassPermissions: false,
            systemPrompt: 'fork-system',
          }),
        });

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
          session: 'session-child',
          job: 'job-fork',
          launchState: 'running',
        });
        expect(fakeService.forkBySessionId).toHaveBeenCalledWith(
          {
            sessionId: 'session-parent',
            prompt: 'branch',
            model: 'gpt-5',
            cwd: '/tmp/work',
            bypassPermissions: false,
            systemPrompt: 'fork-system',
          },
          expect.objectContaining({
            projectRoot: '/tmp/project',
            pluginRoot: '/tmp/plugin',
          }),
        );
      } finally {
        await _closeHttpServer(started.server);
      }
    });

    it('maps workflow camelCase request fields before calling executeWorkflow', async () => {
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
              start_prompt: 'Begin',
              provider: 'codex',
              work_dir: '/tmp/workflow',
              owner: 'team-a',
            },
            expect.objectContaining({
              projectRoot: '/tmp/project',
              pluginRoot: '/tmp/plugin',
              coralEnv: expect.objectContaining({
                CORAL_TEST_HTTP_BASE: 'daemon-base',
                CORAL_OWNER: 'team-a',
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

  it('streams SSE wait events and closes after terminal completion for found/missing mixes', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = new ProgressStore('test-ns', runtime);
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
      progressStore,
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

    const firstIdLine = body.split('\n').find((line) => line.startsWith('id: '));
    expect(firstIdLine).toBeTruthy();
    const encodedCursor = firstIdLine?.slice(4) ?? '';
    expect(JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf-8'))).toEqual({
      jobs: { 'job-1': 7 },
    });
    expect(fakeService.waitStream).toHaveBeenCalledWith({
      jobIds: ['job-1', 'missing-job'],
      timeoutSeconds: 1,
      cursor: { jobs: {} },
      projectRoot: '/tmp/project',
    });
  });

  it('streams passive dashboard SSE events and applies the optional job filter', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const eventBus = new TypedEventBus();
    const backend = await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
      eventBus,
    });

    const stream = await openHttpStream(`${backend.baseUrl}/events/stream?filter=job:job-1`, {
      'X-Coral-Backend-Token': backend.token,
    });

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
      eventBus.emit('session:updated', {
        sessionId: 'session-1',
        shardHash: 'abc123',
        version: 2,
        projectRoot: '/tmp/project',
      });

      const eventChunk = await stream.waitForText(
        (text) => text.includes('event: job:created') && text.includes('event: session:updated'),
      );

      expect(eventChunk).toContain('"jobId":"job-1"');
      expect(eventChunk).not.toContain('"jobId":"job-2"');
      expect(eventChunk).toContain('"sessionId":"session-1"');
      expect(fakeIdleTimer.beginRequest).not.toHaveBeenCalled();
      expect(fakeIdleTimer.endRequest).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });

  it('lists jobs and returns replayed job detail', async () => {
    const progressStore = new ProgressStore('test-ns', runtime);
    const backend = await startBackendServer({
      progressStore,
    });

    createdJobIds.add('job-1');
    createdJobIds.add('job-2');
    progressStore.initJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: testBackendNamespace,
    });
    progressStore.appendProgress('job-1', 'session-1', 'working');
    progressStore.appendTerminal('job-1', 'session-1', { content: 'done' }, 'completed');
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

    const jobsResponse = await fetch(`${backend.baseUrl}/api/jobs`, {
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
            phase: 'launching',
          }),
        },
      ]),
    );

    const detailResponse = await fetch(`${backend.baseUrl}/api/jobs/job-1`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const detailBody = (await detailResponse.json()) as {
      status: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };

    expect(detailResponse.status).toBe(200);
    expect(detailBody.status).toMatchObject({
      jobId: 'job-1',
      phase: 'completed',
      result: { content: 'done' },
    });
    expect(detailBody.events).toHaveLength(2);
    expect(detailBody.events[0]).toMatchObject({
      eventId: 1,
      type: 'progress',
    });
    expect(String(detailBody.events[0].message)).toContain('working');
    expect(detailBody.events[1]).toMatchObject({
      eventId: 2,
      type: 'terminal',
      result: { content: 'done' },
    });

    const missingResponse = await fetch(`${backend.baseUrl}/api/jobs/missing-job`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      code: 'job_not_found',
      message: 'Job not found: missing-job',
    });
  });

  describe('/api/jobs phase filter', () => {
    it('filters collection responses by phase and preserves job detail lookups', async () => {
      const fakeService = createFakeExecutionService();
      const progressStore = new ProgressStore('test-ns', runtime);
      const backend = await startBackendServer({
        createExecutionService: () => fakeService as never,
        progressStore,
      });

      createdJobIds.add('job-running');
      createdJobIds.add('job-queued');
      createdJobIds.add('job-completed');

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
        provider: 'codex',
        projectRoot: '/tmp/project',
        backendNamespace: testBackendNamespace,
      });
      progressStore.appendTerminal('job-completed', 'session-completed', { content: 'done' }, 'completed');

      const allResponse = await fetch(`${backend.baseUrl}/api/jobs`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const allBody = (await allResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(allResponse.status).toBe(200);
      expect(allBody.jobs.map((job) => job.jobId).sort()).toEqual(['job-completed', 'job-queued', 'job-running']);

      const runningResponse = await fetch(`${backend.baseUrl}/api/jobs?phase=running`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const runningBody = (await runningResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(runningResponse.status).toBe(200);
      expect(runningBody.jobs).toEqual([
        {
          jobId: 'job-running',
          status: expect.objectContaining({
            jobId: 'job-running',
            phase: 'running',
          }),
        },
      ]);

      const queuedResponse = await fetch(`${backend.baseUrl}/api/jobs?phase=queued`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const queuedBody = (await queuedResponse.json()) as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(queuedResponse.status).toBe(200);
      expect(queuedBody.jobs).toEqual([
        {
          jobId: 'job-queued',
          status: expect.objectContaining({
            jobId: 'job-queued',
            phase: 'queued',
          }),
        },
      ]);

      const detailResponse = await fetch(`${backend.baseUrl}/api/jobs/job-completed`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const detailBody = (await detailResponse.json()) as {
        status: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };

      expect(detailResponse.status).toBe(200);
      expect(detailBody.status).toMatchObject({
        jobId: 'job-completed',
        phase: 'completed',
        result: { content: 'done' },
      });
      expect(detailBody.events).toEqual([
        expect.objectContaining({
          eventId: 1,
          type: 'terminal',
          result: { content: 'done' },
        }),
      ]);
    });
  });

  it('lists only authoritative in-namespace sessions from /sessions and skips corrupt entries', async () => {
    const projectRoot = createProjectRoot('session-project');
    const foreignProjectRoot = createProjectRoot('foreign-session-project');
    const visible = new SessionManager(projectRoot, runtime).allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: testBackendNamespace,
    });
    new SessionManager(foreignProjectRoot, runtime).allocate({
      provider: 'codex',
      name: 'foreign',
      model: 'gpt-5',
      cwd: foreignProjectRoot,
      projectRoot: foreignProjectRoot,
      backendNamespace: foreignBackendNamespace,
    });
    new SessionManager(projectRoot, runtime).allocate('codex', 'legacy', 'gpt-5', projectRoot, projectRoot);
    const [shardDir] = listSessionShards(runtime.storage);
    writeFileSync(join(shardDir, 'corrupt.json'), '{not-json', 'utf-8');

    const backend = await startBackendServer();
    const response = await fetch(`${backend.baseUrl}/sessions`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = (await response.json()) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.sessions).toEqual([
      expect.objectContaining({
        sessionId: visible.sessionId,
        provider: 'codex',
        state: 'pending',
        backendNamespace: testBackendNamespace,
        provenanceState: 'authoritative',
      }),
    ]);
  });

  it('maps provider-less continuation errors on the new session routes', async () => {
    const projectRoot = createProjectRoot('continuation-project');
    const foreignProjectRoot = createProjectRoot('continuation-foreign-project');
    const foreign = new SessionManager(foreignProjectRoot, runtime).allocate({
      provider: 'codex',
      name: 'foreign',
      model: 'gpt-5',
      cwd: foreignProjectRoot,
      projectRoot: foreignProjectRoot,
      backendNamespace: testBackendNamespace,
    });
    const legacy = new SessionManager(projectRoot, runtime).allocate('codex', 'legacy', 'gpt-5', projectRoot, projectRoot);

    const backend = await startBackendServer();
    const [missingResponse, mismatchResponse, legacyResponse] = await Promise.all([
      fetch(`${backend.baseUrl}/sessions/missing-session/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': backend.token,
        },
        body: JSON.stringify({
          prompt: 'continue',
          projectRoot,
        }),
      }),
      fetch(`${backend.baseUrl}/sessions/${foreign.sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': backend.token,
        },
        body: JSON.stringify({
          prompt: 'continue',
          projectRoot,
        }),
      }),
      fetch(`${backend.baseUrl}/sessions/${legacy.sessionId}/forks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': backend.token,
        },
        body: JSON.stringify({
          prompt: 'branch',
          projectRoot,
        }),
      }),
    ]);

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ code: 'session_not_found' });

    expect(mismatchResponse.status).toBe(403);
    expect(await mismatchResponse.json()).toMatchObject({ code: 'scope_mismatch' });

    expect(legacyResponse.status).toBe(409);
    expect(await legacyResponse.json()).toMatchObject({ code: 'legacy_session_unsupported' });
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

  it('returns 403 before streaming when /jobs/wait includes cross-project jobs', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = new ProgressStore('test-ns', runtime);
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
      progressStore,
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
    const projectA = createProjectRoot('project-a');
    const projectB = createProjectRoot('project-b');
    const sessionA = new SessionManager(projectA, runtime).allocate('codex', 'alpha', 'gpt-5', projectA);
    const sessionB = new SessionManager(projectB, runtime).allocate('codex', 'beta', 'gpt-5', projectB);

    new SessionManager(projectA, runtime).claimForJobSync(sessionA.sessionId, 'missing-job-a');
    new SessionManager(projectB, runtime).claimForJobSync(sessionB.sessionId, 'missing-job-b');

    await startBackendServer();

    expect(new SessionManager(projectA, runtime).get('codex', sessionA.sessionId)).toMatchObject({
      sessionId: sessionA.sessionId,
      lastJobId: 'missing-job-a',
    });
    expect(new SessionManager(projectA, runtime).get('codex', sessionA.sessionId)?.activeJobId).toBeUndefined();

    expect(new SessionManager(projectB, runtime).get('codex', sessionB.sessionId)).toMatchObject({
      sessionId: sessionB.sessionId,
      lastJobId: 'missing-job-b',
    });
    expect(new SessionManager(projectB, runtime).get('codex', sessionB.sessionId)?.activeJobId).toBeUndefined();
  });

  it('releases terminal session claims even when the referenced job dir exists', async () => {
    const progressStore = new ProgressStore('test-ns', runtime);
    const projectRoot = createProjectRoot('project-existing-job');
    const session = new SessionManager(projectRoot, runtime).allocate('codex', 'alpha', 'gpt-5', projectRoot);
    const jobId = 'completed-job';

    createdJobIds.add(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: testBackendNamespace,
    });
    progressStore.updatePhase(jobId, 'completed');
    new SessionManager(projectRoot, runtime).claimForJobSync(session.sessionId, jobId);

    await startBackendServer({ progressStore });

    // Terminal jobs should have their session claims released during startup recovery
    const recoveredSession = new SessionManager(projectRoot, runtime).get('codex', session.sessionId);
    expect(recoveredSession?.activeJobId).toBeUndefined();
    expect(recoveredSession?.lastJobId).toBe(jobId);
  });

  it('recovers orphaned workflow jobs with an empty artifact, workflow marker, and released session claim', async () => {
    const progressStore = new ProgressStore('test-ns', runtime);
    const jobId = 'workflow-orphan-job';
    const projectRoot = createProjectRoot('workflow-project');
    const session = new SessionManager(projectRoot, runtime).allocate('codex', 'workflow-session', 'gpt-5', projectRoot);

    createdJobIds.add(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: testBackendNamespace,
      jobKind: 'workflow',
    });
    progressStore.updatePhase(jobId, 'running');
    new SessionManager(projectRoot, runtime).claimForJobSync(session.sessionId, jobId);

    const backend = await startBackendServer({ progressStore });
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
    const recoveredSession = new SessionManager(projectRoot, runtime).get('codex', session.sessionId);

    expect(response.status).toBe(200);
    expect(body).toContain('event: terminal');
    expect(body).toContain(`"resultPath":"${jobResultPath(jobId)}"`);
    expect(body).toContain('"workflow":{"steps":[]}');
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('');
    expect(status).toMatchObject({
      phase: 'error',
      jobKind: 'workflow',
      result: {
        content: '',
        notice: 'Incompatible job format — missing durable launch record. Job predates the handoff recovery system.',
        workflow: { steps: [] },
      },
    });
    expect(recoveredSession?.activeJobId).toBeUndefined();
    expect(recoveredSession?.lastJobId).toBe(jobId);
  });

  it('returns 200 from /admin/shutdown with draining status and shuts down when idle', async () => {
    const pluginRoot = createProjectRoot('plugin-root');
    const backend = await startBackendServer({ pluginRoot });

    const response = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('draining');
    expect(typeof body.instanceId).toBe('string');

    // Backend is idle (no active jobs in test), so drain fires promptly
    await backend.controller.waitForShutdown();

    expect(backend.controller.getLifecycle()).toBe('stopped');
    expect(existsSync(backend.backendInfo.backendInfoPath(pluginRoot))).toBe(false);
    expect(existsSync(backend.backendLock.backendLockPath(pluginRoot))).toBe(false);
  });

  it('drains shutdown when only foreign namespace live jobs remain', async () => {
    const progressStore = new ProgressStore('test-ns', runtime);
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

    const backend = await startBackendServer({ pluginRoot, progressStore });
    const statusBeforeShutdown = progressStore.readStatus(foreignJobId);

    expect(statusBeforeShutdown).toMatchObject({
      jobId: foreignJobId,
      phase: 'running',
      backendNamespace: foreignBackendNamespace,
    });
    expect(progressStore.liveJobCount('testhash1234')).toBe(0);

    const response = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
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
      phase: 'running',
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
      headers: { 'X-Coral-Backend-Token': backend.token },
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
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>).status).toBe('draining');

    const second = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>).status).toBe('draining');

    idleTimer.endRequest();
    await backend.controller.waitForShutdown();
  });

  it('returns 401 for unauthorized requests', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
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

    it('handoff finalizes live app-server jobs before draining provider servers', async () => {
      const { lifecycleModule } = await loadExecutionModules();
      const pluginRoot = createProjectRoot('handoff-app-server-finalization');
      const namespace = pluginRootNamespace(pluginRoot);
      const progressStore = new ProgressStore('test-ns', runtime);
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
      progressStore.writeRuntimeRecord(jobId, {
        transport: 'app-server',
        startTime: '2026-03-31T00:00:00.000Z',
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          providerContinuity: {
            provider: 'codex',
            threadId: 'thread-1',
          },
          recoveryPolicy: 'session_continuity_only',
        },
      });

      const fakeService = {
        finalizeInterruptedAppServerJob: vi.fn(async () => {}),
      };
      const providerHostManager = createFakeProviderHostManager();
      const fakeIdleTimer = createFakeIdleTimer();
      const { runtimeState } = createRuntimeStateMock();
      runtimeState.setLifecycle('running');

      const controller = lifecycleModule.createLifecycle({
        identity: {
          pluginRoot,
          namespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'handoff-instance-1',
          token: 'test-token',
          now: () => 1,
          log: () => {},
        },
        runtime: createRealRuntime(),
        backendPid: 1234,
        runtimeState,
        idleTimer: fakeIdleTimer as never,
        progressStore,
        sessionIndex: {
          hydrate: vi.fn(),
          hasShard: vi.fn(() => true),
          discoverShard: vi.fn(),
          invalidate: vi.fn(),
        } as never,
        streamResponses: new Set(),
        discussStores: new Map(),
        discussRegistry: createDiscussContextRegistry(),
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
        acquireLockFn: async () => {},
        writeBackendInfoFn: vi.fn(),
        removeBackendInfoIfOwnerFn: () => {},
        removeLockIfOwnerFn: () => {},
        cleanupStaleJobsFn: () => {},
        markJobsAsErrorFn: vi.fn(),
        terminateAllFn: vi.fn(),
        providerHostManager: providerHostManager as never,
        createKbSubsystemFn: async () => createMockKbSubsystem(),
        registerBuiltInProvidersFn: () => {},
        recoverPersistedDiscussFn: async () => [],
        closeServerFn: async () => {},
        listenFn: async () => ({ port: 4102, host: '127.0.0.1' }),
      });

      await controller.shutdown('replaced');
      await controller.waitForShutdown();

      expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
        expect.objectContaining({ jobId }),
        expect.objectContaining({
          transport: 'app-server',
          providerMeta: expect.objectContaining({
            providerContinuity: expect.objectContaining({ threadId: 'thread-1' }),
          }),
        }),
        { reason: 'handoff' },
      );
      expect(providerHostManager.drainForHandoff).toHaveBeenCalledTimes(1);
      const finalizeOrder = fakeService.finalizeInterruptedAppServerJob.mock.invocationCallOrder.at(0);
      const drainOrder = providerHostManager.drainForHandoff.mock.invocationCallOrder.at(0);
      expect(finalizeOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(drainOrder ?? Number.POSITIVE_INFINITY);
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
      const source = resolveProjectSource(projectRoot);
      const store = createDiscussStore(source);

      const startupCandidateCreated = decideSessionCreate(
        {
          topic,
          min_bid_delay_ms: 0,
          agents: [
            { name: 'alpha', persona: '# Alpha', participation: 'required' },
            { name: 'beta', persona: '# Beta', participation: 'required' },
          ],
        },
        'startup-candidate',
        projectRoot,
        topic,
        1,
        '2026-03-11T00:00:00.000Z',
      );
      if (!startupCandidateCreated.ok) {
        throw new Error(startupCandidateCreated.error);
      }
      await store.append('startup-candidate', null, startupCandidateCreated.value);

      const terminalHistoryCreated = decideSessionCreate(
        {
          topic,
          min_bid_delay_ms: 0,
          agents: [
            { name: 'alpha', persona: '# Alpha', participation: 'required' },
            { name: 'beta', persona: '# Beta', participation: 'required' },
          ],
        },
        'terminal-history',
        projectRoot,
        topic,
        1,
        '2026-03-11T00:05:00.000Z',
      );
      if (!terminalHistoryCreated.ok) {
        throw new Error(terminalHistoryCreated.error);
      }
      const terminalCreatedSnapshot = await store.append('terminal-history', null, terminalHistoryCreated.value);
      await store.append('terminal-history', terminalCreatedSnapshot.lastAppliedSeq, [
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
      ]);
      store.flushDirtyIndexes();
      expect(existsSync(discussSourcesPath())).toBe(true);

      const startupBlocked = createDeferred();
      const releaseStartup = createDeferred();
      const startupRegistry = createDiscussContextRegistry();

      controller = serverModule.createBackendServer({
        instanceId: 'execution-backend-instance-1',
        token: 'test-token',
        version: '9.9.9',
        bundleHash: 'testhash1234',
        log: () => {},
        createKbSubsystemFn: async () => createMockKbSubsystem(),
        cleanupStaleJobsFn: () => {},
        discussRegistry: startupRegistry,
        acquireLockFn: async () => {
          startupBlocked.resolve();
          await releaseStartup.promise;
          throw new Error('startup interrupted for shutdown test');
        },
      });

      const startPromise = controller.start().catch((error: unknown) => error);
      await startupBlocked.promise;
      await controller.shutdown('sigint');
      await controller.waitForShutdown();

      const startupCandidateEvents = readDiscussEventLog(
        discussEventLogPath(store.resolveSessionDir('startup-candidate')),
      );
      expect(startupCandidateEvents.at(-1)).toMatchObject({
        kind: 'session.ended',
        payload: { force: true, reason: 'abort' },
      });
      expect(store.load('startup-candidate')).toMatchObject({
        state: { status: 'ended' },
        runtime: { controlPhase: 'synthesize' },
      });

      const terminalHistoryEvents = readDiscussEventLog(
        discussEventLogPath(store.resolveSessionDir('terminal-history')),
      );
      expect(terminalHistoryEvents.filter((event) => event.kind === 'session.ended')).toHaveLength(1);
      expect(terminalHistoryEvents.at(-1)?.kind).toBe('session.synthesized');
      expect(startupRegistry.contexts.size).toBe(0);

      releaseStartup.resolve();
      const startResult = await startPromise;
      expect(startResult).toBeInstanceOf(Error);

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

  describe('startup ordering', () => {
    it('drops the recovery registry before writing backend info', async () => {
      const { backendInfo, lifecycleModule } = await loadExecutionModules();
      const pluginRoot = createProjectRoot('lifecycle-publish-order');
      const namespace = pluginRootNamespace(pluginRoot);
      const progressStore = new ProgressStore('test-ns', runtime);
      const jobId = 'queued-adoption-before-publish';
      createdJobIds.add(jobId);
      progressStore.initJob({
        jobId,
        sessionId: 'queued-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
        initialPhase: 'queued',
      });
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: 'queued-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
      });

      const fakeService = {
        adoptRunningJob: vi.fn(() => ({ cleanup: vi.fn() })),
        recoverQueuedJob: vi.fn(() => jobId),
        completeRecoveredJob: vi.fn(),
      };
      const fakeIdleTimer = createFakeIdleTimer();
      const { runtimeState } = createRuntimeStateMock();
      const sessionIndex = {
        hydrate: vi.fn(),
        hasShard: vi.fn(() => true),
        discoverShard: vi.fn(),
        invalidate: vi.fn(),
      };
      const providerHostManager = createFakeProviderHostManager();
      // eslint-disable-next-line prefer-const -- circular: writeBackendInfoFn closure reads controller, but controller assignment needs writeBackendInfoFn
      let controller!: ReturnType<LifecycleModule['createLifecycle']>;
      const writeBackendInfoFn = vi.fn((root: string, info: Parameters<typeof backendInfo.writeBackendInfo>[1]) => {
        backendInfo.writeBackendInfo(root, info);
        expect(existsSync(backendInfo.backendInfoPath(root))).toBe(true);
        expect(controller.getRecoveryRegistry()).toBeNull();
      });

      controller = lifecycleModule.createLifecycle({
        identity: {
          pluginRoot,
          namespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'lifecycle-instance-1',
          token: 'test-token',
          now: () => 1,
          log: () => {},
        },
        runtime: createRealRuntime(),
        backendPid: 1234,
        runtimeState,
        idleTimer: fakeIdleTimer as never,
        progressStore,
        sessionIndex: sessionIndex as never,
        streamResponses: new Set(),
        discussStores: new Map(),
        discussRegistry: createDiscussContextRegistry(),
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
        acquireLockFn: async () => {},
        writeBackendInfoFn,
        removeBackendInfoIfOwnerFn: () => {},
        removeLockIfOwnerFn: () => {},
        cleanupStaleJobsFn: () => {},
        markJobsAsErrorFn: () => {},
        terminateAllFn: () => {},
        providerHostManager: providerHostManager as never,
        createKbSubsystemFn: async () => createMockKbSubsystem(),
        registerBuiltInProvidersFn: () => {},
        recoverPersistedDiscussFn: async () => [],
        closeServerFn: async () => {},
        listenFn: async () => ({ port: 4100, host: '127.0.0.1' }),
      });

      try {
        const started = await controller.start();

        expect(started.port).toBe(4100);
        expect(fakeService.recoverQueuedJob).toHaveBeenCalledWith(expect.objectContaining({ jobId }));
        expect(writeBackendInfoFn).toHaveBeenCalledTimes(1);
        const recoverOrder = fakeService.recoverQueuedJob.mock.invocationCallOrder.at(0);
        const publishOrder = writeBackendInfoFn.mock.invocationCallOrder.at(0);
        expect(recoverOrder).toBeDefined();
        expect(publishOrder).toBeDefined();
        expect(recoverOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(publishOrder ?? Number.POSITIVE_INFINITY);
        expect(controller.getRecoveryRegistry()).toBeNull();
      } finally {
        await controller.shutdown('test');
        await controller.waitForShutdown();
      }
    });

    it('routes recovered app-server jobs through continuity finalization instead of PID adoption', async () => {
      const { lifecycleModule } = await loadExecutionModules();
      const pluginRoot = createProjectRoot('startup-app-server-recovery');
      const namespace = pluginRootNamespace(pluginRoot);
      const progressStore = new ProgressStore('test-ns', runtime);
      const jobId = 'startup-app-server-job';
      createdJobIds.add(jobId);
      progressStore.initJob({
        jobId,
        sessionId: 'startup-app-server-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
        initialPhase: 'running',
      });
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: 'startup-app-server-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
      });
      progressStore.writeRuntimeRecord(jobId, {
        transport: 'app-server',
        startTime: '2026-03-31T00:00:00.000Z',
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          providerContinuity: {
            provider: 'codex',
            threadId: 'thread-1',
          },
          recoveryPolicy: 'session_continuity_only',
        },
      });

      const fakeService = {
        adoptRunningJob: vi.fn(() => ({ cleanup: vi.fn() })),
        finalizeInterruptedAppServerJob: vi.fn(async () => {}),
        recoverQueuedJob: vi.fn(),
        completeRecoveredJob: vi.fn(),
      };
      const providerHostManager = createFakeProviderHostManager();
      const fakeIdleTimer = createFakeIdleTimer();
      const { runtimeState } = createRuntimeStateMock();
      const sessionIndex = {
        hydrate: vi.fn(),
        hasShard: vi.fn(() => true),
        discoverShard: vi.fn(),
        invalidate: vi.fn(),
      };

      const controller = lifecycleModule.createLifecycle({
        identity: {
          pluginRoot,
          namespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'lifecycle-instance-app-server',
          token: 'test-token',
          now: () => 1,
          log: () => {},
        },
        runtime: createRealRuntime(),
        backendPid: 1234,
        runtimeState,
        idleTimer: fakeIdleTimer as never,
        progressStore,
        sessionIndex: sessionIndex as never,
        streamResponses: new Set(),
        discussStores: new Map(),
        discussRegistry: createDiscussContextRegistry(),
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
        acquireLockFn: async () => {},
        writeBackendInfoFn: vi.fn(),
        removeBackendInfoIfOwnerFn: () => {},
        removeLockIfOwnerFn: () => {},
        cleanupStaleJobsFn: () => {},
        markJobsAsErrorFn: () => {},
        terminateAllFn: () => {},
        providerHostManager: providerHostManager as never,
        createKbSubsystemFn: async () => createMockKbSubsystem(),
        registerBuiltInProvidersFn: () => {},
        recoverPersistedDiscussFn: async () => [],
        closeServerFn: async () => {},
        listenFn: async () => ({ port: 4103, host: '127.0.0.1' }),
      });

      try {
        await controller.start();

        expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
          expect.objectContaining({ jobId }),
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
        await controller.shutdown('test');
        await controller.waitForShutdown();
      }
    });

    it('stops the startup tail when shutdown begins during recovery adoption', async () => {
      const { lifecycleModule } = await loadExecutionModules();
      const discussLoop = await import('../discuss/loop.js');
      const resumeLoopSpy = vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
      const pluginRoot = createProjectRoot('startup-interrupted-during-adoption');
      const namespace = pluginRootNamespace(pluginRoot);
      const progressStore = new ProgressStore('test-ns', runtime);
      const jobId = 'running-adoption-job';
      createdJobIds.add(jobId);
      progressStore.initJob({
        jobId,
        sessionId: 'running-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
        initialPhase: 'running',
      });
      stubLaunchRecord(progressStore, {
        jobId,
        sessionId: 'running-session',
        provider: 'codex',
        projectRoot: pluginRoot,
        backendNamespace: namespace,
      });
      stubRuntimeRecord(progressStore, {
        jobId,
        pid: process.pid,
        startTime: '2026-03-11T00:00:00.000Z',
      });

      const topic = 'Should the city pedestrianize the downtown core?';
      const source = resolveProjectSource(pluginRoot);
      const store = createDiscussStore(source);
      const created = decideSessionCreate(
        {
          topic,
          min_bid_delay_ms: 0,
          agents: [
            { name: 'alpha', persona: '# Alpha', participation: 'required' },
            { name: 'beta', persona: '# Beta', participation: 'required' },
          ],
        },
        'recoverable-discuss',
        pluginRoot,
        topic,
        1,
        '2026-03-11T00:00:00.000Z',
      );
      if (!created.ok) {
        throw new Error(created.error);
      }
      await store.append('recoverable-discuss', null, created.value);
      store.flushDirtyIndexes();

      const fakeIdleTimer = createFakeIdleTimer();
      const { runtimeState, setLifecycle } = createRuntimeStateMock();
      const sessionIndex = {
        hydrate: vi.fn(),
        hasShard: vi.fn(() => true),
        discoverShard: vi.fn(),
        invalidate: vi.fn(),
      };
      const discussRegistry = createDiscussContextRegistry();
      const writeBackendInfoFn = vi.fn();
      // eslint-disable-next-line prefer-const -- circular: fakeService closure reads controller, but controller assignment needs fakeService
      let controller!: ReturnType<LifecycleModule['createLifecycle']>;
      const providerHostManager = createFakeProviderHostManager();
      const fakeService = {
        adoptRunningJob: vi.fn(() => {
          void controller.shutdown('sigint');
          return { cleanup: vi.fn() };
        }),
        recoverQueuedJob: vi.fn(),
        completeRecoveredJob: vi.fn(),
      };

      controller = lifecycleModule.createLifecycle({
        identity: {
          pluginRoot,
          namespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'lifecycle-instance-2',
          token: 'test-token',
          now: () => 1,
          log: () => {},
        },
        runtime: createRealRuntime(),
        backendPid: 1234,
        runtimeState,
        idleTimer: fakeIdleTimer as never,
        progressStore,
        sessionIndex: sessionIndex as never,
        streamResponses: new Set(),
        discussStores: new Map([[source, store]]),
        discussRegistry,
        eventBus: new TypedEventBus(),
        launchCoordinator: createLaunchCoordinator(),
        providerRegistry: new ProviderRegistry(),
        server: createServer(),
        getExecutionService: () => fakeService as never,
        getRecoveryService: () => fakeService as never,
        listExecutionServices: () => [fakeService as never],
        getDiscussStoreForSource: (requestedSource: string) => {
          if (requestedSource !== source) {
            throw new Error(`Unexpected discuss source: ${requestedSource}`);
          }
          return store;
        },
        knownDiscussSources: () => new Set([source]),
        getDiscussContext: (ctx) =>
          getOrCreateDiscussContext(discussRegistry, ctx.projectRoot, fakeService as never, store),
        acquireLockFn: async () => {},
        writeBackendInfoFn,
        removeBackendInfoIfOwnerFn: () => {},
        removeLockIfOwnerFn: () => {},
        cleanupStaleJobsFn: () => {},
        markJobsAsErrorFn: () => {},
        terminateAllFn: () => {},
        providerHostManager: providerHostManager as never,
        createKbSubsystemFn: async () => createMockKbSubsystem(),
        registerBuiltInProvidersFn: () => {},
        recoverPersistedDiscussFn: async () => [],
        closeServerFn: async () => {},
        listenFn: async () => ({ port: 4101, host: '127.0.0.1' }),
      });

      try {
        const startResult = await controller.start().catch((error: unknown) => error);
        await controller.waitForShutdown();

        expect(startResult).toBeInstanceOf(lifecycleModule.StartupInterruptedError);
        expect(fakeService.adoptRunningJob).toHaveBeenCalledTimes(1);
        expect(writeBackendInfoFn).not.toHaveBeenCalled();
        expect(setLifecycle).not.toHaveBeenCalledWith('running');
        expect(resumeLoopSpy).not.toHaveBeenCalled();
      } finally {
        await controller.waitForShutdown().catch(() => {});
      }
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
      const { createHttpHandler } = await import('../http-handler.js');
      const { runtimeState } = createRuntimeStateMock();
      const providerRegistry = new ProviderRegistry();
      providerRegistry.register({
        name: 'codex',
        execute: vi.fn(async () => ({ content: 'ok' })),
      });
      runtimeState.setLifecycle('running');
      runtimeState.setLaunchFenceActive(true);

      const deps: HttpHandlerDeps = {
        identity: {
          pluginRoot: '/tmp/plugin',
          namespace: testBackendNamespace,
          version: '9.9.9',
          bundleHash: 'testhash1234',
          flavor: 'prod',
          instanceId: 'execution-backend-instance-1',
          token: 'test-token',
          now: () => Date.now(),
          log: () => {},
        },
        runtime: { ids: runtime.ids, time: runtime.time },
        runtimeState,
        idleTimer: createFakeIdleTimer() as never,
        progressStore: new ProgressStore('test-ns', runtime),
        sessionIndex: new SessionIndex(runtime),
        activeLaunchCount: () => 0,
        queueDepth: () => 0,
        streamResponses: new Set(),
        coralEnvSnapshot: currentCoralEnvSnapshot(),
        resolveProjectSource: resolveProjectSource,
        isDrainRequested: () => false,
        requestDrain: () => {},
        getExecutionService: () => createFakeExecutionService() as never,
        getDiscussContext: () => ({}) as never,
        providerRegistry,
        abortJobs: () => ({ aborted: [], notFound: [] }),
        scopeCheckJobs: () => ({ valid: [], missing: [], mismatch: [] }),
        subscribeBackendEvents: () => {},
        unsubscribeBackendEvents: () => {},
        liveDiscussCount: () => 0,
        listDiscussSessions: () => [],
        loadDiscussDetail: () => null,
      };

      const server = createServer((req, res) => {
        void createHttpHandler(deps)(req, res);
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
        name: 'session message',
        path: '/sessions/session-1/messages',
        body: { prompt: 'hello', projectRoot: '/tmp/project' },
      },
      {
        name: 'session fork',
        path: '/sessions/session-1/forks',
        body: { prompt: 'hello', projectRoot: '/tmp/project' },
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
    it('classifies old-format jobs as incompatible', async () => {
      const progressStore = new ProgressStore('test-ns', runtime);
      const jobId = 'old-format-job';
      const projectRoot = createProjectRoot('old-format-project');
      const session = new SessionManager(projectRoot, runtime).allocate('codex', 'alpha', 'gpt-5', projectRoot);

      createdJobIds.add(jobId);
      // Create a job with live phase (running) but NO launch.json — old format
      progressStore.initJob({
        jobId,
        sessionId: session.sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: testBackendNamespace,
        initialPhase: 'running',
      });
      // Do NOT write launch.json — this is the old-format marker
      new SessionManager(projectRoot, runtime).claimForJobSync(session.sessionId, jobId);

      const _backend = await startBackendServer({ progressStore });

      // After recovery, the old-format job should be marked as error with the OLD_FORMAT_NOTICE
      const status = progressStore.readStatus(jobId);
      expect(status).toMatchObject({
        phase: 'error',
        result: {
          content: '',
          notice: 'Incompatible job format — missing durable launch record. Job predates the handoff recovery system.',
        },
      });

      // Session claim should be released
      const recoveredSession = new SessionManager(projectRoot, runtime).get('codex', session.sessionId);
      expect(recoveredSession?.activeJobId).toBeUndefined();
    });

    it('marks ghost launch jobs as error when runtime.json was never written', async () => {
      const progressStore = new ProgressStore('test-ns', runtime);
      const jobId = 'ghost-launch-job';
      const projectRoot = createProjectRoot('ghost-launch-project');
      const session = new SessionManager(projectRoot, runtime).allocate('codex', 'alpha', 'gpt-5', projectRoot);

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
      new SessionManager(projectRoot, runtime).claimForJobSync(session.sessionId, jobId);

      const backend = await startBackendServer({ progressStore });

      const status = progressStore.readStatus(jobId);
      expect(status).toMatchObject({
        phase: 'error',
        result: {
          content: '',
          notice:
            'Launch record exists but runtime.json was never written. The durable wrapper did not start successfully.',
        },
      });

      const recoveredSession = new SessionManager(projectRoot, runtime).get('codex', session.sessionId);
      expect(recoveredSession?.activeJobId).toBeUndefined();
      await backend.controller.shutdown('test');
      await backend.controller.waitForShutdown();
    });
  });
});
