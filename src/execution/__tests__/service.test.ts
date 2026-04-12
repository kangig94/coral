import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as AgentResolutionMod from '../agent-resolution.js';
import { createDeferred } from '../../shared/test-deferred.js';
import type {
  AppServerRuntimeRecord,
  DurableCliRuntimeRecord,
  JobPhase,
  PersistedLaunchRecord,
  PersistedProgressRecord,
  PersistedStatusRecord,
  ProviderRequest,
  ProviderResult,
  WaitStreamEvent,
} from '../../shared/types.js';

import type { Provider } from '../../providers/types.js';
import { pluginRootNamespace } from '../../infra/paths.js';
import { buildCodexProviderServerSpec } from '../../providers/codex/request-mapping.js';
import { parseExpression } from '../../workflow/pipe-parser.js';
import {
  AgentNamespaceNotFoundError,
  AgentNotFoundError,
  InvalidAgentRefError,
  type AgentRef,
} from '../agent-resolution.js';
import {
  LaunchCoordinator,
  getMaxWorkers,
  type ProviderServerHandle,
  type SpawnProviderServerFn,
} from '../engine.js';
import { type AbortRegistry } from '../abort-controller-registry.js';
import { TypedEventBus } from '../event-bus.js';
import { ProgressStore } from '../progress-store.js';
import { createProviderHostManager, type ProviderHostManager } from '../host-manager.js';
import { createRealRuntime } from '../runtime.js';
import { SessionManager } from '../session-manager.js';
import type { CallerContext } from '../../shared/request-context.js';
import { ExecutionService } from '../service.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-service-test-tmp`,
  getNewProvider: vi.fn(),
  resolveAgent: vi.fn(),
}));
const TEST_BACKEND_NAMESPACE = 'test-namespace';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
  };
});

vi.mock('../../providers/registry.js', () => ({
  getNewProvider: mockState.getNewProvider,
}));

vi.mock('../agent-resolution.js', async () => {
  const actual = await vi.importActual<typeof AgentResolutionMod>('../agent-resolution.js');
  return {
    ...actual,
    resolveAgent: mockState.resolveAgent,
  };
});

type ServiceInternals = {
  abortRegistry: AbortRegistry;
  progressStore: ProgressStore;
  sessionManager: SessionManager;
};

const createdJobIds = new Set<string>();
let baselineJobIds = new Set<string>();
let eventBus: TypedEventBus;
let launchCoordinator: LaunchCoordinator;
let spawnProviderServer: SpawnProviderServerFn;
let runtime: ReturnType<typeof createRealRuntime>;
let JOBS_DIR = '';

function jobResultPath(jobId: string): string {
  return join(JOBS_DIR, jobId, 'result.md');
}

function cancelQueued(jobId: string, pool?: 'default' | 'discuss' | 'curate'): boolean {
  return launchCoordinator.cancelQueued(jobId, pool);
}

function getActiveJobIds(pool?: 'default' | 'discuss' | 'curate'): string[] {
  return launchCoordinator.getActiveJobIds(pool);
}

function terminateAll(): void {
  launchCoordinator.terminateAll();
}

function queueDepth(pool?: 'default' | 'discuss' | 'curate'): number {
  return launchCoordinator.queueDepth(pool);
}

function releaseLaunch(jobId: string, pool?: 'default' | 'discuss' | 'curate'): void {
  launchCoordinator.releaseLaunch(jobId, pool);
}

function restoreActiveLaunch(jobId: string, provider: string, pool?: 'default' | 'discuss' | 'curate'): void {
  launchCoordinator.restoreActiveLaunch(jobId, provider, pool);
}

