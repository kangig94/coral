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
  JobLaunch as _JobLaunch,
  JobProgress,
  JobStatus,
} from '../../views.js';
import type { WaitStreamEvent } from '../../wait.js';
import {
  streamProviderTerminal,
  type ProviderRequest as _ProviderRequest,
  type ProviderTerminalEventBody,
} from '../../../providers/protocol.js';
import type { DurableCliRuntimeRecord as _DurableCliRuntimeRecord } from '../../../runtime/durable-runtime.js';

import type { PreflightRuntime, Provider } from '../../../providers/provider-contracts.js';
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
import { ProgressStore } from '../../job-store.js';
import { createProviderHostManager, type ProviderHostManager } from '../../../coordinator/live/provider-hosts/pool.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { createFilesystemSessionLookup } from '../../../sessions/lookup.js';
import type { SessionManager } from '../../../sessions/shell/store.js';
import type { CallerContext } from '../../../shared/request-context.js';
import { ExecutionService } from '../../../coordinator/execution-service.js';
import { createDefaultUpcasterRegistry } from '../../../store/upcasters.js';

type ProviderTurnResult = Omit<ProviderTerminalEventBody, 'type'>;

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-wait-test-tmp`,
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

function createProgressStore(namespace = 'test-ns'): ProgressStore {
  return new ProgressStore(namespace, runtime, createDefaultUpcasterRegistry(), { eventBus });
}

function jobResultPath(jobId: string): string {
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
    progressStore: options.progressStore ?? createProgressStore(),
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
    sessionLookup: createFilesystemSessionLookup(runtime),
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

type TestProviderTurnResult = ProviderTurnResult;

type TestJobTerminal = Omit<NonNullable<JobStatus['result']>, 'outcome'> & {
  outcome?: NonNullable<JobStatus['result']>['outcome'];
};

function completedOutcome() {
  return { kind: 'completed' } as const;
}

function toCompletedResult(
  result: TestProviderTurnResult | { content: string },
): TestProviderTurnResult {
  if ('outcome' in result) {
    return result;
  }
  return { ...result, outcome: completedOutcome() };
}

function toCompletedJobTerminal(
  result: TestJobTerminal | { content: string },
): NonNullable<JobStatus['result']> {
  if ('outcome' in result && result.outcome !== undefined) {
    return result as NonNullable<JobStatus['result']>;
  }
  return { ...result, outcome: completedOutcome() };
}

function streamCompletedResult(
  result: TestProviderTurnResult | Promise<TestProviderTurnResult | { content: string }> | { content: string },
) {
  return streamProviderTerminal(Promise.resolve(result).then((value) => toCompletedResult(value)));
}

function makeProvider(options?: {
  execute?: (...args: Parameters<Provider['execute']>) => Promise<TestProviderTurnResult | { content: string }>;
  preflight?: Provider['preflight'];
}): {
  provider: Provider;
  execute: ReturnType<typeof vi.fn>;
  preflight?: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn((...args: Parameters<Provider['execute']>) =>
    streamCompletedResult(options?.execute?.(...args) ?? Promise.resolve({ content: 'ok' })));
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
    execute: vi.fn(() => streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const } })),
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
    execute: vi.fn(() => streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const } })),
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
  progressStore.writeLaunchRecord(jobId, {
    jobId,
    sessionId: session.sessionId,
    provider: 'codex',
    projectRoot: ctx.projectRoot,
    backendNamespace: TEST_BACKEND_NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: 'wait job',
      cwd: ctx.projectRoot,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: '2026-03-06T00:00:00.000Z',
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

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function makeStatusRecord(
  ctx: CallerContext,
  jobId: string,
  phase: JobPhase,
  options: {
    sessionId?: string;
    result?: TestJobTerminal;
  } = {},
): JobStatus {
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
    ...(options.result ? { result: toCompletedJobTerminal(options.result) } : {}),
  };
}

function makeTerminalReplay(
  jobId: string,
  options: {
    seq?: number;
    eventId?: number;
    sessionId?: string;
    ts?: string;
    result?: TestJobTerminal;
  } = {},
): JobProgress {
  return {
    jobId,
    sessionId: options.sessionId ?? `${jobId}-session`,
    seq: options.seq ?? options.eventId ?? 1,
    eventId: options.eventId ?? 1,
    type: 'terminal',
    ts: options.ts ?? '2026-03-06T00:00:00.000Z',
    result: toCompletedJobTerminal(options.result ?? { content: 'done' }),
  };
}

describe('ExecutionService wait', () => {
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

    it('waits for both terminal status and session claim release via session:released without timer polling', async () => {
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
      progressStore.markTerminalStatus(jobId, { content: 'done', outcome: { kind: 'completed' } }, 'completed');
      await flushMicrotasks();
      expect(outcome).toBe('pending');

      sessionManager.releaseJob(sessionId, jobId);
      await flushMicrotasks();

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
          (event === 'job:completed' || event === 'job:phase_changed' || event === 'job:progress')
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
          progressStore.markTerminalStatus(jobId, { content: 'done', outcome: { kind: 'completed' } }, 'completed');
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

  it('waitStream yields progress and terminal events in order', async () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const status: JobStatus = {
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
    const replay: JobProgress[] = [
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        seq: 1,
        eventId: 1,
        type: 'progress',
        ts: '2026-03-06T00:00:01.000Z',
        message: 'step 1',
      },
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        seq: 2,
        eventId: 2,
        type: 'terminal',
        ts: '2026-03-06T00:00:02.000Z',
        result: { content: 'done', outcome: { kind: 'completed' } },
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
        eventId: 1,
        message: 'step 1',
      },
      {
        type: 'terminal',
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done', outcome: { kind: 'completed' } },
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
      result: { content: 'done', outcome: { kind: 'completed' } },
    });
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'terminal',
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done', outcome: { kind: 'completed' } },
      },
    ]);
  });

  it('waitStream re-reads terminal status after replay before waiting for more changes', async () => {
    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const runningStatus: JobStatus = {
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
    const terminalStatus: JobStatus = {
      ...runningStatus,
      phase: 'completed',
      result: { content: 'done', outcome: { kind: 'completed' } },
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
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done', outcome: { kind: 'completed' } },
      },
    ]);
    expect(waitForChange).not.toHaveBeenCalled();
  });

  it('waitStream emits a replayed terminal persisted one millisecond before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 100;
      const deadlineMs = startMs + timeoutMs;
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
      vi.spyOn(progressStore, 'replayFrom').mockReturnValue([
        makeTerminalReplay('job-1', { ts: isoAt(deadlineMs - 1) }),
      ]);

      const events: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: 'terminal',
          jobId: 'job-1',
          remainingJobIds: [],
          resultPath: jobResultPath('job-1'),
          result: { content: 'done', outcome: { kind: 'completed' } },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitStream emits a replayed terminal persisted exactly at the deadline after a late wake', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 100;
      const deadlineMs = startMs + timeoutMs;
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
      vi.spyOn(progressStore, 'replayFrom')
        .mockImplementationOnce(() => [])
        .mockImplementationOnce(() => [makeTerminalReplay('job-1', { ts: isoAt(deadlineMs) })]);
      const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

      const iterator = service
        .waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })
        [Symbol.asyncIterator]();
      const nextPromise = iterator.next();

      await flushMicrotasks();
      expect(waitForChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(timeoutMs + 5);

      await expect(nextPromise).resolves.toEqual({
        done: false,
        value: {
          type: 'terminal',
          jobId: 'job-1',
          remainingJobIds: [],
          resultPath: jobResultPath('job-1'),
          result: { content: 'done', outcome: { kind: 'completed' } },
        },
      });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitStream yields waiting when no terminal evidence exists on disk at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 100;
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
      vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);
      const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

      const iterator = service
        .waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })
        [Symbol.asyncIterator]();
      const nextPromise = iterator.next();

      await flushMicrotasks();
      expect(waitForChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(timeoutMs + 1);

      await expect(nextPromise).resolves.toEqual({
        done: false,
        value: {
          type: 'waiting',
          waitingJobIds: ['job-1'],
        },
      });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitStream stays conservative when a replayed terminal lands after the deadline even if status is terminal on that poll', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 100;
      const deadlineMs = startMs + timeoutMs;
      vi.setSystemTime(startMs);
      vi.spyOn(runtime.time, 'now').mockImplementation(() => Date.now());

      const service = createService(ctx);
      const { progressStore } = getInternals(service);
      const runningStatus = makeStatusRecord(ctx, 'job-1', 'running');
      const terminalStatus = makeStatusRecord(ctx, 'job-1', 'completed', { result: { content: 'done' } });

      vi.spyOn(progressStore, 'readStatus').mockImplementation(() => {
        return runtime.time.now() > deadlineMs ? terminalStatus : runningStatus;
      });
      vi.spyOn(progressStore, 'replayFrom').mockImplementation(() => {
        return runtime.time.now() > deadlineMs ? [makeTerminalReplay('job-1', { ts: isoAt(deadlineMs + 1) })] : [];
      });
      const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

      const iterator = service
        .waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })
        [Symbol.asyncIterator]();
      const nextPromise = iterator.next();

      await flushMicrotasks();
      expect(waitForChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(timeoutMs + 5);

      await expect(nextPromise).resolves.toEqual({
        done: false,
        value: {
          type: 'waiting',
          waitingJobIds: ['job-1'],
        },
      });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('status-only fallback on the final on-time poll returns terminal for waitStream and waitStreamOnce', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 100;

      vi.setSystemTime(startMs);
      const streamService = createService(ctx);
      const { progressStore: streamStore } = getInternals(streamService);
      const streamRunning = makeStatusRecord(ctx, 'job-1', 'running');
      const streamTerminal = makeStatusRecord(ctx, 'job-1', 'completed', { result: { content: 'done' } });

      vi.spyOn(streamStore, 'readStatus')
        .mockImplementationOnce(() => streamRunning)
        .mockImplementationOnce(() => streamRunning)
        .mockImplementationOnce(() => streamRunning)
        .mockImplementationOnce(() => streamTerminal);
      vi.spyOn(streamStore, 'replayFrom').mockReturnValue([]);
      const streamWaitForChange = vi.spyOn(streamStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

      const streamIterator = streamService
        .waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })
        [Symbol.asyncIterator]();
      const streamNext = streamIterator.next();

      await flushMicrotasks();
      expect(streamWaitForChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(timeoutMs);

      await expect(streamNext).resolves.toEqual({
        done: false,
        value: {
          type: 'terminal',
          jobId: 'job-1',
          remainingJobIds: [],
          resultPath: jobResultPath('job-1'),
          result: { content: 'done', outcome: { kind: 'completed' } },
        },
      });
      await expect(streamIterator.next()).resolves.toEqual({ done: true, value: undefined });

      vi.setSystemTime(startMs);
      const onceService = createService(ctx);
      const { progressStore: onceStore } = getInternals(onceService);
      const onceRunning = makeStatusRecord(ctx, 'job-1', 'running');
      const onceTerminal = makeStatusRecord(ctx, 'job-1', 'completed', { result: { content: 'done' } });

      vi.spyOn(onceStore, 'readStatus')
        .mockImplementationOnce(() => onceRunning)
        .mockImplementationOnce(() => onceRunning)
        .mockImplementationOnce(() => onceRunning)
        .mockImplementationOnce(() => onceTerminal);
      vi.spyOn(onceStore, 'replayFrom').mockReturnValue([]);
      const onceWaitForChange = vi.spyOn(onceStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

      const oncePromise = onceService.waitStreamOnce('job-1', timeoutMs);

      await flushMicrotasks();
      expect(onceWaitForChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(timeoutMs);

      await expect(oncePromise).resolves.toEqual({
        content: 'done',
        nonResumable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('status-only fallback first observed after the deadline yields waiting', async () => {
    const startMs = Date.parse('2026-03-06T00:00:00.000Z');
    const timeoutMs = 100;
    let currentTime = startMs;

    const service = createService(ctx);
    const { progressStore } = getInternals(service);
    const runningStatus = makeStatusRecord(ctx, 'job-1', 'running');
    const terminalStatus = makeStatusRecord(ctx, 'job-1', 'completed', { result: { content: 'done' } });

    vi.spyOn(runtime.time, 'now').mockImplementation(() => currentTime);
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
      currentTime += ms + 5;
    });

    vi.spyOn(progressStore, 'readStatus')
      .mockImplementationOnce(() => runningStatus)
      .mockImplementationOnce(() => runningStatus)
      .mockImplementation(() => terminalStatus);
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);
    vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'waiting',
        waitingJobIds: ['job-1'],
      },
    ]);
  });

  it('replayed terminals with invalid or missing ts use the observation-time compatibility rule', async () => {
    const startMs = Date.parse('2026-03-06T00:00:00.000Z');
    const timeoutMs = 100;

    let currentTime = startMs;
    vi.spyOn(runtime.time, 'now').mockImplementation(() => currentTime);
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
      currentTime += ms + 5;
    });

    const onTimeService = createService(ctx);
    const { progressStore: onTimeStore } = getInternals(onTimeService);

    vi.spyOn(onTimeStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
    vi.spyOn(onTimeStore, 'replayFrom').mockReturnValue([makeTerminalReplay('job-1', { ts: '' })]);

    const onTimeEvents: WaitStreamEvent[] = [];
    for await (const event of onTimeService.waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })) {
      onTimeEvents.push(event);
    }

    expect(onTimeEvents).toEqual([
      {
        type: 'terminal',
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: jobResultPath('job-1'),
        result: { content: 'done', outcome: { kind: 'completed' } },
      },
    ]);

    currentTime = startMs;
    const lateService = createService(ctx);
    const { progressStore: lateStore } = getInternals(lateService);
    const missingTsTerminal = {
      jobId: 'job-1',
      sessionId: 'job-1-session',
      seq: 1,
      eventId: 1,
      type: 'terminal',
      result: { content: 'done' },
    } as JobProgress;

    vi.spyOn(lateStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
    vi.spyOn(lateStore, 'replayFrom').mockImplementation(() => {
      return currentTime > startMs + timeoutMs ? [missingTsTerminal] : [];
    });
    vi.spyOn(lateStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

    const lateEvents: WaitStreamEvent[] = [];
    for await (const event of lateService.waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })) {
      lateEvents.push(event);
    }

    expect(lateEvents).toEqual([
      {
        type: 'waiting',
        waitingJobIds: ['job-1'],
      },
    ]);
  });

  it('a skipped late replayed terminal can be replayed on the next request with the same cursor', async () => {
    const startMs = Date.parse('2026-03-06T00:00:00.000Z');
    const timeoutMs = 100;
    const lateTerminalMs = startMs + timeoutMs + 1;
    const cursor = { jobs: { 'job-1': 0 } };
    let currentTime = startMs;

    vi.spyOn(runtime.time, 'now').mockImplementation(() => currentTime);
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
      currentTime += ms + 5;
    });

    const service = createService(ctx);
    const { progressStore } = getInternals(service);

    vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
    vi.spyOn(progressStore, 'replayFrom').mockImplementation(() => {
      return currentTime > startMs + timeoutMs ? [makeTerminalReplay('job-1', { ts: isoAt(lateTerminalMs) })] : [];
    });
    vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

    const firstEvents: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({
      jobIds: ['job-1'],
      timeoutSeconds: timeoutMs / 1000,
      cursor,
    })) {
      firstEvents.push(event);
    }

    expect(firstEvents).toEqual([
      {
        type: 'waiting',
        waitingJobIds: ['job-1'],
      },
    ]);
    expect(cursor).toEqual({ jobs: { 'job-1': 0 } });

    const secondEvents: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({
      jobIds: ['job-1'],
      timeoutSeconds: timeoutMs / 1000,
      cursor,
    })) {
      secondEvents.push(event);
    }

    expect(secondEvents).toEqual([
      {
        type: 'terminal',
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: jobResultPath('job-1'),
        result: { content: 'done', outcome: { kind: 'completed' } },
      },
    ]);
  });

  it('waitStreamOnce returns content for an exact-boundary replayed terminal instead of throwing', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 180_000;
      const deadlineMs = startMs + timeoutMs;
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
      vi.spyOn(progressStore, 'replayFrom')
        .mockImplementationOnce(() => [])
        .mockImplementationOnce(() => [makeTerminalReplay('job-1', { ts: isoAt(deadlineMs) })]);
      const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

      const waitOnce = service.waitStreamOnce('job-1', timeoutMs);

      await flushMicrotasks();
      expect(waitForChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(timeoutMs + 5);

      await expect(waitOnce).resolves.toEqual({
        content: 'done',
        nonResumable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitStream emits a queued event before replaying queued progress records', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
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
      eventId: 1,
    });
    if (events[1]?.type === 'progress') {
      expect(events[1].message).toContain('queued (position 1)');
    }
  });

  describe('waitStream adversarial', () => {
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
      expect(events[0].type).toBe('waiting');
      if (events[0].type !== 'waiting') throw new Error('expected waiting');
      expect(events[0].waitingJobIds).toContain(jobIdA);
      expect(events[0].waitingJobIds).toContain(jobIdB);
      expect(events[0].waitingJobIds).toHaveLength(2);
    });

    it('late replayed terminals keep every pending job in the waiting set across multiple jobs', async () => {
      vi.useFakeTimers();
      try {
        const startMs = Date.parse('2026-03-06T00:00:00.000Z');
        const timeoutMs = 100;
        const deadlineMs = startMs + timeoutMs;
        const jobIdA = `red-ws-late-a-${randomUUID()}`;
        const jobIdB = `red-ws-late-b-${randomUUID()}`;
        createdJobIds.add(jobIdA);
        createdJobIds.add(jobIdB);
        vi.setSystemTime(startMs);
        vi.spyOn(runtime.time, 'now').mockImplementation(() => Date.now());

        const service = createService(ctx);
        const { progressStore } = getInternals(service);

        vi.spyOn(progressStore, 'readStatus').mockImplementation((jobId: string) => {
          if (jobId === jobIdA) return makeStatusRecord(ctx, jobIdA, 'running', { sessionId: 'session-a' });
          if (jobId === jobIdB) return makeStatusRecord(ctx, jobIdB, 'running', { sessionId: 'session-b' });
          return null;
        });
        vi.spyOn(progressStore, 'replayFrom').mockImplementation((jobId: string) => {
          if (jobId === jobIdA && runtime.time.now() > deadlineMs) {
            return [makeTerminalReplay(jobIdA, { sessionId: 'session-a', ts: isoAt(deadlineMs + 1) })];
          }
          return [];
        });
        const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockReturnValue(new Promise<void>(() => {}));

        const iterator = service
          .waitStream({ jobIds: [jobIdA, jobIdB], timeoutSeconds: timeoutMs / 1000 })
          [Symbol.asyncIterator]();
        const nextPromise = iterator.next();

        await flushMicrotasks();
        expect(waitForChange).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(timeoutMs + 5);

        const firstResult = await nextPromise;
        expect(firstResult.done).toBe(false);
        if (firstResult.done || firstResult.value.type !== 'waiting') throw new Error('expected waiting');
        expect(firstResult.value.waitingJobIds).toHaveLength(2);
        expect(firstResult.value.waitingJobIds).toContain(jobIdA);
        expect(firstResult.value.waitingJobIds).toContain(jobIdB);
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      } finally {
        vi.useRealTimers();
      }
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
          { jobId, sessionId: 'session-1', seq: 1, eventId: 1, type: 'progress' as const, ts: '', message: 'event-1' },
          { jobId, sessionId: 'session-1', seq: 2, eventId: 2, type: 'progress' as const, ts: '', message: 'event-2' },
          {
            jobId,
            sessionId: 'session-1',
            seq: 3,
            eventId: 3,
            type: 'terminal' as const,
            ts: '',
            result: { content: 'done', outcome: { kind: 'completed' as const } },
          },
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
      expect(events[0].jobId).toBe(jobId);
      expect(events[0].resultPath).toBe(jobResultPath(jobId));

      const progressMessages = events
        .filter((e): e is Extract<WaitStreamEvent, { type: 'progress' }> => e.type === 'progress')
        .map((e) => e.message);
      expect(progressMessages).not.toContain('event-1');
      expect(progressMessages).not.toContain('event-2');
    });
  });
});
