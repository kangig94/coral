import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as RetentionWorkItemRecoverySourceModule from '#src/sessions/retention-work-item-recovery-source.js';
import type * as SessionStartupRecoveryModule from '#src/sessions/startup-recovery.js';

import { defineRecoverySource } from '#src/recovery/containment.js';
import {
  retentionWorkItemRecoverySource,
  type RawRetentionWorkItem,
} from '#src/sessions/retention-work-item-recovery-source.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { createRecoveryQuarantineRetryService, createRecoverySourceRegistry } from '#src/recovery/source-registry.js';
import type { RecoveryObservation } from '#src/recovery/phase-observation.js';

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
import {
  createLifecycleReactor,
  createRetentionWorkRetryPlan,
  isLifecycleRetentionAdmitted,
} from '#src/sessions/lifecycle-reactor.js';
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

vi.mock('#src/sessions/retention-work-item-recovery-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RetentionWorkItemRecoverySourceModule>();
  return { ...actual, retentionWorkItemRecoverySource: vi.fn(actual.retentionWorkItemRecoverySource) };
});

const openDbs = new Set<Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
  vi.restoreAllMocks();
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
  readonly logs: string[];
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
  const logs: string[] = [];
  const reactor = createLifecycleReactor({
    bootId: () => 'reactor-test-boot',
    db: () => db,
    readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
    providers: providerRegistry,
    runtime,
    time: runtime.time,
    commitEvents: coordinatorCommit,
    signal: reactorLifetime.signal,
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
    reactorLifetime,
    discardCalls,
    appendedBatches,
    logs,
  };
}