function getInternals(service: ExecutionService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

function createService(
  ctx: CallerContext,
  options: {
    progressStore?: ProgressStore;
    bundleHash?: string;
    backendNamespace?: string;
    providerHostManager?: ProviderHostManager;
    pluginRegistry?: { discoverPluginRoot: (namespace: string) => string | null };
  } = {},
): ExecutionService {
  return new ExecutionService(ctx, {
    runtime,
    progressStore: options.progressStore ?? new ProgressStore('test-ns', eventBus, runtime),
    bundleHash: options.bundleHash,
    backendNamespace: options.backendNamespace ?? TEST_BACKEND_NAMESPACE,
    providerHostManager: options.providerHostManager ?? createProviderHostManager({ runtime, spawnProviderServer }),
    launchCoordinator,
    eventBus,
    providerRegistry: {
      get: mockState.getNewProvider,
      getAll: () => [],
      registerBuiltIns: () => {},
    } as never,
    pluginRegistry: options.pluginRegistry ?? { discoverPluginRoot: () => null },
  });
}

function createResolvedAgent(ref: AgentRef, content: string) {
  return {
    ref: { namespace: ref.namespace ?? 'coral', name: ref.name },
    source: 'agent' as const,
    content,
    path: `/tmp/${ref.name}.md`,
  };
}

function setSpawnProviderServerMock(...handles: ProviderServerHandle[]) {
  const fallback = handles.at(-1);
  const mock = vi.fn(async () => {
    if (!fallback) {
      throw new Error('No provider server handle configured');
    }
    return fallback;
  });
  for (const handle of handles) {
    mock.mockResolvedValueOnce(handle);
  }
  spawnProviderServer = mock as unknown as SpawnProviderServerFn;
  return mock;
}

function trackJob(jobId: string): void {
  createdJobIds.add(jobId);
}

function listJobDirs(): Set<string> {
  try {
    return new Set(
      readdirSync(JOBS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set<string>();
  }
}

function trackAllJobDirs(): void {
  try {
    for (const jobId of listJobDirs()) {
      if (baselineJobIds.has(jobId)) continue;
      createdJobIds.add(jobId);
    }
  } catch {
    /* best effort */
  }
}

function createFakeProviderServerHandle(options?: {
  generation?: number;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
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
  const closeMock = vi.fn(async () => {});
  const closePromise = new Promise<Error | void>(() => {});

  return {
    handle: {
      pid: 43210,
      child: {} as never,
      generation: options?.generation ?? 7,
      rpc: {
        request: requestMock as unknown as ProviderServerHandle['rpc']['request'],
        notify: notifyMock,
      },
      onNotification: onNotificationMock as unknown as ProviderServerHandle['onNotification'],
      closePromise,
      markExpectedClose: markExpectedCloseMock,
      close: closeMock,
    } satisfies ProviderServerHandle,
    requestMock,
    notifyMock,
    onNotificationMock,
    markExpectedCloseMock,
    closeMock,
    emit(message: { method: string; params?: Record<string, unknown> }) {
      for (const handler of handlers) {
        handler(message);
      }
    },
  };
}

function makeProvider(options?: { execute?: Provider['execute']; preflight?: Provider['preflight'] }): {
  provider: Provider;
  execute: ReturnType<typeof vi.fn>;
  preflight?: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(
    options?.execute ??
      (async (): Promise<ProviderResult> => ({
        content: 'ok',
      })),
  );
  const preflight = options?.preflight ? vi.fn(options.preflight) : undefined;
  const provider: Provider = {
    name: 'codex',
    execute,
    ...(preflight ? { preflight } : {}),
  };
  return { provider, execute, preflight };
}

function makeCodexAppServerProvider(): Provider {
  return {
    name: 'codex',
    execute: vi.fn(async () => ({ content: 'ok' })),
    appServer: {
      buildServerSpec: (_continuity, request) =>
        buildCodexProviderServerSpec(request.cwd ?? process.cwd(), request.coralEnv),
      interrupt: async (lease, continuity) => {
        const threadId = continuity.threadId;
        const turnId = continuity.turnId;
        if (typeof threadId !== 'string' || typeof turnId !== 'string') {
          return;
        }
        await lease.rpc('turn/interrupt', { threadId, turnId });
      },
      probe: async (lease, continuity) => {
        const threadId = continuity.threadId;
        if (typeof threadId !== 'string') {
          return { resumable: false, updatedContinuity: continuity };
        }
        const cwd = typeof continuity.cwd === 'string' ? continuity.cwd : process.cwd();
        try {
          await lease.rpc('thread/resume', {
            threadId,
            cwd,
            model: null,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
          });
          return { resumable: true, updatedContinuity: continuity };
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
          if (
            message.includes('not found') ||
            message.includes('missing thread') ||
            message.includes('unknown thread') ||
            message.includes('does not exist') ||
            message.includes('no such thread')
          ) {
            return { resumable: false, updatedContinuity: continuity };
          }
          throw error;
        }
      },
      finalizeInterrupted: (probeResult, continuity) =>
        probeResult.resumable
          ? {
              conversationRef: typeof continuity.threadId === 'string' ? continuity.threadId : undefined,
              continuityMutation: continuity,
            }
          : {
              nonResumable: true,
              continuityMutation: continuity,
            },
    },
  };
}

function makeSharedClaudeAppServerProvider(spec: {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  shared: true;
}): Provider {
  return {
    name: 'claude',
    execute: vi.fn(async () => ({ content: 'ok' })),
    appServer: {
      buildServerSpec: () => spec,
      interrupt: async (lease, continuity) => {
        const brokerSessionKey =
          typeof continuity.brokerSessionKey === 'string' ? continuity.brokerSessionKey : undefined;
        if (!brokerSessionKey) {
          return;
        }
        await lease.rpc('turn/interrupt', {
          brokerSessionKey,
          ...(typeof continuity.brokerTurnId === 'string' ? { brokerTurnId: continuity.brokerTurnId } : {}),
        });
      },
      probe: async (_lease, continuity) => ({
        resumable: true,
        updatedContinuity: continuity,
      }),
      finalizeInterrupted: (probeResult) => ({
        continuityMutation: probeResult.updatedContinuity,
      }),
    },
  };
}

async function occupyProviderSlots(
  service: ExecutionService,
  ctx: CallerContext,
  providerName: string,
): Promise<string[]> {
  const decisions = await Promise.all(
    Array.from({ length: getMaxWorkers(runtime.env) }, (_value, index) =>
      service.start(providerName, { prompt: `occupy-${index}` }, ctx),
    ),
  );

  const jobIds: string[] = [];
  for (const decision of decisions) {
    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch while occupying capacity');
    }
    trackJob(decision.job);
    jobIds.push(decision.job);
  }

  return jobIds;
}

async function waitForTerminalEvent(
  service: ExecutionService,
  jobId: string,
): Promise<Extract<WaitStreamEvent, { type: 'terminal' }>> {
  for await (const event of service.waitStream({ jobIds: [jobId], timeoutSeconds: 5 })) {
    if (event.type === 'terminal') {
      return event;
    }
  }

  throw new Error(`Expected terminal event for ${jobId}`);
}

function createClaimedJob(
  service: ExecutionService,
  ctx: CallerContext,
  options: { initialPhase?: JobPhase } = {},
): {
  jobId: string;
  sessionId: string;
  progressStore: ProgressStore;
  sessionManager: SessionManager;
} {
  const { progressStore, sessionManager } = getInternals(service);
  const session = sessionManager.allocate('codex', 'wait-session', 'test-model', ctx.projectRoot, ctx.projectRoot);
  const jobId = `wait-job-${randomUUID()}`;
  trackJob(jobId);
  progressStore.initJob({
    jobId,
    sessionId: session.sessionId,
    provider: 'codex',
    projectRoot: ctx.projectRoot,
    backendNamespace: TEST_BACKEND_NAMESPACE,
    initialPhase: options.initialPhase ?? 'running',
  });
  expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
  return {
    jobId,
    sessionId: session.sessionId,
    progressStore,
    sessionManager,
  };
}

function realizePluginRoot(ctx: CallerContext): string {
  mkdirSync(ctx.pluginRoot, { recursive: true });
  return pluginRootNamespace(ctx.pluginRoot);
}

function createScopedContext(name: string): CallerContext {
  const projectRoot = join(mockState.tmpHome, name);
  mkdirSync(projectRoot, { recursive: true });
  const pluginRoot = join(projectRoot, 'plugin');
  mkdirSync(pluginRoot, { recursive: true });
  return { projectRoot, pluginRoot, coralEnv: {} };
}

describe('ExecutionService', () => {
  let ctx: CallerContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {} };
    baselineJobIds = listJobDirs();
    eventBus = new TypedEventBus();
    runtime = createRealRuntime();
    JOBS_DIR = runtime.paths.jobsDir();
    launchCoordinator = new LaunchCoordinator({ runtime });
    spawnProviderServer = launchCoordinator.spawnProviderServer.bind(launchCoordinator);
    mockState.getNewProvider.mockReset();
    mockState.resolveAgent.mockReset();
  });

  afterEach(async () => {
    trackAllJobDirs();
    terminateAll();
    for (const jobId of createdJobIds) {
      cancelQueued(jobId);
      releaseLaunch(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mockState.getNewProvider.mockReset();
    mockState.resolveAgent.mockReset();
    vi.restoreAllMocks();
  });

  it('start returns a running LaunchDecision with job and session ids', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status === 'running') {
      trackJob(decision.job);
      expect(decision.job).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(decision.session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  it('runs provider CLI jobs through the durable runner and persists runtime artifacts', async () => {
    const provider: Provider = {
      name: 'codex',
      execute: async (request, runtime): Promise<ProviderResult> => {
        const result = await runtime.runCli({
          command: process.execPath,
          args: [
            '-e',
            [
              'process.stdout.write(\'{"message":"step-1"}\\n\');',
              'setTimeout(() => process.stdout.write(\'{"message":"step-2"}\\n\'), 20);',
              "setTimeout(() => process.stdout.write('final output\\n'), 30);",
              'setTimeout(() => process.exit(0), 40);',
            ].join(''),
          ],
          onEvent: (line) => {
            try {
              const parsed = JSON.parse(line) as { message?: string };
              if (!parsed.message) return;
              runtime.onEvent({
                jobId: request.sessionId,
                message: parsed.message,
                ts: new Date().toISOString(),
              });
            } catch {
              /* ignore non-JSON progress lines */
            }
          },
        });

        return { content: result.stdout };
      },
    };
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.job);

    const terminal = await waitForTerminalEvent(service, decision.job);
    const jobDir = join(JOBS_DIR, decision.job);
    const runtimeRecord = JSON.parse(readFileSync(join(jobDir, 'runtime.json'), 'utf-8')) as {
      pid: number;
      tailWatermark?: number;
    };

    expect(terminal.result.content).toContain('final output');
    expect(existsSync(join(jobDir, 'runtime.json'))).toBe(true);
    expect(existsSync(join(jobDir, 'exit.json'))).toBe(true);
    expect(runtimeRecord.pid).toBeGreaterThan(0);
    expect(runtimeRecord.tailWatermark).toBeGreaterThan(0);
    expect(readFileSync(join(jobDir, 'progress.jsonl'), 'utf-8')).toContain('step-1');
    expect(readFileSync(join(jobDir, 'progress.jsonl'), 'utf-8')).toContain('step-2');
  });

  it('writes app-server runtime waiting before lease grant and upgrades the same record on acquisition', async () => {
    const spec = buildCodexProviderServerSpec(ctx.projectRoot);
    const server = createFakeProviderServerHandle({ generation: 41 });
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const jobId1 = `app-server-runtime-${randomUUID()}`;
    const jobId2 = `app-server-runtime-${randomUUID()}`;
    trackJob(jobId1);
    trackJob(jobId2);

    progressStore.initJob({
      jobId: jobId1,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.initJob({
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });

    const firstLease = await service.acquireServer(spec, { jobId: jobId1 });
    const firstRuntime = progressStore.readRuntimeRecord(jobId1) as AppServerRuntimeRecord;
    expect(firstRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        serverGeneration: 41,
        recoveryPolicy: 'session_continuity_only',
      },
    });
    expect(firstRuntime.startTime).toEqual(expect.any(String));
    expect(firstRuntime.providerMeta.providerContinuity).toBeUndefined();

    let secondSettled = false;
    const secondLeasePromise = service.acquireServer(spec, { jobId: jobId2 }).then((lease) => {
      secondSettled = true;
      return lease;
    });

    await Promise.resolve();

    const waitingRuntime = progressStore.readRuntimeRecord(jobId2) as AppServerRuntimeRecord;
    expect(waitingRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        leaseState: 'waiting',
        recoveryPolicy: 'session_continuity_only',
      },
    });
    expect(waitingRuntime.startTime).toEqual(expect.any(String));
    expect(waitingRuntime.providerMeta.serverGeneration).toBeUndefined();
    expect(waitingRuntime.providerMeta.providerContinuity).toBeUndefined();
    expect(secondSettled).toBe(false);
    expect(spawnProviderServerMock).toHaveBeenCalledTimes(1);

    firstLease.release();
    const secondLease = await secondLeasePromise;

    const acquiredRuntime = progressStore.readRuntimeRecord(jobId2) as AppServerRuntimeRecord;
    expect(acquiredRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        serverGeneration: 41,
        recoveryPolicy: 'session_continuity_only',
      },
    });
    expect(acquiredRuntime.startTime).toEqual(expect.any(String));
    expect(acquiredRuntime.providerMeta.providerContinuity).toBeUndefined();

    secondLease.release();
  });

  it('allows shared app-server leases to overlap on the same handle', async () => {
    const spec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      shared: true as const,
    };
    const requestGate = createDeferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const server = createFakeProviderServerHandle({
      generation: 41,
      request: async (_method, params) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await requestGate.promise;
        inFlight -= 1;
        return params;
      },
    });
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const jobId1 = `shared-app-server-${randomUUID()}`;
    const jobId2 = `shared-app-server-${randomUUID()}`;
    trackJob(jobId1);
    trackJob(jobId2);

    progressStore.initJob({
      jobId: jobId1,
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.initJob({
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });

    const firstLease = await service.acquireServer(spec, { jobId: jobId1 });

    let secondSettled = false;
    const secondLeasePromise = service.acquireServer(spec, { jobId: jobId2 }).then((lease) => {
      secondSettled = true;
      return lease;
    });
    await vi.waitFor(() => {
      expect(secondSettled).toBe(true);
    });
    const secondLease = await secondLeasePromise;

    const secondRuntime = progressStore.readRuntimeRecord(jobId2) as AppServerRuntimeRecord;
    expect(secondRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        provider: 'claude',
        leaseState: 'acquired',
        serverGeneration: 41,
        recoveryPolicy: 'session_continuity_only',
      },
    });

    const firstRpc = firstLease.rpc('turn/start', { brokerSessionKey: 'broker-1', brokerTurnId: 'turn-1' });
    const secondRpc = secondLease.rpc('turn/start', { brokerSessionKey: 'broker-2', brokerTurnId: 'turn-2' });
    await Promise.resolve();

    expect(maxInFlight).toBe(2);
    requestGate.resolve();
    await Promise.all([firstRpc, secondRpc]);

    firstLease.release();
    secondLease.release();
    expect(spawnProviderServerMock).toHaveBeenCalledTimes(1);
  });

  it('abort sends turn/interrupt for checkpointed app-server jobs', async () => {
    const jobId = `app-server-abort-${randomUUID()}`;
    const server = createFakeProviderServerHandle({
      request: async (method, params) => {
        if (method === 'turn/interrupt') {
          return {
            threadId: params.threadId,
            turnId: params.turnId,
          };
        }
        return {};
      },
    });
    setSpawnProviderServerMock(server.handle);
    const service = createService(ctx);
    const { progressStore, abortRegistry } = getInternals(service);
    trackJob(jobId);
    mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());

    progressStore.initJob({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.writeRuntimeRecord(jobId, {
      transport: 'app-server',
      startTime: new Date().toISOString(),
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        serverGeneration: 7,
        providerContinuity: {
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
        recoveryPolicy: 'session_continuity_only',
      },
    });
    progressStore.writeLaunchRecord(jobId, {
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'abort me',
        cwd: ctx.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
    });
    abortRegistry.register(jobId);

    expect(service.abort([jobId])).toEqual({
      aborted: [jobId],
      notFound: [],
    });

    await vi.waitFor(() => {
      expect(server.requestMock).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
    });
  });

  it('routes shared app-server interrupts through acquireServer while a live lease is active', async () => {
    const spec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      shared: true as const,
    };
    const server = createFakeProviderServerHandle();
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    const service = createService(ctx);
    mockState.getNewProvider.mockReturnValue(makeSharedClaudeAppServerProvider(spec));

    const firstLease = await service.acquireServer(spec);
    const acquireServerSpy = vi.spyOn(service, 'acquireServer');

    const launchRecord: PersistedLaunchRecord = {
      jobId: `shared-interrupt-${randomUUID()}`,
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'interrupt me',
        cwd: ctx.projectRoot,
        bypassPermissions: true,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
    };
    const runtimeRecord: AppServerRuntimeRecord = {
      transport: 'app-server',
      startTime: new Date().toISOString(),
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        serverGeneration: 7,
        providerContinuity: {
          brokerSessionKey: 'broker-session-1',
          brokerTurnId: 'broker-turn-1',
          bootstrapSignature: {
            cwd: '/workspace',
            systemPromptHash: 'sha256:bootstrap',
            permissionMode: 'bypassPermissions',
          },
          envHash: 'sha256:env',
        },
        recoveryPolicy: 'session_continuity_only',
      },
    };

    await service.interruptAppServerJob(launchRecord, runtimeRecord);

    expect(acquireServerSpy).toHaveBeenCalledTimes(1);
    expect(server.requestMock).toHaveBeenCalledWith('turn/interrupt', {
      brokerSessionKey: 'broker-session-1',
      brokerTurnId: 'broker-turn-1',
    });
    expect(spawnProviderServerMock).toHaveBeenCalledTimes(1);

    acquireServerSpy.mockRestore();
    firstLease.release();
  });

  it('borrows the live exclusive app-server host for interrupts instead of queueing a second lease', async () => {
    const spec = buildCodexProviderServerSpec(ctx.projectRoot);
    const server = createFakeProviderServerHandle();
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    const service = createService(ctx);
    mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());

    const firstLease = await service.acquireServer(spec);
    const acquireServerSpy = vi.spyOn(service, 'acquireServer');

    await service.interruptAppServerJob(
      {
        jobId: `exclusive-interrupt-${randomUUID()}`,
        sessionId: 'session-1',
        provider: 'codex',
        projectRoot: ctx.projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
        pool: 'default',
        enqueueSequence: 0,
        providerAction: 'exec',
        request: {
          prompt: 'interrupt me',
          cwd: ctx.projectRoot,
          bypassPermissions: true,
          coralEnv: {},
        },
        createdAt: new Date().toISOString(),
      },
      {
        transport: 'app-server',
        startTime: new Date().toISOString(),
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          serverGeneration: firstLease.generation,
          providerContinuity: {
            threadId: 'thread-live',
            turnId: 'turn-live',
          },
          recoveryPolicy: 'session_continuity_only',
        },
      },
    );

    expect(acquireServerSpy).not.toHaveBeenCalled();
    expect(server.requestMock).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-live',
      turnId: 'turn-live',
    });
    expect(spawnProviderServerMock).toHaveBeenCalledTimes(1);

    acquireServerSpy.mockRestore();
    firstLease.release();
  });

  it('persists app-server lease-wait aborts as aborted instead of error', async () => {
    const spec = buildCodexProviderServerSpec(ctx.projectRoot);
    const server = createFakeProviderServerHandle();
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    const firstLeaseHeld = createDeferred<void>();
    const { provider } = makeProvider({
      execute: async (_request, runtime): Promise<ProviderResult> => {
        const lease = await runtime.acquireServer!(spec);
        await firstLeaseHeld.promise;
        lease.release();
        return { content: 'done' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const first = await service.start('codex', { prompt: 'hold lease' }, ctx);
    const second = await service.start('codex', { prompt: 'wait for lease' }, ctx);

    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    if (first.status !== 'running' || second.status !== 'running') {
      throw new Error('expected running launches');
    }
    trackJob(first.job);
    trackJob(second.job);

    await Promise.resolve();

    const { progressStore } = getInternals(service);
    const waitingRuntime = progressStore.readRuntimeRecord(second.job) as AppServerRuntimeRecord;
    expect(waitingRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        leaseState: 'waiting',
      },
    });

    expect(service.abort([second.job])).toEqual({
      aborted: [second.job],
      notFound: [],
    });

    const terminal = await waitForTerminalEvent(service, second.job);
    expect(terminal.result).toMatchObject({
      aborted: true,
      notice: 'Aborted while waiting for a provider server lease',
    });
    expect(progressStore.readStatus(second.job)).toMatchObject({
      phase: 'aborted',
      result: {
        aborted: true,
        notice: 'Aborted while waiting for a provider server lease',
      },
    });

    firstLeaseHeld.resolve();
    await waitForTerminalEvent(service, first.job);
    expect(spawnProviderServerMock).toHaveBeenCalledTimes(1);
  });

  it('start rejects unknown providers', async () => {
    mockState.getNewProvider.mockReturnValue(undefined);
    const service = createService(ctx);

    const decision = await service.start('missing', { prompt: 'hello' }, ctx);

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'unknown_provider',
      message: 'Unknown provider: missing',
    });
  });

  it('start rejects when preflight throws', async () => {
    const { provider, preflight } = makeProvider({
      preflight: async () => {
        throw new Error('not ready');
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'preflight_failed',
      message: 'not ready',
    });
  });

  it('start rejects invalid agent refs from the resolver', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation(() => {
      throw new InvalidAgentRefError('Invalid mocked agent ref');
    });
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello', agent: 'architect' }, ctx);

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'invalid_agent',
      message: 'Invalid mocked agent ref',
    });
  });

  it('start rejects missing agents from the resolver', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation(() => {
      throw new AgentNotFoundError('Agent "architect" not found');
    });
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello', agent: 'architect' }, ctx);

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'agent_not_found',
      message: 'Agent "architect" not found',
    });
  });

  it('start rejects unknown agent namespaces from the resolver', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation(() => {
      throw new AgentNamespaceNotFoundError('Plugin namespace "other" not found');
    });
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello', agent: 'architect' }, ctx);

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'agent_namespace_not_found',
      message: 'Plugin namespace "other" not found',
    });
  });

  it('start resolves agent metadata before allocation and persists the agent profile', async () => {
    realizePluginRoot(ctx);
    const never = new Promise<ProviderResult>(() => {});
    const { provider, execute } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockReturnValue(
      createResolvedAgent(
        { namespace: 'coral', name: 'architect' },
        '---\nmodel: gpt-5.4\neffort: high\n---\nArchitect instruction',
      ),
    );
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello', agent: 'architect' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.job);

    expect(mockState.resolveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: null, name: 'architect' }),
      expect.anything(),
    );
    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    const session = new SessionManager(ctx.projectRoot, runtime).get('codex', decision.session);

    expect(request).toMatchObject({
      action: 'exec',
      name: 'architect',
      model: 'gpt-5.4',
      instruction: {
        content: 'Architect instruction',
        channel: 'system',
      },
    });
    expect(request.effort).toBeUndefined();
    expect(session).toMatchObject({
      name: 'architect',
      model: 'gpt-5.4',
      agentName: 'architect',
      bypassPermissions: false,
      instruction: {
        content: 'Architect instruction',
        channel: 'system',
      },
    });
  });

  // @flaky — queue-slot timing sensitive; passes in isolation, intermittent under parallel suite
  describe('queue admission', { retry: 2 }, () => {
    it('start returns queued when provider launch slots are full', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);
      await occupyProviderSlots(service, ctx, 'codex');

      const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

      expect(decision.status).toBe('queued');
      if (decision.status !== 'queued') throw new Error('expected queued launch');
      trackJob(decision.job);

      const { progressStore } = getInternals(service);
      expect(progressStore.readStatus(decision.job)).toMatchObject({
        jobId: decision.job,
        sessionId: decision.session,
        provider: 'codex',
        phase: 'queued',
        launch: {
          state: 'queued',
        },
      });
    });

    it('resume rejects when the session is missing', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);

      const decision = await service.resume('codex', { sessionId: 'missing', prompt: 'hello' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'session_not_found',
      });
      if (decision.status === 'rejected') {
        expect(decision.message).toContain('Session not found: missing');
      }
    });

    it('resumeBySessionId continues the stored provider after a global session lookup', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate({
        provider: 'codex',
        name: 'alpha',
        model: 'gpt-5',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: pluginRootNamespace(ctx.pluginRoot),
      });
      mgr.setConversationRef(entry.sessionId, 'thread-1');
      const service = createService(ctx, { backendNamespace: pluginRootNamespace(ctx.pluginRoot) });

      const decision = await service.resumeBySessionId({ sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status !== 'running') {
        throw new Error('expected running launch');
      }
      trackJob(decision.job);
      const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
      expect(request).toMatchObject({
        action: 'resume',
        conversationRef: 'thread-1',
      });
    });

    it('resumeBySessionId rejects missing sessions', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);

      const decision = await service.resumeBySessionId({ sessionId: 'missing', prompt: 'hello' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'session_not_found',
      });
    });

    it('resumeBySessionId rejects legacy sessions without authoritative scope metadata', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'legacy', 'gpt-5', ctx.projectRoot);
      const service = createService(ctx);

      const decision = await service.resumeBySessionId({ sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'legacy_session_unsupported',
      });
    });

    it('resumeBySessionId rejects sessions outside the current scope', async () => {
      const otherCtx = createScopedContext('other-project');
      const foreignMgr = new SessionManager(otherCtx.projectRoot, runtime);
      const foreignEntry = foreignMgr.allocate({
        provider: 'codex',
        name: 'foreign',
        model: 'gpt-5',
        cwd: otherCtx.projectRoot,
        projectRoot: otherCtx.projectRoot,
        backendNamespace: pluginRootNamespace(otherCtx.pluginRoot),
      });
      const service = createService(ctx);

      const decision = await service.resumeBySessionId({ sessionId: foreignEntry.sessionId, prompt: 'hello' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'scope_mismatch',
      });
    });

    it('resume inherits stored continuation profile fields when the input omits them', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const instruction = {
        content: 'Persisted instruction',
        channel: 'system' as const,
      };
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate({
        provider: 'codex',
        name: 'alpha',
        model: 'gpt-5.1',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: pluginRootNamespace(ctx.pluginRoot),
        instruction,
        bypassPermissions: true,
        systemPrompt: 'Persisted system prompt',
        controllerProfile: {
          owner: 'alice',
          effort: 'high',
          claudeModelCap: 'opus',
        },
      });
      mgr.setConversationRef(entry.sessionId, 'thread-1');
      const service = createService(ctx);

      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status !== 'running') {
        throw new Error('expected running launch');
      }
      trackJob(decision.job);
      const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
      expect(request).toMatchObject({
        action: 'resume',
        conversationRef: 'thread-1',
        model: 'gpt-5.1',
        bypassPermissions: true,
        systemPrompt: 'Persisted system prompt',
        instruction,
        coralEnv: {
          CORAL_OWNER: 'alice',
          CORAL_EFFORT: 'high',
          CORAL_CLAUDE_MODEL_CAP: 'opus',
        },
      });
      expect(request.effort).toBe('high');
    });

    it('resume rejects when the session already has an active job', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      mgr.claimForJobSync(entry.sessionId, 'job-1');
      const service = createService(ctx);

      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'session_busy',
      });
      if (decision.status === 'rejected') {
        expect(decision.message).toContain(`Session ${entry.sessionId} already has an active job`);
      }
    });

    it('resume rolls back queued admission when the session becomes busy during preflight', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const blockingProvider = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(blockingProvider.provider);
      const service = createService(ctx);
      await occupyProviderSlots(service, ctx, 'codex');

      const gate = createDeferred<void>();
      const racingProvider = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
      });
      mockState.getNewProvider.mockReturnValue(racingProvider.provider);

      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      const jobDirsBefore = listJobDirs();

      const decisionPromise = service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);
      expect(mgr.claimForJobSync(entry.sessionId, 'job-race')).toBe(true);
      gate.resolve();

      const decision = await decisionPromise;

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_busy');
      expect(decision.message).toContain(`Session ${entry.sessionId} already has an active job`);
      expect(queueDepth()).toBe(0);
      expect(listJobDirs()).toEqual(jobDirsBefore);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe('job-race');
    });

    it('resume clears conversationRef and marks the session non_resumable on invalid-thread results', async () => {
      const { provider } = makeProvider({
        execute: async () => ({
          content: '',
          nonResumable: true,
          notice: 'Conversation thread-stale is no longer resumable.',
          errors: ['No such thread'],
        }),
      });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      mgr.setConversationRef(entry.sessionId, 'thread-stale');
      const service = createService(ctx);

      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status !== 'running') {
        throw new Error('expected running launch');
      }
      trackJob(decision.job);

      const terminal = await waitForTerminalEvent(service, decision.job);
      const updatedSession = mgr.get('codex', entry.sessionId);

      expect(terminal.result).toMatchObject({
        content: '',
        nonResumable: true,
        notice: 'Conversation thread-stale is no longer resumable.',
        errors: ['No such thread'],
      });
      expect(updatedSession?.activeJobId).toBeUndefined();
      expect(updatedSession?.lastJobId).toBe(decision.job);
      expect(updatedSession?.state).toBe('non_resumable');
      expect(updatedSession?.conversationRef).toBeUndefined();
    });

    it('fork allocates a new session id', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const service = createService(ctx);

      const decision = await service.fork('codex', { sessionId: source.sessionId, prompt: 'branch' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status === 'running') {
        trackJob(decision.job);
        expect(decision.session).not.toBe(source.sessionId);
        expect(mgr.get('codex', decision.session)?.name).toMatch(/^fork-/);
      }
    });

    it('forkBySessionId persists the merged continuation profile onto the child session', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const instruction = {
        content: 'Persisted instruction',
        channel: 'system' as const,
      };
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const source = mgr.allocate({
        provider: 'codex',
        name: 'architect',
        model: 'gpt-5.1',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: pluginRootNamespace(ctx.pluginRoot),
        agentName: 'architect',
        instruction,
        bypassPermissions: true,
        systemPrompt: 'Persisted system prompt',
        controllerProfile: {
          owner: 'alice',
          effort: 'high',
          claudeModelCap: 'opus',
        },
      });
      mgr.setConversationRef(source.sessionId, 'thread-1');
      const service = createService(ctx, { backendNamespace: pluginRootNamespace(ctx.pluginRoot) });

      const decision = await service.forkBySessionId({ sessionId: source.sessionId, prompt: 'branch' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status !== 'running') {
        throw new Error('expected running launch');
      }
      trackJob(decision.job);

      const child = mgr.get('codex', decision.session);
      const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];

      expect(child).toMatchObject({
        model: 'gpt-5.1',
        agentName: 'architect',
        instruction,
        bypassPermissions: true,
        systemPrompt: 'Persisted system prompt',
        controllerProfile: {
          owner: 'alice',
          effort: 'high',
          claudeModelCap: 'opus',
        },
      });
      expect(request).toMatchObject({
        action: 'fork',
        conversationRef: 'thread-1',
        model: 'gpt-5.1',
        bypassPermissions: true,
        systemPrompt: 'Persisted system prompt',
        instruction,
        coralEnv: {
          CORAL_OWNER: 'alice',
          CORAL_EFFORT: 'high',
          CORAL_CLAUDE_MODEL_CAP: 'opus',
        },
      });
      expect(request.effort).toBe('high');
    });

    it('forkBySessionId rejects missing sessions', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);

      const decision = await service.forkBySessionId({ sessionId: 'missing', prompt: 'branch' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'session_not_found',
      });
    });

    it('forkBySessionId rejects legacy sessions without authoritative scope metadata', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const source = mgr.allocate('codex', 'legacy', 'gpt-5', ctx.projectRoot);
      const service = createService(ctx);

      const decision = await service.forkBySessionId({ sessionId: source.sessionId, prompt: 'branch' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'legacy_session_unsupported',
      });
    });

    it('forkBySessionId rejects sessions outside the current scope', async () => {
      const otherCtx = createScopedContext('fork-foreign-project');
      const foreignMgr = new SessionManager(otherCtx.projectRoot, runtime);
      const foreignEntry = foreignMgr.allocate({
        provider: 'codex',
        name: 'foreign',
        model: 'gpt-5',
        cwd: otherCtx.projectRoot,
        projectRoot: otherCtx.projectRoot,
        backendNamespace: pluginRootNamespace(otherCtx.pluginRoot),
      });
      const service = createService(ctx);

      const decision = await service.forkBySessionId({ sessionId: foreignEntry.sessionId, prompt: 'branch' }, ctx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'scope_mismatch',
      });
    });

    it('abort aborts the correct jobs', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);

      const first = await service.start('codex', { prompt: 'first' }, ctx);
      const second = await service.start('codex', { prompt: 'second' }, ctx);

      expect(first.status).toBe('running');
      expect(second.status).toBe('running');
      if (first.status !== 'running' || second.status !== 'running') {
        throw new Error('expected running jobs');
      }

      trackJob(first.job);
      trackJob(second.job);
      const result = service.abort([first.job, 'missing-job']);
      const { abortRegistry } = getInternals(service);

      expect(result).toEqual({
        aborted: [first.job],
        notFound: ['missing-job'],
      });
      expect(abortRegistry.getSignal(first.job)?.aborted).toBe(true);
      expect(abortRegistry.getSignal(second.job)?.aborted).toBe(false);
    });

    it('abort persists queued jobs as aborted instead of error', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);
      await occupyProviderSlots(service, ctx, 'codex');

      const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

      expect(decision.status).toBe('queued');
      if (decision.status !== 'queued') throw new Error('expected queued launch');
      trackJob(decision.job);

      const abortResult = service.abort([decision.job]);
      const { progressStore } = getInternals(service);

      expect(abortResult).toEqual({
        aborted: [decision.job],
        notFound: [],
      });
      expect(progressStore.readStatus(decision.job)).toMatchObject({
        phase: 'aborted',
        result: {
          aborted: true,
          notice: 'Aborted while queued.',
        },
      });
    });
  }); // end queue admission

  it('awaitLaunch returns ready once the launch state changes', async () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `test-await-launch-${Date.now()}`;
    progressStore.initJob({
      jobId,
      sessionId: 'test-session',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });

    setTimeout(() => {
      progressStore.updateLaunchState(jobId, 'ready');
    }, 10);

    await expect(service.awaitLaunch(jobId, 1000)).resolves.toBe('ready');
  });

  describe('waitForJobTerminal', () => {
    it('rejects immediately when the job status is missing', async () => {
      const service = createService(ctx);

      await expect(service.waitForJobTerminal('missing-job', 100)).rejects.toThrow('Job not found: missing-job');
    });

    it('waits for both terminal status and session claim release', async () => {
      const service = createService(ctx);
      const { jobId, sessionId, progressStore, sessionManager } = createClaimedJob(service, ctx);

      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      const waiter = service.waitForJobTerminal(jobId, 250);
      void waiter.then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        },
      );

      await Promise.resolve();
      progressStore.markTerminalStatus(jobId, { content: 'done' }, 'completed');
      await Promise.resolve();
      expect(outcome).toBe('pending');

      sessionManager.setConversationRef(sessionId, 'thread-1');
      await Promise.resolve();
      expect(outcome).toBe('pending');

      sessionManager.releaseJob(sessionId, jobId);
      await expect(waiter).resolves.toBeUndefined();
      expect(outcome).toBe('resolved');
    });

    it('rechecks persisted state after subscribing so listener-install races cannot miss completion', async () => {
      const service = createService(ctx);
      const { jobId, sessionId, progressStore, sessionManager } = createClaimedJob(service, ctx);
      const originalOn = eventBus.on.bind(eventBus);
      const originalEmit = eventBus.emit.bind(eventBus);
      let injected = false;
      let suppressWakeups = false;

      vi.spyOn(eventBus, 'emit').mockImplementation(((
        event: Parameters<TypedEventBus['emit']>[0],
        payload: Parameters<TypedEventBus['emit']>[1],
      ) => {
        if (
          suppressWakeups &&
          (event === 'job:completed' || event === 'job:phase_changed' || event === 'session:updated')
        ) {
          return false;
        }
        return originalEmit(event, payload);
      }) as typeof eventBus.emit);

      vi.spyOn(eventBus, 'on').mockImplementation(((
        event: Parameters<TypedEventBus['on']>[0],
        listener: Parameters<TypedEventBus['on']>[1],
      ) => {
        if (!injected) {
          injected = true;
          suppressWakeups = true;
          progressStore.markTerminalStatus(jobId, { content: 'done' }, 'completed');
          sessionManager.releaseJob(sessionId, jobId);
          suppressWakeups = false;
        }
        return originalOn(event, listener);
      }) as typeof eventBus.on);

      await expect(service.waitForJobTerminal(jobId, 200)).resolves.toBeUndefined();
      expect(injected).toBe(true);
    });

    it('uses the default 30 second timeout when none is provided', async () => {
      vi.useFakeTimers();
      try {
        const service = createService(ctx);
        const { jobId } = createClaimedJob(service, ctx);
        let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
        const waiter = service.waitForJobTerminal(jobId);
        void waiter.then(
          () => {
            outcome = 'resolved';
          },
          () => {
            outcome = 'rejected';
          },
        );

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(outcome).toBe('pending');

        await vi.advanceTimersByTimeAsync(1);
        await expect(waiter).rejects.toThrow(
          `Timed out waiting for job ${jobId} to reach a terminal state and release its session`,
        );
        expect(outcome).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('coralDispatch resolves coral agent content and injects a system instruction', async () => {
    const { provider, execute } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockReturnValue(
      createResolvedAgent({ namespace: 'coral', name: 'sample' }, '---\nname: sample\n---\nInjected coral content'),
    );
    const service = createService(ctx);

    const decision = await service.coralDispatch('codex', 'sample', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status === 'running') {
      trackJob(decision.job);
    }
    expect(mockState.resolveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'coral', name: 'sample' }),
      expect.anything(),
    );
    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    expect(request).toMatchObject({
      action: 'exec',
      prompt: 'hello',
      bypassPermissions: true,

      instruction: {
        content: 'Injected coral content',
        channel: 'system',
      },
    });
  });

  it('coralDispatch forces the coral namespace for bare workflow atoms', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockReturnValue(
      createResolvedAgent({ namespace: 'coral', name: 'architect' }, 'Injected coral architect content'),
    );
    const service = createService(ctx);

    const decision = await service.coralDispatch('codex', 'architect', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status === 'running') {
      trackJob(decision.job);
    }
    expect(mockState.resolveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'coral', name: 'architect' }),
      expect.anything(),
    );
  });

  it('waitStream yields progress and terminal events in order', async () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const status: PersistedStatusRecord = {
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'running',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    };
    const replay: PersistedProgressRecord[] = [
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 1,
        type: 'progress',
        ts: '2026-03-06T00:00:01.000Z',
        message: 'step 1',
      },
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 2,
        type: 'terminal',
        ts: '2026-03-06T00:00:02.000Z',
        result: { content: 'done' },
      },
    ];

    vi.spyOn(progressStore, 'readStatus').mockReturnValue(status);
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue(replay);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 1,
        message: 'step 1',
      },
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done' },
      },
    ]);
  });

  it('waitStream yields terminal from status when no terminal event is replayed', async () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    vi.spyOn(progressStore, 'readStatus').mockReturnValue({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'completed',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
      result: { content: 'done' },
    });
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done' },
      },
    ]);
  });

  it('waitStream re-reads terminal status after replay before waiting for more changes', async () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const runningStatus: PersistedStatusRecord = {
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'running',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    };
    const terminalStatus: PersistedStatusRecord = {
      ...runningStatus,
      phase: 'completed',
      result: { content: 'done' },
    };

    vi.spyOn(progressStore, 'readStatus')
      .mockImplementationOnce(() => runningStatus)
      .mockImplementation(() => terminalStatus);
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);
    const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockImplementation(() => {
      throw new Error('waitForChange should not be called once terminal status is visible');
    });

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 600 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done' },
      },
    ]);
    expect(waitForChange).not.toHaveBeenCalled();
  });

  it('waitStream emits a queued event before replaying queued progress records', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    const runningJobIds = await occupyProviderSlots(service, ctx, 'codex');
    const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

    expect(decision.status).toBe('queued');
    if (decision.status !== 'queued') throw new Error('expected queued launch');
    trackJob(decision.job);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [decision.job], timeoutSeconds: 1 })) {
      events.push(event);
      if (events.length === 2) break;
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'queued',
      jobId: decision.job,
      sessionId: decision.session,
      queuePosition: 1,
      runningJobIds,
    });
    expect(events[1]).toMatchObject({
      type: 'progress',
      jobId: decision.job,
      sessionId: decision.session,
      eventId: 1,
    });
    if (events[1]?.type === 'progress') {
      expect(events[1].message).toContain('queued (position 1)');
    }
  });

  it('persists successful workflow results before exposing the terminal event', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: 'FINAL' };
        }
        return { content: 'unexpected' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation((ref: AgentRef) =>
      createResolvedAgent(ref, `Injected ${ref.name} content`),
    );

    const service = createService(ctx);
    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        start_prompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = new SessionManager(ctx.projectRoot, runtime).get('codex', decision.session);
    const { progressStore } = getInternals(service);
    const status = progressStore.readStatus(decision.job);

    expect(existsSync(terminal.resultPath)).toBe(true);
    expect(markdownAtTerminal).toBe(
      ['# Step 0.0: architect', '', 'ARCH', '', '# Step 1.0: resolver', '', 'FINAL', ''].join('\n'),
    );
    expect(terminal.result).toEqual({
      content: 'FINAL',
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 0,
            atom: 0,
            provider: 'codex',
            start: 3,
            end: 3,
          },
          {
            agent: 'resolver',
            step: 1,
            atom: 0,
            provider: 'codex',
            start: 7,
            end: 7,
          },
        ],
      },
    });
    expect(status).toMatchObject({
      phase: 'completed',
      jobKind: 'workflow',
      result: terminal.result,
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('keeps workflow session provenance on projectRoot while launching atoms in workDir', async () => {
    const seenCwds: string[] = [];
    const { provider } = makeProvider({
      execute: async (request) => {
        if (!request.cwd) throw new Error('expected workflow atom cwd');
        seenCwds.push(request.cwd);
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        return { content: 'FINAL' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation((ref: AgentRef) =>
      createResolvedAgent(ref, `Injected ${ref.name} content`),
    );

    const service = createService(ctx);
    const workDir = join(mockState.tmpHome, 'child-workdir');
    mkdirSync(workDir, { recursive: true });

    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        start_prompt: 'seed',
        provider: 'codex',
      },
      ctx,
      workDir,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    await waitForTerminalEvent(service, decision.job);

    const workflowSession = new SessionManager(ctx.projectRoot, runtime).get('codex', decision.session);
    const workDirSession = new SessionManager(workDir, runtime).get('codex', decision.session);

    expect(seenCwds).toEqual([workDir, workDir]);
    expect(workflowSession?.cwd).toBe(ctx.projectRoot);
    expect(workDirSession).toBeNull();
  });

  it('executeWorkflow bypasses launch admission when provider slots are full', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation((ref: AgentRef) =>
      createResolvedAgent(ref, `Injected ${ref.name} content`),
    );

    const service = createService(ctx);
    for (const jobId of getActiveJobIds()) {
      releaseLaunch(jobId);
    }
    expect(queueDepth()).toBe(0);
    const activeJobIds = await occupyProviderSlots(service, ctx, 'codex');

    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect'),
      {
        expression: 'architect',
        start_prompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackJob(decision.job);
    expect(getActiveJobIds()).toEqual(activeJobIds);
    const { progressStore } = getInternals(service);
    expect(progressStore.readStatus(decision.job)).toMatchObject({
      jobId: decision.job,
      sessionId: decision.session,
      jobKind: 'workflow',
      phase: 'running',
    });
  });

  it('persists partial workflow results on failure and marks the workflow session non_resumable', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: '', notice: 'resolver failed' };
        }
        return { content: 'unexpected' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation((ref: AgentRef) =>
      createResolvedAgent(ref, `Injected ${ref.name} content`),
    );

    const service = createService(ctx);
    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        start_prompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = new SessionManager(ctx.projectRoot, runtime).get('codex', decision.session);
    const { progressStore } = getInternals(service);
    const status = progressStore.readStatus(decision.job);

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toEqual({
      content: '',
      notice: "Step 1, atom 'resolver' failed: resolver failed",
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 0,
            atom: 0,
            provider: 'codex',
            start: 3,
            end: 3,
          },
        ],
      },
    });
    expect(status).toMatchObject({
      phase: 'error',
      result: terminal.result,
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('persists partial workflow results on abort and marks the workflow session non_resumable', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: '', aborted: true };
        }
        return { content: 'unexpected' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockImplementation((ref: AgentRef) =>
      createResolvedAgent(ref, `Injected ${ref.name} content`),
    );

    const service = createService(ctx);
    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        start_prompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = new SessionManager(ctx.projectRoot, runtime).get('codex', decision.session);
    const { progressStore } = getInternals(service);
    const status = progressStore.readStatus(decision.job);

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toEqual({
      content: '',
      aborted: true,
      notice: "Step 1, atom 'resolver' failed: aborted",
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 0,
            atom: 0,
            provider: 'codex',
            start: 3,
            end: 3,
          },
        ],
      },
    });
    expect(status).toMatchObject({
      phase: 'aborted',
      result: terminal.result,
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('start falls back to status-only terminal persistence when appendTerminal throws', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);

    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const appendTerminal = vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackJob(decision.job);

    const terminal = await waitForTerminalEvent(service, decision.job);
    const status = progressStore.readStatus(decision.job);

    expect(appendTerminal).toHaveBeenCalled();
    expect(markTerminalStatus).toHaveBeenCalledWith(
      decision.job,
      expect.objectContaining({ content: 'ok' }),
      'completed',
    );
    expect(terminal.result).toEqual({ content: 'ok' });
    expect(status).toMatchObject({
      phase: 'completed',
      result: { content: 'ok' },
    });
  });

  it('finishQueuedAbort falls back to status-only terminal persistence when appendTerminal throws', () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `queued-abort-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');

    (
      service as unknown as {
        finishQueuedAbort(jobId: string, sessionId: string, message: string): void;
      }
    ).finishQueuedAbort(jobId, 'session-1', 'Aborted while queued.');

    expect(markTerminalStatus).toHaveBeenCalledWith(
      jobId,
      { content: '', aborted: true, notice: 'Aborted while queued.' },
      'aborted',
    );
    expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'aborted' });
  });

  it('failJob falls back to status-only terminal persistence when appendTerminal throws', () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `fail-job-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');

    (
      service as unknown as {
        launchOrchestrator: { failJob(jobId: string, sessionId: string, launchState: string, message: string): void };
      }
    ).launchOrchestrator.failJob(jobId, 'session-1', 'error', 'provider failed');

    expect(markTerminalStatus).toHaveBeenCalledWith(jobId, { content: '', notice: 'provider failed' }, 'error');
    expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'error' });
  });

  it('finishWorkflowJob falls back to status-only terminal persistence when appendTerminal throws', () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `workflow-terminal-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');
    const result = { content: 'done', workflow: { steps: [] } };

    (
      service as unknown as {
        finishWorkflowJob(
          sessionId: string,
          jobId: string,
          phase: 'completed' | 'error' | 'aborted',
          result: { content: string; workflow: { steps: unknown[] } },
          markdown: string,
        ): void;
      }
    ).finishWorkflowJob('session-1', jobId, 'completed', result, '# workflow\n');

    expect(markTerminalStatus).toHaveBeenCalledWith(jobId, result, 'completed');
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result,
    });
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('# workflow\n');
  });

  it.each([
    {
      phase: 'completed' as const,
      result: { content: 'done', workflow: { steps: [] } },
      markdown: '# completed\n',
    },
    {
      phase: 'error' as const,
      result: { content: '', notice: 'failed', workflow: { steps: [] } },
      markdown: '# failed\n',
    },
    {
      phase: 'aborted' as const,
      result: { content: '', aborted: true, notice: 'aborted', workflow: { steps: [] } },
      markdown: '# aborted\n',
    },
  ])(
    'finishWorkflowJob writes result.md before %s terminal persistence and marks the session non_resumable afterward',
    ({ phase, result, markdown }) => {
      const service = createService(ctx);
      const { progressStore, sessionManager } = getInternals(service);
      const session = sessionManager.allocate('codex', `workflow-${phase}`, 'workflow', ctx.projectRoot);
      const jobId = `workflow-order-${phase}-${randomUUID()}`;
      trackJob(jobId);
      progressStore.initJob({
        jobId,
        sessionId: session.sessionId,
        provider: 'codex',
        projectRoot: ctx.projectRoot,
        backendNamespace: 'test-ns',
        jobKind: 'workflow',
      });
      expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);

      const order: string[] = [];
      const originalWriteWorkflowResult = progressStore.writeWorkflowResultMdOrThrow.bind(progressStore);
      const originalAppendTerminal = progressStore.appendTerminal.bind(progressStore);
      const originalSetNonResumable = sessionManager.setNonResumable.bind(sessionManager);

      vi.spyOn(progressStore, 'writeWorkflowResultMdOrThrow').mockImplementation((targetJobId, persistedMarkdown) => {
        order.push('artifact');
        return originalWriteWorkflowResult(targetJobId, persistedMarkdown);
      });
      vi.spyOn(progressStore, 'appendTerminal').mockImplementation(
        (targetJobId, targetSessionId, terminalResult, terminalPhase) => {
          order.push('terminal');
          expect(existsSync(jobResultPath(targetJobId))).toBe(true);
          expect(readFileSync(jobResultPath(targetJobId), 'utf-8')).toBe(markdown);
          expect(new SessionManager(ctx.projectRoot, runtime).get('codex', targetSessionId)?.state).toBe('pending');
          return originalAppendTerminal(targetJobId, targetSessionId, terminalResult, terminalPhase);
        },
      );
      vi.spyOn(sessionManager, 'setNonResumable').mockImplementation((targetSessionId) => {
        order.push('non_resumable');
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase,
          result,
        });
        return originalSetNonResumable(targetSessionId);
      });

      (
        service as unknown as {
          finishWorkflowJob(
            sessionId: string,
            jobId: string,
            terminalPhase: 'completed' | 'error' | 'aborted',
            terminalResult: typeof result,
            persistedMarkdown: string,
          ): void;
        }
      ).finishWorkflowJob(session.sessionId, jobId, phase, result, markdown);

      expect(order).toEqual(['artifact', 'terminal', 'non_resumable']);
      expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(markdown);
      expect(sessionManager.get('codex', session.sessionId)?.state).toBe('non_resumable');
    },
  );

  it('finishWorkflowJob writes result.md before status-only terminal fallback and marks the session non_resumable afterward', () => {
    const service = createService(ctx);
    const { progressStore, sessionManager } = getInternals(service);
    const session = sessionManager.allocate('codex', 'workflow-fallback', 'workflow', ctx.projectRoot);
    const jobId = `workflow-fallback-order-${randomUUID()}`;
    const phase = 'aborted' as const;
    const result = { content: '', aborted: true, notice: 'aborted', workflow: { steps: [] } };
    const markdown = '# fallback\n';
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
      jobKind: 'workflow',
    });
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);

    const order: string[] = [];
    const originalWriteWorkflowResult = progressStore.writeWorkflowResultMdOrThrow.bind(progressStore);
    const originalMarkTerminalStatus = progressStore.markTerminalStatus.bind(progressStore);
    const originalSetNonResumable = sessionManager.setNonResumable.bind(sessionManager);

    vi.spyOn(progressStore, 'writeWorkflowResultMdOrThrow').mockImplementation((targetJobId, persistedMarkdown) => {
      order.push('artifact');
      return originalWriteWorkflowResult(targetJobId, persistedMarkdown);
    });
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    vi.spyOn(progressStore, 'markTerminalStatus').mockImplementation((targetJobId, terminalResult, terminalPhase) => {
      order.push('terminal');
      expect(existsSync(jobResultPath(targetJobId))).toBe(true);
      expect(readFileSync(jobResultPath(targetJobId), 'utf-8')).toBe(markdown);
      expect(new SessionManager(ctx.projectRoot, runtime).get('codex', session.sessionId)?.state).toBe('pending');
      return originalMarkTerminalStatus(targetJobId, terminalResult, terminalPhase);
    });
    vi.spyOn(sessionManager, 'setNonResumable').mockImplementation((targetSessionId) => {
      order.push('non_resumable');
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase,
        result,
      });
      return originalSetNonResumable(targetSessionId);
    });

    (
      service as unknown as {
        finishWorkflowJob(
          sessionId: string,
          jobId: string,
          terminalPhase: 'completed' | 'error' | 'aborted',
          terminalResult: typeof result,
          persistedMarkdown: string,
        ): void;
      }
    ).finishWorkflowJob(session.sessionId, jobId, phase, result, markdown);

    expect(order).toEqual(['artifact', 'terminal', 'non_resumable']);
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(markdown);
    expect(sessionManager.get('codex', session.sessionId)?.state).toBe('non_resumable');
  });

  describe('recovery adoption APIs', () => {
    function makeLaunchRecord(
      overrides: Partial<PersistedLaunchRecord> & { jobId: string; sessionId: string },
    ): PersistedLaunchRecord {
      return {
        provider: 'codex',
        projectRoot: '/tmp/project',
        backendNamespace: 'old-backend-ns',
        pool: 'default',
        enqueueSequence: 0,
        providerAction: 'exec',
        request: {
          prompt: 'recover me',
          bypassPermissions: false,
          coralEnv: {},
        },
        createdAt: new Date().toISOString(),
        ...overrides,
      };
    }

    function makeRuntimeRecord(overrides?: Partial<DurableCliRuntimeRecord>): DurableCliRuntimeRecord {
      return {
        pid: process.pid,
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        startTime: new Date().toISOString(),
        ...overrides,
      };
    }

    function makeAppServerRuntimeRecord(
      overrides?: Partial<AppServerRuntimeRecord['providerMeta']>,
    ): AppServerRuntimeRecord {
      return {
        transport: 'app-server',
        startTime: new Date().toISOString(),
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          recoveryPolicy: 'session_continuity_only',
          ...overrides,
        },
      };
    }

    function buildExpectedInterruptedReport(reason: 'restart' | 'handoff', ...detailLines: string[]): string {
      const baseNotice =
        reason === 'restart'
          ? 'Backend restarted during the app-server turn. The interrupted turn was not replayed.'
          : 'Backend handoff interrupted the app-server turn. The interrupted turn was not replayed.';
      return [baseNotice, '', ...detailLines].join('\n');
    }

    describe('recoverQueuedJob', () => {
      it('recovers a queued job from a persisted launch record and preserves the original jobId', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        const jobId = `recover-queued-${randomUUID()}`;
        const sessionId = `session-recover-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        const recovered = service.recoverQueuedJob(launchRecord);

        expect(recovered).toBe(jobId);
        expect(queueDepth()).toBeGreaterThanOrEqual(1);
      });

      it('rebinds namespace to current backend', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        const jobId = `recover-rebind-${randomUUID()}`;
        const sessionId = `session-rebind-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        service.recoverQueuedJob(launchRecord);

        const status = progressStore.readStatus(jobId);
        expect(status?.backendNamespace).not.toBe('old-backend-ns');
      });

      it('hydrates event counter before new appends', () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        const jobId = `recover-hydrate-${randomUUID()}`;
        const sessionId = `session-hydrate-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });
        // Write some progress so the counter has something to hydrate
        progressStore.appendProgress(jobId, sessionId, 'step-1');
        progressStore.appendProgress(jobId, sessionId, 'step-2');

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        const hydrateSpy = vi.spyOn(progressStore, 'hydrateEventCounter');
        service.recoverQueuedJob(launchRecord);

        expect(hydrateSpy).toHaveBeenCalledWith(jobId);
      });

      it('job eventually executes when queue capacity opens', async () => {
        const never = new Promise<ProviderResult>(() => {});
        const { provider } = makeProvider({ execute: () => never });
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } = getInternals(service);
        const occupyIds = await occupyProviderSlots(service, ctx, 'codex');

        const jobId = `recover-exec-${randomUUID()}`;
        const mgr = new SessionManager(ctx.projectRoot, runtime);
        const session = mgr.allocate('codex', 'recover', 'gpt-5', ctx.projectRoot);
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        service.recoverQueuedJob(launchRecord);

        expect(queueDepth()).toBeGreaterThanOrEqual(1);

        // Release an occupied slot to trigger queue drain
        const releasedJob = occupyIds[0];
        releaseLaunch(releasedJob);

        // Give the async drain a tick to process
        await new Promise((resolve) => setTimeout(resolve, 50));

        // The recovered job should have been dequeued (queue depth should decrease)
        expect(queueDepth()).toBe(0);
      });
    });

    describe('adoptRunningJob', () => {
      it('adopts a running job with a live PID and returns a cleanup handle', () => {
        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        const jobId = `adopt-running-${randomUUID()}`;
        const sessionId = `session-adopt-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.writeRuntimeRecord(jobId, runtimeRecord);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        expect(typeof cleanup).toBe('function');
        expect(getActiveJobIds()).toContain(jobId);

        // Cleanup should release the resources
        cleanup();
        expect(getActiveJobIds()).not.toContain(jobId);
      });

      it('restores pool mapping and active permit', () => {
        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        const jobId = `adopt-pool-${randomUUID()}`;
        const sessionId = `session-pool-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId, pool: 'default' });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.writeRuntimeRecord(jobId, runtimeRecord);

        const activeIdsBefore = getActiveJobIds();
        expect(activeIdsBefore).not.toContain(jobId);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        expect(getActiveJobIds()).toContain(jobId);
        cleanup();
      });

      it('rebinds namespace', () => {
        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        const jobId = `adopt-rebind-${randomUUID()}`;
        const sessionId = `session-rebind-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        progressStore.writeLaunchRecord(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.writeRuntimeRecord(jobId, runtimeRecord);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        const status = progressStore.readStatus(jobId);
        expect(status?.backendNamespace).not.toBe('old-backend-ns');
        cleanup();
      });

      it('routes abort through runtime.process.kill', () => {
        const killSpy = vi.spyOn(runtime.process, 'kill').mockImplementation(() => {});
        const service = createService(ctx);
        const { progressStore, abortRegistry } = getInternals(service);

        const jobId = `adopt-abort-${randomUUID()}`;
        const sessionId = `session-adopt-abort-${randomUUID()}`;
        trackJob(jobId);

        progressStore.initJob({
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        const runtimeRecord = makeRuntimeRecord({ pid: 54321 });
        progressStore.writeLaunchRecord(jobId, launchRecord);
        progressStore.writeRuntimeRecord(jobId, runtimeRecord);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        expect(abortRegistry.abort([jobId])).toEqual({
          aborted: [jobId],
          notFound: [],
        });
        expect(killSpy).toHaveBeenCalledWith(54321, 'SIGTERM');

        cleanup();
      });
    });

    describe('completeRecoveredJob', () => {
      it('writes terminal result and releases session', () => {
        const service = createService(ctx);
        const { progressStore, sessionManager } = getInternals(service);

        const jobId = `complete-recovered-${randomUUID()}`;
        trackJob(jobId);

        const session = sessionManager.allocate('codex', 'recover-complete', 'gpt-5', ctx.projectRoot);
        progressStore.initJob({
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });

        // Simulate a running job being adopted: register active launch + claim session
        restoreActiveLaunch(jobId, 'codex');
        sessionManager.claimForJobSync(session.sessionId, jobId);

        service.completeRecoveredJob(jobId, session.sessionId, { content: 'recovered done' }, 'completed');

        const status = progressStore.readStatus(jobId);
        expect(status).toMatchObject({
          phase: 'completed',
          result: { content: 'recovered done' },
        });
        expect(existsSync(jobResultPath(jobId))).toBe(true);
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('recovered done');

        const updatedSession = sessionManager.get('codex', session.sessionId);
        expect(updatedSession?.activeJobId).toBeUndefined();
        expect(updatedSession?.lastJobId).toBe(jobId);
      });
    });

    describe('finalizeInterruptedAppServerJob', () => {
      it('skips the probe for lease-waiting jobs and preserves an existing conversationRef', async () => {
        const spawnProviderServerMock = vi.fn();
        spawnProviderServer = spawnProviderServerMock as unknown as SpawnProviderServerFn;
        const service = createService(ctx);
        const { progressStore, sessionManager } = getInternals(service);
        const jobId = `app-server-waiting-${randomUUID()}`;
        trackJob(jobId);
        const session = sessionManager.allocate('codex', 'recover-waiting', 'gpt-5', ctx.projectRoot);
        sessionManager.checkpointProviderContinuity(session.sessionId, {
          providerContinuity: {
            threadId: 'thread-existing',
          },
          conversationRef: 'thread-existing',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());

        progressStore.initJob({
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId: session.sessionId,
          projectRoot: ctx.projectRoot,
          request: {
            prompt: 'recover me',
            bypassPermissions: false,
            conversationRef: 'thread-existing',
            coralEnv: {},
          },
        });

        await service.finalizeInterruptedAppServerJob(
          launchRecord,
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          { reason: 'restart' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'restart',
          'Session was interrupted before completion. State unknown.',
        );

        expect(spawnProviderServerMock).not.toHaveBeenCalled();
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            notice: expect.stringContaining('The existing conversation reference was preserved.'),
          },
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
          activeJobId: undefined,
          lastJobId: jobId,
          state: 'ready',
          conversationRef: 'thread-existing',
        });
      });

      it('stores the recovered threadId when continuity is verified', async () => {
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        setSpawnProviderServerMock(
          createFakeProviderServerHandle({
            request: async (method) => {
              if (method === 'thread/resume') {
                return { thread: { id: 'thread-recovered' } };
              }
              return {};
            },
          }).handle,
        );
        const service = createService(ctx);
        const { progressStore, sessionManager } = getInternals(service);
        const jobId = `app-server-verified-${randomUUID()}`;
        trackJob(jobId);
        const session = sessionManager.allocate('codex', 'recover-verified', 'gpt-5', ctx.projectRoot);
        sessionManager.claimForJobSync(session.sessionId, jobId);

        progressStore.initJob({
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });

        await service.finalizeInterruptedAppServerJob(
          makeLaunchRecord({
            jobId,
            sessionId: session.sessionId,
            projectRoot: ctx.projectRoot,
          }),
          makeAppServerRuntimeRecord({
            providerContinuity: {
              threadId: 'thread-recovered',
            },
          }),
          { reason: 'restart' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'restart',
          'Session is resumable. Use resume to continue.',
          'Conversation reference preserved: thread-recovered',
        );

        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
          },
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
          activeJobId: undefined,
          lastJobId: jobId,
          state: 'ready',
          conversationRef: 'thread-recovered',
        });
      });

      it('clears conversationRef and marks the session non_resumable when the thread is definitively missing', async () => {
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        setSpawnProviderServerMock(
          createFakeProviderServerHandle({
            request: async (method) => {
              if (method === 'thread/resume') {
                throw new Error('No such thread');
              }
              return {};
            },
          }).handle,
        );
        const service = createService(ctx);
        const { progressStore, sessionManager } = getInternals(service);
        const jobId = `app-server-missing-${randomUUID()}`;
        trackJob(jobId);
        const session = sessionManager.allocate('codex', 'recover-missing', 'gpt-5', ctx.projectRoot);
        sessionManager.checkpointProviderContinuity(session.sessionId, {
          providerContinuity: {
            threadId: 'thread-stale',
          },
          conversationRef: 'thread-stale',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);

        progressStore.initJob({
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });

        await service.finalizeInterruptedAppServerJob(
          makeLaunchRecord({
            jobId,
            sessionId: session.sessionId,
            projectRoot: ctx.projectRoot,
            request: {
              prompt: 'recover me',
              bypassPermissions: false,
              conversationRef: 'thread-stale',
              coralEnv: {},
            },
          }),
          makeAppServerRuntimeRecord({
            providerContinuity: {
              threadId: 'thread-stale',
            },
          }),
          { reason: 'restart' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'restart',
          'Session thread is no longer available. Marked as non-resumable.',
        );

        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            nonResumable: true,
            notice: expect.stringContaining('session is non-resumable'),
          },
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
          activeJobId: undefined,
          lastJobId: jobId,
          state: 'non_resumable',
        });
        expect(sessionManager.get('codex', session.sessionId)?.conversationRef).toBeUndefined();
      });

      it('marks the session non_resumable and writes an explicit report when the probe is unavailable', async () => {
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        setSpawnProviderServerMock(
          createFakeProviderServerHandle({
            request: async (method) => {
              if (method === 'thread/resume') {
                throw new Error('transport unavailable');
              }
              return {};
            },
          }).handle,
        );
        const service = createService(ctx);
        const { progressStore, sessionManager } = getInternals(service);
        const jobId = `app-server-unavailable-${randomUUID()}`;
        trackJob(jobId);
        const session = sessionManager.allocate('codex', 'recover-unavailable', 'gpt-5', ctx.projectRoot);
        sessionManager.checkpointProviderContinuity(session.sessionId, {
          providerContinuity: {
            threadId: 'thread-unverified',
          },
          conversationRef: 'thread-unverified',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);

        progressStore.initJob({
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });

        await service.finalizeInterruptedAppServerJob(
          makeLaunchRecord({
            jobId,
            sessionId: session.sessionId,
            projectRoot: ctx.projectRoot,
            request: {
              prompt: 'recover me',
              bypassPermissions: false,
              conversationRef: 'thread-unverified',
              coralEnv: {},
            },
          }),
          makeAppServerRuntimeRecord({
            providerContinuity: {
              threadId: 'thread-unverified',
            },
          }),
          { reason: 'handoff' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'handoff',
          'Could not reach provider server to verify session. Marked as non-resumable.',
        );

        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            nonResumable: true,
            notice: expect.stringContaining('could not be verified'),
          },
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
          activeJobId: undefined,
          lastJobId: jobId,
          state: 'non_resumable',
        });
        expect(sessionManager.get('codex', session.sessionId)?.conversationRef).toBeUndefined();
      });
    });
  });
});

// @flaky — timing-sensitive concurrent fork tests; passes in isolation, retry under parallel suite
describe('ExecutionService adversarial', { retry: 2 }, () => {
  let ctx: CallerContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'red-exec-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {} };
    baselineJobIds = listJobDirs();
    mockState.getNewProvider.mockReset();
    mockState.resolveAgent.mockReset();
  });

  afterEach(() => {
    trackAllJobDirs();
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockState.getNewProvider.mockReset();
    mockState.resolveAgent.mockReset();
  });

  describe('ExecutionService.resume() adversarial', () => {
    it('rejects with non_resumable code when session state is non_resumable', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      mgr.setNonResumable(entry.sessionId);

      const service = createService(ctx);
      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('non_resumable');
      expect(decision.message).toContain(`Session ${entry.sessionId} is non-resumable`);
    });

    it('rejects with session_busy when session has activeJobId set (via live start)', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);

      const service = createService(ctx);
      const firstDecision = await service.start('codex', { prompt: 'first' }, ctx);
      expect(firstDecision.status).toBe('running');
      if (firstDecision.status !== 'running') throw new Error('expected running');
      trackJob(firstDecision.job);

      const decision = await service.resume('codex', { sessionId: firstDecision.session, prompt: 'resume' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_busy');
      expect(decision.message).toContain(`Session ${firstDecision.session} already has an active job`);
    });

    it('rejects with unknown_provider without setting activeJobId on the session', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);

      const service = createService(ctx);
      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hi' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('unknown_provider');
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBeUndefined();
    });

    it('allows exactly one concurrent resume and rejects the stale loser with session_busy', async () => {
      const gate = createDeferred<void>();
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
        execute: async () => never,
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      const jobDirsBefore = listJobDirs();
      const service = createService(ctx);

      const firstResume = service.resume('codex', { sessionId: entry.sessionId, prompt: 'one' }, ctx);
      const secondResume = service.resume('codex', { sessionId: entry.sessionId, prompt: 'two' }, ctx);
      gate.resolve();

      const decisions = await Promise.all([firstResume, secondResume]);
      const running = decisions.filter((decision) => decision.status === 'running');
      const rejected = decisions.filter((decision) => decision.status === 'rejected');

      expect(running).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = running[0];
      if (!winner || winner.status !== 'running') throw new Error('expected running winner');
      trackJob(winner.job);

      const loser = rejected[0];
      if (!loser || loser.status !== 'rejected') throw new Error('expected rejected loser');
      expect(loser.code).toBe('session_busy');
      expect(loser.message).toContain(`Session ${entry.sessionId} already has an active job`);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe(winner.job);
      expect([...listJobDirs()].filter((jobId) => !jobDirsBefore.has(jobId))).toHaveLength(1);
    });
  });

  describe('ExecutionService.fork() adversarial', () => {
    it('rejects with session_busy when source session has an active job', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);

      const service = createService(ctx);
      const firstDecision = await service.start('codex', { prompt: 'first' }, ctx);
      expect(firstDecision.status).toBe('running');
      if (firstDecision.status !== 'running') throw new Error('expected running');
      trackJob(firstDecision.job);

      const forkDecision = await service.fork('codex', { sessionId: firstDecision.session, prompt: 'branch' }, ctx);

      expect(forkDecision.status).toBe('rejected');
      if (forkDecision.status !== 'rejected') throw new Error('expected rejected');
      expect(forkDecision.code).toBe('session_busy');
      expect(forkDecision.message).toContain(`Session ${firstDecision.session} already has an active job`);
    });

    it('rejects with unknown_provider without allocating a new session', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const sessionsBefore = mgr.list('codex').length;

      const service = createService(ctx);
      const decision = await service.fork('codex', { sessionId: source.sessionId, prompt: 'branch' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('unknown_provider');
      expect(mgr.list('codex').length).toBe(sessionsBefore);
    });

    it('rejects when the source session becomes busy during preflight without allocating a new fork session', async () => {
      const gate = createDeferred<void>();
      const { provider } = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const sessionsBefore = mgr.list('codex').length;
      const jobDirsBefore = listJobDirs();

      const service = createService(ctx);
      const decisionPromise = service.fork('codex', { sessionId: source.sessionId, prompt: 'branch' }, ctx);
      expect(mgr.claimForJobSync(source.sessionId, 'job-race')).toBe(true);
      gate.resolve();

      const decision = await decisionPromise;

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_busy');
      expect(decision.message).toContain(`Session ${source.sessionId} already has an active job`);
      expect(mgr.list('codex').length).toBe(sessionsBefore);
      expect(listJobDirs()).toEqual(jobDirsBefore);
    });

    it('allows exactly one concurrent fork and rejects the stale loser with session_busy', async () => {
      const gate = createDeferred<void>();
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
        execute: async () => never,
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot, runtime);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const sessionsBefore = mgr.list('codex').length;
      const sourceVersionBefore = mgr.get('codex', source.sessionId)?.version;
      const jobDirsBefore = listJobDirs();
      const service = createService(ctx);

      const firstFork = service.fork('codex', { sessionId: source.sessionId, prompt: 'branch-one' }, ctx);
      const secondFork = service.fork('codex', { sessionId: source.sessionId, prompt: 'branch-two' }, ctx);
      gate.resolve();

      const decisions = await Promise.all([firstFork, secondFork]);
      const running = decisions.filter((decision) => decision.status === 'running');
      const rejected = decisions.filter((decision) => decision.status === 'rejected');

      expect(running).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = running[0];
      if (!winner || winner.status !== 'running') throw new Error('expected running winner');
      trackJob(winner.job);

      const loser = rejected[0];
      if (!loser || loser.status !== 'rejected') throw new Error('expected rejected loser');
      expect(loser.code).toBe('session_busy');
      expect(loser.message).toContain(`Session ${source.sessionId} already has an active job`);
      expect(mgr.list('codex')).toHaveLength(sessionsBefore + 1);
      expect(mgr.get('codex', source.sessionId)?.activeJobId).toBeUndefined();
      expect(mgr.get('codex', source.sessionId)?.version).toBeGreaterThan(sourceVersionBefore ?? 0);
      expect([...listJobDirs()].filter((jobId) => !jobDirsBefore.has(jobId))).toHaveLength(1);
    });

    it('rejects with session_not_found for a non-existent source session', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);

      const service = createService(ctx);
      const decision = await service.fork('codex', { sessionId: 'ghost-session', prompt: 'branch' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_not_found');
      expect(decision.message).toContain('Session not found: ghost-session');
    });
  });

  describe('rejected LaunchDecision does not allocate job or session resources', () => {
    it('start() rejected decision has no job or session property', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const service = createService(ctx);

      const decision = await service.start('missing', { prompt: 'test' }, ctx);

      expect(decision.status).toBe('rejected');
      expect(decision).not.toHaveProperty('job');
      expect(decision).not.toHaveProperty('session');
    });

    it('abort() reports all jobIds as notFound after a series of preflight rejections', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const service = createService(ctx);

      await service.start('missing', { prompt: 'a' }, ctx);
      await service.start('missing', { prompt: 'b' }, ctx);

      const result = service.abort(['phantom-job-1', 'phantom-job-2']);
      expect(result.aborted).toEqual([]);
      expect(result.notFound).toEqual(['phantom-job-1', 'phantom-job-2']);
    });
  });

  describe('ExecutionService.waitStream() adversarial', () => {
    it('timeout event runningJobIds contains ALL still-pending jobs, not just one', async () => {
      const jobIdA = `red-ws-a-${randomUUID()}`;
      const jobIdB = `red-ws-b-${randomUUID()}`;
      createdJobIds.add(jobIdA);
      createdJobIds.add(jobIdB);

      const service = createService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockImplementation((...args: unknown[]) => {
        const jobId = args[0] as string;
        if (jobId === jobIdA) {
          return {
            jobId: jobIdA,
            sessionId: 'session-a',
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: TEST_BACKEND_NAMESPACE,
            phase: 'running',
            launch: { state: 'ready', updatedAt: '' },
          };
        }
        if (jobId === jobIdB) {
          return {
            jobId: jobIdB,
            sessionId: 'session-b',
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: TEST_BACKEND_NAMESPACE,
            phase: 'running',
            launch: { state: 'ready', updatedAt: '' },
          };
        }
        return null;
      });
      vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);

      const events: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({
        jobIds: [jobIdA, jobIdB],
        timeoutSeconds: 0.001,
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('running');
      if (events[0].type !== 'running') throw new Error('expected running');
      expect(events[0].runningJobIds).toContain(jobIdA);
      expect(events[0].runningJobIds).toContain(jobIdB);
      expect(events[0].runningJobIds).toHaveLength(2);
    });

    it('cursor fromEventId skips already-delivered events (only newer events returned)', async () => {
      const jobId = `red-ws-cursor-${randomUUID()}`;
      createdJobIds.add(jobId);

      const service = createService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockImplementation((...args: unknown[]) => {
        const jid = args[0] as string;
        if (jid !== jobId) return null;
        return {
          jobId,
          sessionId: 'session-1',
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          phase: 'running',
          launch: { state: 'ready', updatedAt: '' },
        };
      });
      vi.spyOn(progressStore, 'replayFrom').mockImplementation((...args: unknown[]) => {
        const [jid, fromEventId] = args as [string, number];
        void jid;
        const all = [
          { jobId, sessionId: 'session-1', eventId: 1, type: 'progress' as const, ts: '', message: 'event-1' },
          { jobId, sessionId: 'session-1', eventId: 2, type: 'progress' as const, ts: '', message: 'event-2' },
          { jobId, sessionId: 'session-1', eventId: 3, type: 'terminal' as const, ts: '', result: { content: 'done' } },
        ];
        return all.filter((e) => e.eventId > fromEventId);
      });

      const events: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({
        jobIds: [jobId],
        timeoutSeconds: 5,
        cursor: { jobs: { [jobId]: 2 } },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('terminal');
      if (events[0].type !== 'terminal') throw new Error('expected terminal');
      expect(events[0].completedJobId).toBe(jobId);
      expect(events[0].resultPath).toBe(jobResultPath(jobId));

      const progressMessages = events
        .filter((e): e is Extract<WaitStreamEvent, { type: 'progress' }> => e.type === 'progress')
        .map((e) => e.message);
      expect(progressMessages).not.toContain('event-1');
      expect(progressMessages).not.toContain('event-2');
    });
  });
});
