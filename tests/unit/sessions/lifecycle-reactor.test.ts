import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch, AppServerRuntime, JobTerminalInput } from '#src/jobs/records.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { LaunchPool, QueuedHandle } from '#src/jobs/contracts/admission.js';
import type { JobPhase } from '#src/jobs/phase.js';
import type { TerminalWriteOptions } from '#src/jobs/contracts/job-store.js';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import { applyRecoveryAction } from '#src/coordinator/services/recovery/actions.js';
import { RecoveryService } from '#src/coordinator/services/recovery/service.js';
import { createWorkflowRecoveryFinalizer } from '#src/coordinator/services/workflow-recovery-finalizer.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { defineProvider } from '#src/providers/define.js';
import { managed, none } from '#src/providers/capability.js';
import { SessionManager } from '#src/sessions/shell.js';
import { createLifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
} from '#src/sessions/retention-outbox.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { commit, type AppendedEvent, type CommitEventsFn } from '#src/store/append.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import type { Database } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import type { DiscardOutcome } from '#src/providers/contract.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { CauseRef } from '#src/causality/cause-ref.js';

const openDbs = new Set<Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

type ProviderArtifactMode = 'managed' | 'none';

type Harness = {
  readonly runtime: SimulationRuntime;
  readonly db: Database;
  readonly namespace: string;
  readonly projectRoot: string;
  readonly providerRegistry: ProviderRegistry;
  readonly progressStore: JobStore;
  readonly sessionManager: SessionManager;
  readonly coordinatorCommit: CommitEventsFn;
  readonly reactor: ReturnType<typeof createLifecycleReactor>;
  readonly discardCalls: Array<readonly string[]>;
  readonly logs: string[];
  readonly appendedBatches: AppendedEvent[][];
};

async function* noopProvider() {}

function createHarness(
  options: {
    artifactMode?: ProviderArtifactMode;
    autoObserveCoordinator?: boolean;
    discardArtifacts?: (handles: readonly string[]) => Promise<DiscardOutcome>;
  } = {},
): Harness {
  const artifactMode = options.artifactMode ?? 'managed';
  const autoObserveCoordinator = options.autoObserveCoordinator ?? true;
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  openDbs.add(db);

  const namespace = 'test-ns';
  const projectRoot = '/workspace/project';
  const providerRegistry = new ProviderRegistry();
  const discardCalls: Array<readonly string[]> = [];
  providerRegistry.register(
    defineProvider({ name: 'codex', run: noopProvider })
      .artifacts(
        artifactMode === 'managed'
          ? managed({
              discardArtifacts: async (handles) => {
                discardCalls.push([...handles]);
                if (options.discardArtifacts) {
                  return options.discardArtifacts(handles);
                }
                return { kind: 'discarded' };
              },
            })
          : none('test provider has no artifacts'),
      )
      .build(),
  );

  const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
  const upcasters = createDefaultUpcasterRegistry();
  const logs: string[] = [];
  const appendedBatches: AppendedEvent[][] = [];
  const coordinatorCommit: CommitEventsFn = (cb) => {
    const appended = commit(db, cb, {
      now: () => new Date(runtime.time.now()),
      reducers,
      upcasters,
      providers: permissiveProviderLookupPort,
    });
    appendedBatches.push(appended);
    if (autoObserveCoordinator && appended.length > 0) {
      reactor.observe(appended);
    }
    return appended;
  };
  const reactor = createLifecycleReactor({
    db: () => db,
    providers: providerRegistry,
    runtime,
    commitEvents: coordinatorCommit,
    log: (message) => logs.push(message),
  });
  const progressStore = new JobStore(namespace, runtime, upcasters, {
    db,
    eventBus: new TypedEventBus(),
    reducers,
    providers: permissiveProviderLookupPort,
    observer: reactor.observe,
  });
  const sessionManager = new SessionManager(projectRoot, runtime, coordinatorCommit, undefined, db);

  return {
    runtime,
    db,
    namespace,
    projectRoot,
    providerRegistry,
    progressStore,
    sessionManager,
    coordinatorCommit,
    reactor,
    discardCalls,
    logs,
    appendedBatches,
  };
}