async function admitRetention(harness: Harness): Promise<void> {
  harness.reactor.admitRetention();
  await harness.reactor.waitForIdle();
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
    await admitRetention(harness);
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
    await admitRetention(harness);
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
    await admitRetention(harness);
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
    await admitRetention(harness);
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
    await admitRetention(harness);
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

  it('finishes an event-triggered background observation when recovery rejects', async () => {
    const harness = createHarness();
    const jobId = 'job-observed-lease';
    const sessionId = await openClaimedSession(harness, jobId);
    const failure = new Error('recovery source failed');
    vi.mocked(runSessionStartupRecovery).mockImplementationOnce(async () => {
      harness.runtime.time.tick(25);
      throw failure;
    });

    recordContinuationLease(harness, sessionId, jobId);
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);

    const phases = harness.logs.filter((line) => line.startsWith('recovery-phase '));
    expect(phases).toHaveLength(2);
    expect(phases[0]).toContain('boot=reactor-test-boot kind=background phase=reactor-recovery event=start');
    expect(phases[1]).toContain('event=finish outcome=failed duration_ms=25.000 subjects=0 reads=0 sources={}');
    await harness.reactor.dispose();
  });

  it('reports one background recovery pair for a queue drain with per-source counters', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    await admitRetention(harness);
    harness.logs.length = 0;
    const jobId = 'job-observed-drain';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);
    const terminal = completeJobViaCoordinatorCommit(harness, jobId, sessionId);
    const beforeRelease = harness.appendedBatches.length;
    harness.sessionManager.releaseJob(sessionId, jobId);
    const released = harness.appendedBatches.slice(beforeRelease).flat();

    harness.reactor.observe([...terminal, ...released]);
    await harness.reactor.waitForIdle();

    const phases = harness.logs.filter((line) => line.startsWith('recovery-phase '));
    expect(phases).toHaveLength(2);
    expect(phases[0]).toBe(
      'recovery-phase boot=reactor-test-boot kind=background phase=reactor-recovery event=start subjects=0 reads=0 sources={}\n',
    );
    expect(phases[1]).toMatch(/event=finish outcome=complete duration_ms=\d+\.\d{3} subjects=\d+ reads=\d+/);
    expect(JSON.parse(/ sources=(.*)\n$/.exec(phases[1])![1])).toEqual({
      'session-projection': { subjects: 1, reads: 1 },
      'session-continuation-lease': { subjects: 0, reads: 0 },
      'terminal-retention-outcome': { subjects: 0, reads: 0 },
      'retention-release-pair': { subjects: 2, reads: 2 },
      'session-retention-work': { subjects: 1, reads: 0 },
    });
    await harness.reactor.dispose();
  });

  it('startup discovers existing terminal and release pairs and admission backfills them', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-startup-scan';
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    await harness.reactor.waitForIdle();

    expect(readRetentionEvents(harness, sessionId)).toEqual([]);

    await harness.reactor.scanStartup(harness.reactorLifetime.signal);
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    await admitRetention(harness);

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

  it.each([-100, 100, 300])(
    'preserves a claimed session version until release with a lease expiring in %s ms',
    async (expiresInMs) => {
      const harness = createHarness();
      await admitRetention(harness);
      const jobId = 'job-live-lease';
      const sessionId = await openClaimedSession(harness, jobId);
      await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-live-lease.jsonl');
      initRunningJob(harness, jobId, sessionId);
      recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + expiresInMs);
      const claimedSession = readProjectionProviderSession(harness.db, sessionId);

      await harness.reactor.scanStartup(harness.reactorLifetime.signal);
      harness.runtime.time.tick(200);
      await harness.reactor.waitForIdle();

      expect(readProjectionProviderSession(harness.db, sessionId)).toEqual(claimedSession);
      expect(harness.discardCalls).toEqual([]);

      completeJob(harness, jobId, sessionId);
      await harness.reactor.waitForIdle();
      expect(readProjectionProviderSession(harness.db, sessionId)).toEqual(claimedSession);

      harness.sessionManager.releaseJob(sessionId, jobId);
      await harness.reactor.waitForIdle();
      if (expiresInMs > 200) {
        expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease?.status).toBe('pending');
        harness.runtime.time.tick(expiresInMs - 200);
        await harness.reactor.waitForIdle();
      }

      expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease).toMatchObject({
        status: 'expired',
      });
      expect(harness.discardCalls).toEqual([['/tmp/rollout-live-lease.jsonl']]);
      await harness.reactor.dispose();
    },
  );

  it('expires a pending continuation lease by timer and discards without later terminal or release events', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const jobId = 'job-lease-timer';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-lease-timer.jsonl');
    initRunningJob(harness, jobId, sessionId);
    completeJobViaCoordinatorCommit(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);

    await harness.reactor.scanStartup(harness.reactorLifetime.signal);
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);
    expect(harness.logs.filter((line) => line.startsWith('recovery-phase '))).toEqual([]);

    harness.runtime.time.tick(100);
    await harness.reactor.waitForIdle();
    expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease?.status).toBe('expired');
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);
    harness.logs.length = 0;
    await admitRetention(harness);

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
    const phases = harness.logs.filter((line) => line.startsWith('recovery-phase '));
    expect(phases).toHaveLength(2);
    expect(phases[0]).toContain('boot=reactor-test-boot kind=background phase=reactor-recovery event=start');
    expect(phases[1]).toMatch(/event=finish outcome=complete duration_ms=\d+\.\d{3}/);
    expect(JSON.parse(/ sources=(.*)\n$/.exec(phases[1])![1])).toEqual({
      'session-projection': { subjects: 1, reads: 1 },
      'session-continuation-lease': { subjects: 1, reads: 1 },
      'terminal-retention-outcome': { subjects: 0, reads: 0 },
      'retention-release-pair': { subjects: 2, reads: 2 },
      'session-retention-work': { subjects: 1, reads: 0 },
    });
    await harness.reactor.dispose();
  });
});
import { initTestJob } from '#tests/helpers/session.js';

