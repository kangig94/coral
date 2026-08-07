import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as AgentResolutionMod from '#src/jobs/agent-resolution.js';
import { createDeferred } from '#tools/testing/deferred.js';
import type { AppServerRuntime, JobLaunch, JobEvent, JobStatus } from '#src/jobs/records.js';
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
import type { InitJobOptions } from '#src/jobs/contracts/job-store.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '#src/jobs/reconcile/contracts.js';

import { jobsDir } from '#src/jobs/paths.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { prepareTestCodexAppServer } from '#tests/helpers/provider-credentials.js';
import { parseExpression } from '#src/workflow/parser.js';
import { type AgentRef } from '#src/jobs/agent-resolution.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { getMaxWorkers } from '#src/coordinator/live/worker-limits.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '#src/providers/app-server-transport.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createProviderHostManager, type ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { SessionManager } from '#src/sessions/shell.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { composeReducers } from '#src/store/reducers.js';
import type { CommitContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import {
  defineFakeProvider,
  toProviderDefinition,
  type Provider,
  type StandaloneTestProvider,
} from '#tests/helpers/scripted-provider.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import {
  seedTestProviderContinuity,
  seedTestSessionContinuity,
  seedTestSessionProjection,
} from '#tests/helpers/session.js';
import {
  TEST_CLAUDE_BINDING,
  TEST_CODEX_BINDING,
  TEST_PROVIDER_SCOPE,
  withTestProfileLocation,
} from '#tests/helpers/provider-credentials.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { CORAL_CHILD_PRINCIPAL_HANDLE } from '#src/security/child-principal-env.js';

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
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-execution-service-composition-test-tmp-${process.pid}`,
  getNewProvider: vi.fn(),
  resolveAgent: vi.fn(),
}));
const TEST_BACKEND_NAMESPACE = 'test-namespace';
const TEST_CODEX_SCOPE = {
  origin: 'caller',
  profiles: TEST_PROVIDER_SCOPE.profiles.filter((entry) => entry.provider === 'codex'),
} as const satisfies InvocationContext['providerScope'];

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
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
}

function createSessionManager(projectRoot: string): SessionManager {
  return new SessionManager(
    projectRoot,
    runtime,
    undefined,
    undefined,
    openTestStoreDb(runtime),
    permissiveProviderLookupPort,
  );
}

function allocateCodexSession(
  manager: SessionManager,
  name: string,
  model: string,
  cwd: string,
): ReturnType<SessionManager['allocate']> {
  return manager.allocate({
    binding: TEST_CODEX_BINDING,
    name,
    model,
    cwd,
    projectRoot: cwd,
    backendNamespace: TEST_BACKEND_NAMESPACE,
  });
}

function seedTestJobSession(progressStore: JobStore, options: InitJobOptions): void {
  const entry = seedTestSessionProjection(progressStore.getDb(), {
    sessionId: options.sessionId,
    provider: options.provider,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
  });
  const sessionManager = new SessionManager(
    options.projectRoot,
    runtime,
    undefined,
    undefined,
    progressStore.getDb(),
    permissiveProviderLookupPort,
  );
  const persisted = sessionManager.readById(options.sessionId, { forceFresh: true });
  if (persisted?.activeJobId === options.jobId) return;
  if (persisted?.activeJobId !== undefined) {
    throw new Error(`Test session '${options.sessionId}' is already claimed by '${persisted.activeJobId}'.`);
  }
  if (!sessionManager.claimForJobSync(entry.sessionId, options.jobId)) {
    throw new Error(`Failed to claim test session '${options.sessionId}' for '${options.jobId}'.`);
  }
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
  launchCoordinator.restoreActiveLaunch(jobId, provider, { kind: 'provider-session', id: `session-${jobId}` }, pool);
}

function createService(
  ctx: InvocationContext,
  options: {
    progressStore?: JobStore;
    bundleHash?: string;
    backendNamespace?: string;
    providerHostManager?: ProviderHostManager;
    pluginRegistry?: { discoverPluginRoot: (namespace: string) => string | null };
    childPrincipalRegistry?: ChildPrincipalRegistry;
    providerBindingReady?: boolean;
    providerAccountSubject?: (profile: { readonly canonicalLocation: string }) => {
      readonly issuer: string;
      readonly subject: string;
    };
  } = {},
): ExecutionService {
  const providerRegistry = new ProviderRegistry();
  const rawProvider = mockState.getNewProvider('codex') as Provider | undefined;
  const provider =
    options.providerBindingReady === false || options.providerAccountSubject !== undefined
      ? defineFakeProvider(rawProvider, {
          binding: {
            ...(options.providerBindingReady === false
              ? {
                  readinessFailure: {
                    reason: 'profile-unavailable' as const,
                    provider: rawProvider?.name ?? 'codex',
                    selector: 'fixture profile',
                  },
                }
              : {}),
            ...(options.providerAccountSubject === undefined ? {} : { accountSubject: options.providerAccountSubject }),
          },
        })
      : defineFakeProvider(rawProvider);
  if (provider !== undefined) {
    providerRegistry.register(provider);
  }
  const progressStore = options.progressStore ?? createProgressStore();
  const providerHostManager =
    options.providerHostManager ?? createProviderHostManager({ runtime, spawnProviderServer });
  providerRegistry.connectAppServerHost(providerHostManager);
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
    launchCoordinator,
    eventBus,
    providerRegistry,
    pluginRegistry: options.pluginRegistry ?? { discoverPluginRoot: () => null },
    childPrincipalRegistry: options.childPrincipalRegistry ?? new ChildPrincipalRegistry(runtime.ids),
    coordinatorCommit: (cb) => progressStore.commit(cb),
    loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
    readJobEvents: (jobId) => progressStore.readJobEvents(jobId),
    aggregateWorkflowUsage: (workflowJobId) => aggregateWorkflowUsage(progressStore.getDb(), workflowJobId),
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

function makeLaunchRecord(
  overrides: Partial<JobLaunch> & { jobId: string; sessionId: string; projectRoot: string; backendNamespace: string },
): JobLaunch {
  const { projectRoot, backendNamespace, ...rest } = overrides;
  const record: JobLaunch = {
    owner: { kind: 'provider-session', id: overrides.sessionId },
    provider: 'codex',
    projectRoot,
    backendNamespace,
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
    ...rest,
  };
  return record;
}

async function captureRecoveryAuthority(
  service: Pick<RecoveryCapableService, 'captureProviderRecoveryAuthority'>,
  launchRecord: JobLaunch,
): Promise<ProviderRecoveryAuthority> {
  const captured = await service.captureProviderRecoveryAuthority(launchRecord);
  if (!captured.ok) {
    throw new Error(`Expected recovery authority for ${launchRecord.jobId}.`);
  }
  return captured.authority;
}

function recoveryFence(reason: 'restart' | 'handoff') {
  return { reason, signal: new AbortController().signal, onCommitStart: vi.fn() };
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
      isClosed: () => false,
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
  result: TestProviderTurnResult | { content: string; durationMs: number; continuity?: ProviderTurnContinuity },
): TestProviderTurnResult {
  if ('outcome' in result) {
    return result;
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
    ...args: Parameters<StandaloneTestProvider['execute']>
  ) => Promise<TestProviderTurnResult | { content: string; durationMs: number; continuity?: ProviderTurnContinuity }>;
  preflight?: Provider['preflight'];
}): {
  provider: Provider;
  execute: ReturnType<typeof vi.fn>;
  preflight?: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn((...args: Parameters<StandaloneTestProvider['execute']>) =>
    streamCompletedResult(options?.execute?.(...args) ?? Promise.resolve({ content: 'ok', durationMs: 0 })),
  );
  const preflight = options?.preflight ? vi.fn(options.preflight) : undefined;
  const provider: Provider = {
    name: 'codex',
    execute: execute as unknown as StandaloneTestProvider['execute'],
    ...(preflight ? { preflight } : {}),
  };
  return { provider, execute, preflight };
}

function makeCodexAppServerProvider(): Provider {
  return {
    name: 'codex',
    execute: vi.fn(() =>
      streamProviderTerminal({ content: 'ok', durationMs: 0, outcome: { kind: 'completed' as const } }),
    ),
    appServerLifecycle: {
      host: (_continuity, request) =>
        prepareTestCodexAppServer({ cwd: request.cwd ?? process.cwd(), coralEnv: request.coralEnv }),
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
  };
}

function expectRuntimePreflightArg(preflight: ReturnType<typeof vi.fn>): void {
  expect(preflight).toHaveBeenCalledWith(
    expect.objectContaining({
      process: runtime.process,
      storage: runtime.storage,
      time: runtime.time,
      cwd: expect.any(String),
      baseEnv: expect.any(Object),
      requestEnv: expect.any(Object),
      platform: expect.any(String),
    }),
  );
}

function _makeSharedClaudeAppServerProvider(spec: {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  leaseMode: 'shared';
  idleRetirement: 'host-reported' | 'none';
}): Provider {
  return {
    name: 'claude',
    execute: vi.fn(() =>
      streamProviderTerminal({ content: 'ok', durationMs: 0, outcome: { kind: 'completed' as const } }),
    ),
    appServerLifecycle: {
      host: spec,
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

function realizePluginRoot(ctx: InvocationContext): string {
  mkdirSync(ctx.pluginRoot, { recursive: true });
  return pluginRootNamespace(ctx.pluginRoot);
}

describe('ExecutionService', () => {
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

  describe('queue admission', () => {
    it('rejects an incomplete mixed-provider workflow scope before allocation', async () => {
      const { provider, execute } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);
      const { sessionManager } =
        /* @intentional-private-access — verify the workflow allocation fence */
        getInternals(service);
      const allocate = vi.spyOn(sessionManager, 'allocate');
      const dirsBefore = listJobDirs();

      const decision = await service.executeWorkflow(
        'codex',
        parseExpression('architect@codex -> resolver@claude'),
        {
          expression: 'architect@codex -> resolver@claude',
          startPrompt: 'seed',
          provider: 'codex',
        },
        { ...ctx, providerScope: TEST_CODEX_SCOPE },
      );

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'provider_binding_missing_profile',
      });
      expect(allocate).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(queueDepth()).toBe(0);
      expect(listJobDirs()).toEqual(dirsBefore);
    });

    it('rejects an HTTP launch without configured system scope before allocation', async () => {
      const preflight = vi.fn(async () => {});
      const { provider, execute } = makeProvider({ preflight });
      mockState.getNewProvider.mockReturnValue(provider);
      const requestCtx: InvocationContext = {
        ...ctx,
        principal: testProjectPrincipal(ctx.projectRoot, { transport: 'http' }),
        providerScope: undefined,
      };
      const service = createService(requestCtx);
      const { sessionManager } =
        /* @intentional-private-access — verify the allocation fence */
        getInternals(service);
      const allocate = vi.spyOn(sessionManager, 'allocate');
      const dirsBefore = listJobDirs();

      const decision = await service.start('codex', { prompt: 'hello' }, requestCtx);

      expect(decision).toMatchObject({
        status: 'rejected',
        phase: 'preflight',
        code: 'provider_binding_missing_profile',
      });
      expect(allocate).not.toHaveBeenCalled();
      expect(preflight).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(queueDepth()).toBe(0);
      expect(listJobDirs()).toEqual(dirsBefore);
    });

    it('executes two caller profiles concurrently through one service with distinct bindings', async () => {
      const { provider, execute } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx, {
        providerAccountSubject: (profile) => ({
          issuer: 'https://api.openai.com/chatgpt-account',
          subject: `workspace:${profile.canonicalLocation}`,
        }),
      });
      const callerA = {
        ...ctx,
        providerScope: withTestProfileLocation(TEST_CODEX_SCOPE, 'codex', '/accounts/codex-a'),
      };
      const callerB = {
        ...ctx,
        providerScope: withTestProfileLocation(TEST_CODEX_SCOPE, 'codex', '/accounts/codex-b'),
      };

      const [left, right] = await Promise.all([
        service.start('codex', { prompt: 'left' }, callerA),
        service.start('codex', { prompt: 'right' }, callerB),
      ]);
      expect(left.status).toBe('running');
      expect(right.status).toBe('running');
      if (left.status !== 'running' || right.status !== 'running') {
        throw new Error('expected both caller launches to run');
      }
      trackJob(left.jobId);
      trackJob(right.jobId);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

      const homeByPrompt = new Map(
        execute.mock.calls.map((call) => [
          (call[0] as ProviderRequest).prompt,
          (call[1] as { executionPlan: { host: { access: { root: string } } } }).executionPlan.host.access.root,
        ]),
      );
      expect(homeByPrompt).toEqual(
        new Map([
          ['left', '/accounts/codex-a'],
          ['right', '/accounts/codex-b'],
        ]),
      );
      const { sessionManager } =
        /* @intentional-private-access — inspect persisted binding identity */
        getInternals(service);
      if (left.sessionId === undefined || right.sessionId === undefined) {
        throw new Error('provider launches must return a session');
      }
      expect(sessionManager.readById(left.sessionId)?.binding).toMatchObject({
        binding: {
          profile: { canonicalLocation: '/accounts/codex-a' },
          subject: { subject: 'workspace:/accounts/codex-a' },
        },
      });
      expect(sessionManager.readById(right.sessionId)?.binding).toMatchObject({
        binding: {
          profile: { canonicalLocation: '/accounts/codex-b' },
          subject: { subject: 'workspace:/accounts/codex-b' },
        },
      });
    });

    it('rechecks a queued binding after permit grant and cleans up when the account changed in the queue', async () => {
      let subject = 'account-a';
      const never = new Promise<ProviderTurnResult>(() => {});
      const { provider, execute } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx, {
        providerAccountSubject: () => ({
          issuer: 'https://api.openai.com/chatgpt-account',
          subject,
        }),
      });
      const occupied = await occupyProviderSlots(service, ctx, 'codex');
      const callsAtCapacity = execute.mock.calls.length;

      const decision = await service.start('codex', { prompt: 'queued-account-a' }, ctx);
      expect(decision.status).toBe('queued');
      if (decision.status !== 'queued') throw new Error('expected queued launch');
      trackJob(decision.jobId);
      expect(queueDepth()).toBe(1);

      subject = 'account-b';
      releaseLaunch(occupied[0]);

      const terminal = await waitForTerminalEvent(service, decision.jobId);
      expect(execute).toHaveBeenCalledTimes(callsAtCapacity);
      expect(terminal.result.outcome).toMatchObject({
        kind: 'job_fault',
        fault: { kind: 'provider_binding', provider: 'codex', reason: 'subject-mismatch' },
      });
      expect(queueDepth()).toBe(0);
      expect(getActiveJobIds()).not.toContain(decision.jobId);
      if (decision.sessionId === undefined) throw new Error('provider launch must return a session');
      expect(createSessionManager(ctx.projectRoot).get('codex', decision.sessionId)?.activeJobId).toBeUndefined();
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

    it.each([
      ['missing caller authority', 'provider_binding_missing_profile'] as const,
      ['different caller profile', 'provider_binding_profile_mismatch'] as const,
    ])('resume rejects %s before preflight, admission, claim, or spawn', async (scenario, code) => {
      const preflight = vi.fn(async () => {});
      const { provider, execute } = makeProvider({ preflight });
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
      const entry = allocateCodexSession(mgr, 'bound', 'gpt-5', ctx.projectRoot);
      const requestCtx: InvocationContext =
        scenario === 'missing caller authority'
          ? { ...ctx, providerScope: undefined }
          : scenario === 'different caller profile'
            ? {
                ...ctx,
                providerScope: withTestProfileLocation(TEST_CODEX_SCOPE, 'codex', '/home/user/.codex-other'),
              }
            : ctx;
      const service = createService(requestCtx);
      const dirsBefore = listJobDirs();

      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, requestCtx);

      expect(decision).toMatchObject({ status: 'rejected', phase: 'preflight', code });
      expect(preflight).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(queueDepth()).toBe(0);
      expect(listJobDirs()).toEqual(dirsBefore);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBeUndefined();
    });

    it.each([
      ['subject', 'https://api.openai.com/chatgpt-account', 'different-account'],
      ['issuer', 'https://issuer.changed.example', 'test-account'],
    ] as const)(
      'rejects resume when the same profile has a different account %s',
      async (_field, nextIssuer, nextSubject) => {
        let issuer = 'https://api.openai.com/chatgpt-account';
        let subject = 'test-account';
        const preflight = vi.fn(async () => {});
        const { provider, execute } = makeProvider({ preflight });
        mockState.getNewProvider.mockReturnValue(provider);
        const manager = createSessionManager(ctx.projectRoot);
        const session = allocateCodexSession(manager, 'bound', 'gpt-5', ctx.projectRoot);
        const service = createService(ctx, {
          providerAccountSubject: () => ({ issuer, subject }),
        });
        issuer = nextIssuer;
        subject = nextSubject;
        const dirsBefore = listJobDirs();

        const decision = await service.resume('codex', { sessionId: session.sessionId, prompt: 'hello' }, ctx);

        expect(decision).toMatchObject({
          status: 'rejected',
          phase: 'preflight',
          code: 'provider_binding_subject_mismatch',
        });
        expect(preflight).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(queueDepth()).toBe(0);
        expect(listJobDirs()).toEqual(dirsBefore);
        expect(manager.get('codex', session.sessionId)?.activeJobId).toBeUndefined();
      },
    );

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
        binding: TEST_CODEX_BINDING,
        name: 'alpha',
        model: 'gpt-5.1',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
        instruction,
        bypassPermissions: true,
        systemPrompt: 'Persisted system prompt',
        controllerProfile: {
          owner: 'alice',
          effort: 'high',
          claudeModelCap: 'opus',
        },
      });
      await seedTestProviderContinuity(mgr, entry.sessionId, {
        conversationRef: 'thread-1',
        providerContinuity: { threadId: 'thread-1' },
      });
      const service = createService(ctx);

      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status !== 'running') {
        throw new Error('expected running launch');
      }
      trackJob(decision.jobId);
      const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
      expect(request).toMatchObject({
        action: 'resume',
        conversationRef: 'thread-1',
        model: 'gpt-5.1',
        bypassPermissions: true,
        instruction,
        coralEnv: {
          CORAL_OWNER: 'alice',
          CORAL_EFFORT: 'high',
          CORAL_CLAUDE_MODEL_CAP: 'opus',
        },
      });
      // applyInjectBundle prepend-merges the inject bundle ahead of the persisted systemPrompt.
      expect(request.systemPrompt).toContain('Persisted system prompt');
      expect(request.systemPrompt).toContain('# Coral Guidelines');
      expect(request.systemPrompt?.endsWith('Persisted system prompt')).toBe(true);
      expect(request.effort).toBeUndefined();
    });

    it('resume rejects when the session already has an active job', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const mgr = createSessionManager(ctx.projectRoot);
      const entry = allocateCodexSession(mgr, 'alpha', 'gpt-5', ctx.projectRoot);
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
      const capacityService = createService(ctx);
      await occupyProviderSlots(capacityService, ctx, 'codex');

      const gate = createDeferred<void>();
      const racingProvider = makeProvider({
        preflight: async (_preflightRuntime) => {
          await gate.promise;
        },
      });
      mockState.getNewProvider.mockReturnValue(racingProvider.provider);
      const service = createService(ctx);

      const mgr = createSessionManager(ctx.projectRoot);
      const entry = allocateCodexSession(mgr, 'alpha', 'gpt-5', ctx.projectRoot);
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
          durationMs: 0,
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
      const entry = allocateCodexSession(mgr, 'alpha', 'gpt-5', ctx.projectRoot);
      await seedTestProviderContinuity(mgr, entry.sessionId, {
        conversationRef: 'thread-stale',
        providerContinuity: { threadId: 'thread-stale' },
      });
      const service = createService(ctx);

      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('running');
      if (decision.status !== 'running') {
        throw new Error('expected running launch');
      }
      trackJob(decision.jobId);

      const terminal = await waitForTerminalEvent(service, decision.jobId);
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
      expect(terminal.continuity).toEqual({
        conversationRef: null,
        resumable: false,
        providerContinuity: null,
      });
      expect(updatedSession?.activeJobId).toBeUndefined();
      expect(updatedSession?.state).toBe('non_resumable');
      expect(updatedSession?.conversationRef).toBeUndefined();
    });
  }); // end queue admission

  it('persists successful workflow results before exposing the terminal event', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH', durationMs: 0 };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: 'FINAL', durationMs: 0 };
        }
        return { content: 'unexpected', durationMs: 0 };
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

    const terminal = await waitForTerminalEvent(service, decision.jobId);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status = progressStore.readStatus(decision.jobId);
    const workflow = readWorkflowView(progressStore.getDb(), decision.jobId, createDefaultStoreReadContext());

    expect(existsSync(terminal.resultPath)).toBe(true);
    expect(markdownAtTerminal).toBe(
      ['# Step 0.0: architect', '', 'ARCH', '', '# Step 1.0: resolver', '', 'FINAL', ''].join('\n'),
    );
    expect(terminal.result).toEqual({
      content: 'FINAL',
      durationMs: expect.any(Number),
      outcome: { kind: 'completed' },
    });
    expect(progressStore.loadJobProjectionDetail(decision.jobId).exit?.diagnostics).not.toHaveProperty('workflow');
    expect(workflow).toMatchObject({
      workflowId: decision.jobId,
      outcome: 'completed',
      slotOutcomes: {
        [`${decision.jobId}:0:0`]: { phase: 'completed', causeRef: null },
        [`${decision.jobId}:1:0`]: { phase: 'completed', causeRef: null },
      },
    });
    expect(status).toMatchObject({
      owner: { kind: 'workflow', id: decision.jobId },
      sessionId: null,
      phase: 'completed',
      jobKind: 'workflow',
      result: terminal.result,
    });
    expect(decision.kind).toBe('workflow');
    expect('session' in decision).toBe(false);
  });

  it('runs workflow atoms in workDir without allocating a provider session for the workflow aggregate', async () => {
    const seenCwds: string[] = [];
    const { provider } = makeProvider({
      execute: async (request) => {
        if (!request.cwd) throw new Error('expected workflow atom cwd');
        seenCwds.push(request.cwd);
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH', durationMs: 0 };
        }
        return { content: 'FINAL', durationMs: 0 };
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

    await waitForTerminalEvent(service, decision.jobId);

    expect(seenCwds).toEqual([workDir, workDir]);
    expect(decision.kind).toBe('workflow');
    expect('session' in decision).toBe(false);
    const { progressStore } = getInternals(service);
    expect(progressStore.readStatus(decision.jobId)).toMatchObject({
      owner: { kind: 'workflow', id: decision.jobId },
      sessionId: null,
      projectRoot: ctx.projectRoot,
    });
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
    trackJob(decision.jobId);
    expect(getActiveJobIds()).toEqual(activeJobIds);
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    expect(progressStore.readStatus(decision.jobId)).toMatchObject({
      jobId: decision.jobId,
      owner: { kind: 'workflow', id: decision.jobId },
      sessionId: null,
      jobKind: 'workflow',
      phase: 'running',
    });
    expect(decision.kind).toBe('workflow');
    expect('session' in decision).toBe(false);
  });

  it('persists partial workflow results on failure under the workflow owner', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH', durationMs: 0, outcome: { kind: 'completed' as const } };
        }
        if (request.name?.startsWith('resolver')) {
          return {
            content: '',
            durationMs: 0,
            outcome: {
              kind: 'failed',
            },
            failureCause: providerRequestFailed({ provider: 'codex', message: 'resolver failed' }),
          };
        }
        return { content: 'unexpected', durationMs: 0, outcome: { kind: 'completed' as const } };
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

    const terminal = await waitForTerminalEvent(service, decision.jobId);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status = progressStore.readStatus(decision.jobId);
    const workflow = readWorkflowView(progressStore.getDb(), decision.jobId, createDefaultStoreReadContext());

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toMatchObject({
      content: '',
      outcome: {
        kind: 'failed',
        causeRef: {
          stream: { kind: 'workflow', id: decision.jobId },
        },
      },
    });
    expect(progressStore.loadJobProjectionDetail(decision.jobId).exit?.diagnostics).not.toHaveProperty('workflow');
    expect(workflow).toMatchObject({
      workflowId: decision.jobId,
      outcome: 'failed',
      slotOutcomes: {
        [`${decision.jobId}:0:0`]: { phase: 'completed', causeRef: null },
      },
    });
    expect(status).toMatchObject({
      owner: { kind: 'workflow', id: decision.jobId },
      sessionId: null,
      phase: 'error',
      result: {
        content: '',
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: { kind: 'workflow', id: decision.jobId },
          },
        },
      },
    });
    expect(decision.kind).toBe('workflow');
    expect('session' in decision).toBe(false);
  });

  it('persists partial workflow results on abort under the workflow owner', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH', durationMs: 0, outcome: { kind: 'completed' as const } };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: '', durationMs: 0, outcome: { kind: 'aborted', reason: 'signal_abort' } };
        }
        return { content: 'unexpected', durationMs: 0, outcome: { kind: 'completed' as const } };
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

    const terminal = await waitForTerminalEvent(service, decision.jobId);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const { progressStore } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const status = progressStore.readStatus(decision.jobId);
    const workflow = readWorkflowView(progressStore.getDb(), decision.jobId, createDefaultStoreReadContext());

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toMatchObject({
      content: '',
      outcome: {
        kind: 'aborted',
        reason: 'signal_abort',
      },
    });
    expect(progressStore.loadJobProjectionDetail(decision.jobId).exit?.diagnostics).not.toHaveProperty('workflow');
    expect(workflow).toMatchObject({
      workflowId: decision.jobId,
      outcome: 'aborted',
      causeRef: null,
      slotOutcomes: {
        [`${decision.jobId}:0:0`]: { phase: 'completed', causeRef: null },
      },
    });
    expect(status).toMatchObject({
      owner: { kind: 'workflow', id: decision.jobId },
      sessionId: null,
      phase: 'aborted',
      result: {
        content: '',
        outcome: {
          kind: 'aborted',
          reason: 'signal_abort',
        },
      },
    });
    expect(decision.kind).toBe('workflow');
    expect('session' in decision).toBe(false);
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
    trackJob(decision.jobId);

    const deadline = Date.now() + 2_000;
    while (terminalCommitAttempts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = progressStore.readStatus(decision.jobId);

    expect(commit).toHaveBeenCalled();
    expect(terminalCommitAttempts).toBeGreaterThan(0);
    if (decision.sessionId === undefined) throw new Error('provider launch must return a session');
    expect(status).toMatchObject({
      owner: { kind: 'provider-session', id: decision.sessionId },
      sessionId: decision.sessionId,
      phase: 'launching',
    });
    expect(status?.result).toBeUndefined();
    expect(sessionManager.get('codex', decision.sessionId)?.activeJobId).toBe(decision.jobId);
  });

  it('propagates terminal append failure for finishQueuedAbort without releasing ownership', () => {
    const service = createService(ctx);
    const { progressStore, sessionManager } =
      /* @intentional-private-access — seed or inspect execution internals with no public test seam */
      getInternals(service);
    const session = allocateCodexSession(sessionManager, 'queued-abort', 'gpt-5', ctx.projectRoot);
    const jobId = `queued-abort-${randomUUID()}`;
    trackJob(jobId);
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
    seedTestJobSession(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
    });
    progressStore.appendLaunchRequested(
      jobId,
      makeLaunchRecord({
        jobId,
        sessionId: session.sessionId,
        projectRoot: ctx.projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
      }),
    );
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
    const session = allocateCodexSession(sessionManager, 'fail-job', 'gpt-5', ctx.projectRoot);
    const jobId = `fail-job-${randomUUID()}`;
    trackJob(jobId);
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
    seedTestJobSession(progressStore, {
      jobId,
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
    });
    progressStore.appendLaunchRequested(
      jobId,
      makeLaunchRecord({
        jobId,
        sessionId: session.sessionId,
        projectRoot: ctx.projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
      }),
    );
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

  describe('recovery adoption APIs', () => {
    function makeRuntimeRecord(overrides?: Partial<DurableCliRuntimeRecord>): DurableCliRuntimeRecord {
      return {
        transport: 'durable-cli',
        pid: process.pid,
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        startTime: new Date().toISOString(),
        ...overrides,
      };
    }

    function makeAppServerRuntimeRecord(overrides?: {
      provider?: string;
      leaseState?: 'waiting' | 'acquired';
    }): AppServerRuntime {
      if (overrides?.leaseState === 'waiting') {
        return {
          transport: 'app-server',
          startTime: new Date().toISOString(),
          providerMeta: {
            provider: overrides.provider ?? 'codex',
            leaseState: 'waiting',
          },
        };
      }
      return {
        transport: 'app-server',
        startTime: new Date().toISOString(),
        providerMeta: {
          provider: overrides?.provider ?? 'codex',
          leaseState: 'acquired',
          hostRef: {
            provider: 'test',
            fingerprint: '0'.repeat(64),
            instanceId: 'instance-1',
            leaseMode: 'shared',
          },
        },
      };
    }

    function buildExpectedInterruptedReport(
      reason: 'restart' | 'handoff',
      continuity: 'verified' | 'missing' | 'unavailable' | 'pre_checkpoint_preserved' | 'pre_checkpoint_empty',
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
              : continuity === 'pre_checkpoint_preserved'
                ? 'existing conversation reference was preserved'
                : 'no resumable conversation was available';
      const baseNotice = `${triggerText}; ${continuityText}.`;
      return [baseNotice, '', ...detailLines].join('\n');
    }

    it('captures only deep immutable recovery facts independent of mutable launch and session sources', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx);
      const { progressStore, sessionManager } =
        /* @intentional-private-access — seed or inspect execution internals with no public test seam */
        getInternals(service);
      const jobId = `recovery-authority-snapshot-${randomUUID()}`;
      const sessionId = `session-authority-snapshot-${randomUUID()}`;
      trackJob(jobId);
      seedTestJobSession(progressStore, {
        jobId,
        sessionId,
        provider: 'codex',
        projectRoot: ctx.projectRoot,
        backendNamespace: 'old-backend-ns',
        initialPhase: 'queued',
      });
      const persistedSession = sessionManager.readById(sessionId, { forceFresh: true });
      if (persistedSession === null) throw new Error('expected seeded session');
      const mutableSession: ProviderSession & { unexpectedSecret: string } = {
        ...persistedSession,
        conversationRef: 'conversation-original',
        providerContinuity: { nested: { turn: 'turn-original' } },
        artifactHandles: [
          {
            handle: '/artifacts/original.jsonl',
            identity: { kind: 'thread', threadId: 'thread-original' },
            identityKey: 'codex:identity-original',
            sourceJobId: jobId,
            recordedAt: '2026-07-22T00:00:00.000Z',
          },
        ],
        unexpectedSecret: 'must-not-cross-authority-boundary',
      };
      vi.spyOn(sessionManager, 'readById').mockReturnValue(mutableSession);
      const launchRecord = makeLaunchRecord({
        jobId,
        sessionId,
        projectRoot: ctx.projectRoot,
        backendNamespace: 'old-backend-ns',
      });
      if (launchRecord.jobKind !== 'provider') throw new Error('expected provider launch');
      launchRecord.request.coralEnv = { ROUTE: 'original' };

      const authority = await captureRecoveryAuthority(service, launchRecord);

      launchRecord.request.prompt = 'mutated prompt';
      launchRecord.request.coralEnv.ROUTE = 'mutated';
      (launchRecord.owner as { id: string }).id = 'mutated-owner';
      mutableSession.projectRoot = '/mutated-project';
      (mutableSession.providerContinuity as { nested: { turn: string } }).nested.turn = 'mutated-turn';
      mutableSession.artifactHandles[0].identity.threadId = 'mutated-thread';
      mutableSession.unexpectedSecret = 'mutated-secret';

      expect(Object.keys(authority.session).sort()).toEqual([
        'artifactHandles',
        'conversationRef',
        'projectRoot',
        'providerContinuity',
        'sessionId',
        'version',
      ]);
      expect(authority.session).not.toHaveProperty('binding');
      expect(authority.session).not.toHaveProperty('unexpectedSecret');
      expect(authority.session.projectRoot).toBe(ctx.projectRoot);
      expect(authority.session.providerContinuity).toEqual({ nested: { turn: 'turn-original' } });
      expect(authority.session.artifactHandles).toEqual([
        {
          handle: '/artifacts/original.jsonl',
          identity: { kind: 'thread', threadId: 'thread-original' },
          sourceJobId: jobId,
        },
      ]);
      expect(Object.keys(authority.session.artifactHandles[0]).sort()).toEqual(['handle', 'identity', 'sourceJobId']);
      expect(authority.launchRecord.owner).toEqual({ kind: 'provider-session', id: sessionId });
      expect(authority.launchRecord.request).toMatchObject({
        prompt: 'recover me',
        coralEnv: { ROUTE: 'original' },
      });
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(authority.launchRecord)).toBe(true);
      expect(Object.isFrozen(authority.launchRecord.request.coralEnv)).toBe(true);
      expect(Object.isFrozen(authority.session)).toBe(true);
      expect(Object.isFrozen(authority.session.providerContinuity)).toBe(true);
      expect(Object.isFrozen(authority.session.artifactHandles)).toBe(true);
      expect(Object.isFrozen(authority.session.artifactHandles[0].identity)).toBe(true);
    });

    describe('recoverQueuedJob', () => {
      it.each([['missing session', 'delete'] as const, ['foreign binding', 'replace'] as const])(
        'fails with typed invalid persisted binding for %s before restoring queue admission',
        async (_scenario, corruption) => {
          const { provider } = makeProvider();
          mockState.getNewProvider.mockReturnValue(provider);
          const service = createService(ctx);
          const { progressStore, sessionManager } =
            /* @intentional-private-access — seed or inspect execution internals with no public test seam */
            getInternals(service);
          const jobId = `recover-binding-${corruption}-${randomUUID()}`;
          const sessionId = `session-binding-${corruption}-${randomUUID()}`;
          trackJob(jobId);
          seedTestJobSession(progressStore, {
            jobId,
            sessionId,
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: 'old-backend-ns',
            initialPhase: 'queued',
          });
          const launchRecord = makeLaunchRecord({
            jobId,
            sessionId,
            projectRoot: ctx.projectRoot,
            backendNamespace: 'old-backend-ns',
          });
          progressStore.appendLaunchRequested(jobId, launchRecord);

          if (corruption === 'delete') {
            progressStore.getDb().prepare('DELETE FROM projection_sessions WHERE session_id = ?').run(sessionId);
          } else {
            const current = sessionManager.get('codex', sessionId);
            if (!current) throw new Error('expected seeded session');
            vi.spyOn(sessionManager, 'readById').mockReturnValue({
              ...current,
              binding: TEST_CLAUDE_BINDING,
            });
          }

          const priorQueueDepth = queueDepth();
          const captured = await service.captureProviderRecoveryAuthority(launchRecord);
          expect(captured).toMatchObject({
            ok: false,
            failure: { reason: 'invalid-persisted-binding' },
          });
          if (captured.ok) throw new Error('Expected invalid recovery binding.');
          service.finalizeProviderRecoveryBindingFailure(launchRecord, captured.failure);
          expect(queueDepth()).toBe(priorQueueDepth);
          expect(progressStore.readStatus(jobId)?.result?.outcome).toEqual({
            kind: 'job_fault',
            fault: expect.objectContaining({ kind: 'provider_binding', reason: 'invalid-persisted-binding' }),
          });
        },
      );

      it('preserves the provider binding readiness failure before restoring queue admission', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx, { providerBindingReady: false });
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `recover-source-unavailable-${randomUUID()}`;
        const sessionId = `session-source-unavailable-${randomUUID()}`;
        trackJob(jobId);
        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });
        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const priorQueueDepth = queueDepth();
        const captured = await service.captureProviderRecoveryAuthority(launchRecord);
        expect(captured).toMatchObject({ ok: false, failure: { reason: 'profile-unavailable' } });
        if (captured.ok) throw new Error('Expected unavailable recovery binding.');
        service.finalizeProviderRecoveryBindingFailure(launchRecord, captured.failure);
        expect(queueDepth()).toBe(priorQueueDepth);
        expect(progressStore.readStatus(jobId)?.result?.outcome).toEqual({
          kind: 'job_fault',
          fault: expect.objectContaining({ kind: 'provider_binding', reason: 'profile-unavailable' }),
        });
      });

      it.each([
        ['subject', 'https://api.openai.com/chatgpt-account', 'different-account'],
        ['issuer', 'https://issuer.changed.example', 'test-account'],
      ] as const)(
        'fails recovery closed when the persisted profile now authenticates with a different %s',
        async (_field, nextIssuer, nextSubject) => {
          let issuer = 'https://api.openai.com/chatgpt-account';
          let subject = 'test-account';
          const { provider, execute } = makeProvider();
          mockState.getNewProvider.mockReturnValue(provider);
          const service = createService(ctx, {
            providerAccountSubject: () => ({ issuer, subject }),
          });
          const { progressStore } =
            /* @intentional-private-access — seed or inspect execution internals with no public test seam */
            getInternals(service);
          const jobId = `recover-subject-${randomUUID()}`;
          const sessionId = `session-subject-${randomUUID()}`;
          trackJob(jobId);
          seedTestJobSession(progressStore, {
            jobId,
            sessionId,
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: 'old-backend-ns',
            initialPhase: 'queued',
          });
          const launchRecord = makeLaunchRecord({
            jobId,
            sessionId,
            projectRoot: ctx.projectRoot,
            backendNamespace: 'old-backend-ns',
          });
          progressStore.appendLaunchRequested(jobId, launchRecord);
          issuer = nextIssuer;
          subject = nextSubject;

          const priorQueueDepth = queueDepth();
          const captured = await service.captureProviderRecoveryAuthority(launchRecord);
          expect(captured).toMatchObject({ ok: false, failure: { reason: 'subject-mismatch' } });
          if (captured.ok) throw new Error('Expected mismatched recovery subject.');
          service.finalizeProviderRecoveryBindingFailure(launchRecord, captured.failure);

          expect(queueDepth()).toBe(priorQueueDepth);
          expect(execute).not.toHaveBeenCalled();
          expect(progressStore.readStatus(jobId)?.result?.outcome).toEqual({
            kind: 'job_fault',
            fault: expect.objectContaining({ kind: 'provider_binding', reason: 'subject-mismatch' }),
          });
        },
      );

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

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const recovered = await service.recoverQueuedJob(await captureRecoveryAuthority(service, launchRecord));

        expect(recovered).toBe(jobId);
        expect(queueDepth()).toBeGreaterThanOrEqual(1);
      });

      it('restores the complete protected child tuple before a queued provider can launch', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx, { childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids) });
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const launchOrchestrator = (
          service as unknown as {
            launchOrchestrator: {
              runRecoveredQueuedJob: (
                provider: unknown,
                launchRecord: unknown,
                queuedHandle: { waitForPermit: () => Promise<void>; cancel: () => void },
                pool: unknown,
                protectedEnv: unknown,
              ) => void;
            };
          }
        ).launchOrchestrator;
        const runRecoveredQueuedJob = vi
          .spyOn(launchOrchestrator, 'runRecoveredQueuedJob')
          .mockImplementation((_provider, _launchRecord, queuedHandle) => {
            void queuedHandle.waitForPermit().catch(() => {});
            queuedHandle.cancel();
          });
        const jobId = `recover-protected-env-${randomUUID()}`;
        const sessionId = `session-protected-env-${randomUUID()}`;
        trackJob(jobId);
        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });
        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.recoverQueuedJob(await captureRecoveryAuthority(service, launchRecord));

        expect(runRecoveredQueuedJob).toHaveBeenCalledWith(
          expect.objectContaining({ name: provider.name, envelope: TEST_CODEX_BINDING }),
          launchRecord,
          expect.objectContaining({ type: 'queued' }),
          'default',
          {
            CORAL_JOB_ID: jobId,
            CORAL_SESSION_ID: sessionId,
            [CORAL_CHILD_PRINCIPAL_HANDLE]: expect.any(String),
          },
        );
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

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.recoverQueuedJob(await captureRecoveryAuthority(service, launchRecord));

        const status = progressStore.readStatus(jobId);
        expect(status?.backendNamespace).not.toBe('old-backend-ns');
      });

      it('recovers queued jobs without hydrating retired progress counters', async () => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

        const jobId = `recover-hydrate-${randomUUID()}`;
        const sessionId = `session-hydrate-${randomUUID()}`;
        trackJob(jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);
        // Existing progress no longer requires a per-job counter hydration step.
        const firstProgressSeq = progressStore.appendProgress(jobId, sessionId, 'step-1');
        const secondProgressSeq = progressStore.appendProgress(jobId, sessionId, 'step-2');

        await service.recoverQueuedJob(await captureRecoveryAuthority(service, launchRecord));

        expect(progressStore.readJobEvents(jobId).map((event) => event.seq)).toEqual([
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
        const session = allocateCodexSession(mgr, 'recover', 'gpt-5', ctx.projectRoot);
        trackJob(jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'queued',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId: session.sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: session.backendNamespace,
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.recoverQueuedJob(await captureRecoveryAuthority(service, launchRecord));

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
      beforeEach(() => {
        const { provider } = makeProvider();
        mockState.getNewProvider.mockReturnValue(provider);
      });

      it('adopts a running job with a live PID and returns a cleanup handle', async () => {
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

        const jobId = `adopt-running-${randomUUID()}`;
        const sessionId = `session-adopt-${randomUUID()}`;
        trackJob(jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const { cleanup } = await service.adoptRunningJob(
          await captureRecoveryAuthority(service, launchRecord),
          runtimeRecord,
        );

        expect(typeof cleanup).toBe('function');
        expect(getActiveJobIds()).toContain(jobId);

        // Cleanup should release the resources
        cleanup();
        expect(getActiveJobIds()).not.toContain(jobId);
      });

      it.each([
        ['returns false', (): boolean => false] as const,
        [
          'throws',
          (): boolean => {
            throw new Error('process table unavailable');
          },
        ] as const,
      ])(
        'captures a running binding failure without process or terminal side effects when kill %s',
        async (_mode, kill) => {
          const killSpy = vi.spyOn(runtime.process, 'kill').mockImplementation(kill);
          const service = createService(ctx, { providerBindingReady: false });
          const { progressStore, sessionManager } =
            /* @intentional-private-access — seed or inspect execution internals with no public test seam */
            getInternals(service);
          const jobId = `adopt-binding-unavailable-${randomUUID()}`;
          const sessionId = `session-binding-unavailable-${randomUUID()}`;
          trackJob(jobId);
          seedTestJobSession(progressStore, {
            jobId,
            sessionId,
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: 'old-backend-ns',
            initialPhase: 'running',
          });
          const launchRecord = makeLaunchRecord({
            jobId,
            sessionId,
            projectRoot: ctx.projectRoot,
            backendNamespace: 'old-backend-ns',
          });
          const runtimeRecord = makeRuntimeRecord({ pid: 54322 });
          progressStore.appendLaunchRequested(jobId, launchRecord);
          progressStore.appendRuntimeStarted(jobId, runtimeRecord);

          const captured = await service.captureProviderRecoveryAuthority(launchRecord);

          expect(captured).toMatchObject({ ok: false, failure: { reason: 'profile-unavailable' } });
          expect(killSpy).not.toHaveBeenCalled();
          expect(sessionManager.readById(sessionId, { forceFresh: true })?.activeJobId).toBe(jobId);
          expect(progressStore.readStatus(jobId)?.phase).toBe('running');
        },
      );

      it('releases admission but preserves the session claim when rejected-recovery terminal commit fails', async () => {
        vi.spyOn(runtime.process, 'kill').mockReturnValue(false);
        const service = createService(ctx, { providerBindingReady: false });
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `adopt-binding-terminal-failure-${randomUUID()}`;
        const sessionId = `session-binding-terminal-failure-${randomUUID()}`;
        trackJob(jobId);
        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });
        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        const runtimeRecord = makeRuntimeRecord({ pid: 54323 });
        progressStore.appendLaunchRequested(jobId, launchRecord);
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);
        const originalCommit = progressStore.commit.bind(progressStore);
        vi.spyOn(progressStore, 'commit').mockImplementation((cb) =>
          originalCommit(<Scope>(c: CommitContext<Scope>) => {
            let sawTerminal = false;
            const tracked: CommitContext<Scope> = {
              append(input) {
                sawTerminal = sawTerminal || input.type === 'job.terminal.recorded';
                return c.append(input);
              },
            };
            const result = cb(tracked);
            if (sawTerminal) throw new Error('terminal storage unavailable');
            return result;
          }),
        );

        const captured = await service.captureProviderRecoveryAuthority(launchRecord);
        if (captured.ok) throw new Error('Expected unavailable recovery binding.');
        expect(() => service.finalizeProviderRecoveryBindingFailure(launchRecord, captured.failure)).toThrow(
          'Failed to append terminal event',
        );
        expect(getActiveJobIds()).not.toContain(jobId);
        expect(progressStore.readStatus(jobId)?.phase).toBe('running');
        expect(sessionManager.readById(sessionId, { forceFresh: true })?.activeJobId).toBe(jobId);
      });

      it('restores pool mapping and active permit', async () => {
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

        const jobId = `adopt-pool-${randomUUID()}`;
        const sessionId = `session-pool-${randomUUID()}`;
        trackJob(jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          pool: 'default',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const activeIdsBefore = getActiveJobIds();
        expect(activeIdsBefore).not.toContain(jobId);

        const { cleanup } = await service.adoptRunningJob(
          await captureRecoveryAuthority(service, launchRecord),
          runtimeRecord,
        );

        expect(getActiveJobIds()).toContain(jobId);
        cleanup();
      });

      it('rebinds namespace', async () => {
        const service = createService(ctx);
        const { progressStore } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

        const jobId = `adopt-rebind-${randomUUID()}`;
        const sessionId = `session-rebind-${randomUUID()}`;
        trackJob(jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        const runtimeRecord = makeRuntimeRecord();
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const { cleanup } = await service.adoptRunningJob(
          await captureRecoveryAuthority(service, launchRecord),
          runtimeRecord,
        );

        const status = progressStore.readStatus(jobId);
        expect(status?.backendNamespace).not.toBe('old-backend-ns');
        cleanup();
      });

      it('routes abort through runtime.process.kill', async () => {
        const killSpy = vi.spyOn(runtime.process, 'kill').mockImplementation(() => true);
        const service = createService(ctx);
        const { progressStore, abortRegistry } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);

        const jobId = `adopt-abort-${randomUUID()}`;
        const sessionId = `session-adopt-abort-${randomUUID()}`;
        trackJob(jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
          initialPhase: 'running',
        });

        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: 'old-backend-ns',
        });
        const runtimeRecord = makeRuntimeRecord({ pid: 54321 });
        progressStore.appendLaunchRequested(jobId, launchRecord);
        progressStore.appendRuntimeStarted(jobId, runtimeRecord);

        const { cleanup } = await service.adoptRunningJob(
          await captureRecoveryAuthority(service, launchRecord),
          runtimeRecord,
        );

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

        const session = allocateCodexSession(sessionManager, 'recover-complete', 'gpt-5', ctx.projectRoot);
        expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
        seedTestJobSession(progressStore, {
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: session.backendNamespace,
          initialPhase: 'running',
        });
        progressStore.appendLaunchRequested(
          jobId,
          makeLaunchRecord({
            jobId,
            sessionId: session.sessionId,
            projectRoot: ctx.projectRoot,
            backendNamespace: TEST_BACKEND_NAMESPACE,
          }),
        );

        // Simulate a running job being adopted: register active launch + claim session
        restoreActiveLaunch(jobId, 'codex');
        service.completeRecoveredJob(
          jobId,
          session.sessionId,
          { content: 'recovered done', durationMs: 0, outcome: { kind: 'completed' } },
          'completed',
          { pool: 'default' },
        );

        const status = progressStore.readStatus(jobId);
        expect(status).toMatchObject({
          phase: 'completed',
          result: { content: 'recovered done', outcome: { kind: 'completed' } },
        });
        expect(existsSync(jobResultPath(jobId))).toBe(true);
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('recovered done');

        const updatedSession = sessionManager.readById(session.sessionId, { forceFresh: true });
        expect(updatedSession?.activeJobId).toBeUndefined();
      });
    });

    describe('finalizeInterruptedAppServerJob', () => {
      it('skips the probe for lease-waiting jobs and preserves an existing conversationRef', async () => {
        const spawnProviderServerMock = vi.fn();
        spawnProviderServer = spawnProviderServerMock as unknown as SpawnProviderServerFn;
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        const service = createService(ctx);
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `app-server-waiting-${randomUUID()}`;
        trackJob(jobId);
        const session = allocateCodexSession(sessionManager, 'recover-waiting', 'gpt-5', ctx.projectRoot);
        await seedTestProviderContinuity(sessionManager, session.sessionId, {
          providerContinuity: {
            threadId: 'thread-existing',
          },
          conversationRef: 'thread-existing',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);
        seedTestJobSession(progressStore, {
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
          backendNamespace: TEST_BACKEND_NAMESPACE,
          request: {
            prompt: 'recover me',
            cwd: '/tmp/project',
            bypassPermissions: false,
            coralEnv: {},
          },
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          recoveryFence('restart'),
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
        const updatedSession = sessionManager.get('codex', session.sessionId);
        expect(updatedSession).toMatchObject({
          state: 'ready',
          conversationRef: 'thread-existing',
        });
        expect(Object.hasOwn(updatedSession ?? {}, 'activeJobId')).toBe(false);
      });

      it('marks a fresh lease-waiting session non-resumable without treating its planned ref as evidence', async () => {
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        const service = createService(ctx);
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `app-server-waiting-fresh-${randomUUID()}`;
        trackJob(jobId);
        const session = allocateCodexSession(sessionManager, 'recover-waiting-fresh', 'gpt-5', ctx.projectRoot);
        sessionManager.claimForJobSync(session.sessionId, jobId);
        seedTestJobSession(progressStore, {
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
          backendNamespace: TEST_BACKEND_NAMESPACE,
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          recoveryFence('restart'),
        );

        const expectedReport = buildExpectedInterruptedReport(
          'restart',
          'pre_checkpoint_empty',
          'Session was interrupted before completion. No resumable conversation was available.',
        );
        expect(progressStore.readStatus(jobId)?.result?.content).toBe(expectedReport);
        expect(sessionManager.get('codex', session.sessionId)).toMatchObject({ state: 'non_resumable' });
      });

      it('uses the provider interpretation for a lease-waiting session with no checkpoint', async () => {
        const finalizeInterrupted = vi.fn(() => ({ kind: 'preserve' as const }));
        mockState.getNewProvider.mockReturnValue(
          toProviderDefinition({
            name: 'codex',
            execute: vi.fn(() =>
              streamProviderTerminal({ content: 'ok', durationMs: 0, outcome: { kind: 'completed' } }),
            ),
            appServerLifecycle: {
              host: {
                provider: 'codex',
                command: 'codex',
                args: [],
                cwd: ctx.projectRoot,
                leaseMode: 'job-exclusive',
              },
              interrupt: async () => {},
              finalizeInterrupted,
            },
          }),
        );
        const service = createService(ctx);
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `app-server-provider-interpreter-${randomUUID()}`;
        trackJob(jobId);
        const session = allocateCodexSession(sessionManager, 'provider-interpreter', 'gpt-5', ctx.projectRoot);
        sessionManager.claimForJobSync(session.sessionId, jobId);
        seedTestJobSession(progressStore, {
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: session.backendNamespace,
          initialPhase: 'running',
        });
        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId: session.sessionId,
          projectRoot: ctx.projectRoot,
          backendNamespace: session.backendNamespace,
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          recoveryFence('restart'),
        );

        expect(finalizeInterrupted).toHaveBeenCalledWith({ resumable: false }, undefined, {
          preservedConversationRef: undefined,
        });
        expect(sessionManager.get('codex', session.sessionId)?.state).not.toBe('non_resumable');
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
        const session = allocateCodexSession(sessionManager, 'recover-verified', 'gpt-5', ctx.projectRoot);
        await seedTestProviderContinuity(sessionManager, session.sessionId, {
          providerContinuity: { threadId: 'thread-recovered' },
          conversationRef: 'thread-recovered',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);

        seedTestJobSession(progressStore, {
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });
        progressStore.appendLaunchRequested(
          jobId,
          makeLaunchRecord({
            jobId,
            sessionId: session.sessionId,
            projectRoot: ctx.projectRoot,
            backendNamespace: TEST_BACKEND_NAMESPACE,
          }),
        );

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(
            service,
            makeLaunchRecord({
              jobId,
              sessionId: session.sessionId,
              projectRoot: ctx.projectRoot,
              backendNamespace: TEST_BACKEND_NAMESPACE,
            }),
          ),
          makeAppServerRuntimeRecord(),
          recoveryFence('restart'),
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
        const updatedSession = sessionManager.get('codex', session.sessionId);
        expect(updatedSession).toMatchObject({
          state: 'ready',
          conversationRef: 'thread-recovered',
        });
        expect(Object.hasOwn(updatedSession ?? {}, 'activeJobId')).toBe(false);
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
        const session = allocateCodexSession(sessionManager, 'recover-missing', 'gpt-5', ctx.projectRoot);
        await seedTestProviderContinuity(sessionManager, session.sessionId, {
          providerContinuity: {
            threadId: 'thread-stale',
          },
          conversationRef: 'thread-stale',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);

        seedTestJobSession(progressStore, {
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
          backendNamespace: TEST_BACKEND_NAMESPACE,
          request: {
            prompt: 'recover me',
            cwd: '/tmp/project',
            bypassPermissions: false,
            coralEnv: {},
          },
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord(),
          recoveryFence('restart'),
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
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        const updatedSession = sessionManager.get('codex', session.sessionId);
        expect(updatedSession).toMatchObject({
          state: 'non_resumable',
        });
        expect(Object.hasOwn(updatedSession ?? {}, 'activeJobId')).toBe(false);
        expect(updatedSession?.conversationRef).toBeUndefined();
      });

      it('honors Claude artifact non-resumable evidence instead of falling back to the planned ref', async () => {
        const finalizeFromArtifacts = vi.fn(async () => ({
          terminal: {
            kind: 'terminal' as const,
            terminal: { content: 'artifact result', durationMs: 0, outcome: { kind: 'completed' as const } },
            diagnostics: {},
          },
          continuity: {
            conversationRef: null,
            resumable: false,
          },
        }));
        mockState.getNewProvider.mockReturnValue(
          toProviderDefinition({
            name: 'claude',
            execute: vi.fn(() =>
              streamProviderTerminal({ content: 'ok', durationMs: 0, outcome: { kind: 'completed' } }),
            ),
            appServerLifecycle: {
              host: {
                provider: 'claude',
                command: 'claude',
                args: [],
                cwd: ctx.projectRoot,
                env: {},
                leaseMode: 'shared',
                idleRetirement: 'none',
              },
              interrupt: async () => {},
              finalizeInterrupted: (probeResult, _continuity, context) =>
                probeResult.resumable && context.preservedConversationRef !== undefined
                  ? { kind: 'set_resumable', conversationRef: context.preservedConversationRef }
                  : { kind: 'clear_non_resumable' },
            },
            artifactRecovery: { finalizeFromArtifacts },
          }),
        );
        const spawnProviderServerMock = vi.fn();
        spawnProviderServer = spawnProviderServerMock as unknown as SpawnProviderServerFn;
        const service = createService(ctx);
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `claude-artifact-recovery-${randomUUID()}`;
        trackJob(jobId);
        const session = sessionManager.allocate({
          binding: TEST_CLAUDE_BINDING,
          name: 'recover-claude-artifact',
          model: 'sonnet',
          cwd: ctx.projectRoot,
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);
        seedTestJobSession(progressStore, {
          jobId,
          sessionId: session.sessionId,
          provider: 'claude',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          initialPhase: 'running',
        });
        const launchRecord = makeLaunchRecord({
          jobId,
          sessionId: session.sessionId,
          provider: 'claude',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord({
            provider: 'claude',
          }),
          recoveryFence('restart'),
        );

        expect(spawnProviderServerMock).not.toHaveBeenCalled();
        expect(finalizeFromArtifacts).toHaveBeenCalledWith(
          expect.objectContaining({
            stdoutPath: join(progressStore.jobDir(jobId), 'stdout'),
            stderrPath: join(progressStore.jobDir(jobId), 'stderr'),
          }),
        );
        expect(sessionManager.get('claude', session.sessionId)).toMatchObject({
          state: 'non_resumable',
          artifactHandles: [],
        });
        expect(sessionManager.get('claude', session.sessionId)?.conversationRef).toBeUndefined();
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
        const session = allocateCodexSession(sessionManager, 'recover-unavailable', 'gpt-5', ctx.projectRoot);
        await seedTestProviderContinuity(sessionManager, session.sessionId, {
          providerContinuity: {
            threadId: 'thread-unverified',
          },
          conversationRef: 'thread-unverified',
        });
        sessionManager.claimForJobSync(session.sessionId, jobId);

        seedTestJobSession(progressStore, {
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
          backendNamespace: TEST_BACKEND_NAMESPACE,
          request: {
            prompt: 'recover me',
            cwd: '/tmp/project',
            bypassPermissions: false,
            coralEnv: {},
          },
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord(),
          recoveryFence('handoff'),
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
        });
        expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(expectedReport);
        const updatedSession = sessionManager.get('codex', session.sessionId);
        expect(updatedSession).toMatchObject({
          state: 'non_resumable',
        });
        expect(Object.hasOwn(updatedSession ?? {}, 'activeJobId')).toBe(false);
        expect(updatedSession?.conversationRef).toBeUndefined();
        stderrSpy.mockRestore();
      });

      it('warns when an already-terminal job is observed during handoff recovery', async () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        const service = createService(ctx);
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `app-server-handoff-terminal-${randomUUID()}`;
        trackJob(jobId);
        const session = allocateCodexSession(sessionManager, 'recover-handoff-terminal', 'gpt-5', ctx.projectRoot);
        sessionManager.claimForJobSync(session.sessionId, jobId);

        seedTestJobSession(progressStore, {
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
          backendNamespace: TEST_BACKEND_NAMESPACE,
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        // A terminal job is already finalized; handoff recovery must remain idempotent.
        progressStore.commit((c) => {
          appendJobTerminalRecorded(c, {
            jobId,
            sessionId: session.sessionId,
            namespace: TEST_BACKEND_NAMESPACE,
            project: ctx.projectRoot,
            terminal: { content: '', durationMs: 0, outcome: { kind: 'completed' } },
          });
          return undefined;
        });

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          recoveryFence('handoff'),
        );

        const warnHits = stderrSpy.mock.calls.some(([chunk]) => {
          const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : '';
          return text.includes(jobId) && text.includes('already-terminal');
        });
        expect(warnHits).toBe(true);
        stderrSpy.mockRestore();
      });

      it('does not warn for already-terminal jobs during ordinary restart recovery', async () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        mockState.getNewProvider.mockReturnValue(makeCodexAppServerProvider());
        const service = createService(ctx);
        const { progressStore, sessionManager } =
          /* @intentional-private-access — seed or inspect execution internals with no public test seam */
          getInternals(service);
        const jobId = `app-server-restart-terminal-${randomUUID()}`;
        trackJob(jobId);
        const session = allocateCodexSession(sessionManager, 'recover-restart-terminal', 'gpt-5', ctx.projectRoot);
        sessionManager.claimForJobSync(session.sessionId, jobId);
        seedTestJobSession(progressStore, {
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
          backendNamespace: TEST_BACKEND_NAMESPACE,
        });
        progressStore.appendLaunchRequested(jobId, launchRecord);

        progressStore.commit((c) => {
          appendJobTerminalRecorded(c, {
            jobId,
            sessionId: session.sessionId,
            namespace: TEST_BACKEND_NAMESPACE,
            project: ctx.projectRoot,
            terminal: { content: '', durationMs: 0, outcome: { kind: 'completed' } },
          });
          return undefined;
        });

        await service.finalizeInterruptedAppServerJob(
          await captureRecoveryAuthority(service, launchRecord),
          makeAppServerRuntimeRecord({ leaseState: 'waiting' }),
          recoveryFence('restart'),
        );

        const warnHits = stderrSpy.mock.calls.some(([chunk]) => {
          const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : '';
          return text.includes('already-terminal');
        });
        expect(warnHits).toBe(false);
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
    vi.restoreAllMocks();
    mockState.getNewProvider.mockReset();
    mockState.resolveAgent.mockReset();
  });

  describe('ExecutionService.resume() adversarial', () => {
    it('rejects with non_resumable code when session state is non_resumable', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = createSessionManager(ctx.projectRoot);
      const entry = allocateCodexSession(mgr, 'alpha', 'gpt-5', ctx.projectRoot);
      await seedTestSessionContinuity(mgr, entry.sessionId, {
        conversationRef: null,
        resumable: false,
        providerContinuity: null,
      });

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
      if (firstDecision.sessionId === undefined) throw new Error('provider launch must return a session');
      trackJob(firstDecision.jobId);

      const decision = await service.resume('codex', { sessionId: firstDecision.sessionId, prompt: 'resume' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_busy');
      expect(decision.message).toContain(`Session ${firstDecision.sessionId} already has an active job`);
    });

    it('rejects with unknown_provider without setting activeJobId on the session', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const mgr = createSessionManager(ctx.projectRoot);
      const entry = allocateCodexSession(mgr, 'alpha', 'gpt-5', ctx.projectRoot);

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
      const entry = allocateCodexSession(mgr, 'alpha', 'gpt-5', ctx.projectRoot);
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
      trackJob(winner.jobId);

      const loser = rejected[0];
      if (!loser || loser.status !== 'rejected') throw new Error('expected rejected loser');
      expect(loser.code).toBe('session_busy');
      expect(loser.message).toContain(`Session ${entry.sessionId} already has an active job`);
      expectRuntimePreflightArg(preflight!);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe(winner.jobId);
      expect([...listJobDirs()].filter((jobId) => !jobDirsBefore.has(jobId))).toHaveLength(1);
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
