import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../discuss/events.js';
import type { CallerContext } from '../service.js';
import {
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
} from './discuss-test-helpers.js';

function handleSynthesis(manager: unknown, sessionId: string, ctx: CallerContext): Promise<void> {
  return (manager as { handleSynthesis(targetSessionId: string, targetCtx: CallerContext): Promise<void> })
    .handleSynthesis(sessionId, ctx);
}

afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

describe('DiscussManager synthesis', () => {
  it('records a single synthesis entry from a terminal session', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'synth-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'The panel supported a phased pedestrianization plan centered on transit access.',
      nonResumable: false,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'session.ended', '2026-03-10T00:01:00.000Z', { endReason: 'all_blocked', endReasonContent: 'All blocked.' }),
      ],
    });

    await handleSynthesis(harness.manager, 'discuss-1', harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'The panel supported a phased pedestrianization plan centered on transit access.',
    });

    harness.cleanup();
  });

  it('recovery resumes synthesis for ended sessions that have not been synthesized yet', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'synth-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'Recovered synthesis text.',
      nonResumable: false,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'session.ended', '2026-03-10T00:01:00.000Z', { endReason: 'all_blocked', endReasonContent: 'All blocked.' }),
      ],
    });

    await harness.manager.recoverPersistedSessions(harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'Recovered synthesis text.',
    });
    expect(harness.manager.getSession('discuss-1')).toBeUndefined();

    harness.cleanup();
  });
});
