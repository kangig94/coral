import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import {
  clearAllDiscuss,
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
  listAttachedSessions,
} from '#src/discuss/shell/live-registry.js';
import { abortDiscussSession } from '#src/discuss/shell/operations.js';
import { persistAbortEndForShutdown, recoverPersistedSessionsFromStore } from '#src/discuss/shell/recovery.js';
import { readSessionEvents } from '#src/discuss/shell/persistence.js';
import { detachSession } from '#src/discuss/shell/registry.js';
import {
  attachPersistedSession,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  discussContextOptions,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

async function recoverSessions(harness: DiscussHarness) {
  return recoverPersistedSessionsFromStore(
    harness.store,
    () => harness.context,
    (snapshot) => ({
      projectRoot: snapshot.projectRoot,
      pluginRoot: harness.ctx.pluginRoot,
      coralEnv: {},
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
