import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { allocateTestSession, seedTestProviderContinuity } from '../../helpers/session.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { admittedByThisCoordinator, createObserveCarriers } from '#src/coordinator/composition/carrier-observation.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import type { CarrierInterruptedWaitEvent, WaitStreamEvent } from '#src/jobs/wait.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import {
  type Provider,
  type ProviderContinuityUpdate,
  providerTerminalEventBodySchema,
  providerJobTerminalSchema,
} from '#src/providers/contract.js';
import { prepareFixtureExecutionPlan, type FixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import type { ProviderTransportClose } from '#src/providers/protocol.js';
import { jobTerminalRecordedBodySchema } from '#src/jobs/terminal/result.js';
import { jobRuntimeStartedBodySchema } from '#src/jobs/event-bodies.js';
import { jobLaunchRequestBodySchema } from '#src/jobs/launch.js';
import { loadJobProjectionDetail, readJobEvents } from '#src/jobs/read-queries.js';
import { sessionContinuity, type SessionContinuityContract } from '#src/providers/middleware/session-continuity.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
} from '#src/discuss/shell/live-registry.js';
import { DiscussSessionStore } from '#src/discuss/shell/session-store.js';
import { getSession } from '#src/discuss/shell/registry.js';
import { startDiscussSession } from '#src/discuss/shell/operations.js';
import { createProgressStoreDiscussJournal } from '#tests/unit/discuss/shell/discuss-test-helpers.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import type { AgentConfig } from '#src/discuss/shell/types.js';
import type { ContinuitySnapshot } from '#src/sessions/continuity.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { registerBuiltInProviders } from '#src/providers/bootstrap.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { none } from '#src/providers/capability.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-continuity-lifecycle-test`,
}));
const TEST_BACKEND_NAMESPACE = 'continuity-int';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
  };
});

type ContinuityState = {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity: Record<string, unknown> | null;
};

function continuityContract(
  opening: ContinuityState,
  options: {
    applyTransportClosed?: (state: ContinuityState, closed: ProviderTransportClose) => ContinuityState;
  } = {},
): SessionContinuityContract<ContinuityState> {
  return {
    read: () => ({
      providerState: {
        conversationRef: opening.conversationRef,
        resumable: opening.resumable,
        providerContinuity: opening.providerContinuity === null ? null : { ...opening.providerContinuity },
      },
      opening: {
        conversationRef: opening.conversationRef,
        resumable: opening.resumable,
        providerContinuity: opening.providerContinuity,
      },
    }),
    applyUpdate: (state, update: ProviderContinuityUpdate) => ({
      conversationRef: update.conversationRef ?? state.conversationRef,
      resumable: update.resumable ?? state.resumable,
      providerContinuity:
        update.providerContinuity === undefined
          ? state.providerContinuity
          : ((update.providerContinuity as Record<string, unknown> | null) ?? null),
    }),
    snapshot: (state) => ({
      conversationRef: state.conversationRef,
      resumable: state.resumable,
      providerContinuity: state.providerContinuity,
    }),
    ...(options.applyTransportClosed ? { applyTransportClosed: options.applyTransportClosed } : {}),
    isSessionUnavailable: () => false,
  };
}

type TestProvider = {
  readonly name: string;
  readonly run: Provider<FixtureExecutionPlan>;
};

function wrapWithSessionContinuity(
  provider: Provider<FixtureExecutionPlan>,
  contract: SessionContinuityContract<ContinuityState>,
): Provider<FixtureExecutionPlan> {
  return sessionContinuity<ContinuityState, FixtureExecutionPlan>('fixture', contract)(provider);
}

function continuitySnapshot(
  conversationRef: string | null,
  resumable: boolean,
  providerContinuity?: Record<string, unknown>,
): ContinuitySnapshot {
  return {
    conversationRef,
    resumable,
    providerContinuity: providerContinuity ?? null,
  };
}

