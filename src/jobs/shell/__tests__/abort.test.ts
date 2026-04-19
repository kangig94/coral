import {
  existsSync as _existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as _readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as AgentResolutionMod from '../agent-resolution.js';
import { createDeferred as _createDeferred } from '../../../shared/test-deferred.js';
import type { JobPhase } from '../../phase.js';
import type {
  AppServerRuntimeRecord as _AppServerRuntimeRecord,
  JobLaunchRecord as _JobLaunchRecord,
  JobProgressRecord,
  JobStatusRecord,
} from '../../records.js';
import type { WaitStreamEvent } from '../../wait.js';
import type { ProviderRequest as _ProviderRequest, ProviderTurnResult } from '../../../providers/protocol.js';
import type { DurableCliRuntimeRecord as _DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';

import type { PreflightRuntime, Provider } from '../../../providers/types.js';
import { pluginRootNamespace } from '../../../infra/paths.js';
import { buildCodexProviderServerSpec } from '../../../providers/codex/request-mapping.js';
import { parseExpression as _parseExpression } from '../../../workflow/parser.js';
import {
  AgentNamespaceNotFoundError as _AgentNamespaceNotFoundError,
  AgentNotFoundError as _AgentNotFoundError,
  InvalidAgentRefError as _InvalidAgentRefError,
  type AgentRef,
} from '../agent-resolution.js';
import {
  LaunchCoordinator,
  getMaxWorkers,
  type ProviderServerHandle,
  type SpawnProviderServerFn,
} from '../../../coordinator/live/admission.js';
import type { AbortRegistry } from '../abort-registry.js';
import { TypedEventBus } from '../../../coordinator/control.js';
import { ProgressStore } from '../../../execution/progress-store.js';
import { createProviderHostManager, type ProviderHostManager } from '../../../coordinator/live/provider-hosts/pool.js';
import { createRealRuntime } from '../../../runtime/real.js';
import type { SessionManager } from '../../../execution/session-manager.js';
import type { CallerContext } from '../../../shared/request-context.js';
import { ExecutionService } from '../../../coordinator/api.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-abort-test-tmp`,
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

vi.mock('../../../providers/registry.js', () => ({
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

function _jobResultPath(jobId: string): string {
  return join(JOBS_DIR, jobId, 'result.md');
}

function cancelQueued(jobId: string, pool?: 'default' | 'discuss' | 'curate'): boolean {
  return launchCoordinator.cancelQueued(jobId, pool);
}

function _getActiveJobIds(pool?: 'default' | 'discuss' | 'curate'): string[] {
  return launchCoordinator.getActiveJobIds(pool);
}

function terminateAll(): void {
  launchCoordinator.terminateAll();
}

function _queueDepth(pool?: 'default' | 'discuss' | 'curate'): number {
  return launchCoordinator.queueDepth(pool);
}

function releaseLaunch(jobId: string, pool?: 'default' | 'discuss' | 'curate'): void {
  launchCoordinator.releaseLaunch(jobId, pool);
}

function _restoreActiveLaunch(jobId: string, provider: string, pool?: 'default' | 'discuss' | 'curate'): void {
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
  const resolveProvider = (name: string) => mockState.getNewProvider(name);
  return new ExecutionService(ctx, {
    runtime,
    progressStore: options.progressStore ?? new ProgressStore('test-ns', runtime, eventBus),
    bundleHash: options.bundleHash,
    backendNamespace: options.backendNamespace ?? TEST_BACKEND_NAMESPACE,
    providerHostManager: options.providerHostManager ?? createProviderHostManager({ runtime, spawnProviderServer }),
    launchCoordinator,
    eventBus,
    providerRegistry: {
      get: resolveProvider,
      getExecutor: resolveProvider,
      getAppServerLifecycle: (name: string) => resolveProvider(name)?.appServerLifecycle,
      getArtifactRecovery: (name: string) => resolveProvider(name)?.artifactRecovery,
      getArtifactCleanup: (name: string) => resolveProvider(name)?.artifactCleanup,
      getAll: () => [],
    } as never,
    pluginRegistry: options.pluginRegistry ?? { discoverPluginRoot: () => null },
  });
}

function _createResolvedAgent(ref: AgentRef, content: string) {
  return {
    ref: { namespace: ref.namespace ?? 'coral', name: ref.name },
    source: 'agent' as const,
    content,
    path: `/tmp/${ref.name}.md`,
  };
}

function _setSpawnProviderServerMock(...handles: ProviderServerHandle[]) {
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

function _createFakeProviderServerHandle(options?: {
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

type TestProviderTurnResult = Omit<ProviderTurnResult, 'outcome'> & {
  outcome?: ProviderTurnResult['outcome'];
};

type TestJobTerminalRecord = Omit<NonNullable<JobStatusRecord['result']>, 'outcome'> & {
  outcome?: NonNullable<JobStatusRecord['result']>['outcome'];
};

function completedOutcome() {
  return { kind: 'completed' } as const;
}

function withCompletedOutcome<T extends { content: string; outcome?: unknown }>(
  result: T,
): T & {
  outcome: Exclude<T['outcome'], undefined> | ReturnType<typeof completedOutcome>;
} {
  if (result.outcome !== undefined) {
    return result as T & { outcome: Exclude<T['outcome'], undefined> | ReturnType<typeof completedOutcome> };
  }
  return { ...result, outcome: completedOutcome() };
}

function makeProvider(options?: {
  execute?: (...args: Parameters<Provider['execute']>) => Promise<TestProviderTurnResult>;
  preflight?: Provider['preflight'];
}): {
  provider: Provider;
  execute: ReturnType<typeof vi.fn>;
  preflight?: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (...args: Parameters<Provider['execute']>): Promise<ProviderTurnResult> => {
    const result = await (options?.execute?.(...args) ?? Promise.resolve({ content: 'ok' }));
    return withCompletedOutcome(result) as ProviderTurnResult;
  });
  const preflight = options?.preflight ? vi.fn(options.preflight) : undefined;
  const provider: Provider = {
    name: 'codex',
    execute,
    ...(preflight ? { preflight } : {}),
  };
  return { provider, execute, preflight };
}

function _makeCodexAppServerProvider(): Provider {
  return {
    name: 'codex',
    execute: vi.fn(async () => ({ content: 'ok', outcome: { kind: 'completed' as const } })),
    appServerLifecycle: {
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

function _expectRuntimePreflightArg(preflight: ReturnType<typeof vi.fn>): void {
  expect(preflight).toHaveBeenCalledWith({
    process: runtime.process,
    storage: runtime.storage,
    env: runtime.env,
  } satisfies PreflightRuntime);
}

function _makeSharedClaudeAppServerProvider(spec: {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  shared: true;
}): Provider {
  return {
    name: 'claude',
    execute: vi.fn(async () => ({ content: 'ok', outcome: { kind: 'completed' as const } })),
    appServerLifecycle: {
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

async function _waitForTerminalEvent(
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

function _createClaimedJob(
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

function _realizePluginRoot(ctx: CallerContext): string {
  mkdirSync(ctx.pluginRoot, { recursive: true });
  return pluginRootNamespace(ctx.pluginRoot);
}

function _createScopedContext(name: string): CallerContext {
  const projectRoot = join(mockState.tmpHome, name);
  mkdirSync(projectRoot, { recursive: true });
  const pluginRoot = join(projectRoot, 'plugin');
  mkdirSync(pluginRoot, { recursive: true });
  return { projectRoot, pluginRoot, coralEnv: {} };
}

function _isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

async function _flushMicrotasks(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function _makeStatusRecord(
  ctx: CallerContext,
  jobId: string,
  phase: JobPhase,
  options: {
    sessionId?: string;
    result?: TestJobTerminalRecord;
  } = {},
): JobStatusRecord {
  return {
    jobId,
    sessionId: options.sessionId ?? `${jobId}-session`,
    provider: 'codex',
    projectRoot: ctx.projectRoot,
    backendNamespace: TEST_BACKEND_NAMESPACE,
    phase,
    launch: {
      state: 'ready',
      updatedAt: '2026-03-06T00:00:00.000Z',
    },
    ...(options.result ? { result: withCompletedOutcome(options.result) } : {}),
  };
}

function _makeTerminalReplay(
  jobId: string,
  options: {
    eventId?: number;
    sessionId?: string;
    ts?: string;
    result?: TestJobTerminalRecord;
  } = {},
): JobProgressRecord {
  return {
    jobId,
    sessionId: options.sessionId ?? `${jobId}-session`,
    eventId: options.eventId ?? 1,
    type: 'terminal',
    ts: options.ts ?? '2026-03-06T00:00:00.000Z',
    result: withCompletedOutcome(options.result ?? { content: 'done' }),
  };
}

describe('ExecutionService abort', () => {
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

  it('abort aborts the correct jobs', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
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
    const never = new Promise<ProviderTurnResult>(() => {});
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
        outcome: { kind: 'aborted', reason: 'queue_shutdown' },
      },
    });
  });
});
