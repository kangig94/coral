import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent, type PersistedDiscussSnapshot } from '../../discuss/events.js';
import { DiscussManagerRegistry } from '../discuss-manager.js';
import {
  cleanupDiscussHarnesses,
  createDiscussHarness,
  persistSession,
} from './discuss-test-helpers.js';

function attachSession(manager: unknown, snapshot: PersistedDiscussSnapshot) {
  return (manager as { attachSession(nextSnapshot: PersistedDiscussSnapshot): unknown }).attachSession(snapshot);
}

describe('DiscussManager lifecycle boundaries', () => {
  afterEach(() => {
    cleanupDiscussHarnesses();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it('keeps live registry iteration separate from persisted store summaries', async () => {
    const harness = createDiscussHarness();
    const registry = new DiscussManagerRegistry();
    const manager = registry.getOrCreate(harness.projectRoot, harness.service, harness.store);

    const liveSnapshot = await persistSession({ ...harness, manager }, {
      sessionId: 'live-session',
      recover: false,
    });
    attachSession(manager, liveSnapshot);
    await persistSession({ ...harness, manager }, {
      sessionId: 'ended-session',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'session.ended', '2026-03-10T00:01:00.000Z', { endReason: 'all_blocked', endReasonContent: 'All blocked.' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'session.synthesized', '2026-03-10T00:01:01.000Z', { synthesis: 'done' }),
      ],
    });

    expect(registry.listLiveSessions().map((session) => session.sessionId)).toEqual(['live-session']);
    expect(harness.store.listSummaries().map((summary) => summary.sessionId).sort()).toEqual([
      'ended-session',
      'live-session',
    ]);

    manager.detachSession('live-session');
    expect(registry.hasLiveSessions()).toBe(false);
    expect(harness.store.listSummaries()).toHaveLength(2);

    harness.cleanup();
  });

  it('persisted ended sessions do not count as live sessions', async () => {
    const harness = createDiscussHarness();
    const registry = new DiscussManagerRegistry();
    registry.getOrCreate(harness.projectRoot, harness.service, harness.store);
    await persistSession(harness, {
      sessionId: 'ended-session',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'session.ended', '2026-03-10T00:01:00.000Z', { endReason: 'all_blocked', endReasonContent: 'All blocked.' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'session.synthesized', '2026-03-10T00:01:01.000Z', { synthesis: 'done' }),
      ],
    });

    expect(registry.hasLiveSessions()).toBe(false);
    expect(registry.listLiveSessions()).toEqual([]);
    expect(harness.store.listSummaries()).toHaveLength(1);

    harness.cleanup();
  });
});