describe('coordinator continuity lifecycle integration', () => {
  let runtime: ReturnType<typeof createRealRuntime>;
  let eventBus: TypedEventBus;
  let launchCoordinator: LaunchCoordinator;
  let ctx: InvocationContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-continuity-home-'));
    const projectRoot = fixtureCanonicalWorkDir(join(mockState.tmpHome, 'project'));
    mkdirSync(projectRoot, { recursive: true });
    ctx = {
      projectRoot,
      pluginRoot: join(projectRoot, 'plugin'),
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
      providerScope: TEST_PROVIDER_SCOPE,
    };
    mkdirSync(ctx.pluginRoot, { recursive: true });
    runtime = createRealRuntime('prod');
    eventBus = new TypedEventBus();
    launchCoordinator = new LaunchCoordinator({ runtime });
  });

  afterEach(() => {
    launchCoordinator.terminateAll();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createService(providers: readonly TestProvider[], options: { withObserveCarriers?: boolean } = {}) {
    const providerRegistry = new ProviderRegistry();
    for (const provider of providers) {
      providerRegistry.register(
        defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
          name: provider.name,
          transport: 'standalone',
          run: provider.run,
          prepareExecutionPlan: prepareFixtureExecutionPlan,
        })
          .binding(fixtureProviderBindingCodec(provider.name))
          .artifacts(none('continuity fixture has no provider artifacts'))
          .build(),
      );
    }
    const registeredProviders = new Set(providers.map((provider) => provider.name));
    ctx = {
      ...ctx,
      providerScope: {
        origin: 'caller',
        profiles: TEST_PROVIDER_SCOPE.profiles.filter((profile) => registeredProviders.has(profile.provider)),
      },
    };
    const progressStore = new JobStore(TEST_BACKEND_NAMESPACE, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime),
      eventBus,
      reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
      providers: permissiveProviderLookupPort,
    });
    const journalDeps = createTestJobJournalDeps(progressStore, runtime);
    const service = new ExecutionService(ctx, {
      childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
      runtime,
      progressStore,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      bundleHash: 'bundle-test',
      launchCoordinator,
      eventBus,
      providerRegistry,
      pluginRegistry: { discoverPluginRoot: () => null },
      ...journalDeps,
      ...(options.withObserveCarriers
        ? {
            // Exactly the composition function the real backend wires in
            // (`coordinator/composition/execution-services.ts`), fed this test's own real
            // LaunchCoordinator and store — proves the production construction site, not a test double.
            observeCarriers: createObserveCarriers(
              {
                getDb: () => progressStore.getDb(),
                loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
                platform: runtime.env.platform() as NodeJS.Platform,
                // This fixture exercises the wait stream, not the recovery boundary: the barrier stays
                // unpassed so every local `unknown` is the honest `in-progress` answer rather than a
                // recovery defect this test never set up the durable ownership to judge.
                hasStartupRecoveryPassed: () => false,
                isAdmittedByThisCoordinator: (jobId) => admittedByThisCoordinator(launchCoordinator, jobId),
                registryStateForJob: (): null => null,
              },
              journalDeps.getCurrentJournalSeq,
            ),
          }
        : {}),
    });
    return { service, progressStore };
  }

  async function waitForRunningDecision(
    service: ExecutionService,
    provider: string,
    prompt = 'run',
  ): Promise<{ jobId: string; sessionId: string }> {
    const decision = await service.start(provider, { prompt, cwd: ctx.projectRoot, bypassPermissions: false }, ctx);
    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('Expected running launch');
    }
    if (decision.sessionId === undefined) {
      throw new Error('Provider launch must return a session');
    }
    return { jobId: decision.jobId, sessionId: decision.sessionId };
  }

  it('persists mid-stream continuity and projects it through wait and query readers', async () => {
    const liveSnapshot = continuitySnapshot('thread-live', true, { threadId: 'thread-live' });
    const provider: TestProvider = {
      name: 'codex',
      run: async function* () {
        yield { kind: 'progress', message: 'booting' } as const;
        yield {
          kind: 'continuity',
          conversationRef: liveSnapshot.conversationRef,
          resumable: liveSnapshot.resumable,
          providerContinuity: liveSnapshot.providerContinuity!,
        } as const;
        yield { kind: 'progress', message: 'streaming' } as const;
        yield {
          kind: 'terminal',
          terminal: {
            content: 'midstream complete',
            durationMs: 0,
            outcome: { kind: 'completed' },
          },
          diagnostics: {},
        } as const;
      },
    };
    const { service, progressStore } = createService([provider]);

    const decision = await waitForRunningDecision(service, 'codex');
    const once = await service.waitStreamOnce(decision.jobId, 5_000);
    const detail = loadJobProjectionDetail(progressStore.getDb(), decision.jobId, progressStore);
    const terminalProgress = readJobEvents(progressStore.getDb(), decision.jobId, progressStore).find(
      (event) => event.type === 'terminal',
    );
    const { sessionManager } = getInternals(service);

    expect(once).toEqual({
      content: 'midstream complete',
      continuity: liveSnapshot,
    });
    expect(progressStore.readStatus(decision.jobId)).toMatchObject({
      owner: { kind: 'provider-session', id: decision.sessionId },
      sessionId: decision.sessionId,
      phase: 'completed',
    });
    expect(detail.exit).not.toHaveProperty('continuity');
    expect(terminalProgress).not.toHaveProperty('continuity');
    expect(sessionManager.get('codex', decision.sessionId)).toMatchObject({
      conversationRef: 'thread-live',
      state: 'ready',
      providerContinuity: { threadId: 'thread-live' },
    });
  });

  it('rejects provider continuity on job terminals and app-server runtime records', () => {
    const providerTerminal = providerTerminalEventBodySchema.safeParse({
      kind: 'terminal',
      terminal: {
        content: 'bad',
        outcome: { kind: 'completed' },
        conversationRef: 'thread-extra',
        resumable: true,
      },
      diagnostics: {},
    });
    const jobTerminal = providerJobTerminalSchema.safeParse({
      content: 'bad',
      outcome: { kind: 'completed' },
      conversationRef: 'thread-extra',
      resumable: true,
    });
    const recorded = jobTerminalRecordedBodySchema.safeParse({
      terminal: {
        content: 'bad',
        durationMs: 1,
        outcome: { kind: 'completed' },
      },
      continuity: {
        conversationRef: 'thread-extra',
        resumable: true,
        providerContinuity: { threadId: 'thread-extra' },
      },
    });
    const runtimeWithConversationRef = jobRuntimeStartedBodySchema.safeParse({
      transport: 'app-server',
      startedAt: '2026-07-22T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        conversationRef: 'thread-extra',
      },
    });
    const runtimeWithProviderContinuity = jobRuntimeStartedBodySchema.safeParse({
      transport: 'app-server',
      startedAt: '2026-07-22T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        providerContinuity: { threadId: 'thread-extra' },
      },
    });
    const launchWithConversationRef = jobLaunchRequestBodySchema.safeParse({
      owner: { kind: 'provider-session', id: 'session-extra' },
      sessionId: 'session-extra',
      provider: 'codex',
      providerAction: 'resume',
      projectRoot: '/tmp/project',
      backendNamespace: TEST_BACKEND_NAMESPACE,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
      request: {
        prompt: 'resume',
        cwd: '/tmp/project',
        bypassPermissions: false,
        coralEnv: {},
        conversationRef: 'thread-extra',
      },
    });

    expect(providerTerminal.success).toBe(false);
    expect(jobTerminal.success).toBe(false);
    expect(recorded.success).toBe(false);
    expect(runtimeWithConversationRef.success).toBe(false);
    expect(runtimeWithProviderContinuity.success).toBe(false);
    expect(launchWithConversationRef.success).toBe(false);
  });

  it('checkpoints abort continuity before the terminal event and propagates transport-closed continuity via middleware', async () => {
    const abortProvider: TestProvider = {
      name: 'codex',
      run: wrapWithSessionContinuity(
        async function* (_request, runtime) {
          yield { kind: 'progress', message: 'running' } as const;
          await new Promise<void>((resolve) => {
            runtime.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          runtime.continuityBridge.checkpoint({
            conversationRef: 'thread-abort',
            resumable: true,
            providerContinuity: { threadId: 'thread-abort', state: 'aborted' },
          });
          yield {
            kind: 'terminal',
            terminal: {
              content: 'aborted',
              durationMs: 0,
              outcome: { kind: 'aborted', reason: 'user_abort' },
            },
            diagnostics: {},
          } as const;
        },
        continuityContract({ conversationRef: null, resumable: true, providerContinuity: null }),
      ),
    };
    const closedProvider: TestProvider = {
      name: 'claude',
      run: wrapWithSessionContinuity(
        async function* (_request, runtime) {
          runtime.continuityBridge.checkpoint({
            conversationRef: 'thread-transport',
            resumable: true,
            providerContinuity: { threadId: 'thread-transport' },
          });
          runtime.continuityBridge.transportClosed({
            kind: 'transport_closed',
            error: null,
          });
          yield {
            kind: 'terminal',
            terminal: {
              content: 'transport handled',
              durationMs: 0,
              outcome: { kind: 'completed' },
            },
            diagnostics: {},
          } as const;
        },
        continuityContract(
          { conversationRef: null, resumable: true, providerContinuity: null },
          {
            applyTransportClosed: (state, closed) => ({
              ...state,
              providerContinuity: {
                ...(state.providerContinuity ?? {}),
                transport: closed.kind,
              },
            }),
          },
        ),
      ),
    };
    const { service } = createService([abortProvider, closedProvider]);
    const { sessionManager } = getInternals(service);

    const abortDecision = await waitForRunningDecision(service, 'codex', 'abort me');
    service.abort([abortDecision.jobId]);
    const aborted = await service.waitStreamOnce(abortDecision.jobId, 5_000);
    expect(aborted).toEqual({
      content: 'aborted',
      continuity: continuitySnapshot('thread-abort', true, { threadId: 'thread-abort', state: 'aborted' }),
    });
    expect(sessionManager.get('codex', abortDecision.sessionId)).toMatchObject({
      conversationRef: 'thread-abort',
      providerContinuity: { threadId: 'thread-abort', state: 'aborted' },
    });

    const transportDecision = await waitForRunningDecision(service, 'claude', 'close transport');
    const transported = await service.waitStreamOnce(transportDecision.jobId, 5_000);
    expect(transported).toEqual({
      content: 'transport handled',
      continuity: continuitySnapshot('thread-transport', true, {
        threadId: 'thread-transport',
        transport: 'transport_closed',
      }),
    });
    expect(sessionManager.get('claude', transportDecision.sessionId)).toMatchObject({
      conversationRef: 'thread-transport',
      providerContinuity: {
        threadId: 'thread-transport',
        transport: 'transport_closed',
      },
    });
  });

  it('preserves persisted continuity when generic recovered completion releases the job', async () => {
    const { service, progressStore } = createService([]);
    const { sessionManager } = getInternals(service);

    const preservedSession = allocateTestSession(
      sessionManager,
      'codex',
      'beta',
      'gpt-5',
      ctx.projectRoot,
      ctx.projectRoot,
      TEST_BACKEND_NAMESPACE,
    );
    await seedTestProviderContinuity(sessionManager, preservedSession.sessionId, {
      conversationRef: 'thread-kept',
      providerContinuity: { threadId: 'thread-kept' },
    });
    const preserveJobId = `recovered-${randomUUID()}`;
    sessionManager.claimForJobSync(preservedSession.sessionId, preserveJobId);
    progressStore.initJob({
      jobId: preserveJobId,
      sessionId: preservedSession.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });

    service.completeRecoveredJob(
      preserveJobId,
      preservedSession.sessionId,
      {
        content: 'artifact preserve',
        durationMs: 0,
        outcome: { kind: 'completed' },
      },
      'completed',
      { pool: 'default' },
    );

    expect(sessionManager.get('codex', preservedSession.sessionId)).toMatchObject({
      conversationRef: 'thread-kept',
      state: 'ready',
      providerContinuity: { threadId: 'thread-kept' },
    });
  });

  it('defaults live null continuity to resumable for wait and discuss consumers', async () => {
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});

    const provider: TestProvider = {
      name: 'codex',
      run: async function* () {
        yield { kind: 'progress', message: 'thinking' } as const;
        yield {
          kind: 'terminal',
          terminal: {
            content: '{"score": 55, "thought": "keep the freight window narrow"}',
            durationMs: 0,
            outcome: { kind: 'completed' },
          },
          diagnostics: {},
        } as const;
      },
    };
    const { service, progressStore } = createService([provider]);

    const directDecision = await waitForRunningDecision(service, 'codex', 'score this');
    await expect(service.waitStreamOnce(directDecision.jobId, 5_000)).resolves.toEqual({
      content: '{"score": 55, "thought": "keep the freight window narrow"}',
      continuity: null,
    });
    expect(progressStore.loadJobProjectionDetail(directDecision.jobId).exit).not.toHaveProperty('continuity');

    const access = runtime.paths.projectSource(ctx.projectRoot);
    const store = new DiscussSessionStore(access, {
      journal: createProgressStoreDiscussJournal(runtime.paths.projectSource.bind(runtime.paths), progressStore),
    });
    const registry = createDiscussContextRegistry();
    const providerRegistry = new ProviderRegistry();
    registerBuiltInProviders(providerRegistry);
    const discussContext = getOrCreateDiscussContext(registry, ctx.projectRoot, service, store, {
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
        listOwned: () => [],
      },
      providerRegistry,
    });
    const agents: AgentConfig[] = [{ name: 'alpha', persona: '# Alpha', provider: 'codex', model: 'gpt-5' }];

    try {
      await startDiscussSession(
        discussContext,
        'discuss-continuity-null',
        'Should the city pedestrianize the downtown core?',
        agents,
        {},
        ctx,
      );

      await vi.waitFor(() => {
        expect(getSession(discussContext, 'discuss-continuity-null')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
          lastAttemptOutcome: 'completed',
        });
      });
      expect(getSession(discussContext, 'discuss-continuity-null')?.snapshot.state.current_bids.alpha).toBe(55);
    } finally {
      store.dispose();
    }
  });

  it('emits a wait-stream interrupted event for a durable CLI job whose recorded process is gone', async () => {
    // W3.1 production wiring: `observeCarriers` reaches `ExecutionService` through the same
    // `createObserveCarriers` composition function the real backend wires in
    // (`coordinator/composition/execution-services.ts`), not a test double.
    const { service, progressStore } = createService([], { withObserveCarriers: true });
    const { sessionManager } = getInternals(service);
    // `durable_cli_process.v1` keys on a canonical UUID; the job id must be one to write it below.
    const jobId = randomUUID();
    // A pid this OS will never assign: `probeProcessStartedAtSeconds` and `isProcessAlive` both answer
    // "nothing there" for it locally, with no network call involved.
    const deadPid = 2_147_483_647;
    const session = allocateTestSession(
      sessionManager,
      'codex',
      `carrier-durable-${jobId}`,
      undefined,
      ctx.projectRoot,
      ctx.projectRoot,
      TEST_BACKEND_NAMESPACE,
    );
    const sessionId = session.sessionId;
    sessionManager.claimForJobSync(sessionId, jobId);

    progressStore.initJob({
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'queued',
    });
    progressStore.appendRuntimeStarted(jobId, {
      transport: 'durable-cli',
      pid: deadPid,
      stdoutPath: join(ctx.projectRoot, 'stdout.log'),
      stderrPath: join(ctx.projectRoot, 'stderr.log'),
      startTime: new Date(runtime.time.now()).toISOString(),
    });
    // The separately captured identity `spawnDurableJobTransport` would have written at launch — see
    // `onDurableProcessIdentity` in `providers/cli-runner.ts` and `jobs/shell/launch.ts`.
    writeDurableCliProcessRuntimeMeta(progressStore.getDb(), {
      version: 1,
      jobId,
      pid: deadPid,
      processStartedAtSeconds: 1,
    });
    const expectedStoredPhase = progressStore.readStatus(jobId)?.phase;

    const events: WaitStreamEvent[] = [];
    const iterator = service.waitStream({ jobIds: [jobId], timeoutSeconds: 2 })[Symbol.asyncIterator]();
    for (let index = 0; index < 5; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'interrupted') break;
    }
    await iterator.return?.(undefined);

    const interrupted = events.find((event): event is CarrierInterruptedWaitEvent => event.type === 'interrupted');
    expect(interrupted).toMatchObject({
      jobId,
      storedPhase: expectedStoredPhase,
      observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
      continuity: 'unavailable',
      outcome: 'unknown',
    });
    // Absence never ends the job or the stream: only the journal does that.
    expect(progressStore.readStatus(jobId)?.phase).toBe(expectedStoredPhase);
  });
});
