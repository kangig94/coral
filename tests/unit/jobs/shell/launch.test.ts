import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as AgentResolutionMod from '#src/jobs/agent-resolution.js';
import { createDeferred } from '#tools/testing/deferred.js';
import type { JobPhase } from '#src/jobs/phase.js';
import type { AppServerRuntime, JobLaunch, JobEvent, JobStatus } from '#src/jobs/records.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import {
  providerContinuityEvent,
  providerProgressEvent,
  providerTerminalEvent,
  streamProviderEvents,
  streamProviderTerminal,
  type ProviderTerminalInput,
} from '#src/providers/stream.js';
import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import type { DurableCliRuntimeRecord as _DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';

import { jobsDir } from '#src/jobs/paths.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { buildCodexProviderServerSpec } from '#src/providers/codex/request-mapping.js';
import { parseExpression as _parseExpression } from '#src/workflow/parser.js';
import {
  AgentNamespaceNotFoundError,
  AgentNotFoundError,
  InvalidAgentRefError,
  type AgentRef,
} from '#src/jobs/agent-resolution.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { getMaxWorkers } from '#src/coordinator/live/worker-limits.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '#src/coordinator/live/provider-server-transport.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createProviderHostManager, type ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { SessionManager } from '#src/sessions/shell.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import type { PreflightRuntime } from '#src/providers/contract.js';
import { toProviderSpec, type Provider } from '#tests/helpers/scripted-provider.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

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
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-launch-test-tmp`,
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
    providers: permissiveProviderLookupPort,
  });
}

function _jobResultPath(jobId: string): string {
  return join(runtime.paths.coral.exports.jobsRoot, jobId, 'result.md');
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
  }): AsyncIterable<JobEvent> {
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
        .flatMap((jobId) => progressStore.readJobEvents(jobId).filter((event) => event.seq > observedSeq))
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
    loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
    readJobEvents: (jobId) => progressStore.readJobEvents(jobId),
    subscribeJobEvents,
    getCurrentJournalSeq,
    coordinatorCommit: createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
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

type TestProviderTurnResult = ProviderTurnResult;

type TestJobTerminal = Omit<NonNullable<JobStatus['result']>, 'outcome'> & {
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

function toCompletedJobTerminal(result: TestJobTerminal | { content: string }): NonNullable<JobStatus['result']> {
  if ('outcome' in result && result.outcome !== undefined) {
    return result as NonNullable<JobStatus['result']>;
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
                kind: 'set_resumable' as const,
                conversationRef: effectiveConversationRef,
                providerContinuity: continuity,
              }
            : {
                kind: 'preserve' as const,
                providerContinuity: continuity,
              }
          : {
              kind: 'clear_non_resumable' as const,
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

function makeSharedClaudeAppServerProvider(spec: {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  shared: true;
}): NonNullable<ReturnType<typeof toProviderSpec>> {
  return toProviderSpec({
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
                kind: 'set_resumable' as const,
                conversationRef: effectiveConversationRef,
                ...(probeResult.updatedContinuity ? { providerContinuity: probeResult.updatedContinuity } : {}),
              }
            : {
                kind: 'preserve' as const,
                ...(probeResult.updatedContinuity ? { providerContinuity: probeResult.updatedContinuity } : {}),
              }
          : {
              kind: 'clear_non_resumable' as const,
              ...(probeResult.updatedContinuity ? { providerContinuity: probeResult.updatedContinuity } : {}),
            };
      },
    },
  })!;
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

function _createClaimedJob(
  service: ExecutionService,
  ctx: InvocationContext,
  options: { initialPhase?: JobPhase } = {},
): {
  jobId: string;
  sessionId: string;
  progressStore: JobStore;
  sessionManager: SessionManager;
} {
  const { progressStore, sessionManager } =
    /* @intentional-private-access — seed or inspect execution internals with no public test seam */
    getInternals(service);
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

function realizePluginRoot(ctx: InvocationContext): string {
  mkdirSync(ctx.pluginRoot, { recursive: true });
  return pluginRootNamespace(ctx.pluginRoot);
}

function _createScopedContext(name: string): InvocationContext {
  const projectRoot = join(mockState.tmpHome, name);
  mkdirSync(projectRoot, { recursive: true });
  const pluginRoot = join(projectRoot, 'plugin');
  mkdirSync(pluginRoot, { recursive: true });
  return { projectRoot, pluginRoot, coralEnv: {}, authority: 'admin' };
}

function _isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

async function _flushMicrotasks(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function sessionsCreateSpec() {
  const spec = rpcCatalog.find((entry) => entry.name === 'sessions.create');
  if (!spec) {
    throw new Error('sessions.create spec not found');
  }
  return spec;
}

function createSessionTransportPorts(service: ExecutionService, pluginRoot: string): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot,
      token: 'test-token',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      namespace: TEST_BACKEND_NAMESPACE,
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: vi.fn(),
    },
    sessions: {
      start: service.start.bind(service),
    },
  } as unknown as HttpHandlerPorts;
}

function _makeStatusRecord(
  ctx: InvocationContext,
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
    jobKind: 'provider',
    phase,
    updatedAt: '2026-03-06T00:00:00.000Z',
    ...(options.result ? { result: toCompletedJobTerminal(options.result) } : {}),
  };
}

function _makeTerminalReplay(
  jobId: string,
  options: {
    seq?: number;
    sessionId?: string;
    ts?: string;
    result?: TestJobTerminal;
  } = {},
): JobEvent {
  return {
    jobId,
    sessionId: options.sessionId ?? `${jobId}-session`,
    seq: options.seq ?? 1,
    type: 'terminal',
    ts: options.ts ?? '2026-03-06T00:00:00.000Z',
    result: toCompletedJobTerminal(options.result ?? { content: 'done' }),
    continuity: null,
  };
}

describe('ExecutionService launch', () => {
  let ctx: InvocationContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {}, authority: 'admin' };
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

  it('start returns a running LaunchDecision with job and session ids', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
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

  it('start persists explicit discard retention into session.opened and launch request audit', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start(
      'codex',
      { prompt: 'hello', retention: 'discard_provider_artifacts_on_terminal' },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.job);

    const { progressStore, sessionManager } =
      /* @intentional-private-access — inspect launch retention persistence */
      getInternals(service);
    expect(sessionManager.get('codex', decision.session)?.retention).toBe('discard_provider_artifacts_on_terminal');
    expect(progressStore.readLaunchProjection(decision.job)?.request.retention).toBe(
      'discard_provider_artifacts_on_terminal',
    );
  });

  it('strict sessions.create transport path persists discard retention into session.opened', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    const spec = sessionsCreateSpec();
    const request = spec.requestSchema.parse({
      provider: 'codex',
      prompt: 'hello',
      projectRoot: ctx.projectRoot,
      retention: 'discard_provider_artifacts_on_terminal',
    });

    const response = await executeCatalogRequest(spec, request, createSessionTransportPorts(service, ctx.pluginRoot), 'admin');

    expect(response.kind).toBe('unary');
    if (response.kind !== 'unary') {
      throw new Error('expected unary transport response');
    }
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ launchState: 'running' });
    const body = response.body as { session: string; job: string };
    trackJob(body.job);

    const { sessionManager } =
      /* @intentional-private-access — inspect transport-created session entry */
      getInternals(service);
    expect(sessionManager.get('codex', body.session)?.retention).toBe('discard_provider_artifacts_on_terminal');
  });

  it('runs provider CLI jobs through the durable runner and persists runtime artifacts', async () => {
    const provider: Provider = {
      name: 'codex',
      execute: (request, runtime) =>
        streamProviderEvents(async (emit) => {
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
                emit(providerProgressEvent(parsed.message, new Date().toISOString()));
              } catch {
                /* ignore non-JSON progress lines */
              }
            },
          });

          emit(providerTerminalEvent({ content: result.stdout, outcome: { kind: 'completed' as const } }));
        }),
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
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const jobDir = join(JOBS_DIR, decision.job);
    const runtimeRecord = progressStore.readRuntimeProjection(decision.job) as _DurableCliRuntimeRecord | null;
    const history = progressStore.readJobEvents(decision.job);

    expect(terminal.result.content).toContain('final output');
    expect(existsSync(join(jobDir, 'runtime.json'))).toBe(false);
    expect(existsSync(join(jobDir, 'exit.json'))).toBe(false);
    expect(runtimeRecord?.pid).toBeGreaterThan(0);
    expect(runtimeRecord?.tailWatermark).toBeGreaterThan(0);
    expect(history.some((event) => event.type === 'progress' && event.message?.includes('step-1'))).toBe(true);
    expect(history.some((event) => event.type === 'progress' && event.message?.includes('step-2'))).toBe(true);
  });

  it('releases the session claim when provider session finalization throws after completion', async () => {
    const { provider } = makeProvider({
      execute: async (): Promise<ProviderTurnResult> => ({
        content: 'ok',
        continuity: {
          conversationRef: 'thread-1',
          resumable: true,
        },
        outcome: { kind: 'completed' },
      }),
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    vi.spyOn(sessionManager, 'setConversationRef').mockImplementation(() => {
      throw new Error('finalize failed');
    });

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.job);

    const terminal = await waitForTerminalEvent(service, decision.job);
    expect(terminal.result.content).toBe('ok');
    expect(progressStore.readStatus(decision.job)).toMatchObject({ phase: 'completed' });
    await vi.waitFor(() => {
      expect(sessionManager.get('codex', decision.session)?.activeJobId).toBeUndefined();
    });
  });

  it('records provider artifact handle events through the launch session API before continuity checkpoints', async () => {
    const execute = vi.fn(() =>
      streamProviderEvents<ProviderEventBody>((emit) => {
        emit({
          kind: 'artifact_handle',
          handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-1.jsonl',
        });
        emit(
          providerContinuityEvent({
            conversationRef: 'thread-1',
            resumable: true,
            providerContinuity: { threadId: 'thread-1' },
          }),
        );
        emit(providerTerminalEvent({ content: 'ok', outcome: { kind: 'completed' as const } }));
      }),
    );
    mockState.getNewProvider.mockReturnValue(
      toProviderSpec({
        name: 'codex',
        execute,
      })!,
    );
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.job);

    await waitForTerminalEvent(service, decision.job);
    const { sessionManager } =
      /* @intentional-private-access — inspect launch-session recording integration */
      getInternals(service);
    const session = sessionManager.get('codex', decision.session);

    expect(session?.conversationRef).toBe('thread-1');
    expect(session?.artifactHandles).toMatchObject([
      {
        provider: 'codex',
        handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-1.jsonl',
        sourceJobId: decision.job,
      },
    ]);
  });

  it('writes app-server runtime waiting before lease grant and upgrades the same record on acquisition', async () => {
    const spec = buildCodexProviderServerSpec(ctx.projectRoot);
    const server = createFakeProviderServerHandle({ generation: 41 });
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    const service = createService(ctx);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
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
    progressStore.appendLaunchRequested(jobId1, {
      jobId: jobId1,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'acquire first lease',
        cwd: ctx.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
    });
    progressStore.initJob({
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId2, {
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'acquire second lease',
        cwd: ctx.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
    });

    const firstLease = await service.acquireServer(spec, { jobId: jobId1 });
    const firstRuntime = progressStore.readRuntimeProjection(jobId1) as AppServerRuntime;
    expect(firstRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        serverGeneration: 41,
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

    const waitingRuntime = progressStore.readRuntimeProjection(jobId2) as AppServerRuntime;
    expect(waitingRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        leaseState: 'waiting',
      },
    });
    expect(waitingRuntime.startTime).toEqual(expect.any(String));
    expect(waitingRuntime.providerMeta.serverGeneration).toBeUndefined();
    expect(waitingRuntime.providerMeta.providerContinuity).toBeUndefined();
    expect(secondSettled).toBe(false);
    expect(spawnProviderServerMock).toHaveBeenCalledTimes(1);

    firstLease.release();
    const secondLease = await secondLeasePromise;

    const acquiredRuntime = progressStore.readRuntimeProjection(jobId2) as AppServerRuntime;
    expect(acquiredRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        serverGeneration: 41,
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
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
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
    progressStore.appendLaunchRequested(jobId1, {
      jobId: jobId1,
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'shared lease first',
        cwd: ctx.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
    });
    progressStore.initJob({
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId2, {
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'shared lease second',
        cwd: ctx.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
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

    const secondRuntime = progressStore.readRuntimeProjection(jobId2) as AppServerRuntime;
    expect(secondRuntime).toMatchObject({
      transport: 'app-server',
      providerMeta: {
        provider: 'claude',
        leaseState: 'acquired',
        serverGeneration: 41,
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
    const { progressStore, abortRegistry } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
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
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
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
    progressStore.appendRuntimeStarted(jobId, {
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
      },
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

    const launchRecord: JobLaunch = {
      jobId: `shared-interrupt-${randomUUID()}`,
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
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
    const runtimeRecord: AppServerRuntime = {
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
      preflight: async (_preflightRuntime) => {
        throw new Error('not ready');
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(preflight).toHaveBeenCalledTimes(1);
    expectRuntimePreflightArg(preflight!);
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
    const never = new Promise<ProviderTurnResult>(() => {});
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
    const session = getInternals(service).sessionManager.get('codex', decision.session);

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
      bypassPermissions: true,
      instruction: {
        content: 'Architect instruction',
        channel: 'system',
      },
    });
  });

  it('start defaults bypassPermissions to true when an agent is resolved', async () => {
    realizePluginRoot(ctx);
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider, execute } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockReturnValue(
      createResolvedAgent({ namespace: 'coral', name: 'scanner' }, '---\nmodel: gpt-5.4\n---\nScanner instruction'),
    );
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'scan project', agent: 'scanner' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running launch');
    trackJob(decision.job);

    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    const session = getInternals(service).sessionManager.get('codex', decision.session);

    expect(request.bypassPermissions).toBe(true);
    expect(session!.bypassPermissions).toBe(true);
  });

  it('start preserves explicit bypassPermissions=false even with an agent', async () => {
    realizePluginRoot(ctx);
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider, execute } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockReturnValue(
      createResolvedAgent({ namespace: 'coral', name: 'scanner' }, '---\nmodel: gpt-5.4\n---\nScanner instruction'),
    );
    const service = createService(ctx);

    const decision = await service.start(
      'codex',
      { prompt: 'scan project', agent: 'scanner', bypassPermissions: false },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running launch');
    trackJob(decision.job);

    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    expect(request.bypassPermissions).toBe(false);
  });

  it('start defaults bypassPermissions to false without an agent', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider, execute } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'raw prompt' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running launch');
    trackJob(decision.job);

    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    expect(request.bypassPermissions).toBe(false);
  });

  it('start returns queued when provider launch slots are full', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    await occupyProviderSlots(service, ctx, 'codex');

    const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

    expect(decision.status).toBe('queued');
    if (decision.status !== 'queued') throw new Error('expected queued launch');
    trackJob(decision.job);

    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    expect(progressStore.readStatus(decision.job)).toMatchObject({
      jobId: decision.job,
      sessionId: decision.session,
      provider: 'codex',
      phase: 'queued',
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

  it('coralDispatch rejects an empty sessionId before launch resolution', async () => {
    const service = createService(ctx);

    const decision = await service.coralDispatch('codex', 'sample', { prompt: 'hello', sessionId: '' }, ctx);

    expect(decision).toMatchObject({
      status: 'rejected',
      phase: 'preflight',
      code: 'invalid_request',
      message: 'Session ID is required when provided.',
    });
    expect(mockState.getNewProvider).not.toHaveBeenCalled();
    expect(mockState.resolveAgent).not.toHaveBeenCalled();
  });

  it('coralDispatch persists explicit workflow atom retention into session.opened', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveAgent.mockReturnValue(
      createResolvedAgent({ namespace: 'coral', name: 'sample' }, 'Injected coral content'),
    );
    const service = createService(ctx);

    const decision = await service.coralDispatch(
      'codex',
      'sample',
      { prompt: 'hello', retention: 'discard_provider_artifacts_on_terminal' },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.job);

    const { sessionManager } =
      /* @intentional-private-access — inspect workflow atom retention persistence */
      getInternals(service);
    expect(sessionManager.get('codex', decision.session)?.retention).toBe('discard_provider_artifacts_on_terminal');
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
});
