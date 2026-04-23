import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readStatusRecord } from '../../../testing/persistence-readers.js';
import { readDiscussSourcesWithStorage } from '../discuss-sources-catalog.js';
import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '../../events.js';
import { renderEntries } from '../../transcript.js';
import type { AgentState, DiscussCreateInput, Result, TranscriptEntry } from '../../session-types.js';
import { decideBid, decideBidRoundClose, decideSessionCreate } from '../../state-machine.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import { parseJobStatus, type JobStatus } from '../../../jobs/records.js';
import { nowIsoString } from '../../../infra/time.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  type DiscussContextRegistry,
} from '../live-registry.js';
import type { AgentConfig, DiscussContext } from '../context.js';
import { runPlainTurn } from '../runtime-build.js';
import { getWatchState, startDiscussSession, submitManualBid } from '../operations.js';
import { readSessionEvents } from '../persistence.js';
import { detachSession } from '../registry.js';
import { knownDiscussSources } from '../session-read-service.js';
import { DiscussSessionStore } from '../session-store.js';
import * as discussLoop from '../loop.js';
import type { ExecutionService } from '../../../coordinator/execution-service.js';
import { SimulationRuntime, createSimulationBackend, type SimulationBackend } from '../../../../tools/simulation/core/backend.js';
import { ScenarioHttpRequest, ScenarioHttpResponse } from '../../../../tools/simulation/scenario-http.js';

const TOPIC = 'Should the city pedestrianize the downtown core?';
const PROJECT_ROOT = '/virtual/ac7/project';
const PLUGIN_ROOT = '/virtual/ac7/plugin';
const START_TS = '2035-04-15T01:02:03.000Z';

type SimulationDiscussHarness = {
  runtime: SimulationRuntime;
  projectRoot: string;
  pluginRoot: string;
  source: string;
  store: DiscussSessionStore;
  registry: DiscussContextRegistry;
  context: DiscussContext;
  invocationCtx: InvocationContext;
  service: ExecutionService;
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
    fork: vi.fn(),
    coralDispatch: vi.fn(),
    executeWorkflow: vi.fn(),
    list: vi.fn(() => ({ sessions: [] })),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(),
    ...overrides,
  } as unknown as ExecutionService;
}

function readStatusRecordForRuntime(
  runtime: Pick<SimulationRuntime, 'storage' | 'paths'>,
  jobId: string,
): JobStatus | null {
  try {
    return parseJobStatus(
      JSON.parse(runtime.storage.readFileSync(resolve(runtime.paths.jobsDir(), jobId, 'status.json'), 'utf-8')),
    );
  } catch {
    return null;
  }
}

function manualAgents(): AgentConfig[] {
  return [{ name: 'alpha', persona: '# Alpha', participation: 'observer' }];
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
  const store = new DiscussSessionStore(source, {
    storage: runtime.storage,
    time: runtime.time,
    paths: runtime.paths,
  });
  activeStores.push(store);
  const service = createExecutionServiceStub();
  const registry = createDiscussContextRegistry();
  const context = getOrCreateDiscussContext(registry, projectRoot, service, store, {
    runtime: {
      ids: runtime.ids,
      env: runtime.env,
      time: runtime.time,
    },
    jobStatusReader: {
      read: (jobId) => readStatusRecordForRuntime(runtime, jobId),
    },
  });
  const invocationCtx: InvocationContext = { projectRoot, pluginRoot, coralEnv: {} };
  return { runtime, projectRoot, pluginRoot, source, store, registry, context, invocationCtx, service };
}

