import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as AgentResolutionMod from '#src/jobs/agent-resolution.js';
import { createDeferred } from '#tools/testing/deferred.js';
import type { AppServerRuntime, JobLaunch, JobProgress, JobStatus } from '#src/jobs/records.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import {
  providerContinuityEvent,
  providerTerminalEvent,
  streamProviderEvents,
  streamProviderTerminal,
  type ProviderTerminalInput,
} from '#src/providers/stream.js';
import { providerRequestFailed, providerSessionUnavailable } from '#src/providers/fault.js';
import type { ProviderRequest } from '#src/providers/contract.js';
import type { DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';

import { jobsDir } from '#src/jobs/paths.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { buildCodexProviderServerSpec } from '#src/providers/codex/request-mapping.js';
import { parseExpression } from '#src/workflow/parser.js';
import { type AgentRef } from '#src/jobs/agent-resolution.js';
import {
  LaunchCoordinator,
  getMaxWorkers,
  type ProviderServerHandle,
  type SpawnProviderServerFn,
} from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/job-store.js';
import { createProviderHostManager, type ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createSessionLookup } from '#src/sessions/lookup.js';
import { SessionManager } from '#src/sessions/shell/store.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { composeReducers } from '#src/store/reducers.js';
import type { CommitContext } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { toProviderSpec, type PreflightRuntime, type Provider } from '#tests/helpers/scripted-provider.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';

type ProviderTurnContinuity = {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity?: Record<string, unknown> | null;
};

type ProviderTurnResult = ProviderTerminalInput & {
  continuity?: ProviderTurnContinuity;
};

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-service-composition-test-tmp`,
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

vi.mock('#src/providers/registry.js', () => ({
  getNewProvider: mockState.getNewProvider,
}));

vi.mock('#src/jobs/agent-resolution.js', async () => {
  const actual = await vi.importActual<typeof AgentResolutionMod>('#src/jobs/agent-resolution.js');
  return {
    ...actual,
    resolveAgent: mockState.resolveAgent,
  };
});

const createdJobIds = new Set<string>();
let baselineJobIds = new Set<string>();
let eventBus: TypedEventBus;
let launchCoordinator: LaunchCoordinator;
let spawnProviderServer: SpawnProviderServerFn;
let runtime: ReturnType<typeof createRealRuntime>;
let JOBS_DIR = '';

function createProgressStore(namespace = 'test-ns'): JobStore {
  return new JobStore(namespace, runtime, createDefaultUpcasterRegistry(), {
    db: openTestStoreDb(runtime),
    eventBus,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
  });
}

function createSessionManager(projectRoot: string): SessionManager {
  return new SessionManager(projectRoot, runtime, undefined, undefined, openTestStoreDb(runtime));
}

function jobResultPath(jobId: string): string {
  return join(runtime.paths.coral.exports.jobsRoot, jobId, 'result.md');
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

function createService(
  ctx: InvocationContext,
  options: {
    progressStore?: JobStore;
    bundleHash?: string;
    backendNamespace?: string;
    providerHostManager?: ProviderHostManager;
    pluginRegistry?: { discoverPluginRoot: (namespace: string) => string | null };
  } = {},
): ExecutionService {
  const resolveProvider = (name: string) => toProviderSpec(mockState.getNewProvider(name));
  const progressStore = options.progressStore ?? createProgressStore();
  const getCurrentJournalSeq = () =>
    (progressStore.getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const subscribeJobEvents = async function* ({
    afterSeq,
    jobIds,
    abortSignal,
  }: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }): AsyncIterable<JobProgress> {
    let observedSeq = afterSeq;
    const ids = new Set(jobIds);
    const waitForAbort = () =>
      abortSignal
        ? new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
          })
        : new Promise<void>(() => {});
    while (!abortSignal?.aborted) {
      const events = [...ids]
        .flatMap((jobId) => progressStore.readJobProgress(jobId).filter((event) => event.seq > observedSeq))
        .sort((left, right) => left.seq - right.seq);
      if (events.length > 0) {
        for (const event of events) {
          observedSeq = Math.max(observedSeq, event.seq);
          yield event;
        }
        continue;
      }
      const seq = progressStore.getChangeSeq();
      await Promise.race([
        progressStore.waitForChange(seq),
        runtime.time.sleep(100, { signal: abortSignal }),
        waitForAbort(),
      ]);
    }
  };
  return new ExecutionService(ctx, {
    runtime,
    progressStore,
    bundleHash: options.bundleHash,
    backendNamespace: options.backendNamespace ?? TEST_BACKEND_NAMESPACE,
    providerHostManager: options.providerHostManager ?? createProviderHostManager({ runtime, spawnProviderServer }),
    launchCoordinator,
    eventBus,
    providerRegistry: {
      get: resolveProvider,
      getAll: () => [],
    } as never,
    pluginRegistry: options.pluginRegistry ?? { discoverPluginRoot: () => null },
    coordinatorCommit: (cb) => progressStore.commit(cb),
    sessionLookup: createSessionLookup({ db: progressStore.getDb() }),
    loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
    readJobProgress: (jobId) => progressStore.readJobProgress(jobId),
    subscribeJobEvents,
    getCurrentJournalSeq,
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

function makeLaunchRecord(overrides: Partial<JobLaunch> & { jobId: string; sessionId: string }): JobLaunch {
  return {
    provider: 'codex',
    projectRoot: '/tmp/project',
    backendNamespace: 'old-backend-ns',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: 'recover me',
      cwd: '/tmp/project',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
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

type TestProviderTurnResult = ProviderTurnResult;

type _TestJobTerminal = Omit<NonNullable<JobStatus['result']>, 'outcome'> & {
  outcome?: NonNullable<JobStatus['result']>['outcome'];
};

function completedOutcome() {
  return { kind: 'completed' } as const;
}

function toCompletedResult(
  result: TestProviderTurnResult | { content: string; continuity?: ProviderTurnContinuity },
): TestProviderTurnResult {
  if ('outcome' in result) {
    return result;
  }
  return { ...result, outcome: completedOutcome() };
}

function streamCompletedResult(
  result:
    | TestProviderTurnResult
    | Promise<TestProviderTurnResult | { content: string; continuity?: ProviderTurnContinuity }>
    | { content: string; continuity?: ProviderTurnContinuity },
) {
  return streamProviderEvents(async (emit) => {
    const completed = toCompletedResult(await result);
    if (completed.continuity) {
      emit(
        providerContinuityEvent({
          conversationRef: completed.continuity.conversationRef,
          resumable: completed.continuity.resumable,
          providerContinuity: completed.continuity.providerContinuity ?? null,
        }),
      );
    }
    emit(providerTerminalEvent(completed));
  });
}

function makeProvider(options?: {
  execute?: (
    ...args: Parameters<Provider['execute']>
  ) => Promise<TestProviderTurnResult | { content: string; continuity?: ProviderTurnContinuity }>;
  preflight?: Provider['preflight'];
}): {
  provider: NonNullable<ReturnType<typeof toProviderSpec>>;
  execute: ReturnType<typeof vi.fn>;
  preflight?: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn((...args: Parameters<Provider['execute']>) =>
    streamCompletedResult(options?.execute?.(...args) ?? Promise.resolve({ content: 'ok' })),
  );
  const preflight = options?.preflight ? vi.fn(options.preflight) : undefined;
  const provider: Provider = {
    name: 'codex',
    execute: execute as unknown as Provider['execute'],
    ...(preflight ? { preflight } : {}),
  };
  return { provider: toProviderSpec(provider)!, execute, preflight };
}

function makeCodexAppServerProvider(): NonNullable<ReturnType<typeof toProviderSpec>> {
  return toProviderSpec({
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
      finalizeInterrupted: (probeResult, continuity, context) => {
        const effectiveConversationRef =
          typeof continuity.threadId === 'string' ? continuity.threadId : context.preservedConversationRef;
        return probeResult.resumable
          ? effectiveConversationRef
            ? {
                type: 'set_resumable' as const,
                conversationRef: effectiveConversationRef,
                providerContinuity: continuity,
              }
            : {
                type: 'preserve' as const,
                providerContinuity: continuity,
              }
          : {
              type: 'clear_non_resumable' as const,
              providerContinuity: continuity,
            };
      },
    },
  })!;
}

function expectRuntimePreflightArg(preflight: ReturnType<typeof vi.fn>): void {
  expect(preflight).toHaveBeenCalledWith({
    process: runtime.process,
    storage: runtime.storage,
    env: runtime.env,
    time: runtime.time,
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
      finalizeInterrupted: (probeResult, continuity, context) => {
        const effectiveConversationRef =
          typeof continuity.threadId === 'string' ? continuity.threadId : context.preservedConversationRef;
        return probeResult.resumable
          ? effectiveConversationRef
            ? {
                type: 'set_resumable' as const,
                conversationRef: effectiveConversationRef,
                ...(probeResult.updatedContinuity ? { providerContinuity: probeResult.updatedContinuity } : {}),
              }
            : {
                type: 'preserve' as const,
                ...(probeResult.updatedContinuity ? { providerContinuity: probeResult.updatedContinuity } : {}),
              }
          : {
              type: 'clear_non_resumable' as const,
              ...(probeResult.updatedContinuity ? { providerContinuity: probeResult.updatedContinuity } : {}),
            };
      },
    },
  };
}

async function occupyProviderSlots(
  service: ExecutionService,
  ctx: InvocationContext,
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

function realizePluginRoot(ctx: InvocationContext): string {
  mkdirSync(ctx.pluginRoot, { recursive: true });
  return pluginRootNamespace(ctx.pluginRoot);
}

function createScopedContext(name: string): InvocationContext {
  const projectRoot = join(mockState.tmpHome, name);
  mkdirSync(projectRoot, { recursive: true });
  const pluginRoot = join(projectRoot, 'plugin');
  mkdirSync(pluginRoot, { recursive: true });
  return { projectRoot, pluginRoot, coralEnv: {} };
}

describe('ExecutionService', () => {
  let ctx: InvocationContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {} };
    baselineJobIds = listJobDirs();
    eventBus = new TypedEventBus();
    runtime = createRealRuntime('prod');
    JOBS_DIR = jobsDir(runtime.env);
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

  describe('queue admission', () => {
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

    it('resumeBySessionId rejects a mismatched provider assertion with a recovery hint', async () => {
      realizePluginRoot(ctx);
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
      const entry = mgr.allocate({
        provider: 'codex',
        name: 'alpha',
        model: 'gpt-5',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: pluginRootNamespace(ctx.pluginRoot),
      });
      const service = createService(ctx, { backendNamespace: pluginRootNamespace(ctx.pluginRoot) });

      const decision = await service.resumeBySessionId(
        { provider: 'claude', sessionId: entry.sessionId, prompt: 'hello' },
        ctx,
      );

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'provider_mismatch',
      });
      if (decision.status === 'rejected') {
        expect(decision.message).toBe(
          `Session ${entry.sessionId} belongs to provider 'codex'. Use \`coral-cli codex -s ${entry.sessionId} ...\` instead.`,
        );
      }
    });

    it('resumeBySessionId continues when the asserted provider matches the stored provider', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
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

      const decision = await service.resumeBySessionId(
        { provider: 'codex', sessionId: entry.sessionId, prompt: 'hello' },
        ctx,
      );

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

    it('resumeBySessionId continues the stored provider when no provider assertion is supplied', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
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

    it('resumeBySessionId rejects sessions outside the current scope', async () => {
      const otherCtx = createScopedContext('other-project');
      const foreignMgr = createSessionManager(otherCtx.projectRoot);
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
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const instruction = {
        content: 'Persisted instruction',
        channel: 'system' as const,
      };
      const mgr = createSessionManager(ctx.projectRoot);
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
      expect(request.effort).toBeUndefined();
    });

    it('resume rejects when the session already has an active job', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
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
      const never = new Promise<ProviderTurnResult>(() => {});
      const blockingProvider = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(blockingProvider.provider);
      const service = createService(ctx);
      await occupyProviderSlots(service, ctx, 'codex');

      const gate = createDeferred<void>();
      const racingProvider = makeProvider({
        preflight: async (_preflightRuntime) => {
          await gate.promise;
        },
      });
      mockState.getNewProvider.mockReturnValue(racingProvider.provider);

      const mgr = createSessionManager(ctx.projectRoot);
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
      expectRuntimePreflightArg(racingProvider.preflight!);
      expect(queueDepth()).toBe(0);
      expect(listJobDirs()).toEqual(jobDirsBefore);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe('job-race');
    });

    it('resume clears conversationRef and marks the session non_resumable on invalid-thread results', async () => {
      const { provider } = makeProvider({
        execute: async () => ({
          content: '',
          continuity: {
            conversationRef: null,
            resumable: false,
          },
          outcome: {
            kind: 'failed',
          },
          failureCause: providerSessionUnavailable({
            provider: 'codex',
            reason: 'Conversation thread-stale is no longer resumable.',
          }),
        }),
      });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
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
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: {
              kind: 'session',
              id: expect.any(String),
            },
            seq: expect.any(Number),
          },
        },
      });
      expect(terminal.continuity).toEqual({ conversationRef: null, resumable: false });
      expect(updatedSession?.activeJobId).toBeUndefined();
      expect(updatedSession?.lastJobId).toBe(decision.job);
      expect(updatedSession?.state).toBe('non_resumable');
      expect(updatedSession?.conversationRef).toBeUndefined();
    });

    it('fork allocates a new session id', async () => {
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
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

    it('forkBySessionId rejects a mismatched provider assertion with a recovery hint', async () => {
      realizePluginRoot(ctx);
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
      const source = mgr.allocate({
        provider: 'codex',
        name: 'architect',
        model: 'gpt-5.1',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: pluginRootNamespace(ctx.pluginRoot),
      });
      const service = createService(ctx, { backendNamespace: pluginRootNamespace(ctx.pluginRoot) });

      const decision = await service.forkBySessionId(
        { provider: 'claude', sessionId: source.sessionId, prompt: 'branch' },
        ctx,
      );

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'provider_mismatch',
      });
      if (decision.status === 'rejected') {
        expect(decision.message).toBe(
          `Session ${source.sessionId} belongs to provider 'codex'. Use \`coral-cli codex -s ${source.sessionId} ...\` instead.`,
        );
      }
    });

    it('forkBySessionId persists the merged continuation profile onto the child session when the asserted provider matches', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const instruction = {
        content: 'Persisted instruction',
        channel: 'system' as const,
      };
      const mgr = createSessionManager(ctx.projectRoot);
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

      const decision = await service.forkBySessionId(
        { provider: 'codex', sessionId: source.sessionId, prompt: 'branch' },
        ctx,
      );

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
      expect(request.effort).toBeUndefined();
    });

    it('forkBySessionId persists the merged continuation profile onto the child session when no provider assertion is supplied', async () => {
      realizePluginRoot(ctx);
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const instruction = {
        content: 'Persisted instruction',
        channel: 'system' as const,
      };
      const mgr = createSessionManager(ctx.projectRoot);
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
      expect(request.effort).toBeUndefined();
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

    it('forkBySessionId rejects sessions outside the current scope', async () => {
      const otherCtx = createScopedContext('fork-foreign-project');
      const foreignMgr = createSessionManager(otherCtx.projectRoot);
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
  }); // end queue admission

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
        startPrompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = createSessionManager(ctx.projectRoot).get('codex', decision.session);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status = progressStore.readStatus(decision.job);
    const workflow = readWorkflowView(progressStore.getDb(), decision.job, createDefaultStoreReadContext());

    expect(existsSync(terminal.resultPath)).toBe(true);
    expect(markdownAtTerminal).toBe(
      ['# Step 0.0: architect', '', 'ARCH', '', '# Step 1.0: resolver', '', 'FINAL', ''].join('\n'),
    );
    expect(terminal.result).toEqual({
      content: 'FINAL',
      durationMs: 0,
      outcome: { kind: 'completed' },
    });
    expect(progressStore.loadJobProjectionDetail(decision.job).exit?.diagnostics).not.toHaveProperty('workflow');
    expect(workflow).toMatchObject({
      workflowId: decision.job,
      outcome: 'completed',
      slotOutcomes: {
        [`${decision.job}:0:0`]: { phase: 'completed', causeRef: null },
        [`${decision.job}:1:0`]: { phase: 'completed', causeRef: null },
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
        startPrompt: 'seed',
        provider: 'codex',
      },
      ctx,
      workDir,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    await waitForTerminalEvent(service, decision.job);

    const workflowSession = createSessionManager(ctx.projectRoot).get('codex', decision.session);
    const workDirSession = createSessionManager(workDir).get('codex', decision.session);

    expect(seenCwds).toEqual([workDir, workDir]);
    expect(workflowSession?.cwd).toBe(ctx.projectRoot);
    expect(workDirSession).toBeNull();
  });

  it('executeWorkflow bypasses launch admission when provider slots are full', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
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
        startPrompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackJob(decision.job);
    expect(getActiveJobIds()).toEqual(activeJobIds);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
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
          return { content: 'ARCH', outcome: { kind: 'completed' as const } };
        }
        if (request.name?.startsWith('resolver')) {
          return {
            content: '',
            outcome: {
              kind: 'failed',
            },
            failureCause: providerRequestFailed({ provider: 'codex', message: 'resolver failed' }),
          };
        }
        return { content: 'unexpected', outcome: { kind: 'completed' as const } };
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
        startPrompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = createSessionManager(ctx.projectRoot).get('codex', decision.session);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status = progressStore.readStatus(decision.job);
    const workflow = readWorkflowView(progressStore.getDb(), decision.job, createDefaultStoreReadContext());

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toMatchObject({
      content: '',
      outcome: {
        kind: 'failed',
        causeRef: {
          stream: { kind: 'workflow', id: decision.job },
        },
      },
    });
    expect(progressStore.loadJobProjectionDetail(decision.job).exit?.diagnostics).not.toHaveProperty('workflow');
    expect(workflow).toMatchObject({
      workflowId: decision.job,
      outcome: 'failed',
      slotOutcomes: {
        [`${decision.job}:0:0`]: { phase: 'completed', causeRef: null },
      },
    });
    expect(status).toMatchObject({
      phase: 'error',
      result: {
        content: '',
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: { kind: 'workflow', id: decision.job },
          },
        },
      },
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('persists partial workflow results on abort and marks the workflow session non_resumable', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH', outcome: { kind: 'completed' as const } };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: '', outcome: { kind: 'aborted', reason: 'signal_abort' } };
        }
        return { content: 'unexpected', outcome: { kind: 'completed' as const } };
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
        startPrompt: 'seed',
        provider: 'codex',
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = createSessionManager(ctx.projectRoot).get('codex', decision.session);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status = progressStore.readStatus(decision.job);
    const workflow = readWorkflowView(progressStore.getDb(), decision.job, createDefaultStoreReadContext());

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toMatchObject({
      content: '',
      outcome: {
        kind: 'aborted',
        reason: 'signal_abort',
      },
    });
    expect(progressStore.loadJobProjectionDetail(decision.job).exit?.diagnostics).not.toHaveProperty('workflow');
    expect(workflow).toMatchObject({
      workflowId: decision.job,
      outcome: 'aborted',
      causeRef: null,
      slotOutcomes: {
        [`${decision.job}:0:0`]: { phase: 'completed', causeRef: null },
      },
    });
    expect(status).toMatchObject({
      phase: 'aborted',
      result: {
        content: '',
        outcome: {
          kind: 'aborted',
          reason: 'signal_abort',
        },
      },
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('leaves provider jobs unterminated when authoritative terminal commit throws', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);

    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const originalCommit = progressStore.commit.bind(progressStore);
    let terminalCommitAttempts = 0;
    const commit = vi.spyOn(progressStore, 'commit').mockImplementation((cb) =>
      originalCommit(<Scope>(c: CommitContext<Scope>) => {
        let sawTerminal = false;
        const tracked: CommitContext<Scope> = {
          append(input) {
            sawTerminal = sawTerminal || input.type === 'job.terminal.recorded';
            return c.append(input);
          },
        };
        const result = cb(tracked);
        if (sawTerminal) {
          terminalCommitAttempts += 1;
          throw new Error('disk full');
        }
        return result;
      }),
    );

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackJob(decision.job);

    const deadline = Date.now() + 2_000;
    while (terminalCommitAttempts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = progressStore.readStatus(decision.job);

    expect(commit).toHaveBeenCalled();
    expect(terminalCommitAttempts).toBeGreaterThan(0);
    expect(status).toMatchObject({
      phase: 'launching',
    });
    expect(status?.result).toBeUndefined();
    expect(sessionManager.get('codex', decision.session)?.activeJobId).toBe(decision.job);
  });

  it('propagates terminal append failure for finishQueuedAbort without releasing ownership', () => {
    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = sessionManager.allocate('codex', 'queued-abort', 'gpt-5', ctx.projectRoot);
    const jobId = `queued-abort-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });
    progressStore.appendLaunchRequested(
      jobId,
      makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot }),
    );
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
    vi.spyOn(progressStore, 'commit').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() =>
      (
        service as unknown as {
          finishQueuedAbort(jobId: string, sessionId: string, message: string): void;
        }
      ).finishQueuedAbort(jobId, session.sessionId, 'queue_shutdown'),
    ).toThrow('disk full');

    expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'launching' });
    expect(progressStore.readStatus(jobId)?.result).toBeUndefined();
    expect(sessionManager.get('codex', session.sessionId)?.activeJobId).toBe(jobId);
  });

  it('propagates terminal append failure for failJob before cleanup', () => {
    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = sessionManager.allocate('codex', 'fail-job', 'gpt-5', ctx.projectRoot);
    const jobId = `fail-job-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });
    progressStore.appendLaunchRequested(
      jobId,
      makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot }),
    );
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
    vi.spyOn(progressStore, 'commit').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() =>
      (
        service as unknown as {
          launchOrchestrator: {
            failJob(
              jobId: string,
              sessionId: string,
              terminal: {
                content: string;
                outcome: {
                  kind: 'failed';
                  causeRef: {
                    stream: { kind: 'session'; id: string };
                    seq: number;
                  };
                };
              },
            ): void;
          };
        }
      ).launchOrchestrator.failJob(jobId, session.sessionId, {
        content: '',
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: {
              kind: 'session',
              id: session.sessionId,
            },
            seq: 1,
          },
        },
      }),
    ).toThrow('disk full');
    expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'launching' });
    expect(sessionManager.get('codex', session.sessionId)?.activeJobId).toBe(jobId);
  });

  it('propagates terminal append failure for finishWorkflowJob before session finalization', () => {
    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = sessionManager.allocate('codex', 'workflow-terminal', 'workflow', ctx.projectRoot);
    const jobId = `workflow-terminal-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: 'test-ns',
    });
    progressStore.appendLaunchRequested(
      jobId,
      makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot, jobKind: 'workflow' }),
    );
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
    vi.spyOn(progressStore, 'commit').mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = { content: 'done', outcome: { kind: 'completed' as const } };

    expect(() =>
      (
        service as unknown as {
          finishWorkflowJob(
            sessionId: string,
            jobId: string,
            phase: 'completed' | 'error' | 'aborted',
            result: { content: string },
            markdown: string,
          ): void;
        }
      ).finishWorkflowJob(session.sessionId, jobId, 'completed', result, '# workflow\n'),
    ).toThrow('disk full');

    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'launching',
    });
    expect(progressStore.readStatus(jobId)?.result).toBeUndefined();
    expect(existsSync(jobResultPath(jobId))).toBe(false);
    expect(sessionManager.get('codex', session.sessionId)?.state).toBe('pending');
    expect(sessionManager.get('codex', session.sessionId)?.activeJobId).toBe(jobId);
  });

  it.each([
    {
      phase: 'completed' as const,
      result: { content: 'done', outcome: { kind: 'completed' as const } },
      diagnostics: {},
      markdown: '# completed\n',
    },
    {
      phase: 'error' as const,
      result: {
        content: '',
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: {
              kind: 'workflow',
              id: 'workflow-1',
            },
            seq: 1,
          },
        },
      },
      diagnostics: {},
      markdown: '# failed\n',
    },
    {
      phase: 'error' as const,
      result: {
        content: '',
        outcome: { kind: 'aborted', reason: 'signal_abort' as const },
      },
      diagnostics: {},
      markdown: '# aborted\n',
    },
  ])(
    'finishWorkflowJob persists %s terminal authority before result.md and marks the session non_resumable afterward',
    ({ phase, result, diagnostics, markdown }) => {
      const service = createService(ctx);
      const { progressStore, sessionManager } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);
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
      progressStore.appendLaunchRequested(
        jobId,
        makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot, jobKind: 'workflow' }),
      );
      expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);

      const order: string[] = [];
      const originalCommit = progressStore.commit.bind(progressStore);
      const originalSetNonResumable = sessionManager.setNonResumable.bind(sessionManager);
      const originalWriteAtomic = runtime.storage.writeAtomicSync.bind(runtime.storage);
      let terminalCommitObserved = false;

      vi.spyOn(runtime.storage, 'writeAtomicSync').mockImplementation((targetPath, content, options) => {
        if (targetPath === jobResultPath(jobId)) {
          order.push('artifact');
        }
        return originalWriteAtomic(targetPath, content, options);
      });
      vi.spyOn(progressStore, 'commit').mockImplementation((cb) => {
        if (!terminalCommitObserved) {
          terminalCommitObserved = true;
          order.push('terminal');
          expect(existsSync(jobResultPath(jobId))).toBe(false);
          expect(createSessionManager(ctx.projectRoot).get('codex', session.sessionId)?.state).toBe('pending');
        }
        return originalCommit(cb);
      });
      vi.spyOn(sessionManager, 'setNonResumable').mockImplementation((targetSessionId) => {
        order.push('non_resumable');
        const persistedPhase = result.outcome.kind === 'aborted' ? 'aborted' : phase;
        const persistedResult =
          result.outcome.kind === 'failed'
            ? {
                content: '',
                outcome: {
                  kind: 'failed',
                  causeRef: {
                    stream: { kind: 'workflow', id: jobId },
                  },
                },
              }
            : result;
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: persistedPhase,
          result: persistedResult,
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(markdown);
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
            terminalDiagnostics: typeof diagnostics,
          ): void;
        }
      ).finishWorkflowJob(session.sessionId, jobId, phase, result, markdown, diagnostics);

      expect(order).toEqual(['terminal', 'artifact', 'non_resumable']);
      expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(markdown);
      expect(sessionManager.get('codex', session.sessionId)?.state).toBe('non_resumable');
    },
  );

  it('finishWorkflowJob skips artifact and non_resumable state when terminal append fails', () => {
    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = sessionManager.allocate('codex', 'workflow-terminal-failure', 'workflow', ctx.projectRoot);
    const jobId = `workflow-terminal-failure-order-${randomUUID()}`;
    const phase = 'error' as const;
    const result = {
      content: '',
      outcome: { kind: 'aborted', reason: 'signal_abort' as const },
    };
    const diagnostics = {};
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
    progressStore.appendLaunchRequested(
      jobId,
      makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot, jobKind: 'workflow' }),
    );
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);

    const order: string[] = [];
    const originalWriteAtomic = runtime.storage.writeAtomicSync.bind(runtime.storage);

    vi.spyOn(runtime.storage, 'writeAtomicSync').mockImplementation((targetPath, content, options) => {
      if (targetPath === jobResultPath(jobId)) {
        order.push('artifact');
      }
      return originalWriteAtomic(targetPath, content, options);
    });
    vi.spyOn(progressStore, 'commit').mockImplementation(() => {
      order.push('terminal');
      expect(existsSync(jobResultPath(jobId))).toBe(false);
      expect(createSessionManager(ctx.projectRoot).get('codex', session.sessionId)?.state).toBe('pending');
      throw new Error('disk full');
    });
    const setNonResumable = vi.spyOn(sessionManager, 'setNonResumable');

    expect(() =>
      (
        service as unknown as {
          finishWorkflowJob(
            sessionId: string,
            jobId: string,
            terminalPhase: 'completed' | 'error' | 'aborted',
            terminalResult: typeof result,
            persistedMarkdown: string,
            terminalDiagnostics: typeof diagnostics,
          ): void;
        }
      ).finishWorkflowJob(session.sessionId, jobId, phase, result, markdown, diagnostics),
    ).toThrow('disk full');

    expect(order).toEqual(['terminal']);
    expect(existsSync(jobResultPath(jobId))).toBe(false);
    expect(setNonResumable).not.toHaveBeenCalled();
    expect(sessionManager.get('codex', session.sessionId)?.state).toBe('pending');
    expect(progressStore.readStatus(jobId)?.result).toBeUndefined();
  });

  describe('recovery adoption APIs', () => {
    function makeRuntimeRecord(overrides?: Partial<DurableCliRuntimeRecord>): DurableCliRuntimeRecord {
      return {
        pid: process.pid,
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        startTime: new Date().toISOString(),
        ...overrides,
      };
    }

    function makeAppServerRuntimeRecord(overrides?: Partial<AppServerRuntime['providerMeta']>): AppServerRuntime {
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

    function buildExpectedInterruptedReport(
      reason: 'restart' | 'handoff',
      continuity: 'verified' | 'missing' | 'unavailable' | 'pre_checkpoint_preserved',
      ...detailLines: string[]
    ): string {
      const triggerText =
        reason === 'restart' ? 'App-server restarted during the turn' : 'App-server handoff occurred during the turn';
      const continuityText =
        continuity === 'verified'
          ? 'continuity verified'
          : continuity === 'missing'
            ? 'continuity missing'
            : continuity === 'unavailable'
              ? 'continuity unavailable'
              : 'existing conversation reference was preserved';
      const baseNotice = `${triggerText}; ${continuityText}.`;
      return [baseNotice, '', ...detailLines].join('\n');
    }

    describe('recoverQueuedJob', () => {
      it('recovers a queued job from a persisted launch record and preserves the original jobId', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const recovered = service.recoverQueuedJob(launchRecord);

        expect(recovered).toBe(jobId);
        expect(queueDepth()).toBeGreaterThanOrEqual(1);
      });

      it('rebinds namespace to current backend', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(jobId, launchRecord);

        service.recoverQueuedJob(launchRecord);

        const status = progressStore.readStatus(jobId);
        expect(status?.backendNamespace).not.toBe('old-backend-ns');
      });

      it('recovers queued jobs without hydrating retired progress counters', () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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

        const launchRecord = makeLaunchRecord({ jobId, sessionId });
        progressStore.appendLaunchRequested(jobId, launchRecord);
        // Existing progress no longer requires a per-job counter hydration step.
        const firstProgressSeq = progressStore.appendProgress(jobId, sessionId, 'step-1');
        const secondProgressSeq = progressStore.appendProgress(jobId, sessionId, 'step-2');

        service.recoverQueuedJob(launchRecord);

        expect(progressStore.readJobProgress(jobId).map((event) => event.seq)).toEqual([
          firstProgressSeq,
          secondProgressSeq,
        ]);
      });

      it('job eventually executes when queue capacity opens', async () => {
        const never = new Promise<ProviderTurnResult>(() => {});
        const { provider } = makeProvider({ execute: () => never });
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const occupyIds = await occupyProviderSlots(service, ctx, 'codex');

        const jobId = `recover-exec-${randomUUID()}`;
        const mgr = createSessionManager(ctx.projectRoot);
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
        progressStore.appendLaunchRequested(jobId, launchRecord);

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
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        expect(typeof cleanup).toBe('function');
        expect(getActiveJobIds()).toContain(jobId);

        // Cleanup should release the resources
        cleanup();
        expect(getActiveJobIds()).not.toContain(jobId);
      });

      it('restores pool mapping and active permit', () => {
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const activeIdsBefore = getActiveJobIds();
        expect(activeIdsBefore).not.toContain(jobId);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        expect(getActiveJobIds()).toContain(jobId);
        cleanup();
      });

      it('rebinds namespace', () => {
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const { cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord);

        const status = progressStore.readStatus(jobId);
        expect(status?.backendNamespace).not.toBe('old-backend-ns');
        cleanup();
      });

      it('routes abort through runtime.process.kill', () => {
        const killSpy = vi.spyOn(runtime.process, 'kill').mockImplementation(() => {});
        const service = createService(ctx);
        const { progressStore, abortRegistry } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(jobId, launchRecord);
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

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
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

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
        progressStore.appendLaunchRequested(
          jobId,
          makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot }),
        );

        // Simulate a running job being adopted: register active launch + claim session
        restoreActiveLaunch(jobId, 'codex');
        sessionManager.claimForJobSync(session.sessionId, jobId);

        service.completeRecoveredJob(
          jobId,
          session.sessionId,
          { content: 'recovered done', outcome: { kind: 'completed' } },
          'completed',
        );

        const status = progressStore.readStatus(jobId);
        expect(status).toMatchObject({
          phase: 'completed',
          result: { content: 'recovered done', outcome: { kind: 'completed' } },
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
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
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
            cwd: '/tmp/project',
            bypassPermissions: false,
            conversationRef: 'thread-existing',
            coralEnv: {},
          },
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          launchRecord,
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          { reason: 'restart' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'restart',
          'pre_checkpoint_preserved',
          'Session was interrupted before completion. The existing conversation reference was preserved.',
        );

        expect(spawnProviderServerMock).not.toHaveBeenCalled();
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: {
                  kind: 'session',
                  id: session.sessionId,
                },
                seq: expect.any(Number),
              },
            },
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
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
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
        progressStore.appendLaunchRequested(
          jobId,
          makeLaunchRecord({ jobId, sessionId: session.sessionId, projectRoot: ctx.projectRoot }),
        );

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
          'verified',
          'Session is resumable. Use resume to continue.',
          'Conversation reference preserved: thread-recovered',
        );

        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: {
                  kind: 'session',
                  id: session.sessionId,
                },
                seq: expect.any(Number),
              },
            },
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
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
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

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId: session.sessionId,
          projectRoot: ctx.projectRoot,
          request: {
            prompt: 'recover me',
            cwd: '/tmp/project',
            bypassPermissions: false,
            conversationRef: 'thread-stale',
            coralEnv: {},
          },
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          launchRecord,
          makeAppServerRuntimeRecord({
            providerContinuity: {
              threadId: 'thread-stale',
            },
          }),
          { reason: 'restart' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'restart',
          'missing',
          'Session thread is no longer available. Marked as non-resumable.',
        );

        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: {
                  kind: 'session',
                  id: session.sessionId,
                },
                seq: expect.any(Number),
              },
            },
          },
          continuity: null,
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
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
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

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId: session.sessionId,
          projectRoot: ctx.projectRoot,
          request: {
            prompt: 'recover me',
            cwd: '/tmp/project',
            bypassPermissions: false,
            conversationRef: 'thread-unverified',
            coralEnv: {},
          },
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          launchRecord,
          makeAppServerRuntimeRecord({
            providerContinuity: {
              threadId: 'thread-unverified',
            },
          }),
          { reason: 'handoff' },
        );

        const expectedReport = buildExpectedInterruptedReport(
          'handoff',
          'unavailable',
          'Could not reach provider server to verify session. Marked as non-resumable.',
        );

        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase: 'error',
          result: {
            content: expectedReport,
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: {
                  kind: 'session',
                  id: session.sessionId,
                },
                seq: expect.any(Number),
              },
            },
          },
          continuity: null,
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
          activeJobId: undefined,
          lastJobId: jobId,
          state: 'non_resumable',
        });
        expect(sessionManager.get('codex', session.sessionId)?.conversationRef).toBeUndefined();
        stderrSpy.mockRestore();
      });
    });
  });
});

describe('ExecutionService adversarial', () => {
  let ctx: InvocationContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'red-exec-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {} };
    baselineJobIds = listJobDirs();
    eventBus = new TypedEventBus();
    runtime = createRealRuntime('prod');
    JOBS_DIR = jobsDir(runtime.env);
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
    vi.restoreAllMocks();
    mockState.getNewProvider.mockReset();
    mockState.resolveAgent.mockReset();
  });

  describe('ExecutionService.resume() adversarial', () => {
    it('rejects with non_resumable code when session state is non_resumable', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = createSessionManager(ctx.projectRoot);
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
      const never = new Promise<ProviderTurnResult>(() => {});
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
      const mgr = createSessionManager(ctx.projectRoot);
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
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, preflight } = makeProvider({
        preflight: async (_preflightRuntime) => {
          await gate.promise;
        },
        execute: async () => never,
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = createSessionManager(ctx.projectRoot);
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
      expectRuntimePreflightArg(preflight!);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe(winner.job);
      expect([...listJobDirs()].filter((jobId) => !jobDirsBefore.has(jobId))).toHaveLength(1);
    });
  });

  describe('ExecutionService.fork() adversarial', () => {
    it('rejects with session_busy when source session has an active job', async () => {
      const never = new Promise<ProviderTurnResult>(() => {});
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
      const mgr = createSessionManager(ctx.projectRoot);
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
      const { provider, preflight } = makeProvider({
        preflight: async (_preflightRuntime) => {
          await gate.promise;
        },
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = createSessionManager(ctx.projectRoot);
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
      expectRuntimePreflightArg(preflight!);
      expect(mgr.list('codex').length).toBe(sessionsBefore);
      expect(listJobDirs()).toEqual(jobDirsBefore);
    });

    it('allows exactly one concurrent fork and rejects the stale loser with session_busy', async () => {
      const gate = createDeferred<void>();
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, preflight } = makeProvider({
        preflight: async (_preflightRuntime) => {
          await gate.promise;
        },
        execute: async () => never,
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = createSessionManager(ctx.projectRoot);
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
      expectRuntimePreflightArg(preflight!);
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
});
