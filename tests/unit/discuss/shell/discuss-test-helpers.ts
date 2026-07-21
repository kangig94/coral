import { join } from 'node:path';
import { vi } from 'vitest';

import type {
  DiscussDomainEvent,
  PersistedDiscussSnapshot,
  SessionCreatedAgentExecutionConfig,
} from '#src/discuss/events.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import type { DiscussCreateInput } from '#src/discuss/session-types.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  type DiscussContextConstructionOptions,
  type DiscussContextRegistry,
} from '#src/discuss/shell/live-registry.js';
import type { DiscussContext, DiscussService } from '#src/discuss/shell/types.js';
import { listProjectionDiscussSnapshots, readProjectionDiscuss } from '#src/discuss/projections.js';
import { buildWatchEvents } from '#src/discuss/watch.js';
import { DiscussSessionStore, type DiscussSessionJournal } from '#src/discuss/shell/session-store.js';
import { attachSession, detachSession, listSessions } from '#src/discuss/shell/registry.js';
import { isAbortEnded, readSessionEvents } from '#src/discuss/shell/persistence.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { ExecutionService } from '#src/coordinator/execution-service.js';
import type { Runtime } from '#src/runtime/ports.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { JobStore } from '#src/jobs/store.js';
import { commitJobInputs } from '#tests/helpers/job-commits.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry as discussStoreRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { registerBuiltInProviders } from '#src/providers/bootstrap.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import type { JobLaunchRequest } from '#src/jobs/launch.js';

function resolveBackendNamespace(runtime: Runtime, pluginRoot: string): string {
  const paths = runtime.paths as { pluginRootNamespace?: (root: string) => string };
  return typeof paths.pluginRootNamespace === 'function'
    ? paths.pluginRootNamespace(pluginRoot)
    : pluginRootNamespace(pluginRoot);
}
import { readDiscussEventLog } from '#src/discuss/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';

export const DEFAULT_TOPIC = 'Should the city pedestrianize the downtown core?';
export const DEFAULT_TS = '2026-03-10T00:00:00.000Z';

export function defaultAgents(): Array<DiscussCreateInput['agents'][number]> {
  return [
    { name: 'alpha', persona: '# Alpha', participation: 'required' },
    { name: 'beta', persona: '# Beta', participation: 'required' },
  ];
}

export function defaultAgentExecution(
  agents: Array<DiscussCreateInput['agents'][number]>,
): Record<string, SessionCreatedAgentExecutionConfig> {
  return Object.fromEntries(
    agents.map((agent): [string, SessionCreatedAgentExecutionConfig] => {
      if (agent.participation === 'observer' && agent.name === 'user') {
        return [agent.name, { manual: true }];
      }
      return [
        agent.name,
        {
          manual: false,
          provider: 'codex',
          model: 'gpt-5',
        },
      ];
    }),
  );
}

