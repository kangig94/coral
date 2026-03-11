import { describe, expect, it } from 'vitest';

import {
  makeEvent,
  type DiscussDomainEvent,
  type PersistedDiscussSnapshot,
} from '../events.js';
import {
  makeEmptySnapshot,
  replayDiscussEvents,
} from '../reducer.js';
import {
  applyBid,
  applyEnd,
  applySpeech,
  decideBid,
  decideBidRoundClose,
  decideSessionCreate,
  decideSpeech,
  initSession,
  resolveWinner,
  startBidding,
} from '../state-machine.js';
import type { DiscussCreateInput, DiscussState, Result } from '../types.js';

const NOW = '2026-03-11T00:00:00.000Z';
const PROJECT_ROOT = '/tmp/project';
const SESSION_ID = 'session-1';

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error);
}

function replay(
  snapshot: PersistedDiscussSnapshot | undefined,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return replayDiscussEvents(
    events,
    snapshot,
  );
}

function makeInput(
  agents: DiscussCreateInput['agents'],
  minBidDelayMs = 0,
): DiscussCreateInput {
  return {
    topic: 'Should the city pedestrianize the downtown core?',
    agents,
    min_bid_delay_ms: minBidDelayMs,
  };
}

function makeDirectBiddingState(input: DiscussCreateInput): DiscussState {
  const created = {
    ...initSession(input, NOW),
    session_id: SESSION_ID,
  };
  return unwrap(startBidding(created, NOW));
}

function makeSnapshotFromState(state: DiscussState): PersistedDiscussSnapshot {
  return {
    ...makeEmptySnapshot(SESSION_ID, PROJECT_ROOT),
    updatedAt: state.last_activity_at,
    state,
  };
}

describe('reducer parity', () => {
  it('replays session creation, bidding, round close, and speech to the same state as direct execution', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'observer' },
    ]);
    let seq = 1;

    let direct = makeDirectBiddingState(input);
    let snapshot = replay(
      undefined,
      unwrap(decideSessionCreate(
        input,
        SESSION_ID,
        PROJECT_ROOT,
        input.topic,
        seq,
        NOW,
      )),
    );
    seq += 2;
    expect(snapshot.state).toEqual(direct);

    direct = unwrap(applyBid(direct, 'alpha', 10, 'I can go later.', NOW));
    snapshot = replay(
      snapshot,
      unwrap(decideBid(snapshot.state, 'alpha', 10, 'I can go later.', SESSION_ID, PROJECT_ROOT, input.topic, seq, NOW)),
    );
    seq += 1;
    expect(snapshot.state).toEqual(direct);

    direct = unwrap(applyBid(direct, 'beta', 20, 'I should break the tie now.', NOW));
    snapshot = replay(
      snapshot,
      unwrap(decideBid(snapshot.state, 'beta', 20, 'I should break the tie now.', SESSION_ID, PROJECT_ROOT, input.topic, seq, NOW)),
    );
    seq += 1;
    expect(snapshot.state).toEqual(direct);

    const directClosed = unwrap(resolveWinner(direct, NOW));
    snapshot = replay(
      snapshot,
      unwrap(decideBidRoundClose(snapshot.state, SESSION_ID, PROJECT_ROOT, input.topic, seq, NOW)),
    );
    seq += 1;
    expect(snapshot.state).toEqual(directClosed[0]);

    const directAfterSpeech = unwrap(applySpeech(directClosed[0], 'beta', 'I will open the discussion.', NOW));
    snapshot = replay(
      snapshot,
      unwrap(decideSpeech(snapshot.state, 'beta', 'I will open the discussion.', SESSION_ID, PROJECT_ROOT, input.topic, seq, NOW)),
    );
    expect(snapshot.state).toEqual(directAfterSpeech);
  });

  it('matches direct resolve-then-end behavior for terminal no-winner batches', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    let direct = makeDirectBiddingState(input);
    direct = { ...direct, cold_start: false };
    direct = unwrap(applyBid(direct, 'alpha', 10, 'Not enough urgency.', NOW));
    direct = unwrap(applyBid(direct, 'beta', 20, 'Still below threshold.', NOW));

    const resolved = unwrap(resolveWinner(direct, NOW));
    if ('winner' in resolved[1]) {
      throw new Error('expected a no-winner outcome');
    }
    if (resolved[1].reason === 'epoch_transition') {
      throw new Error('expected a terminal no-winner reason');
    }
    const ended = unwrap(applyEnd(resolved[0], { endReason: resolved[1].reason }, NOW));

    const snapshot = replay(
      makeSnapshotFromState(direct),
      unwrap(decideBidRoundClose(direct, SESSION_ID, PROJECT_ROOT, input.topic, 7, NOW)),
    );

    expect(snapshot.state).toEqual(ended);
    expect(snapshot.runtime.controlPhase).toBe('synthesize');
  });

  it('projects epoch_transition into evaluate_epoch runtime control', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    const baseState = makeDirectBiddingState(input);
    const biddingState: DiscussState = {
      ...baseState,
      cold_start: false,
      current_bids: { alpha: 90, beta: 85 },
      current_thoughts: { alpha: 'I am blocked by quota.', beta: 'Same here.' },
      pending_bidders: [],
      agents: {
        alpha: {
          ...baseState.agents.alpha,
          quota_remaining: 0,
          fallback_used: true,
        },
        beta: {
          ...baseState.agents.beta,
          quota_remaining: 0,
          fallback_used: true,
        },
      },
    };

    const directResolved = unwrap(resolveWinner(biddingState, NOW));
    const snapshot = replay(
      makeSnapshotFromState(biddingState),
      unwrap(decideBidRoundClose(biddingState, SESSION_ID, PROJECT_ROOT, input.topic, 9, NOW)),
    );

    expect(snapshot.state).toEqual(directResolved[0]);
    expect(snapshot.runtime.controlPhase).toBe('evaluate_epoch');
  });

  it('seeds and updates persisted agent run retry fields from runtime events', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'user', persona: 'User', participation: 'observer' },
    ]);
    const created = replayDiscussEvents([
      ...unwrap(decideSessionCreate(
        input,
        SESSION_ID,
        PROJECT_ROOT,
        input.topic,
        1,
        NOW,
        undefined,
        undefined,
        undefined,
        {
          alpha: { manual: false, provider: 'codex', model: 'gpt-5' },
          user: { manual: true },
        },
      )),
    ]);

    const afterBound = replayDiscussEvents([
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 3, 'agent.run.bound', NOW, {
        agent: 'alpha',
        executionSessionId: 'exec-1',
      }),
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 4, 'agent.job.started', NOW, {
        agent: 'alpha',
        jobId: 'job-1',
        purpose: 'bid',
        attempt: 2,
      }),
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 5, 'agent.job.finished', NOW, {
        agent: 'alpha',
        jobId: 'job-1',
        outcome: 'retryable_parse_error',
        attempt: 2,
      }),
    ], created);

    expect(created.runtime.agentRuns).toEqual({
      alpha: {
        provider: 'codex',
        model: 'gpt-5',
      },
    });
    expect(afterBound.runtime.agentRuns.alpha).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      executionSessionId: 'exec-1',
      currentJobId: undefined,
      currentJobPurpose: undefined,
      currentAttempt: 2,
      lastAttemptOutcome: 'retryable_parse_error',
    });
  });
});
