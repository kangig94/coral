import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { allocateTestSession, initTestJob, seedTestJobSession } from '../../../helpers/session.js';
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
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { getMaxWorkers } from '#src/coordinator/live/worker-limits.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '#src/coordinator/live/provider-server-transport.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createProviderHostManager, type ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { SessionManager } from '#src/sessions/shell.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { CommitEventsFn } from '#src/store/append.js';
import { toProviderSpec, type Provider } from '#tests/helpers/scripted-provider.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { CONTEXT_ENV_KEY } from '#src/transport/context-profile.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import {
  TEST_CLAUDE_BINDING,
  TEST_CODEX_BINDING,
  TEST_CODEX_SCOPE,
  TEST_CODEX_SCOPE_INPUT,
  TEST_CODEX_SOURCE,
  TEST_SYSTEM_PROVIDER_SCOPE,
  withTestProfileLocation,
} from '#tests/helpers/provider-credentials.js';

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
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-launch-test-tmp-${process.pid}`,
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

vi.mock('#src/providers/registry.js', async () => ({
  ...(await vi.importActual('#src/providers/registry.js')),
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
  return new JobStore(namespace, runtime, createEventBodyCodec(), {
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

function createService(
  ctx: InvocationContext,
  options: {
    progressStore?: JobStore;
    bundleHash?: string;
    backendNamespace?: string;
    providerHostManager?: ProviderHostManager;
    pluginRegistry?: { discoverPluginRoot: (namespace: string) => string | null };
    coordinatorCommit?: CommitEventsFn;
  } = {},
): ExecutionService {
  const resolveProvider = (name: string) => toProviderSpec(mockState.getNewProvider(name));
  const providerRegistry = new ProviderRegistry();
  const provider = resolveProvider('codex');
  if (provider !== undefined) providerRegistry.register(provider);
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
    childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
    runtime,
    progressStore,
    bundleHash: options.bundleHash,
    backendNamespace: options.backendNamespace ?? TEST_BACKEND_NAMESPACE,
    providerHostManager: options.providerHostManager ?? createProviderHostManager({ runtime, spawnProviderServer }),
    launchCoordinator,
    eventBus,
    providerRegistry,
    pluginRegistry: options.pluginRegistry ?? { discoverPluginRoot: () => null },
    loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
    readJobEvents: (jobId) => progressStore.readJobEvents(jobId),
    aggregateWorkflowUsage: createTestJobJournalDeps(progressStore, runtime).aggregateWorkflowUsage,
    subscribeJobEvents,
    getCurrentJournalSeq,
    coordinatorCommit: options.coordinatorCommit ?? createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
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
  result: TestProviderTurnResult | { content: string; durationMs: number; continuity?: ProviderTurnContinuity },
): TestProviderTurnResult {
  if ('outcome' in result) {
    return result;
  }
  return { ...result, outcome: completedOutcome() };
}

function toCompletedJobTerminal(
  result: TestJobTerminal | { content: string; durationMs: number },
): NonNullable<JobStatus['result']> {
  if ('outcome' in result && result.outcome !== undefined) {
    return result as NonNullable<JobStatus['result']>;
  }
  return { ...result, outcome: completedOutcome() };
}

function streamCompletedResult(
  result:
    | TestProviderTurnResult
    | Promise<TestProviderTurnResult | { content: string; durationMs: number; continuity?: ProviderTurnContinuity }>
    | { content: string; durationMs: number; continuity?: ProviderTurnContinuity },
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
  ) => Promise<TestProviderTurnResult | { content: string; durationMs: number; continuity?: ProviderTurnContinuity }>;
  preflight?: Provider['preflight'];
}): {
  provider: NonNullable<ReturnType<typeof toProviderSpec>>;
  execute: ReturnType<typeof vi.fn>;
  preflight?: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn((...args: Parameters<Provider['execute']>) =>
    streamCompletedResult(options?.execute?.(...args) ?? Promise.resolve({ content: 'ok', durationMs: 0 })),
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
    execute: vi.fn(() =>
      streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const }, durationMs: 0 }),
    ),
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
          typeof continuity?.threadId === 'string' ? continuity.threadId : context.preservedConversationRef;
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
  expect(preflight).toHaveBeenCalledWith(
    expect.objectContaining({
      process: runtime.process,
      storage: runtime.storage,
      env: runtime.env,
      time: runtime.time,
      credentialSource: TEST_CODEX_SOURCE,
      cwd: expect.any(String),
      runExact: expect.any(Function),
    }),
  );
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
    execute: vi.fn(() =>
      streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const }, durationMs: 0 }),
    ),
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
          typeof continuity?.threadId === 'string' ? continuity.threadId : context.preservedConversationRef;
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
    trackJob(decision.jobId);
    jobIds.push(decision.jobId);
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
  const session = allocateTestSession(
    sessionManager,
    'codex',
    'wait-session',
    'test-model',
    ctx.projectRoot,
    ctx.projectRoot,
  );
  const jobId = `wait-job-${randomUUID()}`;
  trackJob(jobId);
  initTestJob(progressStore, {
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
  return {
    projectRoot,
    pluginRoot,
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
    providerScope: TEST_CODEX_SCOPE,
  };
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
      bootToken: 'test-boot-token',
      shutdownToken: 'test-shutdown-token',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      namespace: TEST_BACKEND_NAMESPACE,
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    systemProviderScope: TEST_SYSTEM_PROVIDER_SCOPE,
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
    owner: { kind: 'provider-session', id: options.sessionId ?? `${jobId}-session` },
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
    result: toCompletedJobTerminal(options.result ?? { content: 'done', durationMs: 0 }),
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
    ctx = {
      projectRoot,
      pluginRoot: join(projectRoot, 'plugin'),
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
      providerScope: TEST_CODEX_SCOPE,
    };
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
      trackJob(decision.jobId);
      expect(decision.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(decision.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  it('terminalizes and releases a committed initial launch when synchronous runtime setup fails', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider, execute } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    const { abortRegistry, progressStore, sessionManager } = getInternals(service);
    const jobId = `setup-failure-${randomUUID()}`;
    trackJob(jobId);
    const failedJobDir = progressStore.jobDir(jobId);
    const mkdir = runtime.storage.mkdirSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'mkdirSync').mockImplementation((path, options) => {
      if (path === failedJobDir) throw new Error('mkdir failed after commit');
      mkdir(path, options);
    });

    await expect(service.start('codex', { prompt: 'hello', jobId }, ctx)).rejects.toThrow('mkdir failed after commit');

    const launch = progressStore.readLaunchProjection(jobId);
    expect(launch?.sessionId).toEqual(expect.any(String));
    if (launch?.sessionId === null || launch?.sessionId === undefined) throw new Error('expected provider session');
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'error',
      result: {
        outcome: {
          kind: 'job_fault',
          fault: { kind: 'wrapper_crashed', cause: { message: 'mkdir failed after commit' } },
        },
      },
    });
    expect(sessionManager.get('codex', launch.sessionId)?.activeJobId).toBeUndefined();
    expect(abortRegistry.has(jobId)).toBe(false);
    expect(launchCoordinator.getActiveJobIds()).not.toContain(jobId);
    expect(execute).not.toHaveBeenCalled();
  });

  it('removes the workflow abort registration when its atomic launch commit fails', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    const { abortRegistry, progressStore } = getInternals(service);
    vi.spyOn(progressStore, 'commit').mockImplementationOnce(() => {
      throw new Error('workflow launch commit failed');
    });

    await expect(
      service.executeWorkflow(
        'codex',
        _parseExpression('architect'),
        { expression: 'architect', startPrompt: 'seed', provider: 'codex' },
        ctx,
      ),
    ).rejects.toThrow('workflow launch commit failed');

    expect(abortRegistry.listActive()).toEqual([]);
  });

  it('one execution service keeps consecutive account contexts isolated', async () => {
    const seenHomes: string[] = [];
    const { provider } = makeProvider({
      execute: async (_request, providerRuntime) => {
        if (providerRuntime.providerContext.provider !== 'codex') throw new Error('expected Codex context');
        seenHomes.push(providerRuntime.providerContext.source.home);
        return { content: 'ok', durationMs: 0 };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    const contextA = {
      ...ctx,
      providerScope: withTestProfileLocation(TEST_CODEX_SCOPE, 'codex', '/accounts/codex-a'),
    };
    const contextB = {
      ...ctx,
      providerScope: withTestProfileLocation(TEST_CODEX_SCOPE, 'codex', '/accounts/codex-b'),
    };

    const first = await service.start('codex', { prompt: 'account A' }, contextA);
    const second = await service.start('codex', { prompt: 'account B' }, contextB);
    if (first.status !== 'running' || second.status !== 'running') throw new Error('expected both launches to run');
    trackJob(first.jobId);
    trackJob(second.jobId);

    await vi.waitFor(() => expect(seenHomes).toEqual(['/accounts/codex-a', '/accounts/codex-b']));
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
    trackJob(decision.jobId);

    const { progressStore, sessionManager } =
      /* @intentional-private-access — inspect launch retention persistence */
      getInternals(service);
    expect(sessionManager.get('codex', decision.sessionId)?.retention).toBe('discard_provider_artifacts_on_terminal');
    const launch = progressStore.readLaunchProjection(decision.jobId);
    expect(launch?.jobKind).toBe('provider');
    expect(launch?.jobKind === 'provider' ? launch.request.retention : undefined).toBe(
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
      providerScope: TEST_CODEX_SCOPE_INPUT,
      retention: 'discard_provider_artifacts_on_terminal',
    });

    const response = await executeCatalogRequest(
      spec,
      request,
      createSessionTransportPorts(service, ctx.pluginRoot),
      testProjectPrincipal(ctx.projectRoot),
    );

    expect(response.kind).toBe('unary');
    if (response.kind !== 'unary') {
      throw new Error('expected unary transport response');
    }
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ launchState: 'running' });
    const body = response.body as { sessionId: string; jobId: string };
    trackJob(body.jobId);

    const { sessionManager } =
      /* @intentional-private-access — inspect transport-created session entry */
      getInternals(service);
    expect(sessionManager.get('codex', body.sessionId)?.retention).toBe('discard_provider_artifacts_on_terminal');
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

          emit(
            providerTerminalEvent({ content: result.stdout, outcome: { kind: 'completed' as const }, durationMs: 0 }),
          );
        }),
    };
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch');
    }
    trackJob(decision.jobId);

    const terminal = await waitForTerminalEvent(service, decision.jobId);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const jobDir = join(JOBS_DIR, decision.jobId);
    const runtimeRecord = progressStore.readRuntimeProjection(decision.jobId) as _DurableCliRuntimeRecord | null;
    const history = progressStore.readJobEvents(decision.jobId);

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
        durationMs: 0,
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
    trackJob(decision.jobId);

    const terminal = await waitForTerminalEvent(service, decision.jobId);
    expect(terminal.result.content).toBe('ok');
    expect(progressStore.readStatus(decision.jobId)).toMatchObject({ phase: 'completed' });
    await vi.waitFor(() => {
      expect(sessionManager.get('codex', decision.sessionId)?.activeJobId).toBeUndefined();
    });
  });

  it('records provider artifact handle events through the launch session API before continuity checkpoints', async () => {
    const execute = vi.fn(() =>
      streamProviderEvents<ProviderEventBody>((emit) => {
        emit({
          kind: 'artifact_handle',
          handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-1.jsonl',
          identity: { kind: 'test-artifact', threadId: 'thread-1' },
        });
        emit(
          providerContinuityEvent({
            conversationRef: 'thread-1',
            resumable: true,
            providerContinuity: { threadId: 'thread-1' },
          }),
        );
        emit(providerTerminalEvent({ content: 'ok', outcome: { kind: 'completed' as const }, durationMs: 0 }));
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
    trackJob(decision.jobId);

    await waitForTerminalEvent(service, decision.jobId);
    const { sessionManager } =
      /* @intentional-private-access — inspect launch-session recording integration */
      getInternals(service);
    const session = sessionManager.get('codex', decision.sessionId);

    expect(session?.conversationRef).toBe('thread-1');
    expect(session?.artifactHandles).toMatchObject([
      {
        handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-1.jsonl',
        sourceJobId: decision.jobId,
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

    seedTestJobSession(progressStore, {
      jobId: jobId1,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId1, {
      jobId: jobId1,
      owner: { kind: 'provider-session', id: 'session-1' },
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
    seedTestJobSession(progressStore, {
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId2, {
      jobId: jobId2,
      owner: { kind: 'provider-session', id: 'session-2' },
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
    expect(firstRuntime.providerMeta).not.toHaveProperty('conversationRef');
    expect(firstRuntime.providerMeta).not.toHaveProperty('providerContinuity');

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
    expect(waitingRuntime.providerMeta).not.toHaveProperty('providerContinuity');
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
    expect(acquiredRuntime.providerMeta).not.toHaveProperty('providerContinuity');

    secondLease.release();
  });

  it('allows shared app-server leases to overlap on the same handle', async () => {
    const spec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      env: { [CONTEXT_ENV_KEY.claudeTransport]: 'print' },
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

    seedTestJobSession(progressStore, {
      jobId: jobId1,
      sessionId: 'session-1',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId1, {
      jobId: jobId1,
      owner: { kind: 'provider-session', id: 'session-1' },
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
    seedTestJobSession(progressStore, {
      jobId: jobId2,
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId2, {
      jobId: jobId2,
      owner: { kind: 'provider-session', id: 'session-2' },
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
        claudeTransport: 'print',
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

  it('abort does not reacquire a provider server from durable metadata', async () => {
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
    const { progressStore, abortRegistry, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = sessionManager.allocate({
      binding: TEST_CODEX_BINDING,
      name: 'abort-session',
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
    });
    trackJob(jobId);
    mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());

    seedTestJobSession(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });
    progressStore.appendLaunchRequested(jobId, {
      jobId,
      owner: { kind: 'provider-session', id: session.sessionId },
      sessionId: session.sessionId,
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
      },
    });
    abortRegistry.register(jobId);

    expect(service.abort([jobId])).toEqual({
      aborted: [jobId],
      notFound: [],
    });

    expect(server.requestMock).not.toHaveBeenCalledWith('turn/interrupt', expect.anything());
  });

  it('routes shared app-server interrupts through the bound live server without reacquiring', async () => {
    const spec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      shared: true as const,
    };
    const server = createFakeProviderServerHandle();
    const spawnProviderServerMock = setSpawnProviderServerMock(server.handle);
    mockState.getNewProvider.mockReturnValue(makeSharedClaudeAppServerProvider(spec));
    const service = createService(ctx);
    const { sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = sessionManager.allocate({
      binding: TEST_CLAUDE_BINDING,
      name: 'shared-interrupt-session',
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
    });
    sessionManager.checkpointProviderContinuity(session.sessionId, {
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
    });
    const firstLease = await service.acquireServer(spec);
    const acquireServerSpy = vi.spyOn(service, 'acquireServer');

    const launchRecord: JobLaunch = {
      jobId: `shared-interrupt-${randomUUID()}`,
      owner: { kind: 'provider-session', id: session.sessionId },
      sessionId: session.sessionId,
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
      },
    };

    await service.interruptAppServerJob(launchRecord, runtimeRecord);

    expect(acquireServerSpy).not.toHaveBeenCalled();
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
      code: 'provider_preflight_failed',
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
    trackJob(decision.jobId);

    expect(mockState.resolveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: null, name: 'architect' }),
      expect.anything(),
    );
    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    const session = getInternals(service).sessionManager.get('codex', decision.sessionId);

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
    trackJob(decision.jobId);

    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    const session = getInternals(service).sessionManager.get('codex', decision.sessionId);

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
    trackJob(decision.jobId);

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
    trackJob(decision.jobId);

    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    expect(request.bypassPermissions).toBe(false);
  });

  it('passes installed equipped tools into provider runtime', async () => {
    const engineDir = runtime.paths.coral.engine.dataDir('codebase-memory');
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(join(engineDir, 'codebase-memory-mcp'), 'binary');
    let equippedTools: readonly { id: string; summary: string; guidance?: readonly string[] }[] | undefined;
    const { provider, execute } = makeProvider({
      execute: async (_request, providerRuntime) => {
        equippedTools = providerRuntime.equippedTools;
        return { content: 'ok', durationMs: 0 };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'raw prompt' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running launch');
    trackJob(decision.jobId);
    await waitForTerminalEvent(service, decision.jobId);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(equippedTools?.map((tool) => tool.id)).toEqual(['codebase-memory']);
    expect(equippedTools?.[0]?.summary).toContain('mandatory first stop');
    expect(equippedTools?.[0]?.guidance?.join('\n')).toContain('trace_path');
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
    trackJob(decision.jobId);

    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    expect(progressStore.readStatus(decision.jobId)).toMatchObject({
      jobId: decision.jobId,
      sessionId: decision.sessionId,
      provider: 'codex',
      phase: 'queued',
    });
  });

  it('does not open a provider session when the admission queue is full', async () => {
    terminateAll();
    const previousMaxQueueSize = process.env.CORAL_MAX_QUEUE_SIZE;
    process.env.CORAL_MAX_QUEUE_SIZE = '1';
    runtime = createRealRuntime('prod');
    if (previousMaxQueueSize === undefined) {
      delete process.env.CORAL_MAX_QUEUE_SIZE;
    } else {
      process.env.CORAL_MAX_QUEUE_SIZE = previousMaxQueueSize;
    }
    JOBS_DIR = jobsDir(runtime.env);
    launchCoordinator = new LaunchCoordinator({ runtime });
    spawnProviderServer = launchCoordinator.spawnProviderServer.bind(launchCoordinator);

    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);
    await occupyProviderSlots(service, ctx, 'codex');
    const queued = await service.start('codex', { prompt: 'fills queue' }, ctx);
    expect(queued.status).toBe('queued');
    if (queued.status !== 'queued') throw new Error('expected queued launch');
    trackJob(queued.jobId);
    const sessionsBeforeRejection = service.list('codex').sessions;

    const rejectedJobId = `full-queue-${randomUUID()}`;
    const rejected = await service.start('codex', { prompt: 'must reject', jobId: rejectedJobId }, ctx);

    expect(rejected).toMatchObject({ status: 'rejected', code: 'busy' });
    expect(service.list('codex').sessions).toEqual(sessionsBeforeRejection);
    expect(sessionsBeforeRejection.every((session) => session.activeJobId !== undefined)).toBe(true);
    expect(getInternals(service).progressStore.readStatus(rejectedJobId)).toBeNull();
    expect(launchCoordinator.queueDepth()).toBe(1);
  });

  it('rolls back the prepared session and job when the atomic launch commit crashes', async () => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const progressStore = createProgressStore();
    const baseCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const crash = new Error('simulated crash during initial launch commit');
    const crashingCommit: CommitEventsFn = (callback) =>
      baseCommit((commit) => {
        let appendCount = 0;
        const append = ((input: unknown) => {
          const token = (commit.append as unknown as (next: unknown) => unknown)(input);
          appendCount += 1;
          if (appendCount === 2) throw crash;
          return token;
        }) as unknown as typeof commit.append;
        return callback({ append } as typeof commit);
      });
    const service = createService(ctx, { progressStore, coordinatorCommit: crashingCommit });
    const jobId = `commit-crash-${randomUUID()}`;

    await expect(service.start('codex', { prompt: 'crash atomically', jobId }, ctx)).rejects.toBe(crash);

    expect(service.list('codex').sessions).toEqual([]);
    expect(progressStore.readStatus(jobId)).toBeNull();
    expect(progressStore.readJobEvents(jobId)).toEqual([]);
    expect(launchCoordinator.getActiveJobIds()).toEqual([]);
    expect(launchCoordinator.queueDepth()).toBe(0);
  });

  it.each([
    {
      name: 'ordinary',
      pool: 'default' as const,
      launch: {},
    },
    {
      name: 'discussion',
      pool: 'discuss' as const,
      launch: {
        owner: { kind: 'discussion' as const, id: 'discussion-atomic-resume' },
        discussionRun: { agent: 'reviewer', purpose: 'speech' as const, attempt: 1 },
        pool: 'discuss' as const,
      },
    },
  ])('rolls back the session claim and job when an atomic $name resume commit crashes', async ({ pool, launch }) => {
    const never = new Promise<ProviderTurnResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const progressStore = createProgressStore();
    const baseCommit = createTestJobJournalDeps(progressStore, runtime).coordinatorCommit;
    const crash = new Error('simulated crash during resume launch commit');
    const crashingCommit: CommitEventsFn = (callback) =>
      baseCommit((commit) => {
        let appendCount = 0;
        const append = ((input: unknown) => {
          const token = (commit.append as unknown as (next: unknown) => unknown)(input);
          appendCount += 1;
          if (appendCount === 2) throw crash;
          return token;
        }) as unknown as typeof commit.append;
        return callback({ append } as typeof commit);
      });
    const service = createService(ctx, { progressStore, coordinatorCommit: crashingCommit });
    const { sessionManager } =
      /* @intentional-private-access — establish and inspect the durable resume boundary */
      getInternals(service);
    const session = allocateTestSession(
      sessionManager,
      'codex',
      `${pool}-atomic-resume`,
      'test-model',
      ctx.projectRoot,
    );
    const jobId = `${pool}-resume-crash-${randomUUID()}`;

    await expect(
      service.resume('codex', { sessionId: session.sessionId, prompt: 'resume atomically', jobId, ...launch }, ctx),
    ).rejects.toBe(crash);

    expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
      sessionId: session.sessionId,
      version: session.version,
    });
    expect(sessionManager.get('codex', session.sessionId)?.activeJobId).toBeUndefined();
    expect(
      (
        progressStore
          .getDb()
          .prepare<[string], { count: number }>(
            `SELECT COUNT(*) AS count
               FROM events
              WHERE stream_kind = 'session' AND stream_id = ? AND type = 'session.claimed'`,
          )
          .get(session.sessionId) ?? { count: 0 }
      ).count,
    ).toBe(0);
    expect(progressStore.readStatus(jobId)).toBeNull();
    expect(progressStore.readJobEvents(jobId)).toEqual([]);
    expect(launchCoordinator.getActiveJobIds(pool)).toEqual([]);
    expect(launchCoordinator.queueDepth(pool)).toBe(0);
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
      trackJob(decision.jobId);
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
    mockState.getNewProvider.mockClear();

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
    trackJob(decision.jobId);

    const { sessionManager } =
      /* @intentional-private-access — inspect workflow atom retention persistence */
      getInternals(service);
    expect(sessionManager.get('codex', decision.sessionId)?.retention).toBe('discard_provider_artifacts_on_terminal');
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
      trackJob(decision.jobId);
    }
    expect(mockState.resolveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'coral', name: 'architect' }),
      expect.anything(),
    );
  });
});