async function openClaimedSession(
  harness: Harness,
  jobId: string,
  retention: 'retain' | 'discard_provider_artifacts_on_terminal' = 'discard_provider_artifacts_on_terminal',
): Promise<string> {
  const entry = harness.sessionManager.allocate({
    provider: 'codex',
    name: `session-${jobId}`,
    cwd: harness.projectRoot,
    projectRoot: harness.projectRoot,
    backendNamespace: harness.namespace,
    retention,
  });
  await expect(harness.sessionManager.claimForJobAtomic(entry.sessionId, jobId, entry.version)).resolves.toBe(true);
  return entry.sessionId;
}

async function recordArtifact(harness: Harness, sessionId: string, jobId: string, handle: string): Promise<void> {
  const current = harness.sessionManager.get('codex', sessionId);
  if (current === null) {
    throw new Error(`Expected session ${sessionId}`);
  }

  await expect(
    harness.sessionManager.recordArtifactHandleAtomic(sessionId, {
      expectedActiveJobId: jobId,
      expectedVersion: current.version,
      provider: 'codex',
      handle,
      sourceJobId: jobId,
    }),
  ).resolves.toMatchObject({ ok: true });
}

function initRunningJob(harness: Harness, jobId: string, sessionId: string, jobKind: 'provider' | 'workflow' = 'provider') {
  harness.progressStore.initJob({
    jobId,
    sessionId,
    provider: 'codex',
    projectRoot: harness.projectRoot,
    backendNamespace: harness.namespace,
    jobKind,
    initialPhase: 'running',
  });
}

function completeJob(harness: Harness, jobId: string, sessionId: string): number {
  return commitJobTerminal(harness.progressStore, jobId, sessionId, {
    content: 'done',
    outcome: { kind: 'completed' },
  });
}

function completeJobViaCoordinatorCommit(harness: Harness, jobId: string, sessionId: string): readonly AppendedEvent[] {
  return (
    harness.coordinatorCommit((c) => {
      appendJobTerminalRecorded(c, {
        jobId,
        sessionId,
        namespace: harness.namespace,
        project: harness.projectRoot,
        terminal: {
          content: 'done',
          outcome: { kind: 'completed' },
        },
        continuity: null,
      });
      return undefined;
    }) ?? []
  );
}

type RetentionEventBody = {
  readonly sessionId: string;
  readonly attempt: number;
  readonly handles: readonly string[];
  readonly outcome?: string;
  readonly reason?: string;
  readonly causeRef?: CauseRef;
};

