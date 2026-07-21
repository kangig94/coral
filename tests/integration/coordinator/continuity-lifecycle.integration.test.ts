import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { allocateTestSession } from '../../helpers/session.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import type { SpawnProviderServerFn } from '#src/coordinator/live/provider-server-transport.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { createProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { getInternals } from '#tests/unit/jobs/shell/__helpers__/service-fixture.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { TEST_PROVIDER_CREDENTIALS } from '#tests/helpers/provider-credentials.js';
import {
  type ProviderSpec,
  type Provider,
  type ProviderContinuityUpdate,
  providerTerminalEventBodySchema,
  providerJobTerminalSchema,
} from '#src/providers/contract.js';
import type { ProviderTransportClose } from '#src/providers/protocol.js';
import { jobTerminalRecordedBodySchema } from '#src/jobs/terminal/result.js';
import { loadJobProjectionDetail, readJobEvents } from '#src/jobs/read-queries.js';
import { sessionContinuity, type SessionContinuityContract } from '#src/providers/middleware/session-continuity.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
} from '#src/discuss/shell/live-registry.js';
import { DiscussSessionStore } from '#src/discuss/shell/session-store.js';
import { getSession } from '#src/discuss/shell/registry.js';
import { startDiscussSession } from '#src/discuss/shell/operations.js';
import { createInMemoryDiscussJournal } from '#tests/helpers/discuss-journal.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import type { AgentConfig } from '#src/discuss/shell/types.js';
import type { JobContinuitySnapshot } from '#src/jobs/continuity.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

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

function wrapWithSessionContinuity(provider: Provider, contract: SessionContinuityContract<ContinuityState>): Provider {
  return sessionContinuity(contract)(provider);
}

function continuitySnapshot(
  conversationRef: string | null,
  resumable: boolean,
  providerContinuity?: Record<string, unknown>,
): JobContinuitySnapshot {
  return {
    conversationRef,
    resumable,
    ...(providerContinuity === undefined ? {} : { providerContinuity }),
  };
}