export function createExecutionServiceStub(overrides: Partial<ExecutionService> = {}): ExecutionService {
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

export type DiscussHarness = {
  tmpRoot: string;
  projectRoot: string;
  ctx: InvocationContext;
  store: DiscussSessionStore;
  context: DiscussContext;
  registry: DiscussContextRegistry;
  service: ExecutionService;
  runtime: Runtime;
  progressStore: JobStore;
  cleanup: () => void;
};

const activeHarnesses = new Set<DiscussHarness>();

function cleanupLiveSessions(context: DiscussContext): void {
  for (const [sessionId, session] of listSessions(context)) {
    session.controller.abort();
    detachSession(context, sessionId);
  }
}

let harnessCounter = 0;

export type CreateDiscussHarnessOptions = {
  tmpRoot?: string;
  projectRoot?: string;
  pluginRoot?: string;
  source?: string;
  runtime?: SimulationRuntime;
};

function snapshotBelongsToSource(
  resolveProjectSource: (projectRoot: string) => string,
  snapshot: Pick<PersistedDiscussSnapshot, 'projectRoot'>,
  source: string,
): boolean {
  return snapshot.projectRoot === source || resolveProjectSource(snapshot.projectRoot) === source;
}

export function createProgressStoreDiscussJournal(
  resolveProjectSource: (projectRoot: string) => string,
  progressStore: JobStore,
): DiscussSessionJournal {
  const readCtx = createDefaultStoreReadContext();

  return {
    append(_source, _snapshot, events) {
      commitJobInputs(
        progressStore,
        events.map((event) => toJournalInput(event)),
      );
    },
    readSnapshot(sessionId) {
      return readProjectionDiscuss(progressStore.getDb(), sessionId)?.state ?? null;
    },
    readEvents(sessionId) {
      return readDiscussEventLog(progressStore.getDb(), sessionId, readCtx);
    },
    listSnapshots(source) {
      return listProjectionDiscussSnapshots(progressStore.getDb())
        .map((row) => row.state)
        .filter((snapshot) => snapshotBelongsToSource(resolveProjectSource, snapshot, source));
    },
    listSources() {
      return [
        ...new Set(
          listProjectionDiscussSnapshots(progressStore.getDb()).map((row) =>
            resolveProjectSource(row.state.projectRoot),
          ),
        ),
      ].sort();
    },
  };
}

export function createDiscussContextOptions(
  runtime: Pick<Runtime, 'ids' | 'env' | 'time' | 'storage' | 'paths'>,
  progressStore?: Pick<JobStore, 'readStatus' | 'listJobProjections' | 'loadJobProjectionDetail'>,
): DiscussContextConstructionOptions {
  const providerRegistry = new ProviderRegistry();
  registerBuiltInProviders(providerRegistry);
  return {
    runtime: {
      ids: runtime.ids,
      env: runtime.env,
      time: runtime.time,
      storage: runtime.storage,
      projectData: (projectRoot: string) => runtime.paths.projectData(projectRoot),
    },
    jobStatusReader: {
      read: (jobId) => progressStore?.readStatus(jobId) ?? null,
      readExit: () => null,
      listOwned: (discussionId) =>
        progressStore === undefined
          ? []
          : progressStore
              .listJobProjections()
              .filter(({ status }) => status.owner.kind === 'discussion' && status.owner.id === discussionId)
              .flatMap(({ jobId, status }) => {
                const launch = progressStore.loadJobProjectionDetail(jobId).launch;
                return launch === null ? [] : [{ launch, status }];
              }),
    },
    providerRegistry,
  };
}

export function discussContextOptions(
  harness: Pick<DiscussHarness, 'runtime' | 'progressStore'>,
): DiscussContextConstructionOptions {
  return createDiscussContextOptions(harness.runtime, harness.progressStore);
}

export function createDiscussHarness(
  service = createExecutionServiceStub(),
  options: CreateDiscussHarnessOptions | string = {},
): DiscussHarness {
  const harnessId = ++harnessCounter;
  const resolvedOptions = typeof options === 'string' ? { source: options } : options;
  const tmpRoot = resolvedOptions.tmpRoot ?? `/tmp/sim/coral-discuss-${harnessId}`;
  const projectRoot = resolvedOptions.projectRoot ?? join(tmpRoot, `project-${harnessId}`);
  const pluginRoot = resolvedOptions.pluginRoot ?? join(tmpRoot, 'plugin');

  const runtime = resolvedOptions.runtime ?? new SimulationRuntime();
  runtime.storage.mkdirSync(projectRoot, { recursive: true });
  runtime.storage.mkdirSync(pluginRoot, { recursive: true });
  const progressStore = new JobStore(resolveBackendNamespace(runtime, pluginRoot), runtime, createEventBodyCodec(), {
    db: openTestStoreDb(runtime, ':memory:'),
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussStoreRegistry, workflowRegistry),
    providers: permissiveProviderLookupPort,
  });
  const source = resolvedOptions.source ?? runtime.paths.projectSource(projectRoot);
  const resolveProjectSource = resolvedOptions.source
    ? () => resolvedOptions.source as string
    : runtime.paths.projectSource.bind(runtime.paths);
  const store = new DiscussSessionStore(source, {
    journal: createProgressStoreDiscussJournal(resolveProjectSource, progressStore),
  });
  const persistMockLaunch = (
    provider: string,
    request: Record<string, unknown>,
    decision: Awaited<ReturnType<ExecutionService['start']>>,
  ) => {
    if (decision.status === 'rejected' || decision.sessionId === undefined) return;
    if (progressStore.readStatus(decision.jobId) !== null) return;
    seedTestSessionProjection(progressStore.getDb(), {
      sessionId: decision.sessionId,
      provider,
      projectRoot,
      backendNamespace: progressStore.getNamespace(),
      activeJobId: decision.jobId,
    });
    progressStore.appendLaunchRequested(decision.jobId, {
      jobId: decision.jobId,
      owner: request.owner as NonNullable<JobLaunchRequest['owner']>,
      discussionRun: request.discussionRun as NonNullable<JobLaunchRequest['discussionRun']>,
      sessionId: decision.sessionId,
      provider,
      projectRoot,
      backendNamespace: progressStore.getNamespace(),
      jobKind: 'provider',
      pool: 'discuss',
      enqueueSequence: 0,
      providerAction: 'sessionId' in request ? 'resume' : 'exec',
      request: {
        prompt: typeof request.prompt === 'string' ? request.prompt : '',
        cwd: projectRoot,
        bypassPermissions: true,
        coralEnv: {},
      },
      createdAt: DEFAULT_TS,
    });
  };
  const contextService: DiscussService = {
    start: async (provider, request, invocation) => {
      const decision = await service.start(provider, request, invocation);
      persistMockLaunch(provider, request as unknown as Record<string, unknown>, decision);
      return decision;
    },
    resume: async (provider, request, invocation) => {
      const decision = await service.resume(provider, request, invocation);
      persistMockLaunch(provider, request as unknown as Record<string, unknown>, decision);
      return decision;
    },
    waitStreamOnce: (...args) => service.waitStreamOnce(...args),
  };
  const registry = createDiscussContextRegistry();
  const context = getOrCreateDiscussContext(
    registry,
    projectRoot,
    contextService,
    store,
    createDiscussContextOptions(runtime, progressStore),
  );
  const ctx: InvocationContext = {
    projectRoot,
    pluginRoot,
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
    providerScope: TEST_PROVIDER_SCOPE,
  };
  let cleaned = false;

  const harness: DiscussHarness = {
    tmpRoot,
    projectRoot,
    ctx,
    store,
    context,
    registry,
    service,
    runtime,
    progressStore,
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      store.dispose();
      cleanupLiveSessions(context);
      runtime.storage.rmSync(tmpRoot, { recursive: true, force: true });
      activeHarnesses.delete(harness);
    },
  };
  activeHarnesses.add(harness);

  return harness;
}

