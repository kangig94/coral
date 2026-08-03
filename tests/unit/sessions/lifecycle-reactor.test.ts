import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch, AppServerRuntime, JobTerminalInput } from '#src/jobs/records.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { LaunchPool, QueuedHandle } from '#src/jobs/contracts/admission.js';
import type { JobPhase } from '#src/jobs/phase.js';
import type { TerminalWriteOptions } from '#src/jobs/contracts/job-store.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import { RecoveryService } from '#src/coordinator/services/recovery/service.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { defineProvider } from '#src/providers/registry.js';
import { managed, none } from '#src/providers/capability.js';
import { SessionManager } from '#src/sessions/shell.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { createLifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
} from '#src/sessions/retention-outbox.js';
import { readProjectionProviderSession } from '#src/sessions/projections.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { commit, type AppendedEvent, type CommitEventsFn } from '#src/store/append.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import type { Database } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import {
  ProviderArtifactDefinitiveFailure,
  type ArtifactCleanupRuntime,
  type DiscardOutcome,
  type ProviderArtifactDiscardReconciliation,
} from '#src/providers/contract.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import {
  prepareFixtureAppServerExecutionPlan,
  prepareFixtureExecutionPlan,
  prepareFixtureHost,
  type FixtureExecutionPlan,
} from '#tests/helpers/scripted-provider.js';
import type { CauseRef } from '#src/causality/cause-ref.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

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
    discardArtifacts?: (handles: readonly string[], runtime: ArtifactCleanupRuntime) => Promise<DiscardOutcome>;
    reconcileDiscard?: (
      handles: readonly string[],
      runtime: ArtifactCleanupRuntime,
    ) => Promise<ProviderArtifactDiscardReconciliation>;
    locateArtifact?: (conversationRef: string) => string | null;
    afterCommit?: (appended: readonly AppendedEvent[], commitEvents: CommitEventsFn) => void;
    interruptedRecovery?: boolean;
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
  const providerBuilder = options.interruptedRecovery
    ? defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
        name: 'codex',
        transport: 'app-server',
        run: noopProvider,
        prepareExecutionPlan: prepareFixtureAppServerExecutionPlan,
        appServer: {
          name: 'codex',
          planHost: (input) => {
            if (input.purpose !== 'execution') throw new Error('Codex fixture has no curation host.');
            return prepareFixtureHost(input, {
              provider: 'codex',
              command: 'codex',
              args: [],
              cwd: input.request.cwd,
              env: {},
              leaseMode: 'job-exclusive',
            });
          },
          compileStableHost: (host: FixtureExecutionPlan['host']) => host.serverSpec,
        },
        recovery: {
          finalizeInterrupted: (probeResult, _continuity, context) =>
            probeResult.resumable && context.preservedConversationRef !== undefined
              ? { kind: 'set_resumable' as const, conversationRef: context.preservedConversationRef }
              : { kind: 'clear_non_resumable' as const },
          finalizeFromArtifacts: async () => {
            throw new Error('waiting recovery must not inspect artifacts');
          },
        },
      })
    : defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
        name: 'codex',
        transport: 'standalone',
        run: noopProvider,
        prepareExecutionPlan: prepareFixtureExecutionPlan,
      });
  providerRegistry.register(
    providerBuilder
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts(
        artifactMode === 'managed'
          ? managed({
              discardArtifacts: async ({ handles, runtime: cleanupRuntime }) => {
                discardCalls.push([...handles]);
                if (options.discardArtifacts) {
                  return options.discardArtifacts(handles, cleanupRuntime);
                }
                return { kind: 'discarded' };
              },
              ...(options.reconcileDiscard === undefined
                ? {}
                : {
                    reconcileDiscard: ({ handles, runtime: cleanupRuntime }) =>
                      options.reconcileDiscard!(handles, cleanupRuntime),
                  }),
              ...(options.locateArtifact !== undefined
                ? { locateArtifact: ({ conversationRef }) => options.locateArtifact!(conversationRef) }
                : {}),
            })
          : none('test provider has no artifacts'),
      )
      .build(),
  );

  const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
  const bodyCodec = createEventBodyCodec();
  const logs: string[] = [];
  const appendedBatches: AppendedEvent[][] = [];
  const coordinatorCommit: CommitEventsFn = (cb) => {
    const appended = commit(db, cb, {
      now: () => new Date(runtime.time.now()),
      reducers,
      bodyCodec,
      providers: permissiveProviderLookupPort,
    });
    appendedBatches.push(appended);
    options.afterCommit?.(appended, coordinatorCommit);
    if (autoObserveCoordinator && appended.length > 0) {
      reactor.observe(appended);
    }
    return appended;
  };
  const reactor = createLifecycleReactor({
    db: () => db,
    readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
    providers: providerRegistry,
    runtime,
    time: runtime.time,
    commitEvents: coordinatorCommit,
    log: (message) => logs.push(message),
  });
  const progressStore = new JobStore(namespace, runtime, bodyCodec, {
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

async function runCoordinatorStartupRecovery(harness: Harness): Promise<void> {
  const getRecoveryService = () => {
    throw new Error('These recovery actions must not require provider recovery authority.');
  };
  const createInvocationContext = (projectRoot: string) => ({
    projectRoot,
    pluginRoot: projectRoot,
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
  });
  const coordinator = createRecoveryCoordinator({
    progressStore: harness.progressStore,
    runtime: harness.runtime,
    runtimeState: { setLaunchFenceActive: () => {} },
    eventBus: new TypedEventBus(),
    getRecoveryService,
    createInvocationContext,
    log: (message) => harness.logs.push(message),
  });

  await coordinator.runStartupRecovery({
    namespace: harness.namespace,
    runtime: harness.runtime,
    progressStore: harness.progressStore,
    getRecoveryService,
    createInvocationContext,
    signal: new AbortController().signal,
    log: (message) => harness.logs.push(message),
    coordinatorCommit: harness.coordinatorCommit,
  });
}

async function openClaimedSession(
  harness: Harness,
  jobId: string,
  retention: 'retain' | 'discard_provider_artifacts_on_terminal' = 'discard_provider_artifacts_on_terminal',
): Promise<string> {
  const entry = harness.sessionManager.allocate({
    binding: TEST_CODEX_BINDING,
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
      handle,
      identity: { kind: 'test-artifact', handle },
      sourceJobId: jobId,
    }),
  ).resolves.toMatchObject({ ok: true });
}

function recordContinuationLease(
  harness: Harness,
  sessionId: string,
  staleJobId: string,
  expiresAtMs = harness.runtime.time.now() + 60_000,
): void {
  harness.sessionManager.recordContinuationLease({
    sessionId,
    jobId: staleJobId,
    workflowId: 'workflow-1',
    workflowSlotId: 'workflow-1:0:0',
    replacementGeneration: 1,
    reason: 'stale_recovery',
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

function appendContinuationLeaseRecord(
  commitEvents: CommitEventsFn,
  entry: ProviderSession,
  staleJobId: string,
  expiresAtMs: number,
): void {
  const lease = {
    status: 'pending' as const,
    staleJobId,
    workflowId: 'workflow-1',
    workflowSlotId: 'workflow-1:0:0',
    replacementGeneration: 1,
    reason: 'stale_recovery' as const,
    expiresAt: new Date(expiresAtMs).toISOString(),
    recordedAt: new Date(expiresAtMs - 1).toISOString(),
  };
  const nextEntry: ProviderSession = {
    ...entry,
    continuationLease: lease,
    version: entry.version + 1,
  };
  commitEvents((c) => {
    c.append({
      type: 'session.continuation_lease.recorded',
      stream: { kind: 'session', id: entry.sessionId },
      refs: { sessionId: entry.sessionId, jobId: staleJobId },
      body: {
        entry: nextEntry,
        sessionId: entry.sessionId,
        lease,
      },
    });
    return undefined;
  });
}

function initRunningJob(harness: Harness, jobId: string, sessionId: string) {
  const base = {
    jobId,
    sessionId,
    provider: 'codex',
    projectRoot: harness.projectRoot,
    backendNamespace: harness.namespace,
    initialPhase: 'running',
  } as const;
  initTestJob(harness.progressStore, { ...base, jobKind: 'provider' });
}

function completeJob(harness: Harness, jobId: string, sessionId: string): number {
  return commitJobTerminal(harness.progressStore, jobId, sessionId, {
    content: 'done',
    durationMs: 0,
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
          durationMs: 0,
          outcome: { kind: 'completed' },
        },
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

  it('archives provider artifacts into the job export before deleting native logs', async () => {
    const harness = createHarness({
      discardArtifacts: async (handles, cleanupRuntime) => {
        for (const handle of handles) {
          cleanupRuntime.storage.unlinkSync(handle);
        }
        return { kind: 'discarded' };
      },
    });
    const jobId = 'job-archive-native-log';
    const nativeLog = '/tmp/provider/rollout-archive.jsonl';
    const content = '{"type":"session","message":"hello"}\n';
    const lateContent = '{"type":"session","message":"late-exit-snapshot"}\n';
    harness.runtime.storage.mkdirSync('/tmp/provider', { recursive: true });
    harness.runtime.storage.writeFileSync(nativeLog, content, { encoding: 'utf-8' });
    const sleepSpy = vi.spyOn(harness.runtime.time, 'sleep').mockImplementation(async (ms) => {
      harness.runtime.time.tick(ms);
    });
    const lateAppend = harness.runtime.time.setTimeout(() => {
      harness.runtime.storage.writeFileSync(nativeLog, `${content}${lateContent}`, { encoding: 'utf-8' });
    }, 100);

    try {
      const sessionId = await openClaimedSession(harness, jobId);
      await recordArtifact(harness, sessionId, jobId, nativeLog);
      initRunningJob(harness, jobId, sessionId);

      completeJob(harness, jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, jobId);

      await expectRetentionEvents(harness, sessionId, [
        {
          type: 'session.retention.discard.requested',
          attempt: 1,
          handles: [nativeLog],
        },
        {
          type: 'session.retention.discard.completed',
          attempt: 1,
          handles: [nativeLog],
          outcome: 'discarded',
        },
      ]);

      const actionsRoot = join(
        harness.runtime.paths.coral.exports.jobsRoot,
        jobId,
        'provider-artifacts',
        'codex',
        'actions',
      );
      const actionEntries = harness.runtime.storage.readdirSync(actionsRoot, { withFileTypes: true });
      expect(actionEntries).toHaveLength(1);
      const actionEntry = actionEntries[0];
      if (actionEntry === undefined) throw new Error('Expected one archive action namespace.');
      const archiveDir = join(actionsRoot, actionEntry.name);
      const archivedLog = join(archiveDir, '0001-rollout-archive.jsonl');
      const manifestPath = join(archiveDir, 'manifest.json');
      expect(harness.runtime.storage.existsSync(nativeLog)).toBe(false);
      expect(harness.runtime.storage.readFileSync(archivedLog, 'utf-8')).toBe(`${content}${lateContent}`);
      const manifest = JSON.parse(harness.runtime.storage.readFileSync(manifestPath, 'utf-8')) as {
        schemaVersion: number;
        jobId: string;
        sessionId: string;
        provider: string;
        artifacts: Array<{
          sourceHandle: string;
          archivePath: string;
          bytes: number;
          sourceSha256: string;
          archiveSha256: string;
          status: string;
          identity: { kind: string; handle: string };
          sourceJobId: string;
        }>;
      };
      expect(manifest).toMatchObject({
        schemaVersion: 2,
        jobId,
        sessionId,
        provider: 'codex',
        artifacts: [
          {
            sourceHandle: nativeLog,
            archivePath: archivedLog,
            bytes: Buffer.byteLength(`${content}${lateContent}`, 'utf-8'),
            status: 'archived',
            identity: { kind: 'test-artifact', handle: nativeLog },
            sourceJobId: jobId,
          },
        ],
      });
      expect(manifest.artifacts[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.artifacts[0]?.archiveSha256).toBe(manifest.artifacts[0]?.sourceSha256);
      expect(harness.discardCalls).toEqual([[nativeLog]]);
    } finally {
      harness.runtime.time.clearTimeout(lateAppend);
      sleepSpy.mockRestore();
    }
  });

  it('does not discard stale-aborted session artifacts until the resumed job releases', async () => {
    const harness = createHarness();
    const staleJobId = 'job-stale-abort';
    const resumedJobId = 'job-stale-resumed';
    const sessionId = await openClaimedSession(harness, staleJobId);
    await recordArtifact(harness, sessionId, staleJobId, '/tmp/rollout-stale.jsonl');
    recordContinuationLease(harness, sessionId, staleJobId);
    initRunningJob(harness, staleJobId, sessionId);

    completeJob(harness, staleJobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, staleJobId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);

    const afterStaleRelease = harness.sessionManager.get('codex', sessionId);
    if (afterStaleRelease === null) {
      throw new Error(`Expected session ${sessionId}`);
    }
    const claimedEntries: ProviderSession[] = [];
    harness.coordinatorCommit((c) => {
      claimedEntries.push(
        harness.sessionManager.appendContinuationReplacementClaim(c, {
          sessionId,
          staleJobId,
          resumedJobId,
          workflowId: 'workflow-1',
          workflowSlotId: 'workflow-1:0:0',
          replacementGeneration: 1,
          expectedVersion: afterStaleRelease.version,
        }),
      );
      return undefined;
    });
    const claimedEntry = claimedEntries[0];
    if (claimedEntry === undefined) throw new Error('Expected committed replacement claim');
    harness.sessionManager.observeCommittedEntry(claimedEntry);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);

    initRunningJob(harness, resumedJobId, sessionId);
    completeJob(harness, resumedJobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, resumedJobId);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-stale.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-stale.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-stale.jsonl']]);
  });

  it('records a failed terminal outcome when provider discard fails', async () => {
    const harness = createHarness({
      discardArtifacts: async () => {
        throw new ProviderArtifactDefinitiveFailure('discard permission denied');
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

  it('quarantines an unclassified provider settlement exception and still settles its sibling', async () => {
    const failedHandle = '/tmp/rollout-unclassified-provider-failure.jsonl';
    const validHandle = '/tmp/rollout-unclassified-provider-sibling.jsonl';
    const harness = createHarness({
      autoObserveCoordinator: false,
      discardArtifacts: async (handles) => {
        if (handles.includes(failedHandle)) throw new Error('provider process exited before applying discard');
        return { kind: 'discarded' };
      },
      reconcileDiscard: async () => ({ kind: 'not-applied' }),
    });
    const failedJobId = 'job-unclassified-provider-failure';
    const validJobId = 'job-unclassified-provider-sibling';
    const failedSessionId = await openClaimedSession(harness, failedJobId);
    const validSessionId = await openClaimedSession(harness, validJobId);

    for (const [jobId, sessionId, handle] of [
      [failedJobId, failedSessionId, failedHandle],
      [validJobId, validSessionId, validHandle],
    ] as const) {
      await recordArtifact(harness, sessionId, jobId, handle);
      initRunningJob(harness, jobId, sessionId);
      completeJobViaCoordinatorCommit(harness, jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, jobId);
    }

    harness.reactor.observe(harness.appendedBatches.flat());
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, failedSessionId).map((event) => event.type)).toEqual([
      'session.retention.discard.requested',
    ]);
    expect(
      harness.db
        .prepare(
          `SELECT state, stage, continuation_kind
             FROM recovery_quarantine
            WHERE boundary_id = 'session-retention-work'
              AND subject_key = ?`,
        )
        .get(`${failedSessionId}\u0000${failedJobId}`),
    ).toEqual({ state: 'active', stage: 'settle', continuation_kind: null });
    expect(readRetentionEvents(harness, validSessionId).map((event) => ({ type: event.type, ...event.body }))).toEqual([
      {
        type: 'session.retention.discard.requested',
        sessionId: validSessionId,
        attempt: 1,
        handles: [validHandle],
      },
      {
        type: 'session.retention.discard.completed',
        sessionId: validSessionId,
        attempt: 1,
        handles: [validHandle],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([[failedHandle], [validHandle]]);
  });

  it('quarantines a request-append exception before provider effect and still settles its sibling', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const failedJobId = 'job-request-append-failure';
    const validJobId = 'job-request-append-sibling';
    const failedSessionId = await openClaimedSession(harness, failedJobId);
    const validSessionId = await openClaimedSession(harness, validJobId);
    const failedHandle = '/tmp/rollout-request-append-failure.jsonl';
    const validHandle = '/tmp/rollout-request-append-sibling.jsonl';

    for (const [jobId, sessionId, handle] of [
      [failedJobId, failedSessionId, failedHandle],
      [validJobId, validSessionId, validHandle],
    ] as const) {
      await recordArtifact(harness, sessionId, jobId, handle);
      initRunningJob(harness, jobId, sessionId);
      completeJobViaCoordinatorCommit(harness, jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, jobId);
    }
    harness.db.exec(`
      CREATE TRIGGER reject_fixture_retention_request
      BEFORE INSERT ON events
      WHEN NEW.type = 'session.retention.discard.requested'
       AND NEW.stream_id = '${failedSessionId}'
      BEGIN
        SELECT RAISE(ABORT, 'fixture request append failure');
      END;
    `);

    harness.reactor.observe(harness.appendedBatches.flat());
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, failedSessionId)).toEqual([]);
    expect(
      harness.db
        .prepare(
          `SELECT state, stage, continuation_kind
             FROM recovery_quarantine
            WHERE boundary_id = 'session-retention-work'
              AND subject_key = ?`,
        )
        .get(`${failedSessionId}\u0000${failedJobId}`),
    ).toEqual({ state: 'active', stage: 'settle', continuation_kind: null });
    expect(readRetentionEvents(harness, validSessionId).map((event) => ({ type: event.type, ...event.body }))).toEqual([
      {
        type: 'session.retention.discard.requested',
        sessionId: validSessionId,
        attempt: 1,
        handles: [validHandle],
      },
      {
        type: 'session.retention.discard.completed',
        sessionId: validSessionId,
        attempt: 1,
        handles: [validHandle],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([[validHandle]]);
  });

  it('keeps an unknown provider outcome durably deferred and reconciles before replay', async () => {
    const harness = createHarness({
      discardArtifacts: async () => {
        throw new Error('provider response lost');
      },
      reconcileDiscard: async () => ({ kind: 'unknown' }),
    });
    const jobId = 'job-discard-unknown';
    const handle = '/tmp/rollout-discard-unknown.jsonl';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, handle);
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId).map((event) => event.type)).toEqual([
      'session.retention.discard.requested',
    ]);
    expect(harness.discardCalls).toEqual([[handle]]);
    expect(
      harness.db
        .prepare(
          `SELECT boundary_id, subject_key, state, stage, continuation_kind
             FROM recovery_quarantine
            WHERE boundary_id = 'session-retention-work'
              AND subject_key = ?`,
        )
        .get(`${sessionId}\u0000${jobId}`),
    ).toEqual({
      boundary_id: 'session-retention-work',
      subject_key: `${sessionId}\u0000${jobId}`,
      state: 'continuation',
      stage: 'settle',
      continuation_kind: 'retention-discard.v1',
    });

    await harness.reactor.scanStartup();
    expect(harness.discardCalls).toEqual([[handle]]);
    expect(readRetentionEvents(harness, sessionId).map((event) => event.type)).toEqual([
      'session.retention.discard.requested',
    ]);
  });

  it('skips provider deletion when protection appears after the discard request commits', async () => {
    let protectedSessionId = '';
    let protectedOnce = false;
    const harness: Harness = createHarness({
      afterCommit: (appended, commitEvents) => {
        if (protectedOnce || protectedSessionId.length === 0) {
          return;
        }
        if (!appended.some((event) => event.type === 'session.retention.discard.requested')) {
          return;
        }
        const entry = readProjectionProviderSession(harness.db, protectedSessionId);
        if (entry === null) {
          throw new Error(`Expected session ${protectedSessionId}`);
        }
        protectedOnce = true;
        appendContinuationLeaseRecord(
          commitEvents,
          entry,
          'job-predelete-protection',
          harness.runtime.time.now() + 60_000,
        );
      },
    });
    const jobId = 'job-predelete-protection';
    protectedSessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, protectedSessionId, jobId, '/tmp/rollout-predelete.jsonl');
    initRunningJob(harness, jobId, protectedSessionId);

    completeJob(harness, jobId, protectedSessionId);
    harness.sessionManager.releaseJob(protectedSessionId, jobId);

    await expectRetentionEvents(harness, protectedSessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-predelete.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-predelete.jsonl'],
        outcome: 'skipped_protected',
      },
    ]);
    expect(harness.discardCalls).toEqual([]);
  });

  it('rejects contradictory completed and failed outcomes transactionally', async () => {
    const harness = createHarness();
    const entry = harness.sessionManager.allocate({
      binding: TEST_CODEX_BINDING,
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
      binding: TEST_CODEX_BINDING,
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
    const sourceClaimId = 'synthetic-access-claim';
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

  it('falls back to provider locateArtifact when no handle was recorded but a conversationRef exists', async () => {
    const harness = createHarness({
      locateArtifact: (conversationRef) =>
        conversationRef === 'thread-fallback' ? '/tmp/rollout-thread-fallback.jsonl' : null,
    });
    const jobId = 'job-locate-fallback';
    const sessionId = await openClaimedSession(harness, jobId);
    await checkpointClaimedTestContinuity(harness.sessionManager, sessionId, jobId, {
      conversationRef: 'thread-fallback',
      resumable: true,
      providerContinuity: { threadId: 'thread-fallback' },
    });
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await expectRetentionEvents(harness, sessionId, [
      {
        type: 'session.retention.discard.requested',
        attempt: 1,
        handles: ['/tmp/rollout-thread-fallback.jsonl'],
      },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-thread-fallback.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-thread-fallback.jsonl']]);
  });

  it('records skipped_no_handles when locateArtifact also finds nothing', async () => {
    const harness = createHarness({ locateArtifact: () => null });
    const jobId = 'job-locate-miss';
    const sessionId = await openClaimedSession(harness, jobId);
    await checkpointClaimedTestContinuity(harness.sessionManager, sessionId, jobId, {
      conversationRef: 'thread-missing',
      resumable: true,
      providerContinuity: { threadId: 'thread-missing' },
    });
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
    expect(harness.discardCalls).toEqual([]);
  });

  it('discards the crash-recovered job handle without using another job or the session fallback', async () => {
    const locateSpy = vi.fn((_ref: string) => '/tmp/should-not-be-used.jsonl');
    const harness = createHarness({ locateArtifact: locateSpy });
    const otherJobId = 'job-before-crash-recovery';
    const jobId = 'job-crash-recovered';
    const otherHandle = '/tmp/rollout-other-job.jsonl';
    const recoveredHandle = '/tmp/rollout-crash-recovered.jsonl';
    const sessionId = await openClaimedSession(harness, otherJobId);
    await recordArtifact(harness, sessionId, otherJobId, otherHandle);
    harness.sessionManager.releaseJob(sessionId, otherJobId);
    const released = harness.sessionManager.get('codex', sessionId);
    if (released === null) throw new Error(`Expected session ${sessionId}`);
    await expect(harness.sessionManager.claimForJobAtomic(sessionId, jobId, released.version)).resolves.toBe(true);
    await checkpointClaimedTestContinuity(harness.sessionManager, sessionId, jobId, {
      conversationRef: 'thread-precedence',
      resumable: true,
      providerContinuity: { threadId: 'thread-precedence' },
    });
    await recordArtifact(harness, sessionId, jobId, recoveredHandle);
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [recoveredHandle] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [recoveredHandle],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([[recoveredHandle]]);
    expect(harness.discardCalls.flat()).not.toContain(otherHandle);
    expect(locateSpy).not.toHaveBeenCalled();
  });

  it('discardSessionArtifacts discards recorded handles on demand, bypassing the retain gate', async () => {
    const harness = createHarness();
    const jobId = 'job-ondemand';
    const sessionId = await openClaimedSession(harness, jobId, 'retain');
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-ondemand.jsonl');
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await harness.reactor.discardSessionArtifacts(sessionId);

    expect(harness.discardCalls).toEqual([['/tmp/rollout-ondemand.jsonl']]);
  });

  it('discardSessionArtifacts falls back to locateArtifact when no handle was recorded', async () => {
    const harness = createHarness({
      locateArtifact: (conversationRef) =>
        conversationRef === 'thread-ondemand' ? '/tmp/rollout-thread-ondemand.jsonl' : null,
    });
    const jobId = 'job-ondemand-locate';
    const sessionId = await openClaimedSession(harness, jobId, 'retain');
    initRunningJob(harness, jobId, sessionId);
    await checkpointClaimedTestContinuity(harness.sessionManager, sessionId, jobId, {
      conversationRef: 'thread-ondemand',
      resumable: true,
      providerContinuity: { threadId: 'thread-ondemand' },
    });
    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await harness.reactor.discardSessionArtifacts(sessionId);

    expect(harness.discardCalls).toEqual([['/tmp/rollout-thread-ondemand.jsonl']]);
  });

  it('discardSessionArtifacts is a no-op for an unknown session', async () => {
    const harness = createHarness();
    await harness.reactor.discardSessionArtifacts('missing-session');
    expect(harness.discardCalls).toEqual([]);
  });

  it('discardSessionArtifacts is a no-op when the provider declares no artifacts', async () => {
    const harness = createHarness({ artifactMode: 'none' });
    const jobId = 'job-ondemand-none';
    const sessionId = await openClaimedSession(harness, jobId, 'retain');
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-none.jsonl');

    await harness.reactor.discardSessionArtifacts(sessionId);

    expect(harness.discardCalls).toEqual([]);
  });

  it('discardSessionArtifacts is a no-op when no handle was recorded and no conversationRef exists', async () => {
    const harness = createHarness();
    const jobId = 'job-ondemand-empty';
    const sessionId = await openClaimedSession(harness, jobId, 'retain');

    await harness.reactor.discardSessionArtifacts(sessionId);

    expect(harness.discardCalls).toEqual([]);
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

  it.each([
    {
      name: 'projection',
      corrupt: (harness: Harness, sessionId: string, _jobId: string) => {
        harness.db
          .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
          .run('not valid session json', sessionId);
        return { boundary: 'session-projection', subjectKey: sessionId };
      },
    },
    {
      name: 'release event',
      corrupt: (harness: Harness, sessionId: string, _jobId: string) => {
        const row = harness.db
          .prepare<[string], { seq: number }>(
            `SELECT seq
               FROM events
              WHERE type = 'session.claim.released'
                AND stream_id = ?`,
          )
          .get(sessionId);
        if (row === undefined) throw new Error('Expected release event fixture.');
        harness.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from('malformed'), row.seq);
        return { boundary: 'retention-release-pair', subjectKey: String(row.seq) };
      },
    },
    {
      name: 'terminal event',
      corrupt: (harness: Harness, _sessionId: string, jobId: string) => {
        const row = harness.db
          .prepare<[string], { seq: number }>(
            `SELECT seq
               FROM events
              WHERE type = 'job.terminal.recorded'
                AND stream_id = ?`,
          )
          .get(jobId);
        if (row === undefined) throw new Error('Expected terminal event fixture.');
        harness.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from('malformed'), row.seq);
        return { boundary: 'retention-release-pair', subjectKey: String(row.seq) };
      },
    },
  ])('quarantines one malformed $name pair without requeueing its pending siblings', async ({ corrupt }) => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const pairs = [
      { jobId: 'job-queue-malformed', handle: '/tmp/rollout-queue-malformed.jsonl' },
      { jobId: 'job-queue-valid-a', handle: '/tmp/rollout-queue-valid-a.jsonl' },
      { jobId: 'job-queue-valid-b', handle: '/tmp/rollout-queue-valid-b.jsonl' },
    ];
    const seeded: Array<{ jobId: string; sessionId: string; handle: string }> = [];
    for (const pair of pairs) {
      const sessionId = await openClaimedSession(harness, pair.jobId);
      await recordArtifact(harness, sessionId, pair.jobId, pair.handle);
      initRunningJob(harness, pair.jobId, sessionId);
      completeJobViaCoordinatorCommit(harness, pair.jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, pair.jobId);
      seeded.push({ ...pair, sessionId });
    }

    const malformed = seeded[0];
    if (malformed === undefined) throw new Error('Expected malformed pair fixture.');
    const quarantine = corrupt(harness, malformed.sessionId, malformed.jobId);

    harness.reactor.observe(harness.appendedBatches.flat());
    await harness.reactor.waitForIdle();

    for (const valid of seeded.slice(1)) {
      expect(
        readRetentionEvents(harness, valid.sessionId).map((event) => ({ type: event.type, ...event.body })),
        harness.logs.join('\n'),
      ).toEqual([
        {
          type: 'session.retention.discard.requested',
          sessionId: valid.sessionId,
          attempt: 1,
          handles: [valid.handle],
        },
        {
          type: 'session.retention.discard.completed',
          sessionId: valid.sessionId,
          attempt: 1,
          handles: [valid.handle],
          outcome: 'discarded',
        },
      ]);
    }
    expect(harness.discardCalls).toEqual([['/tmp/rollout-queue-valid-a.jsonl'], ['/tmp/rollout-queue-valid-b.jsonl']]);
    expect(readRetentionEvents(harness, malformed.sessionId)).toEqual([]);
    expect(
      harness.db
        .prepare(
          `SELECT boundary_id, subject_key, state, stage
             FROM recovery_quarantine
            WHERE boundary_id = ?
              AND subject_key = ?`,
        )
        .get(quarantine.boundary, quarantine.subjectKey),
    ).toEqual({
      boundary_id: quarantine.boundary,
      subject_key: quarantine.subjectKey,
      state: 'active',
      stage: 'hydrate',
    });
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

  it('continues startup retention processing for a valid session when another projection cannot be decoded', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const malformedJobId = 'job-startup-scan-malformed-session';
    const validJobId = 'job-startup-scan-valid-session';
    const malformedSessionId = await openClaimedSession(harness, malformedJobId);
    const validSessionId = await openClaimedSession(harness, validJobId);

    for (const [jobId, sessionId] of [
      [malformedJobId, malformedSessionId],
      [validJobId, validSessionId],
    ] as const) {
      initRunningJob(harness, jobId, sessionId);
      completeJobViaCoordinatorCommit(harness, jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, jobId);
    }
    await harness.reactor.waitForIdle();
    harness.db
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run('not valid session json', malformedSessionId);

    await harness.reactor.scanStartup();

    await expectRetentionEvents(harness, validSessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: [] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: [],
        outcome: 'skipped_no_handles',
      },
    ]);
    expect(
      harness.db
        .prepare(
          `SELECT boundary_id, subject_key, state, stage
             FROM recovery_quarantine
            WHERE boundary_id = 'session-projection'
              AND subject_key = ?`,
        )
        .get(malformedSessionId),
    ).toEqual({
      boundary_id: 'session-projection',
      subject_key: malformedSessionId,
      state: 'active',
      stage: 'hydrate',
    });
    expect(readRetentionEvents(harness, malformedSessionId)).toEqual([]);
  });

  it('expires a pending continuation lease by timer and discards without later terminal or release events', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-lease-timer';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-lease-timer.jsonl');
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);

    await harness.reactor.scanStartup();
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);

    harness.runtime.time.tick(100);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-lease-timer.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-lease-timer.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-lease-timer.jsonl']]);
    harness.reactor.dispose();
  });

  it('expires overdue pending continuation leases during startup scan', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-lease-restart-expired';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-lease-restart.jsonl');
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() - 1);

    await harness.reactor.scanStartup();

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-lease-restart.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-lease-restart.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-lease-restart.jsonl']]);
    harness.reactor.dispose();
  });

  it('reschedules the continuation lease timer for the earliest pending expiry', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const firstJobId = 'job-lease-late';
    const secondJobId = 'job-lease-early';
    const firstSessionId = await openClaimedSession(harness, firstJobId);
    const secondSessionId = await openClaimedSession(harness, secondJobId);
    await recordArtifact(harness, firstSessionId, firstJobId, '/tmp/rollout-lease-late.jsonl');
    await recordArtifact(harness, secondSessionId, secondJobId, '/tmp/rollout-lease-early.jsonl');
    initRunningJob(harness, firstJobId, firstSessionId);
    initRunningJob(harness, secondJobId, secondSessionId);
    completeJob(harness, firstJobId, firstSessionId);
    completeJob(harness, secondJobId, secondSessionId);
    harness.sessionManager.releaseJob(firstSessionId, firstJobId);
    harness.sessionManager.releaseJob(secondSessionId, secondJobId);
    recordContinuationLease(harness, firstSessionId, firstJobId, harness.runtime.time.now() + 1_000);
    recordContinuationLease(harness, secondSessionId, secondJobId, harness.runtime.time.now() + 100);

    await harness.reactor.scanStartup();
    harness.runtime.time.tick(100);
    await harness.reactor.waitForIdle();

    expect(
      readRetentionEvents(harness, secondSessionId)
        .map((event) => event.body.outcome)
        .at(-1),
    ).toBe('discarded');
    expect(readRetentionEvents(harness, firstSessionId)).toEqual([]);

    harness.runtime.time.tick(900);

    await expectRetentionEvents(harness, firstSessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-lease-late.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-lease-late.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-lease-early.jsonl'], ['/tmp/rollout-lease-late.jsonl']]);
    harness.reactor.dispose();
  });

  it('quarantines a malformed lease while a valid timer sibling expires and settles', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const malformedJobId = 'job-lease-malformed';
    const validJobId = 'job-lease-valid-sibling';
    const malformedSessionId = await openClaimedSession(harness, malformedJobId);
    const validSessionId = await openClaimedSession(harness, validJobId);

    for (const [jobId, sessionId, handle] of [
      [malformedJobId, malformedSessionId, '/tmp/rollout-lease-malformed.jsonl'],
      [validJobId, validSessionId, '/tmp/rollout-lease-valid-sibling.jsonl'],
    ] as const) {
      await recordArtifact(harness, sessionId, jobId, handle);
      initRunningJob(harness, jobId, sessionId);
      completeJob(harness, jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, jobId);
      recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);
    }

    const malformedEntryRow = harness.db
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(malformedSessionId);
    if (malformedEntryRow === undefined) throw new Error('Expected malformed lease projection fixture.');
    const malformedEntry = JSON.parse(malformedEntryRow.entry) as Record<string, unknown>;
    malformedEntry.continuationLease = {
      ...(malformedEntry.continuationLease as Record<string, unknown>),
      expiresAt: 'not-an-instant',
    };
    harness.db
      .prepare('UPDATE projection_sessions SET entry = ? WHERE session_id = ?')
      .run(JSON.stringify(malformedEntry), malformedSessionId);

    await harness.reactor.scanStartup();
    expect(readRetentionEvents(harness, malformedSessionId)).toEqual([]);
    expect(
      harness.db
        .prepare(
          `SELECT boundary_id, subject_key, state, stage
             FROM recovery_quarantine
            WHERE boundary_id = 'session-continuation-lease'
              AND subject_key = ?`,
        )
        .get(malformedSessionId),
    ).toEqual({
      boundary_id: 'session-continuation-lease',
      subject_key: malformedSessionId,
      state: 'active',
      stage: 'hydrate',
    });

    harness.runtime.time.tick(100);
    await expectRetentionEvents(harness, validSessionId, [
      {
        type: 'session.retention.discard.requested',
        attempt: 1,
        handles: ['/tmp/rollout-lease-valid-sibling.jsonl'],
      },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-lease-valid-sibling.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-lease-valid-sibling.jsonl']]);
    harness.reactor.dispose();
  });

  it('quarantines one expiry append failure and keeps the valid sibling timer live', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const failedJobId = 'job-lease-expiry-append-fails';
    const validJobId = 'job-lease-expiry-append-sibling';
    const failedSessionId = await openClaimedSession(harness, failedJobId);
    const validSessionId = await openClaimedSession(harness, validJobId);

    for (const [jobId, sessionId, handle] of [
      [failedJobId, failedSessionId, '/tmp/rollout-expiry-append-fails.jsonl'],
      [validJobId, validSessionId, '/tmp/rollout-expiry-append-sibling.jsonl'],
    ] as const) {
      await recordArtifact(harness, sessionId, jobId, handle);
      initRunningJob(harness, jobId, sessionId);
      completeJob(harness, jobId, sessionId);
      harness.sessionManager.releaseJob(sessionId, jobId);
    }
    recordContinuationLease(harness, failedSessionId, failedJobId, harness.runtime.time.now() - 1);
    recordContinuationLease(harness, validSessionId, validJobId, harness.runtime.time.now() + 100);
    harness.db.exec(`
      CREATE TRIGGER reject_fixture_lease_expiry
      BEFORE INSERT ON events
      WHEN NEW.type = 'session.continuation_lease.expired'
       AND NEW.stream_id = '${failedSessionId}'
      BEGIN
        SELECT RAISE(ABORT, 'fixture expiry append failure');
      END;
    `);

    await harness.reactor.scanStartup();
    expect(readRetentionEvents(harness, failedSessionId)).toEqual([]);
    expect(
      harness.db
        .prepare(
          `SELECT boundary_id, subject_key, state, stage
             FROM recovery_quarantine
            WHERE boundary_id = 'session-continuation-lease'
              AND subject_key = ?`,
        )
        .get(failedSessionId),
    ).toEqual({
      boundary_id: 'session-continuation-lease',
      subject_key: failedSessionId,
      state: 'active',
      stage: 'settle',
    });
    expect(
      harness.db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM events
            WHERE type = 'session.continuation_lease.expired'
              AND stream_id = ?`,
        )
        .get(failedSessionId),
    ).toEqual({ count: 0 });

    harness.db.exec('DROP TRIGGER reject_fixture_lease_expiry');
    harness.runtime.time.tick(100);
    await expectRetentionEvents(harness, validSessionId, [
      {
        type: 'session.retention.discard.requested',
        attempt: 1,
        handles: ['/tmp/rollout-expiry-append-sibling.jsonl'],
      },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-expiry-append-sibling.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-expiry-append-sibling.jsonl']]);
    harness.reactor.dispose();
  });

  it('observes startup recovery markError releases through the observer-aware entry point', async () => {
    const harness = createHarness();
    const jobId = 'job-recovery-mark-error';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);

    await runCoordinatorStartupRecovery(harness);

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

  it('observes startup recovery releaseSessionClaim through the observer-aware entry point', async () => {
    const harness = createHarness();
    const jobId = 'job-recovery-release';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);

    await runCoordinatorStartupRecovery(harness);

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
    const harness = createHarness({ interruptedRecovery: true });
    const jobId = 'job-finalize-interrupted';
    const sessionId = await openClaimedSession(harness, jobId);
    await checkpointClaimedTestContinuity(harness.sessionManager, sessionId, jobId, {
      conversationRef: 'thread-finalize-interrupted',
      resumable: true,
      providerContinuity: { threadId: 'thread-finalize-interrupted' },
    });
    initRunningJob(harness, jobId, sessionId);

    const launchRecord: JobLaunch = {
      jobId,
      owner: { kind: 'provider-session', id: sessionId },
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
      childPrincipalRegistry: new ChildPrincipalRegistry(harness.runtime.ids),
      parentPrincipal: testProjectPrincipal(harness.projectRoot),
      sessionManager: harness.sessionManager,
      abortRegistry: {
        register: () => 'abort-key',
        getSignal: () => null,
        has: () => false,
        listActive: () => [],
        abort: () => ({ aborted: [], notFound: [] }),
        remove: vi.fn(),
      },
      backendNamespace: harness.namespace,
      bundleHash: 'test-bundle',
      progressStore: harness.progressStore,
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
            });
            return undefined;
          });
        },
      },
    });

    const captured = await recoveryService.captureProviderRecoveryAuthority(launchRecord);
    if (!captured.ok) throw new Error('Expected provider recovery authority.');
    await recoveryService.finalizeInterruptedAppServerJob(captured.authority, runtimeRecord, {
      reason: 'restart',
      signal: new AbortController().signal,
      onCommitStart: vi.fn(),
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
import { checkpointClaimedTestContinuity, initTestJob } from '#tests/helpers/session.js';
