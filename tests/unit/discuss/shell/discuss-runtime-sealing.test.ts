import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '#src/discuss/events.js';
import { renderEntries } from '#src/discuss/transcript.js';
import type { AgentState, DiscussCreateInput, Result, TranscriptEntry } from '#src/discuss/session-types.js';
import { decideBid, decideSessionCreate } from '#src/discuss/state-machine.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { JobStore } from '#src/jobs/store.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  type DiscussContextRegistry,
} from '#src/discuss/shell/live-registry.js';
import type { AgentConfig, DiscussContext } from '#src/discuss/shell/types.js';
import { runPlainTurn } from '#src/discuss/shell/runtime-build.js';
import { startDiscussSession, submitManualBid } from '#src/discuss/shell/operations.js';
import { readSessionEvents } from '#src/discuss/shell/persistence.js';
import * as discussSessionRegistry from '#src/discuss/shell/registry.js';
import * as discussRecovery from '#src/discuss/shell/recovery.js';
import { createDiscussRuntime } from '#src/discuss/shell/runtime-services.js';
import { DiscussSessionStore } from '#src/discuss/shell/session-store.js';
import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { commitJobInputs, commitJobTerminal } from '#tests/helpers/job-commits.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import type { ExecutionService } from '#src/coordinator/execution-service.js';
import { createSimulationBackend, type SimulationBackend } from '#tools/simulation/core/backend.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { ScenarioHttpRequest, ScenarioHttpResponse } from '#tools/simulation/scenario-http.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { registerBuiltInProviders } from '#src/providers/bootstrap.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { createInMemoryDiscussJournal } from '#tests/helpers/discuss-journal.js';

const TOPIC = 'Should the city pedestrianize the downtown core?';
const PROJECT_ROOT = '/virtual/ac7/project';
const PLUGIN_ROOT = '/virtual/ac7/plugin';

function resolveBackendNamespace(runtime: SimulationRuntime, pluginRoot: string): string {
  const paths = runtime.paths as { pluginRootNamespace?: (root: string) => string };
  return typeof paths.pluginRootNamespace === 'function'
    ? paths.pluginRootNamespace(pluginRoot)
    : pluginRootNamespace(pluginRoot);
}
const START_TS = '2035-04-15T01:02:03.000Z';

type SimulationDiscussHarness = {
  runtime: SimulationRuntime;
  projectRoot: string;
  pluginRoot: string;
  source: string;
  store: DiscussSessionStore;
  progressStore: JobStore;
  registry: DiscussContextRegistry;
  context: DiscussContext;
  invocationCtx: InvocationContext;
  service: ExecutionService;
};

type PersistedRecoveryHarness = {
  runtime: SimulationRuntime;
  projectRoot: string;
  pluginRoot: string;
  progressStore: JobStore;
  registry: DiscussContextRegistry;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  services: ReturnType<typeof createDiscussRuntime>;
};

const activeStores: DiscussSessionStore[] = [];
const activeBackends: SimulationBackend[] = [];
const originalTz = process.env.TZ;

afterEach(async () => {
  for (const store of activeStores.splice(0)) {
    store.dispose();
  }
  while (activeBackends.length > 0) {
    const world = activeBackends.pop();
    if (!world) {
      continue;
    }
    await world.backend.shutdown('test-teardown');
    await world.backend.waitForShutdown();
  }
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error);
}

function createExecutionServiceStub(overrides: Partial<ExecutionService> = {}): ExecutionService {
  return {
    start: vi.fn(),
    resume: vi.fn(),
    coralDispatch: vi.fn(),
    executeWorkflow: vi.fn(),
    list: vi.fn(() => ({ sessions: [] })),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(),
    ...overrides,
  } as unknown as ExecutionService;
}

function manualAgents(): AgentConfig[] {
  return [
    { name: 'bot', persona: '# Bot', provider: 'codex' },
    { name: 'alpha', persona: '# Alpha', participation: 'observer' },
  ];
}

function manualInputAgents(): DiscussCreateInput['agents'] {
  return manualAgents().map((agent) => ({
    name: agent.name,
    persona: agent.persona,
    participation: agent.participation ?? 'required',
  }));
}