export function cleanupDiscussHarnesses(): void {
  for (const harness of [...activeHarnesses]) {
    harness.cleanup();
  }
}

export async function advanceDiscussRuntime(harness: Pick<DiscussHarness, 'runtime'>, ms: number): Promise<void> {
  const tick = (harness.runtime.time as { tick?: (durationMs: number) => void }).tick;
  if (typeof tick !== 'function') {
    throw new Error('advanceDiscussRuntime requires a virtual-time runtime');
  }
  tick.call(harness.runtime.time, ms);
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

export function attachPersistedSession(
  harness: Pick<DiscussHarness, 'context'>,
  snapshot: PersistedDiscussSnapshot,
): void {
  const events = readSessionEvents(harness.context, snapshot.sessionId);
  attachSession(
    harness.context,
    snapshot,
    {
      baseCursor: 0,
      events: buildWatchEvents(events),
    },
    isAbortEnded(events),
  );
}

function seedTailJobLinks(
  harness: DiscussHarness,
  snapshot: PersistedDiscussSnapshot,
  events: readonly DiscussDomainEvent[],
): void {
  const finishedJobIds = new Set(
    events.filter((event) => event.kind === 'agent.job.finished').map((event) => event.payload.jobId),
  );
  const startedAgents = new Set(
    events.filter((event) => event.kind === 'agent.job.started').map((event) => event.payload.agent),
  );
  const rejectSeededJob = (jobId: string, sessionId: string, provider: string, ts: string) => {
    commitJobInputs(harness.progressStore, [
      {
        type: 'job.launch.rejected',
        stream: { kind: 'job', id: jobId },
        namespace: harness.progressStore.getNamespace(),
        project: harness.projectRoot,
        refs: { jobId, sessionId },
        bodyVersion: 1,
        body: { reason: 'busy', message: 'synthetic unavailable test job', provider, globalActive: 1, globalLimit: 1 },
        tsOverride: ts,
      },
    ]);
  };
  const sessionsByAgent = new Map<string, string>();
  for (const [agent, run] of Object.entries(snapshot.runtime.agentRuns)) {
    if (run.executionSessionId !== undefined) sessionsByAgent.set(agent, run.executionSessionId);
  }
  for (const event of events) {
    if (event.kind === 'agent.run.bound') sessionsByAgent.set(event.payload.agent, event.payload.executionSessionId);
  }
  for (const event of events) {
    if (event.kind !== 'agent.job.started' || harness.progressStore.readStatus(event.payload.jobId) !== null) continue;
    const run = snapshot.runtime.agentRuns[event.payload.agent];
    const sessionId = sessionsByAgent.get(event.payload.agent) ?? `${event.payload.jobId}-session`;
    const provider = run?.provider ?? 'codex';
    seedTestSessionProjection(harness.progressStore.getDb(), {
      sessionId,
      provider,
      projectRoot: harness.projectRoot,
      backendNamespace: harness.progressStore.getNamespace(),
      activeJobId: event.payload.jobId,
    });
    harness.progressStore.appendLaunchRequested(event.payload.jobId, {
      jobId: event.payload.jobId,
      owner: { kind: 'discussion', id: snapshot.sessionId },
      discussionRun: {
        agent: event.payload.agent,
        purpose: event.payload.purpose,
        attempt: event.payload.attempt,
      },
      sessionId,
      provider,
      projectRoot: harness.projectRoot,
      backendNamespace: harness.progressStore.getNamespace(),
      jobKind: 'provider',
      pool: 'discuss',
      enqueueSequence: 0,
      providerAction: run?.executionSessionId === undefined ? 'exec' : 'resume',
      request: { prompt: '', cwd: harness.projectRoot, bypassPermissions: true, coralEnv: {} },
      createdAt: event.ts,
    });
    if (!finishedJobIds.has(event.payload.jobId)) {
      rejectSeededJob(event.payload.jobId, sessionId, provider, event.ts);
    }
  }
  for (const event of events) {
    if (event.kind !== 'agent.run.bound' || startedAgents.has(event.payload.agent)) continue;
    const jobId = `${snapshot.sessionId}-${event.payload.agent}-prior-binding`;
    if (harness.progressStore.readStatus(jobId) !== null) continue;
    const run = snapshot.runtime.agentRuns[event.payload.agent];
    const provider = run?.provider ?? 'codex';
    seedTestSessionProjection(harness.progressStore.getDb(), {
      sessionId: event.payload.executionSessionId,
      provider,
      projectRoot: harness.projectRoot,
      backendNamespace: harness.progressStore.getNamespace(),
      activeJobId: jobId,
    });
    harness.progressStore.appendLaunchRequested(jobId, {
      jobId,
      owner: { kind: 'discussion', id: snapshot.sessionId },
      discussionRun: { agent: event.payload.agent, purpose: 'bid', attempt: 1 },
      sessionId: event.payload.executionSessionId,
      provider,
      projectRoot: harness.projectRoot,
      backendNamespace: harness.progressStore.getNamespace(),
      jobKind: 'provider',
      pool: 'discuss',
      enqueueSequence: 0,
      providerAction: 'exec',
      request: { prompt: '', cwd: harness.projectRoot, bypassPermissions: true, coralEnv: {} },
      createdAt: event.ts,
    });
    rejectSeededJob(jobId, event.payload.executionSessionId, provider, event.ts);
  }
}

export async function persistSession(
  harness: DiscussHarness,
  options: {
    sessionId?: string;
    topic?: string;
    agents?: Array<DiscussCreateInput['agents'][number]>;
    minBidDelayMs?: number;
    createdAt?: string;
    agentExecution?: Record<string, SessionCreatedAgentExecutionConfig>;
    buildTail?: (snapshot: PersistedDiscussSnapshot) => DiscussDomainEvent[];
    recover?: boolean;
  } = {},
): Promise<PersistedDiscussSnapshot> {
  const sessionId = options.sessionId ?? 'discuss-1';
  const topic = options.topic ?? DEFAULT_TOPIC;
  const agents = options.agents ?? defaultAgents();
  const createdAt = options.createdAt ?? DEFAULT_TS;
  const input: DiscussCreateInput = {
    topic,
    agents,
    min_bid_delay_ms: options.minBidDelayMs ?? 0,
  };
  const created = decideSessionCreate(
    input,
    { sessionId: sessionId, projectRoot: harness.projectRoot, topic: topic },
    1,
    createdAt,
    {
      agentExecution: options.agentExecution ?? defaultAgentExecution(agents),
      providerScope: harness.ctx.providerScope ?? TEST_PROVIDER_SCOPE,
    },
  );
  if (!created.ok) {
    const createError = created.error;
    throw new Error(createError);
  }

  let snapshot = await harness.store.append(sessionId, null, created.value);
  if (options.buildTail) {
    const tailEvents = options.buildTail(snapshot);
    if (tailEvents.length > 0) {
      seedTailJobLinks(harness, snapshot, tailEvents);
      snapshot = await harness.store.append(sessionId, snapshot.lastAppliedSeq, tailEvents);
    }
  }

  if (options.recover ?? false) {
    const attached = harness.store.load(sessionId) ?? snapshot;
    attachPersistedSession(harness, attached);
  }

  return harness.store.load(sessionId) ?? snapshot;
}

export async function appendPersistedEvents(
  harness: DiscussHarness,
  sessionId: string,
  buildTail: (snapshot: PersistedDiscussSnapshot) => DiscussDomainEvent[],
): Promise<PersistedDiscussSnapshot> {
  const snapshot = harness.store.load(sessionId);
  if (!snapshot) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const events = buildTail(snapshot);
  if (events.length === 0) {
    return snapshot;
  }

  seedTailJobLinks(harness, snapshot, events);
  const result = await harness.store.append(sessionId, snapshot.lastAppliedSeq, events);
  return result;
}
