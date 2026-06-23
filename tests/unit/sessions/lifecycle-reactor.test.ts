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
import type { SessionEntry } from '#src/sessions/entry.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
} from '#src/sessions/retention-outbox.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { readProjectionSessionEntry } from '#src/sessions/projections.js';
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
    locateArtifact?: (conversationRef: string) => string | null;
    afterCommit?: (appended: readonly AppendedEvent[], commitEvents: CommitEventsFn) => void;
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
              ...(options.locateArtifact !== undefined
                ? { locateArtifact: (conversationRef: string) => options.locateArtifact!(conversationRef) }
                : {}),
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
    options.afterCommit?.(appended, coordinatorCommit);
    if (autoObserveCoordinator && appended.length > 0) {
      reactor.observe(appended);
    }
    return appended;
  };
  const reactor = createLifecycleReactor({
    db: () => db,
    providers: providerRegistry,
    runtime,
    time: runtime.time,
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

function recordContinuationLease(
  harness: Harness,
  sessionId: string,
  staleJobId: string,
  expiresAtMs = harness.runtime.time.now() + 60_000,
): void {
  harness.sessionManager.recordContinuationLease({
    sessionId,
    jobId: staleJobId,
    reason: 'stale_recovery',
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

function appendContinuationLeaseRecord(
  commitEvents: CommitEventsFn,
  entry: SessionEntry,
  staleJobId: string,
  expiresAtMs: number,
): void {
  const lease = {
    status: 'pending' as const,
    staleJobId,
    reason: 'stale_recovery' as const,
    expiresAt: new Date(expiresAtMs).toISOString(),
    recordedAt: new Date(expiresAtMs - 1).toISOString(),
  };
  const nextEntry: SessionEntry = {
    ...entry,
    continuationLease: lease,
    version: entry.version + 1,
  };
  commitEvents((c) => {
    c.append({
      type: 'session.continuation_lease.recorded',
      stream: { kind: 'session', id: entry.sessionId },
      refs: { sessionId: entry.sessionId, jobId: staleJobId },
      bodyVersion: 1,
      body: {
        entry: nextEntry,
        sessionId: entry.sessionId,
        lease,
      },
    });
    return undefined;
  });
}

function initRunningJob(
  harness: Harness,
  jobId: string,
  sessionId: string,
  jobKind: 'provider' | 'workflow' = 'provider',
) {
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
    await expect(
      harness.sessionManager.claimForJobAtomic(sessionId, resumedJobId, afterStaleRelease.version),
    ).resolves.toBe(true);
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
        const entry = readProjectionSessionEntry(harness.db, protectedSessionId);
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

  it('falls back to provider locateArtifact when no handle was recorded but a conversationRef exists', async () => {
    const harness = createHarness({
      locateArtifact: (conversationRef) =>
        conversationRef === 'thread-fallback' ? '/tmp/rollout-thread-fallback.jsonl' : null,
    });
    const jobId = 'job-locate-fallback';
    const sessionId = await openClaimedSession(harness, jobId);
    harness.sessionManager.setConversationRef(sessionId, 'thread-fallback');
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
    harness.sessionManager.setConversationRef(sessionId, 'thread-missing');
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

  it('prefers an in-run recorded handle over the locateArtifact fallback', async () => {
    const locateSpy = vi.fn((_ref: string) => '/tmp/should-not-be-used.jsonl');
    const harness = createHarness({ locateArtifact: locateSpy });
    const jobId = 'job-handle-precedence';
    const sessionId = await openClaimedSession(harness, jobId);
    harness.sessionManager.setConversationRef(sessionId, 'thread-precedence');
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-recorded.jsonl');
    initRunningJob(harness, jobId, sessionId);

    completeJob(harness, jobId, sessionId);
    harness.sessionManager.releaseJob(sessionId, jobId);

    await expectRetentionEvents(harness, sessionId, [
      { type: 'session.retention.discard.requested', attempt: 1, handles: ['/tmp/rollout-recorded.jsonl'] },
      {
        type: 'session.retention.discard.completed',
        attempt: 1,
        handles: ['/tmp/rollout-recorded.jsonl'],
        outcome: 'discarded',
      },
    ]);
    expect(harness.discardCalls).toEqual([['/tmp/rollout-recorded.jsonl']]);
    expect(locateSpy).not.toHaveBeenCalled();
  });

  it('discardSessionArtifacts discards recorded handles on demand, bypassing the retain gate', async () => {
    const harness = createHarness();
    const jobId = 'job-ondemand';
    const sessionId = await openClaimedSession(harness, jobId, 'retain');
    await recordArtifact(harness, sessionId, jobId, '/tmp/rollout-ondemand.jsonl');

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
    harness.sessionManager.setConversationRef(sessionId, 'thread-ondemand');

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
        createInvocationContext: (projectRoot) => ({
          projectRoot,
          pluginRoot: projectRoot,
          coralEnv: {},
          authority: 'admin',
        }),
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
        createInvocationContext: (projectRoot) => ({
          projectRoot,
          pluginRoot: projectRoot,
          coralEnv: {},
          authority: 'admin',
        }),
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