function createHarness(options: { epochMs?: number; projectRoot?: string } = {}): SimulationDiscussHarness {
  const runtime = new SimulationRuntime({ epochMs: options.epochMs ?? Date.parse(START_TS) });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const pluginRoot = PLUGIN_ROOT;
  runtime.storage.mkdirSync(projectRoot, { recursive: true });
  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  const source = runtime.paths.projectSource(projectRoot);
  const progressStore = new JobStore(resolveBackendNamespace(runtime, pluginRoot), runtime, createEventBodyCodec(), {
    db: openTestStoreDb(runtime, ':memory:'),
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
  const store = new DiscussSessionStore(source, {
    journal: createInMemoryDiscussJournal(),
  });
  activeStores.push(store);
  const service = createExecutionServiceStub();
  const registry = createDiscussContextRegistry();
  const providerRegistry = new ProviderRegistry();
  registerBuiltInProviders(providerRegistry);
  const canonicalProjectRoot = fixtureCanonicalWorkDir(projectRoot);
  const context = getOrCreateDiscussContext(registry, canonicalProjectRoot, service, store, {
    runtime: {
      ids: runtime.ids,
      env: runtime.env,
      time: runtime.time,
      storage: runtime.storage,
      projectData: (projectRoot: string) => runtime.paths.projectData(projectRoot),
    },
    jobStatusReader: {
      read: (jobId) => progressStore.readStatus(jobId),
      readExit: () => null,
      listOwned: (discussionId) =>
        progressStore
          .listJobProjections()
          .filter(({ status }) => status.owner.kind === 'discussion' && status.owner.id === discussionId)
          .flatMap(({ jobId, status }) => {
            const launch = progressStore.loadJobProjectionDetail(jobId).launch;
            return launch === null ? [] : [{ launch, status }];
          }),
    },
    providerRegistry,
  });
  const invocationCtx: InvocationContext = {
    projectRoot: canonicalProjectRoot,
    pluginRoot,
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
    providerScope: TEST_PROVIDER_SCOPE,
  };
  return { runtime, projectRoot, pluginRoot, source, store, progressStore, registry, context, invocationCtx, service };
}

function createPersistedRecoveryHarness(): PersistedRecoveryHarness {
  const runtime = new SimulationRuntime({ epochMs: Date.parse(START_TS) });
  const projectRoot = PROJECT_ROOT;
  const pluginRoot = PLUGIN_ROOT;
  runtime.storage.mkdirSync(projectRoot, { recursive: true });
  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  const providerRegistry = new ProviderRegistry();
  registerBuiltInProviders(providerRegistry);
  const registry = createDiscussContextRegistry();
  const progressStore = new JobStore(resolveBackendNamespace(runtime, pluginRoot), runtime, createEventBodyCodec(), {
    db: openTestStoreDb(runtime, ':memory:'),
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
  const service = createExecutionServiceStub();
  const services = createDiscussRuntime({
    world: {
      identity: { pluginRoot },
      discussRegistry: registry,
      resolveProjectSource: (root) => runtime.paths.projectSource(root),
      providerRegistry,
      eventBus: { emit: vi.fn(() => true) },
    },
    runtime,
    getProgressStore: () => progressStore,
    getExecutionService: () => service,
  });
  const createInvocationContext = (root: string): InvocationContext => ({
    projectRoot: fixtureCanonicalWorkDir(root),
    pluginRoot,
    coralEnv: {},
    principal: testProjectPrincipal(root),
    providerScope: TEST_PROVIDER_SCOPE,
  });
  return { runtime, projectRoot, pluginRoot, progressStore, registry, createInvocationContext, services };
}

function seedPersistedRecoveryDiscussion(harness: PersistedRecoveryHarness, sessionId: string): void {
  const events = unwrap(
    decideSessionCreate(
      {
        topic: TOPIC,
        min_bid_delay_ms: 0,
        agents: manualInputAgents(),
      },
      { sessionId, projectRoot: harness.projectRoot, topic: TOPIC },
      1,
      START_TS,
      {
        providerScope: TEST_PROVIDER_SCOPE,
        agentExecution: {
          bot: { manual: false, provider: 'codex', model: 'gpt-5' },
          alpha: { manual: true },
        },
      },
    ),
  );
  commitJobInputs(
    harness.progressStore,
    events.map((event) => toJournalInput(event)),
  );
}

async function runPersistedDiscussionRecovery(harness: PersistedRecoveryHarness): Promise<void> {
  await discussRecovery.runStartup({
    getDiscussContext: harness.services.getDiscussContext,
    createInvocationContext: harness.createInvocationContext,
    signal: new AbortController().signal,
  });
}

async function appendCreatedSession(
  harness: Pick<SimulationDiscussHarness, 'store' | 'projectRoot'>,
  sessionId: string,
  ts = START_TS,
): Promise<PersistedDiscussSnapshot> {
  const input: DiscussCreateInput = {
    topic: TOPIC,
    min_bid_delay_ms: 0,
    agents: manualInputAgents(),
  };
  return harness.store.append(
    sessionId,
    null,
    unwrap(
      decideSessionCreate(input, { sessionId: sessionId, projectRoot: harness.projectRoot, topic: TOPIC }, 1, ts, {
        providerScope: TEST_PROVIDER_SCOPE,
        agentExecution: {
          bot: { manual: false, provider: 'codex', model: 'gpt-5' },
          alpha: { manual: true },
        },
      }),
    ),
  );
}

async function invokeBackend(
  world: SimulationBackend,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const req = new ScenarioHttpRequest(method, path, token, body);
  const res = new ScenarioHttpResponse();
  const completion = Promise.resolve(world.handleRequest(req as never, res as never));
  req.start();
  await completion;
  return {
    statusCode: res.statusCode,
    body: res.body,
  };
}

describe('runtime-sealed discuss behavior', () => {
  it('createSimulationBackend can list and recover persisted discuss state that exists only in runtime storage', async () => {
    const world = createSimulationBackend({
      recoverPersistedDiscuss: 'default',
      projectRoot: process.cwd(),
      pluginRoot: process.cwd(),
    });
    activeBackends.push(world);
    const createdEvents = unwrap(
      decideSessionCreate(
        {
          topic: TOPIC,
          min_bid_delay_ms: 0,
          agents: manualInputAgents(),
        },
        { sessionId: 'backend-recovered-discuss', projectRoot: world.projectRoot, topic: TOPIC },
        1,
        '2035-04-15T01:02:03.000Z',
        { providerScope: { origin: 'caller', profiles: [] } },
      ),
    );
    const created = commitJobInputs(
      world.progressStore,
      createdEvents.map((event) => toJournalInput(event)),
    );
    expect(created).toHaveLength(createdEvents.length);
    const createdSnapshot = world.progressStore
      .getDb()
      .prepare(`SELECT state FROM projection_discuss WHERE discuss_id = ?`)
      .get('backend-recovered-discuss') as { state: string } | undefined;
    if (!createdSnapshot) {
      throw new Error('Missing seeded discuss projection');
    }
    const seeded = JSON.parse(createdSnapshot.state) as PersistedDiscussSnapshot;
    const bid = unwrap(
      decideBid(
        seeded.state,
        'alpha',
        91,
        'Recovery should close this in virtual time.',
        { sessionId: 'backend-recovered-discuss', projectRoot: world.projectRoot, topic: TOPIC },
        seeded.lastAppliedSeq + 1,
        '2035-04-15T01:02:04.000Z',
      ),
    );
    commitJobInputs(
      world.progressStore,
      bid.map((event) => toJournalInput(event)),
    );

    const info = await world.backend.start();
    expect(world.hooks.recoverPersistedDiscussCalls).toBe(1);
    await world.advance(1);

    const response = await invokeBackend(world, info.token, 'GET', '/discuss/sessions');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      sessions: [
        expect.objectContaining({
          sessionId: 'backend-recovered-discuss',
          projectRoot: world.projectRoot,
          topic: TOPIC,
          authority: 'live',
        }),
      ],
    });
  });

  it('contains a malformed raw discussion candidate while a valid sibling attaches and resumes', async () => {
    const resumeLoop = vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createPersistedRecoveryHarness();
    seedPersistedRecoveryDiscussion(harness, 'valid-candidate-sibling');
    seedPersistedRecoveryDiscussion(harness, 'malformed-candidate-sibling');
    const db = harness.progressStore.getDb();
    const malformedEvent = db
      .prepare(
        `SELECT seq
           FROM events
          WHERE stream_kind = 'discuss' AND stream_id = ?
          ORDER BY seq ASC
          LIMIT 1`,
      )
      .get('malformed-candidate-sibling') as { seq: number } | undefined;
    if (malformedEvent === undefined) throw new Error('Missing discussion event to corrupt');
    db.prepare(`UPDATE events SET body = ? WHERE seq = ?`).run(Buffer.from('{not-json'), malformedEvent.seq);

    await runPersistedDiscussionRecovery(harness);

    expect(resumeLoop).toHaveBeenCalledTimes(1);
    expect(resumeLoop.mock.calls[0]?.[1]).toBe('valid-candidate-sibling');
    const context = harness.services.getDiscussContext(harness.createInvocationContext(harness.projectRoot));
    expect(discussSessionRegistry.getSession(context, 'valid-candidate-sibling')).toBeDefined();
    expect(discussSessionRegistry.getSession(context, 'malformed-candidate-sibling')).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT boundary_id, subject_key, state, stage
             FROM recovery_quarantine
            WHERE boundary_id = 'discussion-candidate' AND subject_key = ?`,
        )
        .get('malformed-candidate-sibling'),
    ).toEqual({
      boundary_id: 'discussion-candidate',
      subject_key: 'malformed-candidate-sibling',
      state: 'active',
      stage: 'hydrate',
    });
  });

  it('keeps a candidate retryable when settlement fails after continuation persistence and before attach', async () => {
    const attachSession = vi.spyOn(discussSessionRegistry, 'attachSession');
    const resumeLoop = vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createPersistedRecoveryHarness();
    seedPersistedRecoveryDiscussion(harness, 'pre-attach-failure');
    const signal = new AbortController().signal;

    await discussRecovery.runStartup({
      getDiscussContext: harness.services.getDiscussContext,
      createInvocationContext: () => {
        throw new Error('context resolution failed');
      },
      signal,
    });

    expect(attachSession).not.toHaveBeenCalled();
    expect(resumeLoop).not.toHaveBeenCalled();
    expect(
      harness.progressStore
        .getDb()
        .prepare(
          `SELECT state, continuation_kind
             FROM recovery_quarantine
            WHERE boundary_id = 'discussion-candidate' AND subject_key = 'pre-attach-failure'`,
        )
        .get(),
    ).toEqual({ state: 'continuation', continuation_kind: 'discussion-resume.v1' });

    await runPersistedDiscussionRecovery(harness);

    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(resumeLoop).toHaveBeenCalledTimes(1);
  });

  it('recovers an active discuss executor job from runtime storage only', async () => {
    const harness = createHarness();
    const created = await appendCreatedSession(harness, 'executor-recovery');
    commitJobInputs(
      harness.progressStore,
      readSessionEvents(harness.context, 'executor-recovery').map((event) => toJournalInput(event)),
    );
    const jobId = 'runtime-only-job-ac7';
    const activeEvents: DiscussDomainEvent[] = [
      makeEvent(
        'executor-recovery',
        harness.projectRoot,
        TOPIC,
        created.lastAppliedSeq + 1,
        'agent.job.started',
        '2035-04-15T01:02:04.000Z',
        {
          agent: 'bot',
          jobId,
          purpose: 'bid',
          attempt: 1,
        },
      ),
    ];
    await harness.store.append('executor-recovery', created.lastAppliedSeq, activeEvents);
    seedTestJobSession(harness.progressStore, {
      jobId,
      sessionId: 'execution-session-1',
      provider: 'codex',
      projectRoot: harness.projectRoot,
      backendNamespace: 'runtime-only',
      initialPhase: 'running',
    });
    harness.progressStore.appendLaunchRequested(jobId, {
      jobId,
      owner: { kind: 'discussion', id: 'executor-recovery' },
      discussionRun: { agent: 'bot', purpose: 'bid', attempt: 1 },
      sessionId: 'execution-session-1',
      provider: 'codex',
      projectRoot: harness.projectRoot,
      backendNamespace: 'runtime-only',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: {
        prompt: 'Recover the active job.',
        cwd: harness.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: '2035-04-15T01:02:05.000Z',
    });
    commitJobTerminal(harness.progressStore, jobId, 'execution-session-1', {
      content: 'Recovered content from runtime storage',
      durationMs: 1_000,
      outcome: { kind: 'completed' },
    });
    expect(harness.progressStore.readStatus(jobId)).toMatchObject({
      owner: { kind: 'discussion', id: 'executor-recovery' },
      phase: 'completed',
      result: { content: 'Recovered content from runtime storage' },
    });
    vi.mocked(harness.service.waitStreamOnce).mockResolvedValueOnce({
      content: 'Recovered content from runtime storage',
      continuity: null,
    });

    const result = await runPlainTurn(harness.context, {
      agentName: 'bot',
      sessionId: 'executor-recovery',
      provider: 'codex',
      model: 'gpt-5',
      prompt: 'Recover the active job.',
      instruction: 'Use recovered output.',
      cwd: fixtureCanonicalWorkDir(harness.projectRoot),
      invocationCtx: harness.invocationCtx,
      purpose: 'bid',
    });

    expect(result).toEqual({ content: 'Recovered content from runtime storage', continuity: null });
    expect(harness.service.start).not.toHaveBeenCalled();
  });

  it('uses virtual runtime time for deterministic discuss event timestamps', async () => {
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const epochMs = Date.parse('2044-05-06T07:08:09.000Z');
    const harness = createHarness({ epochMs });
    vi.mocked(harness.service.start).mockResolvedValueOnce({
      kind: 'provider-session',
      status: 'running',
      jobId: 'job-bot-bid',
      sessionId: 'exec-bot',
    });
    vi.mocked(harness.service.waitStreamOnce).mockResolvedValueOnce({
      content: '{"score": 12, "thought": "Let the manual observer lead."}',
      continuity: null,
    });

    await startDiscussSession(
      harness.context,
      'virtual-time-session',
      TOPIC,
      manualAgents(),
      {},
      harness.invocationCtx,
    );
    harness.runtime.time.tick(1_234);
    await submitManualBid(
      harness.context,
      'virtual-time-session',
      'alpha',
      77,
      'This bid timestamp comes from virtual time.',
      harness.invocationCtx,
    );

    const events = readSessionEvents(harness.context, 'virtual-time-session');
    expect(events[0]?.ts).toBe('2044-05-06T07:08:09.000Z');
    expect(events.find((event) => event.kind === 'bid.submitted' && event.payload.agent === 'alpha')?.ts).toBe(
      '2044-05-06T07:08:10.234Z',
    );
  });

  it('renders persisted transcript timestamps in stable UTC under varied TZ settings', () => {
    const agents: Record<string, AgentState> = {
      alpha: {
        persona: '# Alpha',
        display_name: 'Alpha',
        participation: 'required',
        quota_remaining: 3,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
    };
    const entries: TranscriptEntry[] = [
      {
        type: 'speech',
        step: 1,
        epoch: 1,
        ts: '2035-04-15T23:05:06.000Z',
        agent: 'alpha',
        display_name: 'Alpha',
        content: 'A fixed persisted timestamp should render the same in every host timezone.',
      },
    ];

    process.env.TZ = 'Pacific/Kiritimati';
    const kiribati = renderEntries(entries, agents);
    process.env.TZ = 'America/Los_Angeles';
    const losAngeles = renderEntries(entries, agents);
    process.env.TZ = 'Asia/Seoul';
    const seoul = renderEntries(entries, agents);

    expect(kiribati).toBe(losAngeles);
    expect(losAngeles).toBe(seoul);
    expect(seoul).toContain('### [23:05:06] Alpha (alpha)');
  });
});
import { seedTestJobSession } from '#tests/helpers/session.js';
