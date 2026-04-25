import { afterEach, describe, expect, it } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import { buildAuditView, buildControlView } from '#src/discuss/projections.js';
import { buildWatchEvents } from '#src/discuss/watch.js';
import {
  cleanupDiscussHarnesses,
  createDiscussHarness,
  defaultAgents,
  persistSession,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

afterEach(() => {
  cleanupDiscussHarnesses();
});

describe('discuss projections', () => {
  it('buildControlView redacts sealed-bid transcript internals', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'control-view-session',
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-11T00:01:00.000Z',
          {
            agent: 'alpha',
            score: 88,
            thought: 'keep sealed',
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-11T00:01:01.000Z',
          {
            agent: 'beta',
            score: 42,
            thought: 'also sealed',
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-11T00:01:02.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
      ],
    });

    const controlView = buildControlView(snapshot);
    const bidsEntry = controlView.transcript.find((entry) => entry.type === 'bids');

    expect(controlView.lastSeq).toBe(snapshot.lastAppliedSeq);
    expect(bidsEntry).toEqual({
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: '2026-03-11T00:01:02.000Z',
      winner: 'alpha',
      resolve_type: 'normal',
    });
    expect(JSON.stringify(controlView.transcript)).not.toContain('keep sealed');
    expect(JSON.stringify(controlView.transcript)).not.toContain('effective_bids');
  });

  it('buildAuditView keeps full bid transcript internals', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'audit-view-session',
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-11T00:01:00.000Z',
          {
            agent: 'alpha',
            score: 88,
            thought: 'keep sealed',
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-11T00:01:01.000Z',
          {
            agent: 'beta',
            score: 42,
            thought: 'also sealed',
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-11T00:01:02.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 4,
          'speech.recorded',
          '2026-03-11T00:01:03.000Z',
          {
            agent: 'alpha',
            content: 'Open the street to buses and bikes first.',
            decrementQuota: true,
            recordLastSpeechStep: 1,
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 5,
          'session.ended',
          '2026-03-11T00:01:04.000Z',
          {
            endReason: 'all_below_threshold',
            endReasonContent: 'Consensus reached.',
          },
        ),
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 6,
          'session.synthesized',
          '2026-03-11T00:01:05.000Z',
          {
            synthesis: 'Build the transit-first pilot and measure results.',
          },
        ),
      ],
    });

    const auditView = buildAuditView(snapshot);
    const bidsEntry = auditView.transcript.find((entry) => entry.type === 'bids');

    expect(auditView.lastSeq).toBe(snapshot.lastAppliedSeq);
    expect(bidsEntry).toMatchObject({
      type: 'bids',
      bids: { alpha: 88, beta: 42 },
      effective_bids: { alpha: 88, beta: 42 },
      thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
      winner: 'alpha',
      resolve_type: 'normal',
    });
  });

  it('buildWatchEvents preserves immediate epoch_transition ordering', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'watch-order-session',
      agents: defaultAgents(),
    });

    const events = [
      makeEvent(
        snapshot.sessionId,
        harness.projectRoot,
        snapshot.state.topic,
        snapshot.lastAppliedSeq + 1,
        'bid.round.closed',
        '2026-03-11T00:01:00.000Z',
        {
          allBids: { alpha: 4, beta: 3 },
          effectiveBids: { alpha: 4, beta: 3 },
          thoughts: { alpha: 'spent', beta: 'spent' },
          outcome: { no_winner: true as const, reason: 'epoch_transition' as const },
          stateMutations: {
            epoch: 2,
            cold_start: false,
            fallback_used: { alpha: true, beta: true },
            quota_remaining: { alpha: 0, beta: 0 },
          },
        },
      ),
      makeEvent(
        snapshot.sessionId,
        harness.projectRoot,
        snapshot.state.topic,
        snapshot.lastAppliedSeq + 2,
        'session.ended',
        '2026-03-11T00:01:01.000Z',
        {
          force: true,
          reason: 'abort',
        },
      ),
    ];

    expect(buildWatchEvents(events)).toEqual([
      {
        type: 'epoch_transition',
        data: { epoch: 2 },
        ts: Date.parse('2026-03-11T00:01:00.000Z'),
      },
      {
        type: 'session_ended',
        data: { reason: 'force_end', detail: 'abort' },
        ts: Date.parse('2026-03-11T00:01:01.000Z'),
      },
    ]);
  });
});
