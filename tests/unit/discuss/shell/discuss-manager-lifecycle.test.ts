import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import {
  clearAllDiscuss,
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
  listAttachedSessions,
} from '#src/discuss/shell/live-registry.js';
import { abortDiscussSession, submitManualBid } from '#src/discuss/shell/operations.js';
import { persistAbortEndForShutdown, recoverPersistedSessionsFromStore } from '#src/discuss/shell/recovery.js';
import {
  appendRuntimeEvents,
  commitDecision,
  isSilentCommitRefusal,
  readSessionEvents,
} from '#src/discuss/shell/persistence.js';
import * as discussPersistence from '#src/discuss/shell/persistence.js';
import { SESSION_SHUTTING_DOWN, DiscussManagerError } from '#src/discuss/shell/errors.js';
import { runFollowUpTurns } from '#src/discuss/shell/flow/followup.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { detachSession } from '#src/discuss/shell/registry.js';
import { decideEnd } from '#src/discuss/state-machine.js';
import { makeDecisionContext } from '#src/discuss/shell/flow/primitives.js';
import {
  attachPersistedSession,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  discussContextOptions,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

async function recoverSessions(harness: DiscussHarness) {
  return recoverPersistedSessionsFromStore(
    harness.store,
    () => harness.context,
    (snapshot) => ({
      projectRoot: fixtureCanonicalWorkDir(snapshot.projectRoot),
      pluginRoot: harness.ctx.pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(snapshot.projectRoot),
      providerScope: snapshot.providerScope ?? harness.ctx.providerScope,
    }),
  );
}

describe('DiscussContext lifecycle boundaries', () => {
  afterEach(() => {
    cleanupDiscussHarnesses();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it('keeps attached-session iteration separate from persisted store summaries', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );

    const liveSnapshot = await persistSession(
      { ...harness, context },
      {
        sessionId: 'live-session',
        recover: false,
      },
    );
    attachPersistedSession({ ...harness, context }, liveSnapshot);
    await persistSession(
      { ...harness, context },
      {
        sessionId: 'ended-session',
        recover: false,
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'session.ended',
            '2026-03-10T00:01:00.000Z',
            { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 2,
            'session.synthesized',
            '2026-03-10T00:01:01.000Z',
            { synthesis: 'done' },
          ),
        ],
      },
    );

    expect(listAttachedSessions(registry).map((session) => session.sessionId)).toEqual(['live-session']);
    expect(
      harness.store
        .listSummaries()
        .map((summary) => summary.sessionId)
        .sort(),
    ).toEqual(['ended-session', 'live-session']);

    detachSession(context, 'live-session');
    expect(hasRunningSessions(registry)).toBe(false);
    expect(harness.store.listSummaries()).toHaveLength(2);
  });

  it('persisted ended sessions do not count as running sessions', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );
    await persistSession(harness, {
      sessionId: 'ended-session',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'session.synthesized',
          '2026-03-10T00:01:01.000Z',
          { synthesis: 'done' },
        ),
      ],
    });

    expect(hasRunningSessions(registry)).toBe(false);
    expect(listAttachedSessions(registry)).toEqual([]);
    expect(harness.store.listSummaries()).toHaveLength(1);
  });

  it('hard shutdown persists abort markers for recoverable attached sessions and skips terminal attached history', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );

    const liveSnapshot = await persistSession(
      { ...harness, context },
      {
        sessionId: 'live-session',
        recover: false,
      },
    );
    attachPersistedSession({ ...harness, context }, liveSnapshot);

    const synthSnapshot = await persistSession(
      { ...harness, context },
      {
        sessionId: 'ended-synthesize-session',
        recover: false,
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'session.ended',
            '2026-03-10T00:01:00.000Z',
            {
              endReason: 'all_blocked',
              endReasonContent: 'All blocked.',
            },
          ),
        ],
      },
    );
    attachPersistedSession({ ...harness, context }, synthSnapshot);

    const terminalSnapshot = await persistSession(
      { ...harness, context },
      {
        sessionId: 'terminal-ended-session',
        recover: false,
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'session.ended',
            '2026-03-10T00:02:00.000Z',
            {
              endReason: 'all_blocked',
              endReasonContent: 'All blocked.',
            },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 2,
            'session.synthesized',
            '2026-03-10T00:02:01.000Z',
            {
              synthesis: 'done',
            },
          ),
        ],
      },
    );
    attachPersistedSession({ ...harness, context }, terminalSnapshot);

    const liveSession = context.sessions.get('live-session');
    const synthSession = context.sessions.get('ended-synthesize-session');
    const terminalSession = context.sessions.get('terminal-ended-session');

    await clearAllDiscuss(registry, 'hard', persistAbortEndForShutdown);

    expect(liveSession?.controller.signal.aborted).toBe(true);
    expect(synthSession?.controller.signal.aborted).toBe(true);
    expect(terminalSession?.controller.signal.aborted).toBe(true);
    expect(registry.contexts.size).toBe(0);

    const liveEvents = readSessionEvents(context, 'live-session');
    expect(liveEvents.at(-1)).toMatchObject({
      kind: 'session.ended',
      payload: { force: true, reason: 'abort' },
    });

    const synthEvents = readSessionEvents(context, 'ended-synthesize-session');
    expect(synthEvents.filter((event) => event.kind === 'session.ended')).toHaveLength(2);
    expect(synthEvents.at(-1)).toMatchObject({
      kind: 'session.ended',
      payload: { force: true, reason: 'abort' },
    });

    const terminalEvents = readSessionEvents(context, 'terminal-ended-session');
    expect(terminalEvents.filter((event) => event.kind === 'session.ended')).toHaveLength(1);
    expect(terminalEvents.at(-1)?.kind).toBe('session.synthesized');
  });

  it('handoff shutdown aborts attached sessions without persisting abort markers', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );

    const liveSnapshot = await persistSession(
      { ...harness, context },
      {
        sessionId: 'handoff-session',
        recover: false,
      },
    );
    attachPersistedSession({ ...harness, context }, liveSnapshot);

    const liveSession = context.sessions.get('handoff-session');
    await clearAllDiscuss(registry, 'handoff', persistAbortEndForShutdown);

    expect(liveSession?.controller.signal.aborted).toBe(true);
    expect(registry.contexts.size).toBe(0);
    expect(readSessionEvents(context, 'handoff-session').map((event) => event.kind)).toEqual([
      'session.created',
      'bidding.opened',
    ]);
  });

  it('commitDecision refuses a decided commit once the live controller signal is aborted', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'aborted-controller-session',
      recover: false,
    });
    attachPersistedSession(harness, snapshot);

    const session = harness.context.sessions.get('aborted-controller-session');
    if (!session) {
      throw new Error('Expected attached aborted-controller-session');
    }
    session.controller.abort();

    const committed = await commitDecision(harness.context, 'aborted-controller-session', (current) =>
      decideEnd(
        current.state,
        { force: true, reason: 'natural-completion-race' },
        makeDecisionContext(harness.context, current.sessionId, current.state.topic),
        current.lastAppliedSeq + 1,
        '2026-03-10T00:05:00.000Z',
      ),
    );

    expect(committed).toMatchObject({ ok: false, error: SESSION_SHUTTING_DOWN });
    expect(harness.store.load('aborted-controller-session')?.lastAppliedSeq).toBe(snapshot.lastAppliedSeq);
    expect(readSessionEvents(harness.context, 'aborted-controller-session').map((event) => event.kind)).toEqual([
      'session.created',
      'bidding.opened',
    ]);
  });

  it('hard shutdown aborts every live controller before persisting any abort marker, preempting a racing natural commit', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );

    const liveSnapshot = await persistSession(
      { ...harness, context },
      {
        sessionId: 'racing-session',
        recover: false,
      },
    );
    attachPersistedSession({ ...harness, context }, liveSnapshot);
    const liveSession = context.sessions.get('racing-session');
    if (!liveSession) {
      throw new Error('Expected attached racing-session');
    }

    // Stands in for a `continueLoop` invocation that was already scheduled before shutdown
    // began and only reaches its own commit once shutdown starts persisting the abort marker.
    let racingCommitResult: Awaited<ReturnType<typeof commitDecision>> | undefined;
    let signalAbortedWhenPersistRan: boolean | undefined;
    const persistAbortEndAndRaceNaturalCompletion = async (
      ctx: Parameters<typeof persistAbortEndForShutdown>[0],
      sessionId: string,
      session: Parameters<typeof persistAbortEndForShutdown>[2],
    ): Promise<void> => {
      signalAbortedWhenPersistRan = liveSession.controller.signal.aborted;
      racingCommitResult = await commitDecision(ctx, sessionId, (current) =>
        decideEnd(
          current.state,
          { force: true, reason: 'natural-completion-race' },
          makeDecisionContext(ctx, current.sessionId, current.state.topic),
          current.lastAppliedSeq + 1,
          '2026-03-10T00:05:00.000Z',
        ),
      );
      await persistAbortEndForShutdown(ctx, sessionId, session);
    };

    await clearAllDiscuss(registry, 'hard', persistAbortEndAndRaceNaturalCompletion);

    // The abort-first pass must have already run by the time the marker persistence
    // (and the racing commit it wraps) executes.
    expect(signalAbortedWhenPersistRan).toBe(true);
    expect(racingCommitResult).toMatchObject({ ok: false, error: SESSION_SHUTTING_DOWN });

    const events = readSessionEvents(context, 'racing-session');
    expect(events.at(-1)).toMatchObject({
      kind: 'session.ended',
      payload: { force: true, reason: 'abort' },
    });
  });

  it('isSilentCommitRefusal recognizes exactly the two commit-refusal codes internal flows must stop quietly on', () => {
    expect(isSilentCommitRefusal('session_not_found')).toBe(true);
    expect(isSilentCommitRefusal(SESSION_SHUTTING_DOWN)).toBe(true);
    expect(isSilentCommitRefusal('invalid_phase')).toBe(false);
    expect(isSilentCommitRefusal('already_bid')).toBe(false);
  });

  it('submitManualBid tells the caller the session is shutting down, not that it does not exist', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'shutdown-racing-bid-session',
      recover: false,
    });
    attachPersistedSession(harness, snapshot);

    const session = harness.context.sessions.get('shutdown-racing-bid-session');
    if (!session) {
      throw new Error('Expected attached shutdown-racing-bid-session');
    }
    // Exercises commitDecision's controller-aborted guard through submitManualBid, which
    // reads `error` directly instead of going through isSilentCommitRefusal (unlike the
    // internal flows), so it must surface SESSION_SHUTTING_DOWN rather than session_not_found.
    session.controller.abort();

    let thrown: unknown;
    try {
      await submitManualBid(harness.context, 'shutdown-racing-bid-session', 'alpha', 80, 'racing a drain', harness.ctx);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscussManagerError);
    expect((thrown as DiscussManagerError).code).toBe(SESSION_SHUTTING_DOWN);
    // The guard fires without removing anything from the store.
    expect(harness.store.load('shutdown-racing-bid-session')).not.toBeNull();
  });

  it('runFollowUpTurns exits once a tolerated commit refusal lands, instead of spinning forever', async () => {
    const start = vi.fn().mockResolvedValue({
      kind: 'provider-session' as const,
      status: 'running' as const,
      jobId: 'job-1',
      sessionId: 'agent-session-1',
    });
    const waitStreamOnce = vi.fn().mockResolvedValue({ content: 'An answer.', continuity: null });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    const snapshot = await persistSession(harness, {
      sessionId: 'follow-up-spin-session',
      recover: false,
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'follow_up.queue.set',
          '2026-03-10T00:02:00.000Z',
          { queue: [{ agent: 'alpha', question: 'What changed?' }] },
        ),
      ],
    });
    attachPersistedSession(harness, snapshot);

    const session = harness.context.sessions.get('follow-up-spin-session');
    if (!session) {
      throw new Error('Expected attached follow-up-spin-session');
    }
    // Stands in for clearAllDiscuss's abort-first pass racing a suspended runFollowUpTurns
    // iteration that resumes after the abort but before the registry finishes clearing.
    session.controller.abort();

    // Bounds a regression: without the fix, a tolerated refusal falls through instead of
    // returning, so runFollowUpTurns re-reads the same unwritten queue and calls
    // collectFollowUpAnswer again on every iteration, launching another job each time. This
    // spy fails the test the moment that happens a second time, instead of hanging the suite.
    const originalCommitDecision = discussPersistence.commitDecision;
    let commitCalls = 0;
    const COMMIT_CALL_BOUND = 1;
    vi.spyOn(discussPersistence, 'commitDecision').mockImplementation(async (...args) => {
      commitCalls += 1;
      if (commitCalls > COMMIT_CALL_BOUND) {
        throw new Error(
          `runFollowUpTurns issued a ${commitCalls}${
            commitCalls === 2 ? 'nd' : 'th'
          } commitDecision call after a tolerated refusal instead of returning`,
        );
      }
      return originalCommitDecision(...args);
    });

    const result = await runFollowUpTurns(harness.context, 'follow-up-spin-session', harness.ctx);

    expect(result).toEqual({ shouldResume: false });
    expect(commitCalls).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(harness.store.load('follow-up-spin-session')?.runtime.followUpQueue).toEqual([
      { agent: 'alpha', question: 'What changed?' },
    ]);
  });

  it('once clearAllDiscuss clears its sessions map, commitDecision can no longer observe the abort at all', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );

    const snapshot = await persistSession({ ...harness, context }, { sessionId: 'post-clear-session', recover: false });
    attachPersistedSession({ ...harness, context }, snapshot);

    await clearAllDiscuss(registry, 'hard', persistAbortEndForShutdown);

    // The guard in commitDecision reads ctx.sessions.get(sessionId)?.controller — once
    // clearAllDiscuss has cleared the map, that lookup returns nothing, so the guard cannot
    // fire here regardless of what the abort pass did.
    expect(context.sessions.get('post-clear-session')).toBeUndefined();

    // What keeps this window inert today is not commitDecision's guard: decideEnd refuses a
    // decision against a state.status already 'ended' on its own (the same shape as
    // buildBidBatch, in src/discuss/shell/flow/bid.ts, returning no events once
    // state.status is no longer 'bidding'). commitDecision's own short-circuit for an
    // empty decide result is what turns that refusal into a successful no-op commit here.
    const committed = await commitDecision(context, 'post-clear-session', (current) =>
      decideEnd(
        current.state,
        { force: true, reason: 'natural-completion-race' },
        makeDecisionContext(context, current.sessionId, current.state.topic),
        current.lastAppliedSeq + 1,
        '2026-03-10T00:06:00.000Z',
      ),
    );

    expect(committed).toMatchObject({ ok: true, events: [] });
    const events = readSessionEvents(context, 'post-clear-session');
    expect(events.at(-1)).toMatchObject({ kind: 'session.ended', payload: { force: true, reason: 'abort' } });
  });

  it('stale-write shutdown retry skips the abort marker once the session becomes terminal', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'stale-retry-session',
      recover: false,
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:03:00.000Z',
          {
            endReason: 'all_blocked',
            endReasonContent: 'All blocked.',
          },
        ),
      ],
    });
    attachPersistedSession(harness, snapshot);

    const session = harness.context.sessions.get('stale-retry-session');
    if (!session) {
      throw new Error('Expected attached stale-retry-session');
    }

    const originalAppend = harness.store.append.bind(harness.store);
    let injectedSynthesis = false;
    vi.spyOn(harness.store, 'append').mockImplementation(async (sessionId, expectedSeq, events) => {
      if (!injectedSynthesis) {
        injectedSynthesis = true;
        const current = harness.store.load(sessionId);
        if (!current) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await originalAppend(sessionId, current.lastAppliedSeq, [
          makeEvent(
            sessionId,
            harness.projectRoot,
            current.state.topic,
            current.lastAppliedSeq + 1,
            'session.synthesized',
            '2026-03-10T00:03:01.000Z',
            {
              synthesis: 'done',
            },
          ),
        ]);
      }
      return originalAppend(sessionId, expectedSeq, events);
    });

    await persistAbortEndForShutdown(harness.context, 'stale-retry-session', session);

    const events = readSessionEvents(harness.context, 'stale-retry-session');
    expect(events.filter((event) => event.kind === 'session.ended')).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe('session.synthesized');
    expect(harness.store.load('stale-retry-session')?.runtime.controlPhase).toBe('idle');
    expect(harness.context.sessions.get('stale-retry-session')?.snapshot.runtime.controlPhase).toBe('idle');
  });

  it('runtime append retries when live snapshot already advanced before stale handling', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'runtime-stale-race-session',
      recover: false,
    });
    attachPersistedSession(harness, snapshot);

    const session = harness.context.sessions.get('runtime-stale-race-session');
    if (!session) {
      throw new Error('Expected attached runtime-stale-race-session');
    }

    const originalAppend = harness.store.append.bind(harness.store);
    let injectedConcurrentAppend = false;
    vi.spyOn(harness.store, 'append').mockImplementation(async (sessionId, expectedSeq, events) => {
      if (!injectedConcurrentAppend) {
        injectedConcurrentAppend = true;
        const current = harness.store.load(sessionId);
        if (!current) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        const concurrent = await originalAppend(sessionId, current.lastAppliedSeq, [
          makeEvent(
            sessionId,
            harness.projectRoot,
            current.state.topic,
            current.lastAppliedSeq + 1,
            'bid.submitted',
            '2026-03-10T00:03:10.000Z',
            {
              agent: 'alpha',
              score: 42,
              thought: 'Concurrent bid.',
            },
          ),
        ]);
        session.snapshot = concurrent;
      }
      return originalAppend(sessionId, expectedSeq, events);
    });

    await appendRuntimeEvents(harness.context, 'runtime-stale-race-session', (current) => [
      makeEvent(
        current.sessionId,
        harness.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        'must_answer.carry_forward.set',
        '2026-03-10T00:03:11.000Z',
        { items: ['alpha\u0000What changed?'] },
      ),
    ]);

    const events = readSessionEvents(harness.context, 'runtime-stale-race-session');
    expect(events.map((event) => event.kind)).toEqual([
      'session.created',
      'bidding.opened',
      'bid.submitted',
      'must_answer.carry_forward.set',
    ]);
    expect(harness.store.load('runtime-stale-race-session')?.lastAppliedSeq).toBe(4);
    expect(session.snapshot.lastAppliedSeq).toBe(4);
  });

  it('user abort durably appends an abort marker for ended synthesize-window sessions and recovery skips them', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'user-abort-synthesize-session',
      recover: false,
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:04:00.000Z',
          {
            endReason: 'all_blocked',
            endReasonContent: 'All blocked.',
          },
        ),
      ],
    });
    attachPersistedSession(harness, snapshot);

    const liveSession = harness.context.sessions.get('user-abort-synthesize-session');
    expect(liveSession?.snapshot.state.status).toBe('ended');
    expect(liveSession?.snapshot.runtime.controlPhase).toBe('synthesize');

    await abortDiscussSession(harness.context, 'user-abort-synthesize-session');

    const events = readSessionEvents(harness.context, 'user-abort-synthesize-session');
    const abortMarkers = events.filter((event) => event.kind === 'session.ended' && event.payload.reason === 'abort');

    expect(liveSession?.controller.signal.aborted).toBe(true);
    expect(harness.context.sessions.get('user-abort-synthesize-session')).toBeUndefined();
    expect(abortMarkers).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'session.ended',
      payload: { endReasonContent: 'abort', force: true, reason: 'abort' },
    });

    const recovered = await recoverSessions(harness);

    expect(recovered.map((session) => session.sessionId)).not.toContain('user-abort-synthesize-session');
    expect(harness.context.sessions.has('user-abort-synthesize-session')).toBe(false);
  });

  it('user abort does not duplicate an existing abort marker for ended synthesize-window sessions', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'user-abort-ended-session',
      recover: false,
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:05:00.000Z',
          {
            endReason: 'all_blocked',
            endReasonContent: 'All blocked.',
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 2,
          'session.ended',
          '2026-03-10T00:05:01.000Z',
          {
            endReasonContent: 'abort',
            force: true,
            reason: 'abort',
          },
        ),
      ],
    });
    attachPersistedSession(harness, snapshot);

    await abortDiscussSession(harness.context, 'user-abort-ended-session');

    const events = readSessionEvents(harness.context, 'user-abort-ended-session');
    expect(events.filter((event) => event.kind === 'session.ended' && event.payload.reason === 'abort')).toHaveLength(
      1,
    );
    expect(events.at(-1)).toMatchObject({ payload: { reason: 'abort' } });
  });
});
