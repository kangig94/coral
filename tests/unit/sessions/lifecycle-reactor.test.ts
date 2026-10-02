import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SessionStartupRecoveryModule from '#src/sessions/startup-recovery.js';

import { JobStore } from '#src/jobs/store.js';
import { appendJobTerminalRecorded } from '#src/jobs/terminal/recording.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { defineProvider } from '#src/providers/registry.js';
import { managed } from '#src/providers/capability.js';
import { SessionManager } from '#src/sessions/shell.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { createLifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import { runSessionStartupRecovery } from '#src/sessions/startup-recovery.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { readProjectionProviderSession } from '#src/sessions/projections.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { commit, type AppendedEvent, type CommitEventsFn } from '#src/store/append.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import type { Database } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import {
  type ArtifactCleanupRuntime,
  type DiscardOutcome,
  type ProviderArtifactDiscardReconciliation,
} from '#src/providers/contract.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { prepareFixtureExecutionPlan, type FixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import type { CauseRef } from '#src/causality/cause-ref.js';

vi.mock('#src/sessions/startup-recovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionStartupRecoveryModule>();
  return { ...actual, runSessionStartupRecovery: vi.fn(actual.runSessionStartupRecovery) };
});

const openDbs = new Set<Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

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
  readonly reactorLifetime: AbortController;
  readonly discardCalls: Array<readonly string[]>;
  readonly appendedBatches: AppendedEvent[][];
};

async function* noopProvider() {}

function createHarness(
  options: {
    autoObserveCoordinator?: boolean;
    discardArtifacts?: (handles: readonly string[], runtime: ArtifactCleanupRuntime) => Promise<DiscardOutcome>;
    reconcileDiscard?: (
      handles: readonly string[],
      runtime: ArtifactCleanupRuntime,
    ) => Promise<ProviderArtifactDiscardReconciliation>;
    afterCommit?: (appended: readonly AppendedEvent[], commitEvents: CommitEventsFn) => void;
  } = {},
): Harness {
  const autoObserveCoordinator = options.autoObserveCoordinator ?? true;
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  openDbs.add(db);

  const namespace = 'test-ns';
  const projectRoot = process.cwd();
  const providerRegistry = new ProviderRegistry();
  const discardCalls: Array<readonly string[]> = [];
  const providerBuilder = defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
    name: 'codex',
    transport: 'standalone',
    run: noopProvider,
    prepareExecutionPlan: prepareFixtureExecutionPlan,
  });
  providerRegistry.register(
    providerBuilder
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts(
        managed({
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
        }),
      )
      .build(),
  );

  const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
  const bodyCodec = createEventBodyCodec();
  const appendedBatches: AppendedEvent[][] = [];
  const reactorLifetime = new AbortController();
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
    signal: reactorLifetime.signal,
    log: () => {},
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
    reactorLifetime,
    discardCalls,
    appendedBatches,
  };
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
  it('observes lifetime cancellation and settles recovery before the store closes', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    let recoverySignal: AbortSignal | undefined;
    let releaseRecovery!: () => void;
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    const recoveryReleased = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    vi.mocked(runSessionStartupRecovery).mockImplementationOnce(async (walks) => {
      recoverySignal = walks.sessions.policy.signal;
      markRecoveryStarted();
      await recoveryReleased;
      walks.sessions.policy.signal.throwIfAborted();
      throw new Error('expected cancellation');
    });

    const startupSignal = new AbortController().signal;
    const recoveryWalk = harness.reactor.scanStartup(startupSignal);
    await recoveryStarted;

    let storeClosed = false;
    const shutdown = (async () => {
      harness.reactorLifetime.abort();
      await harness.reactor.dispose();
      harness.db.close();
      openDbs.delete(harness.db);
      storeClosed = true;
    })();

    expect(recoverySignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(storeClosed).toBe(false);

    releaseRecovery();
    await expect(recoveryWalk).rejects.toMatchObject({ name: 'AbortError' });
    await shutdown;
    expect(storeClosed).toBe(true);
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

    await harness.reactor.scanStartup(harness.reactorLifetime.signal);
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

    await harness.reactor.scanStartup(harness.reactorLifetime.signal);

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

  it('expires a pending continuation lease by timer and discards without later terminal or release events', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-lease-timer';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-lease-timer.jsonl');
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);

    await harness.reactor.scanStartup(harness.reactorLifetime.signal);
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
    await harness.reactor.dispose();
  });
});
import { initTestJob } from '#tests/helpers/session.js';
