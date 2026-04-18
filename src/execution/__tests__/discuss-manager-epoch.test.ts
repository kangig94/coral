import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent, type PersistedDiscussSnapshot } from '../../discuss/events.js';
import { continueLoop } from '../../discuss/shell/loop.js';
import { getWatchState } from '../../discuss/shell/operations.js';
import { getSession } from '../../discuss/shell/registry.js';
import { handleEpochTransition } from '../../discuss/shell/subflows.js';
import {
  attachPersistedSession,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
} from './discuss-test-helpers.js';

afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

function epochTransitionEvents(projectRoot: string) {
  return (snapshot: PersistedDiscussSnapshot) => [
    makeEvent(
      snapshot.sessionId,
      projectRoot,
      snapshot.state.topic,
      snapshot.lastAppliedSeq + 1,
      'bid.submitted',
      '2026-03-10T00:01:00.000Z',
      { agent: 'alpha', score: 80, thought: 'alpha' },
    ),
    makeEvent(
      snapshot.sessionId,
      projectRoot,
      snapshot.state.topic,
      snapshot.lastAppliedSeq + 2,
      'bid.submitted',
      '2026-03-10T00:01:01.000Z',
      { agent: 'beta', score: 78, thought: 'beta' },
    ),
    makeEvent(
      snapshot.sessionId,
      projectRoot,
      snapshot.state.topic,
      snapshot.lastAppliedSeq + 3,
      'bid.round.closed',
      '2026-03-10T00:01:02.000Z',
      {
        allBids: { alpha: 80, beta: 78 },
        effectiveBids: { alpha: 80, beta: 78 },
        thoughts: { alpha: 'alpha', beta: 'beta' },
        outcome: { no_winner: true as const, reason: 'epoch_transition' as const },
        stateMutations: {
          cold_start: true,
          epoch: 2,
          fallback_used: { alpha: false, beta: false },
          quota_remaining: { alpha: 3, beta: 3 },
        },
      },
    ),
  ];
}

describe('Discuss epoch evaluation', () => {
  it('records the epoch summary and carry-forward questions for a non-converged epoch', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'eval-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        convergence: 4,
        summary: 'The panel is still split on freight exemptions.',
        must_answer: [{ to: 'alpha', question: 'What freight exemption would you accept?' }],
      }),
      nonResumable: false,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    const snapshot = await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: false,
      buildTail: epochTransitionEvents(harness.projectRoot),
    });
    attachPersistedSession(harness, snapshot);

    await handleEpochTransition(harness.context, 'discuss-1', harness.ctx);

    const updated = harness.store.load('discuss-1');
    expect(updated?.state.epoch).toBe(2);
    expect(updated?.state.epoch_summary_written).toBe(2);
    expect(updated?.runtime.carryForwardMustAnswer).toEqual(['alpha\u0000What freight exemption would you accept?']);
    expect(getWatchState(harness.context, 'discuss-1').events).toContainEqual(
      expect.objectContaining({ type: 'epoch_transition', data: { epoch: 2 } }),
    );

    harness.cleanup();
  });

  it('runs follow-up turns and synthesis after a converged epoch', async () => {
    let launchCount = 0;
    const start = vi.fn().mockImplementation(async () => {
      launchCount += 1;
      return { status: 'running', job: `job-${launchCount}`, session: `session-${launchCount}` };
    });
    const resume = vi.fn().mockImplementation(async () => {
      launchCount += 1;
      return { status: 'running', job: `job-${launchCount}`, session: 'session-2' };
    });
    const waitStreamOnce = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          convergence: 9,
          summary: 'The panel is nearly aligned.',
          must_answer: [
            { to: 'alpha', question: 'What freight exemption would you accept?' },
            { to: 'beta', question: 'How would you phase delivery access?' },
          ],
        }),
        nonResumable: false,
      })
      .mockResolvedValueOnce({ content: 'Allow timed morning freight windows.', nonResumable: false })
      .mockResolvedValueOnce({ content: 'Start with the transit core and expand quarterly.', nonResumable: false })
      .mockResolvedValueOnce({
        content: 'The discussion converged after clarifying freight access and rollout timing.',
        nonResumable: false,
      });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, resume, waitStreamOnce }));
    const snapshot = await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: false,
      buildTail: epochTransitionEvents(harness.projectRoot),
    });
    attachPersistedSession(harness, snapshot);

    await continueLoop(harness.context, 'discuss-1', harness.ctx);

    const updated = harness.store.load('discuss-1');
    expect(updated?.state.status).toBe('ended');
    expect(updated?.state.transcript.filter((entry) => entry.type === 'follow_up')).toHaveLength(2);
    expect(updated?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'The discussion converged after clarifying freight access and rollout timing.',
    });
    expect(getSession(harness.context, 'discuss-1')).toBeUndefined();

    harness.cleanup();
  });
});
