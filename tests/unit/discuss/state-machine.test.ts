import { describe, expect, it } from 'vitest';
import { TEST_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';

import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '#src/discuss/events.js';
import { replayDiscussEvents } from '#src/discuss/reducer.js';
import { decideBid, decideBidRoundClose, decideSessionCreate } from '#src/discuss/state-machine.js';
import type { Result } from '#src/discuss/session-types.js';

const NOW = '2026-03-11T00:00:00.000Z';
const SESSION_ID = 'session-123';
const PROJECT_ROOT = '/tmp/project';

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }

  throw new Error(result.error);
}

function nextSeq(snapshot: PersistedDiscussSnapshot): number {
  return snapshot.lastAppliedSeq + 1;
}

function createBiddingSnapshot(): PersistedDiscussSnapshot {
  return replayDiscussEvents(
    unwrap(
      decideSessionCreate(
        {
          topic: 'Should the city pedestrianize the downtown core?',
          agents: [
            { name: 'alpha', persona: 'Alpha', participation: 'required' },
            { name: 'beta', persona: 'Beta', participation: 'observer' },
          ],
          min_bid_delay_ms: 0,
        },
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: 'Should the city pedestrianize the downtown core?' },
        1,
        NOW,
        { providerScope: TEST_PROVIDER_SCOPE },
      ),
    ),
  );
}

function appendDecision(
  snapshot: PersistedDiscussSnapshot,
  result: Result<DiscussDomainEvent[]>,
): PersistedDiscussSnapshot {
  return replayDiscussEvents(unwrap(result), snapshot);
}

describe('state-machine deciders', () => {
  it('rejects session creation without a required agent', () => {
    const result = decideSessionCreate(
      {
        topic: 'Should the city pedestrianize the downtown core?',
        agents: [
          { name: 'alpha', persona: 'Alpha', participation: 'observer' },
          { name: 'beta', persona: 'Beta', participation: 'observer' },
        ],
        min_bid_delay_ms: 0,
      },
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: 'Should the city pedestrianize the downtown core?' },
      1,
      NOW,
      { providerScope: TEST_PROVIDER_SCOPE },
    );

    expect(result).toEqual({
      ok: false,
      error: 'required_agent_missing',
      detail: { hint: 'At least one required agent is needed to run a discussion.' },
    });
  });

  it('allows an observer with a submitted bid to win cold start', () => {
    let snapshot = createBiddingSnapshot();
    snapshot = appendDecision(
      snapshot,
      decideBid(
        snapshot.state,
        'alpha',
        10,
        'I can go later.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    snapshot = appendDecision(
      snapshot,
      decideBid(
        snapshot.state,
        'beta',
        20,
        'I should break the tie now.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );

    const decided = decideBidRoundClose(
      snapshot.state,
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
      nextSeq(snapshot),
      NOW,
    );

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    expect(decided.value[0]).toMatchObject({
      kind: 'bid.round.closed',
      payload: {
        outcome: { winner: 'beta', speaker_type: 'cold_start' },
      },
    });
  });

  it('does not let an observer without a bid win cold start', () => {
    let snapshot = createBiddingSnapshot();
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state,
        agents: {
          ...snapshot.state.agents,
          alpha: { ...snapshot.state.agents.alpha, total_speaks: 1 },
        },
      },
    };
    snapshot = appendDecision(
      snapshot,
      decideBid(
        snapshot.state,
        'alpha',
        10,
        'I should handle this round.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );

    const decided = decideBidRoundClose(
      snapshot.state,
      { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
      nextSeq(snapshot),
      NOW,
    );

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    expect(decided.value[0]).toMatchObject({
      kind: 'bid.round.closed',
      payload: {
        outcome: { winner: 'alpha', speaker_type: 'cold_start' },
      },
    });
  });

  it('forces the highest low bidder when enough quota remains', () => {
    let snapshot = createBiddingSnapshot();
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state,
        cold_start: false,
        agents: {
          alpha: { ...snapshot.state.agents.alpha, participation: 'required', quota_remaining: 3 },
          beta: { ...snapshot.state.agents.beta, participation: 'required', quota_remaining: 3 },
        },
        pending_bidders: ['alpha', 'beta'],
      },
    };
    snapshot = appendDecision(
      snapshot,
      decideBid(
        snapshot.state,
        'alpha',
        10,
        'Low urgency.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );
    snapshot = appendDecision(
      snapshot,
      decideBid(
        snapshot.state,
        'beta',
        20,
        'Still below threshold, but more urgent.',
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );

    const events = unwrap(
      decideBidRoundClose(
        snapshot.state,
        { sessionId: SESSION_ID, projectRoot: PROJECT_ROOT, topic: snapshot.state.topic },
        nextSeq(snapshot),
        NOW,
      ),
    );

    expect(events.map((event) => event.kind)).toEqual(['bid.round.closed']);
    expect(events[0]).toMatchObject({
      payload: {
        outcome: { winner: 'beta', speaker_type: 'forced' },
        stateMutations: { cold_start: false },
      },
    });
  });
});