describe('coordinator continuity lifecycle integration', () => {
  let runtime: ReturnType<typeof createRealRuntime>;
  let eventBus: TypedEventBus;
  let launchCoordinator: LaunchCoordinator;
  let spawnProviderServer: SpawnProviderServerFn;
  let ctx: InvocationContext;

  beforeEach(() => {
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-continuity-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = {
      projectRoot,
      pluginRoot: join(projectRoot, 'plugin'),
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
      providerCredentials: TEST_PROVIDER_CREDENTIALS,
    };
    mkdirSync(ctx.pluginRoot, { recursive: true });
    runtime = createRealRuntime('prod');
    eventBus = new TypedEventBus();
    launchCoordinator = new LaunchCoordinator({ runtime });
    spawnProviderServer = launchCoordinator.spawnProviderServer.bind(launchCoordinator);
  });

  afterEach(() => {
    launchCoordinator.terminateAll();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createService(providerRegistry: { get(name: string): ProviderSpec | undefined; getAll(): ProviderSpec[] }) {
    const progressStore = new JobStore(TEST_BACKEND_NAMESPACE, runtime, createEventBodyCodec(), {
      db: openTestStoreDb(runtime),
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const service = new ExecutionService(ctx, {
      childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
      providerCredentialSourceAvailability: { isAvailable: () => true },
      runtime,
      progressStore,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      bundleHash: 'bundle-test',
      providerHostManager: createProviderHostManager({ runtime, spawnProviderServer }),
      launchCoordinator,
      eventBus,
      providerRegistry: providerRegistry as never,
      pluginRegistry: { discoverPluginRoot: () => null },
      ...createTestJobJournalDeps(progressStore, runtime),
    });
    return { service, progressStore };
  }

  async function waitForRunningDecision(
    service: ExecutionService,
    provider: string,
    prompt = 'run',
  ): Promise<{ job: string; session: string }> {
    const decision = await service.start(provider, { prompt, cwd: ctx.projectRoot, bypassPermissions: false }, ctx);
    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('Expected running launch');
    }
    return { job: decision.job, session: decision.session };
  }

  it('persists mid-stream continuity and projects it through wait and query readers', async () => {
    const liveSnapshot = continuitySnapshot('thread-live', true, { threadId: 'thread-live' });
    const provider: ProviderSpec = {
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
            outcome: { kind: 'completed' },
          },
          diagnostics: {},
        } as const;
      },
    };
    const { service, progressStore } = createService({
      get: (name) => (name === 'codex' ? provider : undefined),
      getAll: () => [provider],
    });

    const decision = await waitForRunningDecision(service, 'codex');
    const once = await service.waitStreamOnce(decision.job, 5_000);
    const detail = loadJobProjectionDetail(progressStore.getDb(), decision.job, progressStore);
    const terminalProgress = readJobEvents(progressStore.getDb(), decision.job, progressStore).find(
      (event) => event.type === 'terminal',
    );
    const { sessionManager } = getInternals(service);

    expect(once).toEqual({
      content: 'midstream complete',
      continuity: liveSnapshot,
    });
    expect(progressStore.readStatus(decision.job)).toMatchObject({
      phase: 'completed',
    });
    expect(detail.exit?.continuity).toEqual(liveSnapshot);
    expect(terminalProgress).toMatchObject({
      type: 'terminal',
      continuity: liveSnapshot,
    });
    expect(sessionManager.get('codex', decision.session)).toMatchObject({
      conversationRef: 'thread-live',
      state: 'ready',
      providerContinuity: { threadId: 'thread-live' },
    });
  });

  it('rejects extra continuity keys on provider terminal bodies and downstream terminal schemas', () => {
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
      conversationRef: 'thread-extra',
      resumable: true,
    });

    expect(providerTerminal.success).toBe(false);
    expect(jobTerminal.success).toBe(false);
    expect(recorded.success).toBe(false);
  });

  it('checkpoints abort continuity before the terminal event and propagates transport-closed continuity via middleware', async () => {
    const abortProvider: ProviderSpec = {
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
              outcome: { kind: 'aborted', reason: 'user_abort' },
            },
            diagnostics: {},
          } as const;
        },
        continuityContract({ conversationRef: null, resumable: true, providerContinuity: null }),
      ),
    };
    const closedProvider: ProviderSpec = {
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
    const { service } = createService({
      get: (name) => {
        if (name === 'codex') return abortProvider;
        if (name === 'claude') return closedProvider;
        return undefined;
      },
      getAll: () => [abortProvider, closedProvider],
    });
    const { sessionManager } = getInternals(service);

    const abortDecision = await waitForRunningDecision(service, 'codex', 'abort me');
    service.abort([abortDecision.job]);
    const aborted = await service.waitStreamOnce(abortDecision.job, 5_000);
    expect(aborted).toEqual({
      content: 'aborted',
      continuity: continuitySnapshot('thread-abort', true, { threadId: 'thread-abort', state: 'aborted' }),
    });
    expect(sessionManager.get('codex', abortDecision.session)).toMatchObject({
      conversationRef: 'thread-abort',
      providerContinuity: { threadId: 'thread-abort', state: 'aborted' },
    });

    const transportDecision = await waitForRunningDecision(service, 'claude', 'close transport');
    const transported = await service.waitStreamOnce(transportDecision.job, 5_000);
    expect(transported).toEqual({
      content: 'transport handled',
      continuity: continuitySnapshot('thread-transport', true, {
        threadId: 'thread-transport',
        transport: 'transport_closed',
      }),
    });
    expect(sessionManager.get('claude', transportDecision.session)).toMatchObject({
      conversationRef: 'thread-transport',
      providerContinuity: {
        threadId: 'thread-transport',
        transport: 'transport_closed',
      },
    });
  });

  it('uses recovered continuity separately from terminal content and preserves persisted continuity when omitted', async () => {
    const { service, progressStore } = createService({
      get: () => undefined,
      getAll: () => [],
    });
    const { sessionManager } = getInternals(service);

    const explicitSession = allocateTestSession(sessionManager, 'codex', 'alpha', 'gpt-5', ctx.projectRoot);
    const explicitJobId = `recovered-${randomUUID()}`;
    sessionManager.claimForJobSync(explicitSession.sessionId, explicitJobId);
    progressStore.initJob({
      jobId: explicitJobId,
      sessionId: explicitSession.sessionId,
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      initialPhase: 'running',
    });

    const recoveredSnapshot = continuitySnapshot('thread-recovered', true, {
      threadId: 'thread-recovered',
      checkpoint: 'artifact',
    });
    service.completeRecoveredJob(
      explicitJobId,
      explicitSession.sessionId,
      {
        content: 'artifact completion',
        outcome: { kind: 'completed' },
      },
      'completed',
      { continuity: recoveredSnapshot },
    );

    // Recovery continuity flows to session state; terminal bodies never
    // carry conversationRef / resumable. The session assertion below is the
    // load-bearing check that recovered continuity is projected from
    // journal-owned session state.
    expect(sessionManager.get('codex', explicitSession.sessionId)).toMatchObject({
      conversationRef: 'thread-recovered',
      state: 'ready',
      providerContinuity: {
        threadId: 'thread-recovered',
        checkpoint: 'artifact',
      },
    });

    const preservedSession = allocateTestSession(sessionManager, 'codex', 'beta', 'gpt-5', ctx.projectRoot);
    sessionManager.checkpointProviderContinuity(preservedSession.sessionId, {
      conversationRef: 'thread-kept',
      providerContinuity: { threadId: 'thread-kept', preserved: true },
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
        outcome: { kind: 'completed' },
      },
      'completed',
    );

    expect(sessionManager.get('codex', preservedSession.sessionId)).toMatchObject({
      conversationRef: 'thread-kept',
      state: 'ready',
      providerContinuity: { threadId: 'thread-kept', preserved: true },
    });
  });

  it('defaults live null continuity to resumable for wait and discuss consumers', async () => {
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});

    const provider: ProviderSpec = {
      name: 'codex',
      run: async function* () {
        yield { kind: 'progress', message: 'thinking' } as const;
        yield {
          kind: 'terminal',
          terminal: {
            content: '{"score": 55, "thought": "keep the freight window narrow"}',
            outcome: { kind: 'completed' },
          },
          diagnostics: {},
        } as const;
      },
    };
    const { service, progressStore } = createService({
      get: (name) => (name === 'codex' ? provider : undefined),
      getAll: () => [provider],
    });

    const directDecision = await waitForRunningDecision(service, 'codex', 'score this');
    await expect(service.waitStreamOnce(directDecision.job, 5_000)).resolves.toEqual({
      content: '{"score": 55, "thought": "keep the freight window narrow"}',
      continuity: null,
    });
    expect(progressStore.loadJobProjectionDetail(directDecision.job).exit?.continuity).toBeNull();

    const source = runtime.paths.projectSource(ctx.projectRoot);
    const store = new DiscussSessionStore(source, {
      journal: createInMemoryDiscussJournal(),
    });
    const registry = createDiscussContextRegistry();
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
      },
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

      expect(getSession(discussContext, 'discuss-continuity-null')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
        lastAttemptOutcome: 'completed',
      });
      expect(getSession(discussContext, 'discuss-continuity-null')?.snapshot.state.current_bids.alpha).toBe(55);
    } finally {
      store.dispose();
    }
  });
});
