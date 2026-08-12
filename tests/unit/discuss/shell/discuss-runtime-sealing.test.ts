import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '#src/discuss/events.js';
import { renderEntries } from '#src/discuss/transcript.js';
import type { AgentState, DiscussCreateInput, Result, TranscriptEntry } from '#src/discuss/session-types.js';
import { decideBid, decideBidRoundClose, decideSessionCreate } from '#src/discuss/state-machine.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { JobStore } from '#src/jobs/store.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { nowIsoString } from '#src/infra/time.js';
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
import { knownDiscussSources } from '#src/discuss/shell/session-read-service.js';
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
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';

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
    await world.backend.shutdown('test-cleanup');
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
  it('starts, appends, loads, lists, replays watch history, and reads events through SimulationRuntime storage', async () => {
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createHarness();
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

    const session = await startDiscussSession(
      harness.context,
      'sim-discuss-1',
      TOPIC,
      manualAgents(),
      {},
      harness.invocationCtx,
    );
    expect(session.snapshot.sessionId).toBe('sim-discuss-1');

    const submittedAt = nowIsoString(harness.runtime.time);
    await submitManualBid(
      harness.context,
      'sim-discuss-1',
      'alpha',
      88,
      'Open the walkable core first.',
      harness.invocationCtx,
    );
    const afterBid = harness.store.load('sim-discuss-1');
    expect(afterBid).not.toBeNull();

    const closed = unwrap(
      decideBidRoundClose(
        afterBid!.state,
        { sessionId: 'sim-discuss-1', projectRoot: harness.projectRoot, topic: TOPIC },
        afterBid!.lastAppliedSeq + 1,
        '2035-04-15T01:02:04.000Z',
      ),
    );
    const finalSnapshot = await harness.store.append('sim-discuss-1', afterBid!.lastAppliedSeq, closed);

    expect(harness.store.load('sim-discuss-1')).toMatchObject({
      sessionId: 'sim-discuss-1',
      lastAppliedSeq: finalSnapshot.lastAppliedSeq,
    });
    expect(harness.store.listSummaries()).toEqual([
      expect.objectContaining({
        sessionId: 'sim-discuss-1',
        projectRoot: harness.projectRoot,
        topic: TOPIC,
        authority: 'persisted',
      }),
    ]);
    expect(harness.store.listRecoveryCandidates()).toEqual([
      expect.objectContaining({
        sessionId: 'sim-discuss-1',
      }),
    ]);

    discussSessionRegistry.detachSession(harness.context, 'sim-discuss-1');
    expect(discussSessionRegistry.getWatchState(harness.context, 'sim-discuss-1')).toMatchObject({
      session: 'sim-discuss-1',
      cursor: 1,
      events: [
        {
          type: 'bid_resolved',
          data: { winner: 'alpha', speaker_type: 'quota' },
          ts: Date.parse('2035-04-15T01:02:04.000Z'),
        },
      ],
    });

    const events = readSessionEvents(harness.context, 'sim-discuss-1');
    expect(events.map((event) => event.kind)).toEqual([
      'session.created',
      'bidding.opened',
      'agent.run.bound',
      'agent.job.started',
      'agent.job.finished',
      'bid.submitted',
      'bid.submitted',
      'bid.round.closed',
    ]);
    expect(events.find((event) => event.kind === 'bid.submitted' && event.payload.agent === 'alpha')?.ts).toBe(
      submittedAt,
    );
  });

  it('replays invalid persisted watch timestamps deterministically without host Date.now', async () => {
    const harness = createHarness();
    const created = await appendCreatedSession(harness, 'invalid-watch-ts');
    await harness.store.append('invalid-watch-ts', created.lastAppliedSeq, [
      makeEvent(
        'invalid-watch-ts',
        harness.projectRoot,
        TOPIC,
        created.lastAppliedSeq + 1,
        'bid.round.closed',
        'not-an-iso-timestamp',
        {
          allBids: { alpha: 88 },
          effectiveBids: { alpha: 88 },
          thoughts: { alpha: 'deterministic' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        },
      ),
    ]);

    vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999);
    const first = discussSessionRegistry.getWatchState(harness.context, 'invalid-watch-ts');
    vi.mocked(Date.now).mockReturnValue(1);
    const second = discussSessionRegistry.getWatchState(harness.context, 'invalid-watch-ts');

    expect(first.events).toEqual(second.events);
    expect(first.events).toEqual([
      {
        type: 'bid_resolved',
        data: { winner: 'alpha', speaker_type: 'quota' },
        ts: 0,
      },
    ]);
  });

  it('discovers persisted sources from the Journal source list', () => {
    const harness = createHarness();
    const source = 'runtime/source';

    const sources = knownDiscussSources({
      discussRegistry: harness.registry,
      getDiscussStoreForSource: () => {
        throw new Error('store lookup is not needed for source discovery');
      },
      resolveProjectSource: harness.runtime.paths.projectSource.bind(harness.runtime.paths),
      readDiscussSources: () => [source, source],
    });

    expect([...sources]).toEqual([source]);
    expect(harness.runtime.observer.events).toEqual([]);
  });

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

  it('contains a malformed raw discussion source while a valid sibling attaches and resumes', async () => {
    const resumeLoop = vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createPersistedRecoveryHarness();
    seedPersistedRecoveryDiscussion(harness, 'valid-recovery-sibling');
    harness.progressStore
      .getDb()
      .prepare(`INSERT INTO projection_discuss (discuss_id, state, last_seq) VALUES (?, ?, ?)`)
      .run('malformed-recovery-sibling', '{not-json', 999);

    await runPersistedDiscussionRecovery(harness);

    expect(resumeLoop).toHaveBeenCalledTimes(1);
    expect(resumeLoop.mock.calls[0]?.[1]).toBe('valid-recovery-sibling');
    const context = harness.services.getDiscussContext(harness.createInvocationContext(harness.projectRoot));
    expect(discussSessionRegistry.getSession(context, 'valid-recovery-sibling')).toBeDefined();
    expect(
      harness.progressStore
        .getDb()
        .prepare(
          `SELECT boundary_id, subject_key, state, stage
             FROM recovery_quarantine
            WHERE boundary_id = 'discussion-source' AND subject_key = ?`,
        )
        .get('malformed-recovery-sibling'),
    ).toEqual({
      boundary_id: 'discussion-source',
      subject_key: 'malformed-recovery-sibling',
      state: 'active',
      stage: 'hydrate',
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

  it('quarantines a candidate when its initial resume continuation cannot be persisted', async () => {
    const attachSession = vi.spyOn(discussSessionRegistry, 'attachSession');
    const resumeLoop = vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createPersistedRecoveryHarness();
    seedPersistedRecoveryDiscussion(harness, 'continuation-write-failure');
    const originalUpsert = RecoveryQuarantineStore.prototype.upsert;
    let failedInitialWrite = false;
    vi.spyOn(RecoveryQuarantineStore.prototype, 'upsert').mockImplementation(function failInitialContinuation(
      this: RecoveryQuarantineStore,
      write,
    ) {
      if (!failedInitialWrite && write.boundary === 'discussion-candidate' && write.state === 'continuation') {
        failedInitialWrite = true;
        throw new Error('initial continuation write failed');
      }
      return originalUpsert.call(this, write);
    });

    await runPersistedDiscussionRecovery(harness);

    expect(attachSession).not.toHaveBeenCalled();
    expect(resumeLoop).not.toHaveBeenCalled();
    expect(
      harness.progressStore
        .getDb()
        .prepare(
          `SELECT state, stage
             FROM recovery_quarantine
            WHERE boundary_id = 'discussion-candidate' AND subject_key = 'continuation-write-failure'`,
        )
        .get(),
    ).toEqual({ state: 'active', stage: 'settle' });
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

  it('checkpoints idempotent attach cleanup when resume decision construction fails', async () => {
    const attachSession = vi.spyOn(discussSessionRegistry, 'attachSession');
    const detachSession = vi.spyOn(discussSessionRegistry, 'detachSession');
    const resumeLoop = vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createPersistedRecoveryHarness();
    seedPersistedRecoveryDiscussion(harness, 'resume-decision-failure');
    let invocationCount = 0;

    await discussRecovery.runStartup({
      getDiscussContext: harness.services.getDiscussContext,
      createInvocationContext: (projectRoot) => {
        invocationCount += 1;
        if (invocationCount === 2) throw new Error('resume invocation construction failed');
        return harness.createInvocationContext(projectRoot);
      },
      signal: new AbortController().signal,
    });

    const continuation = harness.progressStore
      .getDb()
      .prepare(
        `SELECT continuation_key
           FROM recovery_quarantine
          WHERE boundary_id = 'discussion-candidate' AND subject_key = 'resume-decision-failure'`,
      )
      .get() as { continuation_key: string } | undefined;
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(detachSession).toHaveBeenCalledTimes(1);
    expect(resumeLoop).not.toHaveBeenCalled();
    expect(JSON.parse(continuation?.continuation_key ?? '{}').completedObligationIds).toEqual([
      'discussion.owned-job-reconciliation',
      'discussion.attach',
      'discussion.attach-cleanup',
    ]);

    await runPersistedDiscussionRecovery(harness);

    expect(attachSession).toHaveBeenCalledTimes(2);
    expect(detachSession).toHaveBeenCalledTimes(1);
    expect(resumeLoop).toHaveBeenCalledTimes(1);
  });

  it('retries a synchronous resume failure without duplicating completed attach or resume obligations', async () => {
    const attachSession = vi.spyOn(discussSessionRegistry, 'attachSession');
    const resumeLoop = vi
      .spyOn(discussLoop, 'resumeLoop')
      .mockImplementationOnce(() => {
        throw new Error('synchronous resume scheduling failed');
      })
      .mockImplementation(() => {});
    const harness = createPersistedRecoveryHarness();
    seedPersistedRecoveryDiscussion(harness, 'retryable-resume');
    const db = harness.progressStore.getDb();
    const readContinuation = () =>
      db
        .prepare(
          `SELECT state, continuation_kind, continuation_key
             FROM recovery_quarantine
            WHERE boundary_id = 'discussion-candidate' AND subject_key = 'retryable-resume'`,
        )
        .get() as
        | {
            state: string;
            continuation_kind: string | null;
            continuation_key: string | null;
          }
        | undefined;

    await runPersistedDiscussionRecovery(harness);

    expect(readContinuation()).toMatchObject({
      state: 'continuation',
      continuation_kind: 'discussion-resume.v1',
    });
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(resumeLoop).toHaveBeenCalledTimes(1);

    const originalDelete = RecoveryQuarantineStore.prototype.delete;
    let candidateDeleteCount = 0;
    vi.spyOn(RecoveryQuarantineStore.prototype, 'delete').mockImplementation(function deleteWithLostCheckpoint(
      this: RecoveryQuarantineStore,
      request,
    ) {
      if (request.boundary === 'discussion-candidate') {
        candidateDeleteCount += 1;
        if (candidateDeleteCount === 2) {
          throw new Error('continuation clear checkpoint failed');
        }
      }
      return originalDelete.call(this, request);
    });

    await runPersistedDiscussionRecovery(harness);

    const afterCompletedResume = readContinuation();
    expect(afterCompletedResume).toMatchObject({
      state: 'continuation',
      continuation_kind: 'discussion-resume.v1',
    });
    expect(JSON.parse(afterCompletedResume?.continuation_key ?? '{}').completedObligationIds).toEqual([
      'discussion.owned-job-reconciliation',
      'discussion.attach',
      'discussion.resume',
      'discussion.attach-cleanup',
    ]);
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(resumeLoop).toHaveBeenCalledTimes(2);

    await runPersistedDiscussionRecovery(harness);

    expect(readContinuation()).toBeUndefined();
    expect(attachSession).toHaveBeenCalledTimes(1);
    expect(resumeLoop).toHaveBeenCalledTimes(2);
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

describe('discuss shell import audits', () => {
  const sourceRoot = resolve(process.cwd(), 'src/discuss/shell');

  function readSource(relativePath: string): string {
    return readFileSync(resolve(sourceRoot, relativePath), 'utf-8');
  }

  function expectNoNativeTimers(source: string): void {
    expect(source).not.toMatch(/(?<!\.)\bsetTimeout\s*\(/u);
    expect(source).not.toMatch(/(?<!\.)\bclearTimeout\s*\(/u);
  }

  it('keeps session-store.ts free of node:fs and native timers', () => {
    const source = readSource('session-store.ts');
    expect(source).not.toMatch(/node:fs/u);
    expectNoNativeTimers(source);
  });

  it('keeps session-read-service.ts free of direct client source-registry readers', () => {
    const source = readSource('session-read-service.ts');
    expect(source).not.toMatch(/client\/readers/u);
    expect(source).not.toMatch(/(?<!\.)\breadDiscussSources(?:WithStorage)?\s*\(/u);
  });

  it('keeps runtime-build.ts free of direct client job-status readers', () => {
    const source = readSource('runtime-build.ts');
    expect(source).not.toMatch(/client\/readers/u);
    expect(source).not.toMatch(/\breadStatusRecord\b/u);
  });

  it('keeps tools.ts free of node:crypto', () => {
    expect(readSource('tools.ts')).not.toMatch(/node:crypto/u);
  });

  it('keeps operations.ts free of direct process.env', () => {
    expect(readSource('operations.ts')).not.toMatch(/process\.env/u);
  });

  it('keeps loop.ts free of native timers', () => {
    expectNoNativeTimers(readSource('loop.ts'));
  });
});
import { seedTestJobSession } from '#tests/helpers/session.js';