describe('LifecycleReactor retention admission and failure ownership', () => {
  async function seedEligible(harness: Harness, jobId: string): Promise<string> {
    const sessionId = await openClaimedSession(harness, jobId);
    initRunningJob(harness, jobId, sessionId);
    completeJobViaCoordinatorCommit(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    return sessionId;
  }

  it('discovers all startup work in component-scan time and settles only after idempotent admission', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const sessions = [];
    for (let index = 0; index < 3; index += 1) sessions.push(await seedEligible(harness, `startup-${index}`));
    const settle = vi.spyOn(harness.reactor, 'enforceRetention');
    const record = vi.fn<RecoveryObservation['record']>();
    const before = harness.runtime.time.now();

    await harness.reactor.scanStartup(harness.reactorLifetime.signal, { record });

    expect(harness.runtime.time.now()).toBe(before);
    expect(record).toHaveBeenCalledWith('session-retention-work', { subjects: 3 });
    expect(settle).not.toHaveBeenCalled();
    expect(harness.discardCalls).toEqual([]);
    expect(harness.db.prepare('SELECT * FROM recovery_quarantine').all()).toEqual([]);
    for (const sessionId of sessions) expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(isLifecycleRetentionAdmitted(harness.db)).toBe(false);

    harness.reactor.admitRetention();
    harness.reactor.admitRetention();
    await harness.reactor.waitForIdle();

    expect(isLifecycleRetentionAdmitted(harness.db)).toBe(true);
    expect(settle).toHaveBeenCalledTimes(3);
    for (const sessionId of sessions) {
      expect(readRetentionEvents(harness, sessionId).map(({ type }) => type)).toEqual([
        'session.retention.discard.requested',
        'session.retention.discard.completed',
      ]);
    }
    expect(harness.logs.filter((line) => line.includes('event=start'))).toHaveLength(1);
    await harness.reactor.dispose();
  });

  it('releases deferred drain pairs and re-derives them on admission', async () => {
    const harness = createHarness();
    const sessionId = await seedEligible(harness, 'deferred-drain');
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.discardCalls).toEqual([]);
    const passes = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    await harness.reactor.waitForIdle();
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(passes);
    await admitRetention(harness);
    expect(readRetentionEvents(harness, sessionId)).toHaveLength(2);
    await harness.reactor.dispose();
  });

  it('runs an admitted pass when admission arrives after the final rerun check', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const sessionId = await seedEligible(harness, 'completion-admission');
    const passes = vi.spyOn(
      harness.reactor as unknown as { performContainedRecovery(signal: AbortSignal): Promise<void> },
      'performContainedRecovery',
    );
    const startup = harness.reactor.scanStartup(harness.reactorLifetime.signal);
    const deferredPass = passes.mock.results[0].value;
    await deferredPass.then(() => {
      expect(readRetentionEvents(harness, sessionId)).toEqual([]);
      queueMicrotask(() => harness.reactor.admitRetention());
    });
    await startup;
    await harness.reactor.waitForIdle();

    expect(passes).toHaveBeenCalledTimes(2);
    expect(readRetentionEvents(harness, sessionId).map(({ type }) => type)).toEqual([
      'session.retention.discard.requested',
      'session.retention.discard.completed',
    ]);
    await harness.reactor.dispose();
  });

  it('recovers lease events and timers while deferred without retention effects', async () => {
    const harness = createHarness();
    const jobId = 'deferred-lease';
    const sessionId = await seedEligible(harness, jobId);
    await harness.reactor.waitForIdle();
    recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);
    await harness.reactor.waitForIdle();
    expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease?.status).toBe('pending');
    harness.runtime.time.tick(100);
    await harness.reactor.waitForIdle();
    expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease?.status).toBe('expired');
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(harness.db.prepare('SELECT * FROM recovery_quarantine').all()).toEqual([]);
    expect(harness.discardCalls).toEqual([]);
    await admitRetention(harness);
    expect(readRetentionEvents(harness, sessionId)).toHaveLength(2);
    await harness.reactor.dispose();
  });

  it('refuses direct retry plans without a registered reactor even for absent subjects', async () => {
    const runtime = new SimulationRuntime();
    const db = openTestStoreDb(runtime, ':memory:');
    openDbs.add(db);
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    const subject = { key: 'absent\u0000job', revision: { kind: 'fingerprint' as const, value: 'revision' } };

    await expect(createRetentionWorkRetryPlan(db, subject, new AbortController().signal, quarantine)).rejects.toThrow(
      'not admitted',
    );
  });

  it('refuses direct retry plans for deferred reactors even for absent subjects', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const quarantine = new RecoveryQuarantineStore(harness.db, harness.runtime.time);
    const subject = { key: 'absent\u0000job', revision: { kind: 'fingerprint' as const, value: 'revision' } };
    expect(isLifecycleRetentionAdmitted(harness.db)).toBe(false);
    await expect(
      createRetentionWorkRetryPlan(harness.db, subject, harness.reactorLifetime.signal, quarantine),
    ).rejects.toThrow('not admitted');
    await harness.reactor.scanStartup(harness.reactorLifetime.signal);
    await expect(
      createRetentionWorkRetryPlan(harness.db, subject, harness.reactorLifetime.signal, quarantine),
    ).rejects.toThrow('not admitted');
    await admitRetention(harness);
    const plan = await createRetentionWorkRetryPlan(harness.db, subject, harness.reactorLifetime.signal, quarantine);
    expect(plan.source.boundary).toBe('session-retention-work');
    await harness.reactor.dispose();
  });

  it('preserves an existing real retention quarantine until admission permits exact absence completion', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const quarantine = new RecoveryQuarantineStore(harness.db, harness.runtime.time);
    const subject = { key: 'missing\u0000job', revision: { kind: 'fingerprint' as const, value: 'revision' } };
    expect(
      quarantine.upsert({
        boundary: 'session-retention-work',
        subject,
        state: 'active',
        stage: 'settle',
        errorMessage: 'previous failure',
        detail: 'retention retry retained',
      }),
    ).toBe(true);
    const sources = createRecoverySourceRegistry();
    sources.register('session-retention-work', (exact, signal, port) =>
      createRetentionWorkRetryPlan(harness.db, exact, signal, port),
    );
    const ids = { uuid: vi.fn(() => 'retry-token') };
    const claim = vi.spyOn(quarantine, 'claimRetry');
    const reclaim = vi.spyOn(quarantine, 'reclaimRetry');
    const retry = createRecoveryQuarantineRetryService({
      instanceId: 'reactor-process',
      ids,
      quarantine,
      sources,
      isRetryAdmitted: () => isLifecycleRetentionAdmitted(harness.db),
    });
    const request = { boundary: 'session-retention-work', key: subject.key, revision: 'revision' };
    const before = harness.db.prepare('SELECT * FROM recovery_quarantine').all();
    await harness.reactor.scanStartup(harness.reactorLifetime.signal);
    await expect(retry.clear(request)).rejects.toMatchObject({ code: 'retention-not-admitted' });
    expect(harness.db.prepare('SELECT * FROM recovery_quarantine').all()).toEqual(before);
    expect(ids.uuid).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(reclaim).not.toHaveBeenCalled();
    expect(harness.discardCalls).toEqual([]);
    await admitRetention(harness);
    await expect(retry.clear(request)).resolves.toEqual({ ...request, disposition: 'advanced' });
    expect(claim).toHaveBeenCalledOnce();
    expect(quarantine.read('session-retention-work', subject.key)).toBeNull();
    await harness.reactor.dispose();
  });

  it.each(['failure', 'abort'] as const)(
    'propagates discovery %s at startup without count evidence or a re-arm',
    async (mode) => {
      const harness = createHarness({ autoObserveCoordinator: false });
      await seedEligible(harness, `startup-${mode}`);
      const abort = new AbortController();
      const failure = new Error('composition scan failed');
      const record = vi.fn<RecoveryObservation['record']>();
      const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
      vi.mocked(retentionWorkItemRecoverySource).mockImplementationOnce(() =>
        defineRecoverySource<RawRetentionWorkItem>({
          boundary: 'session-retention-work',
          scanSubject: { key: 'composition', revision: { kind: 'until-cleared' } },
          scan: async () => {
            if (mode === 'abort') {
              abort.abort();
              abort.signal.throwIfAborted();
            }
            throw failure;
          },
          subject: (raw) => raw.subject,
        }),
      );
      const scan = harness.reactor.scanStartup(abort.signal, { record });
      if (mode === 'abort') await expect(scan).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(scan).rejects.toBe(failure);
      expect(record.mock.calls.filter(([source]) => source === 'session-retention-work')).toEqual([]);
      expect(timers).not.toHaveBeenCalled();
      expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toEqual([]);
      await harness.reactor.dispose();
    },
  );

  it('re-arms a rejected admission pass with an empty queue and later settles', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const sessionId = await seedEligible(harness, 'admission-retry');
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    const failure = new Error('temporary admission failure');
    vi.mocked(runSessionStartupRecovery).mockRejectedValueOnce(failure);
    harness.reactor.admitRetention();
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    await harness.reactor.waitForIdle();
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([30_000]);
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toHaveLength(1);
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    harness.runtime.time.tick(29_999);
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    harness.runtime.time.tick(1);
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toHaveLength(2);
    await harness.reactor.dispose();
  });

  it('uses the same owner for a live drain failure and coalesces events without consuming queued pairs', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    await admitRetention(harness);
    const sessionId = await seedEligible(harness, 'live-drain');
    const observed = harness.appendedBatches.flat();
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    const failure = new Error('live drain failed');
    vi.mocked(runSessionStartupRecovery).mockRejectedValueOnce(failure);
    harness.reactor.observe(observed);
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    await harness.reactor.waitForIdle();
    const passes = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    harness.reactor.observe(observed);
    harness.reactor.observe(observed);
    await harness.reactor.waitForIdle();
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(passes);
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([30_000]);
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toHaveLength(1);
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    harness.runtime.time.tick(30_000);
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toHaveLength(2);
    const settledPasses = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    harness.runtime.time.tick(300_000);
    await harness.reactor.waitForIdle();
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(settledPasses);
    await harness.reactor.dispose();
  });

  it('logs and re-arms once when admission, lease events and drains join a rejected promise', async () => {
    const harness = createHarness();
    const jobId = 'joined-failure';
    const sessionId = await openClaimedSession(harness, jobId);
    let reject!: (reason: Error) => void;
    vi.mocked(runSessionStartupRecovery).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    harness.reactor.admitRetention();
    recordContinuationLease(harness, sessionId, jobId);
    initRunningJob(harness, jobId, sessionId);
    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    const failure = new Error('shared failure');
    const idle = expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    reject(failure);
    await idle;
    await harness.reactor.waitForIdle();
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toHaveLength(1);
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([30_000]);
    await harness.reactor.dispose();
  });

  it('exhausts three re-arms and only a successful fresh pass restores the budget', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const sessionId = await seedEligible(harness, 'exhausted');
    const observed = harness.appendedBatches.flat();
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    const failure = new Error('persistent failure');
    for (let index = 0; index < 5; index += 1) vi.mocked(runSessionStartupRecovery).mockRejectedValueOnce(failure);
    harness.reactor.admitRetention();
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    await harness.reactor.waitForIdle();
    for (const delay of [30_000, 60_000, 120_000]) {
      harness.runtime.time.tick(delay);
      await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
      await harness.reactor.waitForIdle();
    }
    const exhaustedPasses = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    harness.runtime.time.tick(1_000_000);
    await harness.reactor.waitForIdle();
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(exhaustedPasses);
    harness.reactor.observe(observed);
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    await harness.reactor.waitForIdle();
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([30_000, 60_000, 120_000]);
    const afterFreshFailure = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    harness.runtime.time.tick(1_000_000);
    await harness.reactor.waitForIdle();
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(afterFreshFailure);
    harness.reactor.observe(observed);
    await harness.reactor.waitForIdle();
    expect(readRetentionEvents(harness, sessionId)).toHaveLength(2);
    vi.mocked(runSessionStartupRecovery).mockRejectedValueOnce(failure);
    harness.reactor.observe(observed);
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    await harness.reactor.waitForIdle();
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([30_000, 60_000, 120_000, 30_000]);
    await harness.reactor.dispose();
  });

  it.each(['event', 'timer'] as const)('re-arms a lease %s failure even without pending pairs', async (trigger) => {
    const harness = createHarness();
    await admitRetention(harness);
    const jobId = `lease-failure-${trigger}`;
    const sessionId = await openClaimedSession(harness, jobId);
    const failure = new Error('lease pass failed');
    if (trigger === 'timer') {
      recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);
      await harness.reactor.waitForIdle();
      harness.sessionManager.releaseJob(sessionId, jobId);
      await harness.reactor.waitForIdle();
    }
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    vi.mocked(runSessionStartupRecovery).mockRejectedValueOnce(failure);
    if (trigger === 'event') recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);
    else harness.runtime.time.tick(100);
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    await harness.reactor.waitForIdle();
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([30_000]);
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toHaveLength(1);
    harness.runtime.time.tick(30_000);
    await harness.reactor.waitForIdle();
    if (trigger === 'timer') {
      expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease?.status).toBe('expired');
    }
    expect(harness.logs.some((line) => line.includes('event=finish outcome=complete'))).toBe(true);
    await harness.reactor.dispose();
  });

  it('quarantines a contained subject fault without treating the pass as rejected', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const sessionId = await seedEligible(harness, 'contained-fault');
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    vi.spyOn(harness.reactor, 'enforceRetention').mockRejectedValueOnce(new Error('subject failed'));
    harness.reactor.admitRetention();
    await harness.reactor.waitForIdle();
    expect(
      harness.db
        .prepare('SELECT state, stage FROM recovery_quarantine WHERE boundary_id = ?')
        .get('session-retention-work'),
    ).toEqual({ state: 'active', stage: 'settle' });
    expect(readRetentionEvents(harness, sessionId)).toEqual([]);
    expect(timers).not.toHaveBeenCalled();
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toEqual([]);
    await harness.reactor.dispose();
  });

  it('keeps startup ownership when background callers join its rejected promise', async () => {
    const harness = createHarness();
    const sessionId = await openClaimedSession(harness, 'startup-owner');
    let reject!: (reason: Error) => void;
    vi.mocked(runSessionStartupRecovery).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    const failure = new Error('startup failed');
    const startup = expect(harness.reactor.scanStartup(harness.reactorLifetime.signal)).rejects.toBe(failure);
    harness.reactor.admitRetention();
    recordContinuationLease(harness, sessionId, 'startup-owner');
    reject(failure);
    await startup;
    expect(timers).not.toHaveBeenCalled();
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toEqual([]);
    await harness.reactor.dispose();
  });

  it('cancels a re-arm and refuses an already queued callback after disposal', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    const failure = new Error('schedule then dispose');
    vi.mocked(runSessionStartupRecovery).mockRejectedValueOnce(failure);
    harness.reactor.admitRetention();
    await expect(harness.reactor.waitForIdle()).rejects.toBe(failure);
    const callback = timers.mock.calls[0]?.[0];
    expect(callback).toBeDefined();
    const passes = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    await harness.reactor.dispose();
    callback();
    harness.runtime.time.tick(1_000_000);
    harness.reactor.admitRetention();
    harness.reactor.observe([]);
    await harness.reactor.waitForIdle();
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(passes);
  });

  it('cancels a continuation lease timer and its already queued callback on disposal', async () => {
    const harness = createHarness();
    await admitRetention(harness);
    const jobId = 'dispose-lease';
    const sessionId = await openClaimedSession(harness, jobId);
    recordContinuationLease(harness, sessionId, jobId, harness.runtime.time.now() + 100);
    await harness.reactor.waitForIdle();
    const timers = vi.spyOn(harness.runtime.time, 'setTimeout');
    harness.sessionManager.releaseJob(sessionId, jobId);
    await harness.reactor.waitForIdle();
    const callback = timers.mock.calls.find(([, delay]) => delay === 100)?.[0];
    expect(callback).toBeDefined();
    const passes = vi.mocked(runSessionStartupRecovery).mock.calls.length;
    await harness.reactor.dispose();
    callback!();
    harness.runtime.time.tick(1_000);
    expect(vi.mocked(runSessionStartupRecovery).mock.calls).toHaveLength(passes);
    expect(readProjectionProviderSession(harness.db, sessionId)?.continuationLease?.status).toBe('pending');
  });

  it('leaves later subjects untouched when disposal interrupts an admitted pass', async () => {
    const harness = createHarness({ autoObserveCoordinator: false });
    const first = await seedEligible(harness, 'dispose-first');
    const second = await seedEligible(harness, 'dispose-second');
    const original = harness.reactor.enforceRetention.bind(harness.reactor);
    let disposal: Promise<void> | undefined;
    const settle = vi.spyOn(harness.reactor, 'enforceRetention').mockImplementationOnce(async (work) => {
      const result = await original(work);
      disposal = harness.reactor.dispose();
      return result;
    });
    harness.reactor.admitRetention();
    await harness.reactor.waitForIdle().catch((error: unknown) => {
      expect(error).toMatchObject({ name: 'AbortError' });
    });
    expect(disposal).toBeDefined();
    await disposal;
    expect(settle).toHaveBeenCalledOnce();
    const settledSession = settle.mock.calls[0]?.[0].sessionId;
    expect([first, second]).toContain(settledSession);
    for (const sessionId of [first, second]) {
      expect(readRetentionEvents(harness, sessionId)).toHaveLength(sessionId === settledSession ? 2 : 0);
    }
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toEqual([]);
  });

  it('aborts inside provider discard, waits for recovery and appends no completion after disposal', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      autoObserveCoordinator: false,
      discardArtifacts: async () => {
        started();
        await blocked;
        return { kind: 'discarded' };
      },
    });
    const jobId = 'dispose-in-discard';
    const sessionId = await openClaimedSession(harness, jobId);
    await recordArtifact(harness, sessionId, jobId, '/tmp/dispose-in-discard.jsonl');
    initRunningJob(harness, jobId, sessionId);
    completeJobViaCoordinatorCommit(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);
    harness.reactor.admitRetention();
    await entered;
    const events = readRetentionEvents(harness, sessionId);
    expect(events.map(({ type }) => type)).toEqual(['session.retention.discard.requested']);
    const disposal = harness.reactor.dispose();
    release();
    await disposal;
    expect(readRetentionEvents(harness, sessionId)).toEqual(events);
    expect(harness.logs.filter((line) => line.includes('reactor failed:'))).toEqual([]);
    expect(
      harness.db.prepare('SELECT state FROM recovery_quarantine WHERE boundary_id = ?').get('session-retention-work'),
    ).toEqual({ state: 'continuation' });
  });
});
