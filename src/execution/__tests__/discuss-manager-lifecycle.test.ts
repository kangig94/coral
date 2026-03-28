import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../discuss/events.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
  listAttachedSessions,
} from '../discuss/context-registry.js';
import { detachSession } from '../discuss/registry.js';
import {
  attachPersistedSession,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  persistSession,
} from './discuss-test-helpers.js';

describe('DiscussContext lifecycle boundaries', () => {
  afterEach(() => {
    cleanupDiscussHarnesses();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it('keeps attached-session iteration separate from persisted store summaries', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);

    const liveSnapshot = await persistSession({ ...harness, context }, {
      sessionId: 'live-session',
      recover: false,
    });
    attachPersistedSession({ ...harness, context }, liveSnapshot);
    await persistSession({ ...harness, context }, {
      sessionId: 'ended-session',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'session.ended', '2026-03-10T00:01:00.000Z', { endReason: 'all_blocked', endReasonContent: 'All blocked.' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'session.synthesized', '2026-03-10T00:01:01.000Z', { synthesis: 'done' }),
      ],
    });

    expect(listAttachedSessions(registry).map((session) => session.sessionId)).toEqual(['live-session']);
    expect(harness.store.listSummaries().map((summary) => summary.sessionId).sort()).toEqual([
      'ended-session',
      'live-session',
    ]);

    detachSession(context, 'live-session');
    expect(hasRunningSessions(registry)).toBe(false);
    expect(harness.store.listSummaries()).toHaveLength(2);
  });

  it('persisted ended sessions do not count as running sessions', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
    await persistSession(harness, {
      sessionId: 'ended-session',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'session.ended', '2026-03-10T00:01:00.000Z', { endReason: 'all_blocked', endReasonContent: 'All blocked.' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'session.synthesized', '2026-03-10T00:01:01.000Z', { synthesis: 'done' }),
      ],
    });

    expect(hasRunningSessions(registry)).toBe(false);
    expect(listAttachedSessions(registry)).toEqual([]);
    expect(harness.store.listSummaries()).toHaveLength(1);
  });
});
