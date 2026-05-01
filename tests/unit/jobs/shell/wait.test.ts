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
import type * as AgentResolutionMod from '#src/jobs/agent-resolution.js';
import { createDeferred as _createDeferred } from '#tools/testing/deferred.js';
import type { JobPhase } from '#src/jobs/phase.js';
import type { JobLaunch as _JobLaunch, JobEvent, JobStatus } from '#src/jobs/records.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import {
  providerContinuityEvent,
  providerTerminalEvent,
  streamProviderEvents,
  streamProviderTerminal,
  type ProviderTerminalInput,
} from '#src/providers/stream.js';
import type { DurableCliRuntimeRecord as _DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';

import { jobsDir } from '#src/jobs/paths.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { buildCodexProviderServerSpec } from '#src/providers/codex/request-mapping.js';
import { parseExpression as _parseExpression } from '#src/workflow/parser.js';
import {
  AgentNamespaceNotFoundError as _AgentNamespaceNotFoundError,
  AgentNotFoundError as _AgentNotFoundError,
  InvalidAgentRefError as _InvalidAgentRefError,
  type AgentRef,
} from '#src/jobs/agent-resolution.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { getMaxWorkers } from '#src/coordinator/live/worker-limits.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '#src/coordinator/live/provider-server-transport.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createProviderHostManager, type ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import type { SessionManager } from '#src/sessions/shell/store.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { toProviderSpec, type PreflightRuntime, type Provider } from '#tests/helpers/scripted-provider.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import { workflowCompletedEvent, workflowLifecycleFaultEvent } from '#src/workflow/events.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

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

function jobResultPath(jobId: string): string {
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
    subscribeJobEvents?: (options: {
      afterSeq: number;
      jobIds: readonly string[];
      abortSignal?: AbortSignal;
    }) => AsyncIterable<JobEvent>;
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
    sessionLookup: createProjectionSessionLookup(progressStore.getDb()),
    loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
    readJobEvents: (jobId) => progressStore.readJobEvents(jobId),
    subscribeJobEvents: options.subscribeJobEvents ?? subscribeJobEvents,
    getCurrentJournalSeq,
    coordinatorCommit: createTestJobJournalDeps(progressStore, runtime).coordinatorCommit,
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

function _realizePluginRoot(ctx: InvocationContext): string {
  mkdirSync(ctx.pluginRoot, { recursive: true });
  return pluginRootNamespace(ctx.pluginRoot);
}

function _createScopedContext(name: string): InvocationContext {
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
    phase,
    updatedAt: '2026-03-06T00:00:00.000Z',
    ...(options.result ? { result: toCompletedJobTerminal(options.result) } : {}),
  };
}

function makeTerminalReplay(
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
  };
}