function readRetentionEvents(
  harness: Pick<Harness, 'db'>,
  sessionId: string,
): Array<{ readonly seq: number; readonly type: string; readonly body: RetentionEventBody }> {
  const rows = harness.db
    .prepare(
      `SELECT seq, type, body
         FROM events
        WHERE stream_kind = 'session'
          AND stream_id = ?
          AND type IN (
            'session.retention.discard.requested',
            'session.retention.discard.completed',
            'session.retention.discard.failed'
          )
        ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{ seq: number; type: string; body: Buffer }>;

  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    body: decodeEventBody(row.body) as RetentionEventBody,
  }));
}

async function expectRetentionEvents(
  harness: Harness,
  sessionId: string,
  expected: readonly {
    readonly type: string;
    readonly attempt: number;
    readonly handles: readonly string[];
    readonly outcome?: string;
    readonly reason?: string;
    readonly causeRef?: CauseRef;
  }[],
): Promise<void> {
  await harness.reactor.waitForIdle();
  expect(readRetentionEvents(harness, sessionId).map((event) => ({ type: event.type, ...event.body }))).toEqual(
    expected.map((event) => ({
      sessionId,
      ...event,
    })),
  );
}

describe('LifecycleReactor retention enforcement', () => {
  it('enforces a terminal and release pair once and coalesces repeated appended events', async () => {
    const harness = createHarness();
    const jobId = 'job-pair-once';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-job-pair-once.jsonl');
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await expectRetentionEvents(harness, sessionId, [
      {
        type: 'session.retention.discard.requested',
        attempt: 1,
        handles: ['/tmp/rollout-job-pair-once.jsonl'],
      },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-job-pair-once.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-job-pair-once.jsonl']]);

    const appended = harness.appendedBatches.flat();
    harness.reactor.observe(appended);
    harness.reactor.observe(appended);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toHaveLength(2);
    expect(harness.discardCalls).toHaveLength(1);
  });

  it('records a failed terminal outcome when provider discard fails', async () => {
    const harness = createHarness({
      discardArtifacts: async () => {
        throw new Error('discard permission denied');
      },
    });
    const jobId = 'job-discard-fails';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-discard-fails.jsonl');
    initRunningJob(harness, jobId, sessionId);

    const terminalSeq = completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await expectRetentionEvents(harness, sessionId, [
      {
        type: 'session.retention.discard.requested',
        attempt: 1,
        handles: ['/tmp/rollout-discard-fails.jsonl'],
      },
      {
        type: 'session.retention.discard.failed',
        attempt: 1,
        handles: ['/tmp/rollout-discard-fails.jsonl'],
        reason: 'discard permission denied',
        causeRef: {
          stream: { kind: 'job', id: jobId },
          seq: terminalSeq,
        },
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-discard-fails.jsonl']]);
  });

  it('rejects contradictory completed and failed outcomes transactionally', async () => {
    const harness = createHarness();
    const entry = harness.sessionManager.allocate({
      provider: 'codex',
      name: 'session-retention-validator',
      cwd: harness.projectRoot,
      projectRoot: harness.projectRoot,
      backendNamespace: harness.namespace,
      retention: 'discard_provider_artifacts_on_terminal',
    });
    const handles = ['/tmp/retention-validator.jsonl'];

    expect(
      appendRetentionDiscardRequested(harness.coordinatorCommit, {
        sessionId: entry.sessionId,
        attempt: 1,
        handles,
      }),
    ).toMatchObject({ kind: 'appended' });
    appendRetentionDiscardCompleted(harness.coordinatorCommit, {
      sessionId: entry.sessionId,
      attempt: 1,
      handles,
      outcome: 'discarded',
    });
    const before = readRetentionEvents(harness, entry.sessionId);

    expect(() =>
      appendRetentionDiscardFailed(harness.coordinatorCommit, {
        sessionId: entry.sessionId,
        attempt: 1,
        handles,
        reason: 'late failure',
      }),
    ).toThrow(/contradicts existing completed outcome/);
    expect(readRetentionEvents(harness, entry.sessionId)).toEqual(before);
  });

  it('treats duplicate requested attempts as outbox no-ops before insertion', async () => {
    const harness = createHarness();
    const entry = harness.sessionManager.allocate({
      provider: 'codex',
      name: 'session-retention-duplicate',
      cwd: harness.projectRoot,
      projectRoot: harness.projectRoot,
      backendNamespace: harness.namespace,
      retention: 'discard_provider_artifacts_on_terminal',
    });
    const handles = ['/tmp/retention-duplicate.jsonl'];

    expect(
      appendRetentionDiscardRequested(harness.coordinatorCommit, {
        sessionId: entry.sessionId,
        attempt: 1,
        handles,
      }),
    ).toMatchObject({ kind: 'appended' });
    expect(
      appendRetentionDiscardRequested(harness.coordinatorCommit, {
        sessionId: entry.sessionId,
        attempt: 1,
        handles,
      }),
    ).toEqual({ kind: 'duplicate' });

    expect(readRetentionEvents(harness, entry.sessionId)).toHaveLength(1);
  });

  it('does not enqueue retention work for retain sessions', async () => {
    const harness = createHarness();
    const jobId = 'job-retain';
    const sessionId = await openClaimedSession(harness, jobId, 'retain');
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);
  });

  it('ignores synthetic releases that have no matching terminal for the same job', async () => {
    const harness = createHarness();
    const sourceClaimId = 'synthetic-source-claim';
    const sessionId = await openClaimedSession(harness, sourceClaimId);

    harness.sessionManager.releaseJob(sessionId, sourceClaimId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
  });

  it('records durable completed no-op outcomes for empty handles and providers declaring none', async () => {
    const emptyHarness = createHarness();
    const emptyJobId = 'job-empty-handles';
    const emptySessionId = await openClaimedSession(emptyHarness, emptyJobId);
    initRunningJob(emptyHarness, emptyJobId, emptySessionId);

    completeJob(emptyHarness, emptyJobId, emptySessionId);
    emptyHarness.sessionManager.releaseJob(emptySessionId, emptyJobId);

    await expectRetentionEvents(emptyHarness, emptySessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
    expect(emptyHarness.discardCalls).toEqual([]);

    const noneHarness = createHarness({ artifactMode: 'none' });
    const noneJobId = 'job-provider-none';
    const noneSessionId = await openClaimedSession(noneHarness, noneJobId);
    await recordArtifact(noneHarness, noneSessionId, noneJobId, '/tmp/provider-none.jsonl');
    initRunningJob(noneHarness, noneJobId, noneSessionId);

    completeJob(noneHarness, noneJobId, noneSessionId);
    noneHarness.sessionManager.releaseJob(noneSessionId, noneJobId);

    await expectRetentionEvents(noneHarness, noneSessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/provider-none.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/provider-none.jsonl'],
        outcome: 'provider_declares_none',
      },
    ]);
    expect(noneHarness.discardCalls).toEqual([]);
  });

  it('observes job.terminal.recorded appended through JobStore.commit', async () => {
    const harness = createHarness();
    const jobId = 'job-store-terminal';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);

    completeJob(harness, jobId, sessionId);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
  });

  it('enforces once when terminal and release observations arrive out of order', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-out-of-order';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-out-of-order.jsonl');
    initRunningJob(harness, jobId, sessionId);

    const terminalOnly = completeJobViaCoordinatorCommit(harness, jobId, sessionId);
    harness.reactor.observe(terminalOnly);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);

    const beforeReleaseBatches = harness.appendedBatches.length;
    harness.sessionManager.releaseJob(sessionId, jobId);
    const releaseOnly = harness.appendedBatches.slice(beforeReleaseBatches).flat();

    harness.reactor.observe(releaseOnly);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-out-of-order.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-out-of-order.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-out-of-order.jsonl']]);
  });

  it('startup scan backfills existing terminal and release pairs', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-startup-scan';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);

    await harness.reactor.scanStartup();

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
  });

  it('observes recovery markError session releases through the observer-aware release path', async () => {
    const harness = createHarness();
    const jobId = 'job-recovery-mark-error';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);
    const status = harness.progressStore.readStatus(jobId);
    if (status === null) {
      throw new Error(`Expected status for ${jobId}`);
    }

    applyRecoveryAction(
      { type: 'markError', jobId, status, fault: { kind: 'wrapper_lost' } },
      {
        progressStore: harness.progressStore,
        recoveryRegistry: new RecoveryRegistry(harness.runtime.process),
        queuedRecoverable: [],
        runningRecoverable: [],
        log: () => {},
        runtime: harness.runtime,
        createInvocationContext: (projectRoot) => ({ projectRoot, pluginRoot: projectRoot, coralEnv: {} }),
        getRecoveryService: () => {
          throw new Error('unexpected recovery service lookup');
        },
        sessionLookup: createProjectionSessionLookup(harness.db),
        emitSessionReleased: () => {},
        coordinatorCommit: harness.coordinatorCommit,
      },
    );

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
  });

  it('observes recovery releaseSessionClaim through the observer-aware release path', async () => {
    const harness = createHarness();
    const jobId = 'job-recovery-release';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);

    applyRecoveryAction(
      { type: 'releaseSessionClaim', sessionId, jobId },
      {
        progressStore: harness.progressStore,
        recoveryRegistry: new RecoveryRegistry(harness.runtime.process),
        queuedRecoverable: [],
        runningRecoverable: [],
        log: () => {},
        runtime: harness.runtime,
        createInvocationContext: (projectRoot) => ({ projectRoot, pluginRoot: projectRoot, coralEnv: {} }),
        getRecoveryService: () => {
          throw new Error('unexpected recovery service lookup');
        },
        sessionLookup: createProjectionSessionLookup(harness.db),
        emitSessionReleased: () => {},
        coordinatorCommit: harness.coordinatorCommit,
      },
    );

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
  });

  it('observes finalizeInterruptedAppServerJob releases emitted by finalizeJobContinuityAtomic', async () => {
    const harness = createHarness();
    const jobId = 'job-finalize-interrupted';
    const sessionId = await openClaimedSession(harness, jobId);
    harness.sessionManager.setConversationRef(sessionId, 'thread-finalize-interrupted');
    initRunningJob(harness, jobId, sessionId);

    const launchRecord: JobLaunch = {
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot: harness.projectRoot,
      backendNamespace: harness.namespace,
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: {
        prompt: 'recover interrupted',
        cwd: harness.projectRoot,
        bypassPermissions: false,
        coralEnv: {},
        conversationRef: 'thread-finalize-interrupted',
      },
      createdAt: '2026-04-19T00:00:00.000Z',
    };
    const runtimeRecord: AppServerRuntime = {
      transport: 'app-server',
      startTime: '2026-04-19T00:00:01.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'waiting',
      },
    };
    const recoveryService = new RecoveryService({
      runtime: harness.runtime,
      sessionManager: harness.sessionManager,
      abortRegistry: {
        register: () => 'abort-key',
        getSignal: () => null,
        has: () => false,
        abort: () => ({ aborted: [], notFound: [] }),
        remove: vi.fn(),
      },
      backendNamespace: harness.namespace,
      bundleHash: 'test-bundle',
      progressStore: harness.progressStore,
      providerHostManager: {
        acquireServer: async () => {
          throw new Error('unexpected acquireServer');
        },
        borrowLiveServer: async () => null,
      },
      launchAdmission: {
        releaseLaunch: vi.fn(),
      },
      launchRecovery: {
        restoreActiveLaunch: vi.fn(),
        restoreQueuedLaunch: vi.fn((): QueuedHandle => {
          throw new Error('unexpected restoreQueuedLaunch');
        }),
      },
      providerRegistry: harness.providerRegistry,
      jobPools: new Map<string, LaunchPool>(),
      launchOrchestrator: {
        runRecoveredQueuedJob: vi.fn(),
        writeJobTerminal: (
          terminalJobId: string,
          terminalSessionId: string,
          result: JobTerminalInput,
          _phase: JobPhase,
          options?: TerminalWriteOptions,
        ) => {
          harness.progressStore.commit((c) => {
            appendJobTerminalRecorded(c, {
              jobId: terminalJobId,
              sessionId: terminalSessionId,
              namespace: harness.namespace,
              project: harness.projectRoot,
              terminal: result,
              diagnostics: options?.diagnostics,
              continuity: options?.continuity ?? null,
            });
            return undefined;
          });
        },
      },
    });

    await recoveryService.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, { reason: 'restart' });

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
  });

  it('observes workflow recovery finalization session releases', async () => {
    const harness = createHarness();
    const workflowJobId = 'workflow-finalized';
    const sessionId = await openClaimedSession(harness, workflowJobId);
    initRunningJob(harness, workflowJobId, sessionId, 'workflow');

    const finalizer = createWorkflowRecoveryFinalizer({
      runtime: harness.runtime,
      progressStore: harness.progressStore,
      coordinatorCommit: harness.coordinatorCommit,
      emitSessionReleased: () => {},
      log: () => {},
    });

    finalizer({
      outcome: 'completed',
      workflowJobId,
      finalOutput: 'workflow done',
      stepDetails: [],
    });

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
  });
});
