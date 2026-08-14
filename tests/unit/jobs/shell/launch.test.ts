import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { allocateTestSession, initTestJob } from '../../../helpers/session.js';
import { fixtureCanonicalWorkDir } from '../../../helpers/canonical-work-dir.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as AgentResolutionMod from '#src/jobs/agent-resolution.js';
import type * as ContinuityConsumerMod from '#src/jobs/shell/continuity-consumer.js';
import type { JobPhase } from '#src/jobs/phase.js';
import type { JobEvent, JobLaunch, JobStatus } from '#src/jobs/records.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import {
  providerContinuityEvent,
  providerProgressEvent,
  providerTerminalEvent,
  streamProviderEvents,
  type ProviderTerminalInput,
} from '#src/providers/stream.js';
import type { AppServerTransport, HostRef, ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import type { AppServerHostAuthority } from '#src/providers/internal/app-server-host.js';
import { ProviderHostUnserviceableError } from '#src/providers/host-admission.js';
import { encodeHostRef } from '#src/providers/host-ref-codec.js';
import type { DurableCliRuntimeRecord as _DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';
import type { AppServerProxyRoute } from '#src/jobs/contracts/app-server-proxy-route.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';

import { jobsDir } from '#src/jobs/paths.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
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
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import type { ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { SessionManager } from '#src/sessions/shell.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { CommitEventsFn } from '#src/store/append.js';
import {
  toProviderDefinition,
  type AppServerTestProvider,
  type Provider,
  type StandaloneTestProvider,
} from '#tests/helpers/scripted-provider.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import {
  TEST_CODEX_BINDING,
  TEST_CODEX_SCOPE,
  TEST_CODEX_SCOPE_INPUT,
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
  // A passthrough spy, not a behavior override: every existing test in this file relies on the real
  // `consumeJobStream` running for its local-path assertions. Wrapping it (default implementation set below,
  // once, at module init) is what lets the 'proxied' branch test prove it was never reached at all.
  consumeJobStream: vi.fn(),
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

vi.mock('#src/jobs/shell/continuity-consumer.js', async () => {
  const actual = await vi.importActual<typeof ContinuityConsumerMod>('#src/jobs/shell/continuity-consumer.js');
  mockState.consumeJobStream.mockImplementation(actual.consumeJobStream);
  return {
    ...actual,
    consumeJobStream: mockState.consumeJobStream,
  };
});

const createdJobIds = new Set<string>();
let baselineJobIds = new Set<string>();
let eventBus: TypedEventBus;
let launchCoordinator: LaunchCoordinator;
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
    /** The W2.3 proxy-routing seam. Configuring it is what makes `executeJob` take the `'proxied'` branch;
     *  every other existing test in this file omits it, exactly as `LaunchOrchestrator` treats an absent
     *  route — falling straight through to local execution. */
    appServerProxyRoute?: AppServerProxyRoute;
    /** Only needed for an app-server provider whose local path actually runs (`prepared.execute()` opens a
     *  session): omitted for every standalone-provider test, and unnecessary even for an app-server test
     *  that stays on the proxied branch, since that branch never opens a session locally. */
    appServerHostAuthority?: AppServerHostAuthority;
  } = {},
): ExecutionService {
  const resolveProvider = (name: string) => toProviderDefinition(mockState.getNewProvider(name));
  const providerRegistry = new ProviderRegistry();
  if (options.appServerHostAuthority !== undefined) {
    providerRegistry.connectAppServerHost(options.appServerHostAuthority);
  }
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
    ...(options.appServerProxyRoute === undefined ? {} : { appServerProxyRoute: options.appServerProxyRoute }),
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
    ...args: Parameters<StandaloneTestProvider['execute']>
  ) => Promise<TestProviderTurnResult | { content: string; durationMs: number; continuity?: ProviderTurnContinuity }>;
  preflight?: Provider['preflight'];
}): {
  provider: NonNullable<ReturnType<typeof toProviderDefinition>>;
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
  return { provider: toProviderDefinition(provider)!, execute, preflight };
}