function writeJson(runtime: SimulationRuntime, filePath: string, value: unknown): void {
  runtime.storage.mkdirSync(dirname(filePath), { recursive: true });
  runtime.storage.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf-8' });
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
    unwrap(decideSessionCreate(input, { sessionId: sessionId, projectRoot: harness.projectRoot, topic: TOPIC }, 1, ts)),
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

describe('AC7 runtime-sealed discuss behavior', () => {
  it('starts, appends, loads, lists, replays watch history, and reads events through SimulationRuntime storage', async () => {
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const harness = createHarness();

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
    harness.store.flushDirtyIndexes();

    const sessionDir = harness.store.resolveSessionDir('sim-discuss-1');
    expect(harness.runtime.storage.existsSync(harness.runtime.paths.discussStatePath(sessionDir))).toBe(true);
    expect(existsSync(harness.runtime.paths.discussStatePath(sessionDir))).toBe(false);
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
        sessionDir,
      }),
    ]);

    detachSession(harness.context, 'sim-discuss-1');
    expect(getWatchState(harness.context, 'sim-discuss-1')).toMatchObject({
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
      'bid.submitted',
      'bid.round.closed',
    ]);
    expect(events.find((event) => event.kind === 'bid.submitted')?.ts).toBe(submittedAt);
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
    harness.store.flushDirtyIndexes();

    vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999);
    const first = getWatchState(harness.context, 'invalid-watch-ts');
    vi.mocked(Date.now).mockReturnValue(1);
    const second = getWatchState(harness.context, 'invalid-watch-ts');

    expect(first.events).toEqual(second.events);
    expect(first.events).toEqual([
      {
        type: 'bid_resolved',
        data: { winner: 'alpha', speaker_type: 'quota' },
        ts: 0,
      },
    ]);
  });

  it('discovers legacy projectRoots through the injected runtime projectSource resolver', () => {
    const harness = createHarness();
    const legacyProjectRoot = '/legacy/checkout-only-in-runtime';
    const projectSource = vi.fn((root: string) => `runtime-resolved:${root}`);
    (harness.runtime.paths as unknown as { projectSource: (root: string) => string }).projectSource = projectSource;
    writeJson(harness.runtime, harness.runtime.paths.discussSourcesPath(), {
      updatedAt: START_TS,
      projectRoots: [legacyProjectRoot],
    });

    const sources = knownDiscussSources({
      discussRegistry: harness.registry,
      getDiscussStoreForSource: () => {
        throw new Error('store lookup is not needed for source discovery');
      },
      resolveProjectSource: harness.runtime.paths.projectSource.bind(harness.runtime.paths),
      readDiscussSources: () => readDiscussSourcesWithStorage(harness.runtime.storage, harness.runtime.paths),
    });

    expect([...sources]).toEqual([`runtime-resolved:${legacyProjectRoot}`]);
    expect(projectSource).toHaveBeenCalledWith(legacyProjectRoot);
    expect(harness.runtime.observer.events).toEqual([]);
  });

  it('createSimulationBackend can list and recover persisted discuss state that exists only in runtime storage', async () => {
    const world = createSimulationBackend({
      recoverPersistedDiscuss: 'default',
      projectRoot: '/virtual/backend/project',
      pluginRoot: '/virtual/backend/plugin',
    });
    activeBackends.push(world);
    const source = world.runtime.paths.projectSource(world.projectRoot);
    const seedStore = new DiscussSessionStore(source, {
      storage: world.runtime.storage,
      time: world.runtime.time,
      paths: world.runtime.paths,
    });
    activeStores.push(seedStore);
    const created = await appendCreatedSession(
      { store: seedStore, projectRoot: world.projectRoot },
      'backend-recovered-discuss',
    );
    const bid = unwrap(
      decideBid(
        created.state,
        'alpha',
        91,
        'Recovery should close this in virtual time.',
        { sessionId: 'backend-recovered-discuss', projectRoot: world.projectRoot, topic: TOPIC },
        created.lastAppliedSeq + 1,
        '2035-04-15T01:02:04.000Z',
      ),
    );
    await seedStore.append('backend-recovered-discuss', created.lastAppliedSeq, bid);
    seedStore.flushDirtyIndexes();
    const sessionDir = seedStore.resolveSessionDir('backend-recovered-discuss');
    expect(existsSync(world.runtime.paths.discussStatePath(sessionDir))).toBe(false);

    const info = await world.backend.start();
    expect(world.hooks.recoverPersistedDiscussCalls).toBe(1);
    await world.advance(1);

    expect(seedStore.load('backend-recovered-discuss')?.state.status).toBe('speaking');
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

  it('recovers an active discuss executor job from runtime storage only', async () => {
    const harness = createHarness();
    const created = await appendCreatedSession(harness, 'executor-recovery');
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
          agent: 'alpha',
          jobId,
          purpose: 'bid',
          attempt: 1,
        },
      ),
    ];
    await harness.store.append('executor-recovery', created.lastAppliedSeq, activeEvents);
    const status: JobStatus = {
      jobId,
      sessionId: 'execution-session-1',
      provider: 'codex',
      projectRoot: harness.projectRoot,
      backendNamespace: 'runtime-only',
      phase: 'completed',
      launch: { state: 'ready', updatedAt: '2035-04-15T01:02:05.000Z' },
      result: {
        content: 'Recovered content from runtime storage',
        outcome: { kind: 'completed' },
      },
      continuity: null,
    };
    writeJson(harness.runtime, resolve(harness.runtime.paths.jobsDir(), jobId, 'status.json'), status);
    expect(readStatusRecord(jobId)).toBeNull();

    const result = await runPlainTurn(harness.context, {
      agentName: 'alpha',
      sessionId: 'executor-recovery',
      provider: 'codex',
      model: 'gpt-5',
      prompt: 'Recover the active job.',
      instruction: 'Use recovered output.',
      cwd: harness.projectRoot,
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

    await startDiscussSession(harness.context, 'virtual-time-session', TOPIC, manualAgents(), {}, harness.invocationCtx);
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
    expect(events.find((event) => event.kind === 'bid.submitted')?.ts).toBe('2044-05-06T07:08:10.234Z');
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

describe('AC7 import audits', () => {
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