describe('ExecutionService wait', () => {
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

  it('awaitLaunch returns ready once launch readiness changes', async () => {
    const service = createService(ctx);
    const { jobId, progressStore } = createClaimedJob(service, ctx, { initialPhase: 'launching' });

    setTimeout(() => {
      progressStore.appendRuntimeStarted(jobId, {
        transport: 'app-server',
        startTime: isoAt(runtime.time.now()),
        providerMeta: {
          provider: 'codex',
          leaseState: 'waiting',
        },
      });
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
      commitJobTerminal(
        progressStore,
        jobId,
        sessionId,
        { content: 'done', outcome: { kind: 'completed' } },
        'completed',
      );
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
          commitJobTerminal(
            progressStore,
            jobId,
            sessionId,
            { content: 'done', outcome: { kind: 'completed' } },
            'completed',
          );
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
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status: JobStatus = {
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'running',
      updatedAt: '2026-03-06T00:00:00.000Z',
    };
    const replay: JobEvent[] = [
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        seq: 1,
        type: 'progress',
        ts: '2026-03-06T00:00:01.000Z',
        message: 'step 1',
      },
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        seq: 2,
        type: 'terminal',
        ts: '2026-03-06T00:00:02.000Z',
        result: { content: 'done', outcome: { kind: 'completed' } },
      },
    ];

    vi.spyOn(progressStore, 'readStatus').mockReturnValue(status);
    vi.spyOn(progressStore, 'readJobEvents').mockReturnValue(replay);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'progress',
        jobId: 'job-1',
        seq: 1,
        message: 'step 1',
      },
      {
        type: 'terminal',
        jobId: 'job-1',
        seq: 2,
        remainingJobIds: [],
        resultPath: `${runtime.paths.coral.exports.jobsRoot}/job-1/result.md`,
        result: { content: 'done', outcome: { kind: 'completed' } },
        continuity: null,
      },
    ]);
  });

  it('rebuilds a missing result artifact from the Journal before emitting terminal', async () => {
    const service = createService(ctx);
    const { jobId, sessionId, progressStore } = createClaimedJob(service, ctx);
    const resultPath = jobResultPath(jobId);

    commitJobTerminal(
      progressStore,
      jobId,
      sessionId,
      { content: 'rebuild me', outcome: { kind: 'completed' } },
      'completed',
    );
    rmSync(resultPath, { force: true });

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [jobId], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'terminal',
      jobId,
      resultPath,
      result: { content: 'rebuild me', outcome: { kind: 'completed' } },
    });
    expect(_existsSync(resultPath)).toBe(true);
    expect(_readFileSync(resultPath, 'utf-8')).toBe('rebuild me\n');
  });

  it('rebuilds failed workflow result artifacts with lifecycle fault details', async () => {
    const service = createService(ctx);
    const { jobId, sessionId, progressStore } = createClaimedJob(service, ctx);
    const resultPath = jobResultPath(jobId);
    const workflowId = `workflow-${jobId}`;
    const status = progressStore.readStatus(jobId);

    progressStore.commit((c) => {
      const fault = c.append(
        workflowLifecycleFaultEvent(workflowId, {
          kind: 'unknown',
          message: 'workflow failure',
        }),
      );
      const completed = c.append(
        workflowCompletedEvent(workflowId, {
          outcome: 'failed',
          causeRef: fault,
          stepDetails: [],
        }),
      );
      appendJobTerminalRecorded(c, {
        jobId,
        sessionId,
        namespace: status?.backendNamespace,
        project: status?.projectRoot,
        terminal: {
          content: '',
          outcome: { kind: 'failed', causeRef: completed },
        },
      });
      return undefined;
    });
    rmSync(resultPath, { force: true });

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [jobId], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'terminal',
      jobId,
      resultPath,
      result: {
        content: '',
        outcome: {
          kind: 'failed',
          causeRef: { stream: { kind: 'workflow', id: workflowId } },
        },
      },
    });
    expect(_existsSync(resultPath)).toBe(true);
    expect(_readFileSync(resultPath, 'utf-8')).toBe(
      'Failed: Workflow failed. Caused by: Workflow lifecycle fault (unknown): workflow failure.\n',
    );
  });

  it('waitStream polls durable journal catch-up when live notifications are missed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-03-06T00:00:00.000Z'));
      const silentSubscribe = async function* ({
        abortSignal,
      }: {
        afterSeq: number;
        jobIds: readonly string[];
        abortSignal?: AbortSignal;
      }): AsyncIterable<JobEvent> {
        await new Promise<void>((resolve) => {
          if (abortSignal?.aborted) {
            resolve();
            return;
          }
          abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const service = createService(ctx, { subscribeJobEvents: silentSubscribe });
      const { jobId, sessionId, progressStore } = createClaimedJob(service, ctx);
      const iterator = service.waitStream({ jobIds: [jobId], timeoutSeconds: 1 })[Symbol.asyncIterator]();
      const nextPromise = iterator.next();

      await flushMicrotasks();
      commitJobTerminal(
        progressStore,
        jobId,
        sessionId,
        { content: 'done', outcome: { kind: 'completed' } },
        'completed',
      );
      await vi.advanceTimersByTimeAsync(250);

      await expect(nextPromise).resolves.toEqual({
        done: false,
        value: {
          type: 'terminal',
          jobId,
          seq: expect.any(Number),
          remainingJobIds: [],
          resultPath: jobResultPath(jobId),
          result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
          continuity: null,
        },
      });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitStream does not synthesize terminal events from terminal status without Journal evidence', async () => {
    const service = createService(ctx);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    vi.spyOn(progressStore, 'readStatus').mockReturnValue({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'completed',
      updatedAt: '2026-03-06T00:00:00.000Z',
      result: { content: 'done', outcome: { kind: 'completed' } },
    });
    vi.spyOn(progressStore, 'readJobEvents').mockReturnValue([]);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 0.001 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'waiting',
        waitingJobIds: ['job-1'],
      },
    ]);
  });

  it('waitStream emits a replayed terminal persisted one millisecond before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 100;
      const deadlineMs = startMs + timeoutMs;
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { progressStore } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
      vi.spyOn(progressStore, 'readJobEvents').mockReturnValue([
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
          seq: 1,
          remainingJobIds: [],
          resultPath: jobResultPath('job-1'),
          result: { content: 'done', outcome: { kind: 'completed' } },
          continuity: null,
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
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { jobId, sessionId, progressStore } = createClaimedJob(service, ctx);
      setTimeout(() => {
        commitJobTerminal(
          progressStore,
          jobId,
          sessionId,
          { content: 'done', outcome: { kind: 'completed' } },
          'completed',
        );
      }, timeoutMs);

      const iterator = service
        .waitStream({ jobIds: [jobId], timeoutSeconds: timeoutMs / 1000 })
        [Symbol.asyncIterator]();
      const nextPromise = iterator.next();

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(timeoutMs);

      await expect(nextPromise).resolves.toEqual({
        done: false,
        value: {
          type: 'terminal',
          jobId,
          seq: expect.any(Number),
          remainingJobIds: [],
          resultPath: jobResultPath(jobId),
          result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
          continuity: null,
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
      const { progressStore } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
      vi.spyOn(progressStore, 'readJobEvents').mockReturnValue([]);
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
      const { progressStore } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);
      const runningStatus = makeStatusRecord(ctx, 'job-1', 'running');
      const terminalStatus = makeStatusRecord(ctx, 'job-1', 'completed', { result: { content: 'done' } });

      vi.spyOn(progressStore, 'readStatus').mockImplementation(() => {
        return runtime.time.now() > deadlineMs ? terminalStatus : runningStatus;
      });
      vi.spyOn(progressStore, 'readJobEvents').mockImplementation(() => {
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

  it('replayed terminals with invalid or missing ts use the observation-time rule', async () => {
    const startMs = Date.parse('2026-03-06T00:00:00.000Z');
    const timeoutMs = 100;

    let currentTime = startMs;
    vi.spyOn(runtime.time, 'now').mockImplementation(() => currentTime);
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
      currentTime += ms + 5;
    });

    const onTimeService = createService(ctx);
    const { progressStore: onTimeStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(onTimeService);

    vi.spyOn(onTimeStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
    vi.spyOn(onTimeStore, 'readJobEvents').mockReturnValue([makeTerminalReplay('job-1', { ts: '' })]);

    const onTimeEvents: WaitStreamEvent[] = [];
    for await (const event of onTimeService.waitStream({ jobIds: ['job-1'], timeoutSeconds: timeoutMs / 1000 })) {
      onTimeEvents.push(event);
    }

    expect(onTimeEvents).toEqual([
      {
        type: 'terminal',
        jobId: 'job-1',
        seq: 1,
        remainingJobIds: [],
        resultPath: jobResultPath('job-1'),
        result: { content: 'done', outcome: { kind: 'completed' } },
        continuity: null,
      },
    ]);

    currentTime = startMs;
    const lateService = createService(ctx);
    const { progressStore: lateStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(lateService);
    const missingTsTerminal = {
      jobId: 'job-1',
      sessionId: 'job-1-session',
      seq: 1,
      type: 'terminal',
      result: { content: 'done' },
    } as JobEvent;

    vi.spyOn(lateStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
    vi.spyOn(lateStore, 'readJobEvents').mockImplementation(() => {
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
    const cursor = { afterSeq: 0 };
    let currentTime = startMs;

    vi.spyOn(runtime.time, 'now').mockImplementation(() => currentTime);
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
      currentTime += ms + 5;
    });

    const service = createService(ctx);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);

    vi.spyOn(progressStore, 'readStatus').mockReturnValue(makeStatusRecord(ctx, 'job-1', 'running'));
    vi.spyOn(progressStore, 'readJobEvents').mockImplementation(() => {
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
    expect(cursor).toEqual({ afterSeq: 0 });

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
        seq: 1,
        remainingJobIds: [],
        resultPath: jobResultPath('job-1'),
        result: { content: 'done', outcome: { kind: 'completed' } },
        continuity: null,
      },
    ]);
  });

  it('waitStreamOnce returns content for an exact-boundary replayed terminal instead of throwing', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.parse('2026-03-06T00:00:00.000Z');
      const timeoutMs = 180_000;
      vi.setSystemTime(startMs);

      const service = createService(ctx);
      const { jobId, sessionId, progressStore } = createClaimedJob(service, ctx);
      setTimeout(() => {
        commitJobTerminal(
          progressStore,
          jobId,
          sessionId,
          { content: 'done', outcome: { kind: 'completed' } },
          'completed',
        );
      }, timeoutMs);

      const waitOnce = service.waitStreamOnce(jobId, timeoutMs);

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(timeoutMs + 5);

      await expect(waitOnce).resolves.toEqual({
        content: 'done',
        continuity: null,
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
      seq: expect.any(Number),
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
      const { progressStore } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);

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
            updatedAt: '',
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
            updatedAt: '',
          };
        }
        return null;
      });
      vi.spyOn(progressStore, 'readJobEvents').mockReturnValue([]);

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
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

        vi.spyOn(progressStore, 'readStatus').mockImplementation((jobId: string) => {
          if (jobId === jobIdA) return makeStatusRecord(ctx, jobIdA, 'running', { sessionId: 'session-a' });
          if (jobId === jobIdB) return makeStatusRecord(ctx, jobIdB, 'running', { sessionId: 'session-b' });
          return null;
        });
        vi.spyOn(progressStore, 'readJobEvents').mockImplementation((jobId: string) => {
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

    it('cursor afterSeq skips already-delivered events (only newer events returned)', async () => {
      const jobId = `red-ws-cursor-${randomUUID()}`;
      createdJobIds.add(jobId);

      const service = createService(ctx);
      const { progressStore } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);

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
          updatedAt: '',
        };
      });
      vi.spyOn(progressStore, 'readJobEvents').mockImplementation((...args: unknown[]) => {
        const [jid] = args as [string];
        void jid;
        return [
          { jobId, sessionId: 'session-1', seq: 1, type: 'progress' as const, ts: '', message: 'event-1' },
          { jobId, sessionId: 'session-1', seq: 2, type: 'progress' as const, ts: '', message: 'event-2' },
          {
            jobId,
            sessionId: 'session-1',
            seq: 3,
            type: 'terminal' as const,
            ts: '',
            result: { content: 'done', outcome: { kind: 'completed' as const } },
          },
        ];
      });

      const events: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({
        jobIds: [jobId],
        timeoutSeconds: 5,
        cursor: { afterSeq: 2 },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('terminal');
      if (events[0].type !== 'terminal') throw new Error('expected terminal');
      expect(events[0].jobId).toBe(jobId);
      expect(events[0].seq).toBe(3);
      expect(events[0].resultPath).toBe(jobResultPath(jobId));

      const progressMessages = events
        .filter((e): e is Extract<WaitStreamEvent, { type: 'progress' }> => e.type === 'progress')
        .map((e) => e.message);
      expect(progressMessages).not.toContain('event-1');
      expect(progressMessages).not.toContain('event-2');
    });
  });
});