/** An app-server-transport provider — the only shape that can ever reach `executePreparedProvider`'s
 *  `route`-fallback branch, since only `prepared.kind === 'app-server'` even consults `appServerProxyRoute`.
 *  The raw kernel ignores `runtime.appServerSession` entirely (matching the same pattern other unused
 *  app-server test fixtures in this suite already use), so this fixture never needs a real or fake process —
 *  only a real or fake `AppServerHostAuthority` needs to exist, and only for a run that takes the *local* path. */
function makeAppServerProvider(): {
  provider: NonNullable<ReturnType<typeof toProviderDefinition>>;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(() => streamCompletedResult(Promise.resolve({ content: 'ok', durationMs: 0 })));
  const provider: Provider = {
    name: 'codex',
    execute: execute as unknown as AppServerTestProvider['execute'],
    appServerLifecycle: {
      host: {
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        cwd: fixtureCanonicalWorkDir('/workspace'),
        leaseMode: 'job-exclusive',
      },
      interrupt: async () => {},
      finalizeInterrupted: () => ({ kind: 'preserve' as const }),
    },
  };
  return { provider: toProviderDefinition(provider)!, execute };
}

/** The minimal `AppServerHostAuthority` an app-server provider's *local* path needs to open a session at
 *  all — only `openSession` is ever reached (this fixture's provider never recovers/attaches), so
 *  `attachSession` stays a stub. */
function fakeAppServerHostAuthority(openError?: Error): AppServerHostAuthority {
  let counter = 0;
  return {
    openSession: async (spec, sessionOptions) => {
      if (openError !== undefined) throw openError;
      counter += 1;
      const base = { provider: spec.provider, fingerprint: 'f'.repeat(64), instanceId: `inst-${counter}` };
      const hostRef: HostRef =
        spec.leaseMode === 'shared'
          ? { ...base, leaseMode: 'shared' }
          : { ...base, leaseMode: 'job-exclusive', ownerJobId: sessionOptions?.jobId ?? '' };
      const session: AppServerTransport = {
        rpc: async () => ({}) as never,
        subscribe: () => () => {},
        closed: new Promise<Error | void>(() => {}),
      };
      return { session, hostRef, close: () => {} };
    },
    attachSession: async () => null,
  };
}

function expectRuntimePreflightArg(preflight: ReturnType<typeof vi.fn>): void {
  expect(preflight).toHaveBeenCalledWith(
    expect.objectContaining({
      process: runtime.process,
      storage: runtime.storage,
      env: runtime.env,
      time: runtime.time,
      cwd: expect.any(String),
      baseEnv: expect.any(Object),
      requestEnv: expect.any(Object),
      platform: expect.any(String),
    }),
  );
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
  const projectRoot = fixtureCanonicalWorkDir(join(mockState.tmpHome, name));
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
    const projectRoot = fixtureCanonicalWorkDir(join(mockState.tmpHome, 'project'));
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

  it('prepares and executes the same provider request after generic inject is applied', async () => {
    const { provider, execute } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    const service = createService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);
    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running launch');
    trackJob(decision.jobId);
    await waitForTerminalEvent(service, decision.jobId);

    expect(execute).toHaveBeenCalledOnce();
    const executedRequest = execute.mock.calls[0]?.[0] as ProviderRequest | undefined;
    expect(executedRequest?.systemPrompt).toContain('# Coral Guidelines');
    expect(Object.isFrozen(executedRequest)).toBe(true);
    expect(Object.isFrozen(executedRequest?.coralEnv)).toBe(true);
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
        {
          expression: 'architect',
          startPrompt: 'seed',
          provider: 'codex',
          workDir: ctx.projectRoot,
        },
        ctx,
        ctx.projectRoot,
      ),
    ).rejects.toThrow('workflow launch commit failed');

    expect(abortRegistry.listActive()).toEqual([]);
  });

  it('one execution service keeps consecutive account contexts isolated', async () => {
    const seenHomes: string[] = [];
    const { provider } = makeProvider({
      execute: async (_request, providerRuntime) => {
        seenHomes.push(providerRuntime.executionPlan.host.access.root);
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
      toProviderDefinition({
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

  describe("executeJob's 'proxied' branch", () => {
    it('recovers a pre-upgrade queued workflow child locally when a live proxy route is configured', async () => {
      const { provider, execute } = makeAppServerProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const activate = vi.fn(async () => {
        throw new Error('A live proxy must never receive the pre-upgrade slot-shaped identity.');
      });
      const service = createService(ctx, {
        appServerProxyRoute: { activate },
        appServerHostAuthority: fakeAppServerHostAuthority(),
      });
      const { progressStore, sessionManager } = getInternals(service);
      const workflowId = randomUUID();
      const legacySlotJobId = `${workflowId}:0:0`;
      const session = sessionManager.allocate({
        binding: TEST_CODEX_BINDING,
        name: 'legacy-workflow-child',
        model: 'test-model',
        cwd: ctx.projectRoot,
        projectRoot: ctx.projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
        retention: 'discard_provider_artifacts_on_terminal',
      });
      expect(sessionManager.claimForJobSync(session.sessionId, legacySlotJobId)).toBe(true);
      const launchRecord: JobLaunch = {
        jobId: legacySlotJobId,
        owner: { kind: 'workflow', id: workflowId },
        sessionId: session.sessionId,
        provider: 'codex',
        projectRoot: ctx.projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: 1,
        providerAction: 'exec',
        parentWorkflowJobId: workflowId,
        workflowSlotId: legacySlotJobId,
        workflowSlotGeneration: 0,
        request: {
          prompt: 'recover the queued workflow child',
          cwd: ctx.projectRoot,
          bypassPermissions: false,
          coralEnv: {},
        },
        createdAt: new Date(runtime.time.now()).toISOString(),
      };
      progressStore.appendLaunchRequested(legacySlotJobId, launchRecord);
      trackJob(legacySlotJobId);
      const captured = await service.captureProviderRecoveryAuthority(launchRecord);
      if (!captured.ok) throw new Error(`Expected recovery authority: ${captured.failure.reason}`);
      const blockerJobId = randomUUID();
      launchCoordinator.restoreActiveLaunch(
        blockerJobId,
        'codex',
        { kind: 'provider-session', id: `session-${blockerJobId}` },
        'default',
      );

      await expect(service.recoverQueuedJob(captured.authority)).resolves.toBe(legacySlotJobId);
      launchCoordinator.releaseLaunch(blockerJobId, 'default');
      await waitForTerminalEvent(service, legacySlotJobId);

      expect(legacySlotJobId).toHaveLength(40);
      expect(activate).not.toHaveBeenCalled();
      expect(progressStore.readTerminalProjection(legacySlotJobId)?.outcome).toEqual({ kind: 'completed' });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('takes the proxied branch exclusively: consumeJobStream and completeConsumedJob are never reached for an operation the proxy already owns', async () => {
      const { provider, execute } = makeAppServerProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const activate = vi.fn(async () => ({ kind: 'remote-executing' as const }));
      const service = createService(ctx, { appServerProxyRoute: { activate } });
      // Spies on the class's own prototype method, not a mocked module: `completeConsumedJob` is private and
      // has no separate module seam, so this is the direct way to prove it specifically was never invoked —
      // not merely that *some* terminal-writing side effect didn't happen to fire.
      const completeConsumedJobSpy = vi.spyOn(
        LaunchOrchestrator.prototype as unknown as { completeConsumedJob: (...args: never[]) => Promise<boolean> },
        'completeConsumedJob',
      );
      const consumeJobStreamCallsBefore = mockState.consumeJobStream.mock.calls.length;

      const decision = await service.start('codex', { prompt: 'hello' }, ctx);
      expect(decision.status).toBe('running');
      if (decision.status !== 'running') throw new Error('expected running launch');
      trackJob(decision.jobId);

      await vi.waitFor(() => expect(activate).toHaveBeenCalled());
      // Give `executeJob`'s post-activation synchronous continuation room to run to completion. If the
      // exclusivity guard were ever removed, `consumeJobStream` would be reachable within this same window —
      // it is the very next thing `executeJob` would call.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(execute).not.toHaveBeenCalled();
      expect(mockState.consumeJobStream.mock.calls.length).toBe(consumeJobStreamCallsBefore);
      expect(completeConsumedJobSpy).not.toHaveBeenCalled();
      // The strongest corroboration of all: no terminal was recorded locally. A double-applied terminal is
      // exactly what this exclusivity exists to prevent — this is what its absence would fail to show if the
      // branch above had accidentally also run the local finalization path.
      expect(getInternals(service).progressStore.readTerminalProjection(decision.jobId)).toBeNull();
    });

    it('persists complete proxy identity diagnostics in the recorded provider failure', async () => {
      const { provider, execute } = makeAppServerProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      let failureMessage = '';
      const activate = vi.fn(async (request: Parameters<AppServerProxyRoute['activate']>[0]) => {
        failureMessage =
          `Provider proxy launch rejected operation identity for job '${request.jobId}'. ` +
          'Invalid fields: jobId: invalid UUID; operationId: invalid UUID. ' +
          'If this is a queued workflow child created before the job-id upgrade, restart it under the upgraded coordinator.';
        throw new Error(failureMessage, { cause: { issues: [{ path: ['jobId'] }, { path: ['operationId'] }] } });
      });
      const service = createService(ctx, { appServerProxyRoute: { activate } });

      const decision = await service.start('codex', { prompt: 'hello' }, ctx);
      expect(decision.status).toBe('running');
      if (decision.status !== 'running') throw new Error('expected running launch');
      trackJob(decision.jobId);
      await waitForTerminalEvent(service, decision.jobId);

      expect(getInternals(service).progressStore.readTerminalProjection(decision.jobId)?.outcome).toEqual({
        kind: 'job_fault',
        fault: { kind: 'wrapper_crashed', cause: { message: failureMessage } },
      });
      expect(failureMessage).toContain('jobId');
      expect(failureMessage).toContain('operationId');
      expect(failureMessage).toContain('queued workflow child created before the job-id upgrade');
      expect(execute).not.toHaveBeenCalled();
    });

    it('with no appServerProxyRoute configured, an app-server job runs the exact local path it always did', async () => {
      const { provider, execute } = makeAppServerProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx, { appServerHostAuthority: fakeAppServerHostAuthority() });

      const decision = await service.start('codex', { prompt: 'hello' }, ctx);
      expect(decision.status).toBe('running');
      if (decision.status !== 'running') throw new Error('expected running launch');
      trackJob(decision.jobId);
      await waitForTerminalEvent(service, decision.jobId);

      expect(execute).toHaveBeenCalledOnce();
      expect(getInternals(service).progressStore.readTerminalProjection(decision.jobId)?.outcome).toEqual({
        kind: 'completed',
      });
    });

    it('terminalizes a local blocked-host admission with exact identity and remediation', async () => {
      const { provider, execute } = makeAppServerProvider();
      const hostRef: HostRef = {
        provider: 'codex',
        fingerprint: 'f'.repeat(64),
        instanceId: 'blocked-local-host',
        leaseMode: 'job-exclusive',
        ownerJobId: 'owner-job',
      };
      mockState.getNewProvider.mockReturnValue(provider);
      const service = createService(ctx, {
        appServerHostAuthority: fakeAppServerHostAuthority(new ProviderHostUnserviceableError(hostRef)),
      });

      const decision = await service.start('codex', { prompt: 'hello' }, ctx);
      expect(decision.status).toBe('running');
      if (decision.status !== 'running') throw new Error('expected running launch');
      trackJob(decision.jobId);
      await waitForTerminalEvent(service, decision.jobId);

      const { progressStore } = getInternals(service);
      const rows = progressStore
        .getDb()
        .prepare<
          [string],
          { body: Uint8Array }
        >("SELECT body FROM events WHERE stream_id = ? AND type = 'job.progress.emitted' ORDER BY seq ASC")
        .all(decision.jobId);
      const bodies = rows.map((row) => JSON.parse(Buffer.from(row.body).toString('utf8')) as unknown);
      const encodedHostRef = encodeHostRef(hostRef);
      expect(bodies).toContainEqual({
        kind: 'domain',
        stage: 'provider_operation_failed',
        message:
          `Provider host ${encodedHostRef} (${hostRef.provider}/${hostRef.instanceId}) is unserviceable. ` +
          `Run coral-cli backend provider-host inspect ${encodedHostRef}, then ` +
          `coral-cli backend provider-host evict ${encodedHostRef} before retrying fresh placement.`,
        detail: {
          code: 'provider_host_unserviceable',
          hostRef,
          remediation: {
            action: 'evict-provider-host',
            command: 'coral-cli backend provider-host evict <host-ref>',
          },
        },
      });
      expect(progressStore.readTerminalProjection(decision.jobId)?.outcome.kind).toBe('failed');
      expect(execute).not.toHaveBeenCalled();
    });

    it('runs the local executor when the route explicitly authorizes local placement', async () => {
      const { provider, execute } = makeAppServerProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const activate = vi.fn(async () => ({ kind: 'local-authorized' as const, reason: 'capacity' }));
      const service = createService(ctx, {
        appServerProxyRoute: { activate },
        appServerHostAuthority: fakeAppServerHostAuthority(),
      });

      const decision = await service.start('codex', { prompt: 'hello' }, ctx);
      expect(decision.status).toBe('running');
      if (decision.status !== 'running') throw new Error('expected running launch');
      trackJob(decision.jobId);
      await waitForTerminalEvent(service, decision.jobId);

      // Local execution is safe here because this exact route decision authorized it, not merely because the
      // remote path returned without claiming execution.
      expect(activate).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(getInternals(service).progressStore.readTerminalProjection(decision.jobId)?.outcome).toEqual({
        kind: 'completed',
      });
    });

    it('cleans up an already-terminalized placement without writing a second terminal', async () => {
      const { provider, execute } = makeAppServerProvider();
      mockState.getNewProvider.mockReturnValue(provider);
      const activate = vi.fn(async (request: Parameters<AppServerProxyRoute['activate']>[0]) => {
        const store = getInternals(service).progressStore;
        const status = store.readStatus(request.jobId);
        store.commit((commit) => {
          appendJobTerminalRecorded(commit, {
            jobId: request.jobId,
            sessionId: request.sessionId,
            namespace: status?.backendNamespace,
            project: status?.projectRoot,
            terminal: {
              content: '',
              durationMs: 0,
              outcome: { kind: 'aborted', reason: 'signal_abort' },
            },
          });
          return undefined;
        });
        return { kind: 'terminalized' as const };
      });
      const service = createService(ctx, {
        appServerProxyRoute: { activate },
        appServerHostAuthority: fakeAppServerHostAuthority(),
      });

      const decision = await service.start('codex', { prompt: 'hello' }, ctx);
      expect(decision.status).toBe('running');
      if (decision.status !== 'running') throw new Error('expected running launch');
      trackJob(decision.jobId);
      await vi.waitFor(() =>
        expect(getInternals(service).progressStore.readTerminalProjection(decision.jobId)?.outcome).toEqual({
          kind: 'aborted',
          reason: 'signal_abort',
        }),
      );
      await vi.waitFor(() => expect(getInternals(service).abortRegistry.has(decision.jobId)).toBe(false));

      expect(execute).not.toHaveBeenCalled();
      expect(
        getInternals(service)
          .progressStore.readJobEvents(decision.jobId)
          .filter((event) => event.type === 'terminal'),
      ).toHaveLength(1);
    });
  });
});
