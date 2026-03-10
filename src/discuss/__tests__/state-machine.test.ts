import { describe, expect, it } from 'vitest';

import {
  applyBid,
  applyEpochSummary,
  applySpeech,
  initSession,
  resolveWinner,
  startBidding,
} from '../state-machine.js';
import type { Result } from '../types.js';

const NOW = '2026-03-10T00:00:00.000Z';

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }

  throw new Error(result.error);
}

function createBiddingState() {
  return unwrap(startBidding(initSession({
    topic: 'Should the city pedestrianize the downtown core?',
    agents: [
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'observer' },
    ],
    min_bid_delay_ms: 0,
  }, NOW), NOW));
}

describe('state-machine cold start selection', () => {
  it('allows an observer with a submitted bid to win cold start', () => {
    let state = createBiddingState();
    state = unwrap(applyBid(state, 'alpha', 10, 'I can go later.', NOW));
    state = unwrap(applyBid(state, 'beta', 20, 'I should break the tie now.', NOW));

    const resolved = resolveWinner(state, NOW);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const [nextState, result] = resolved.value;
    expect(result).toMatchObject({ winner: 'beta', speaker_type: 'cold_start' });
    expect(nextState.status).toBe('speaking');
    expect(nextState.current_speaker).toBe('beta');
  });

  it('does not let an observer without a bid win cold start', () => {
    let state = createBiddingState();
    state = {
      ...state,
      agents: {
        ...state.agents,
        alpha: { ...state.agents.alpha, total_speaks: 1 },
      },
    };
    state = unwrap(applyBid(state, 'alpha', 10, 'I should handle this round.', NOW));

    const resolved = resolveWinner(state, NOW);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const [, result] = resolved.value;
    expect(result).toMatchObject({ winner: 'alpha', speaker_type: 'cold_start' });
  });
});

describe('state-machine status hints', () => {
  it('returns the cleaned speaking-status hint from applySpeech', () => {
    const result = applySpeech(createBiddingState(), 'alpha', 'Not yet.', NOW);

    expect(result).toEqual({
      ok: false,
      error: 'invalid_status',
      detail: {
        current: 'bidding',
        hint: 'Not your turn. Session is not in speaking status.',
      },
    });
  });

  it('returns the cleaned loop hint from applyEpochSummary', () => {
    const result = applyEpochSummary(createBiddingState(), 'Still discussing.', NOW);

    expect(result).toEqual({
      ok: false,
      error: 'epoch_summary_not_due',
      detail: {
        epoch: 1,
        hint: 'No epoch transition has occurred. Continue the discussion loop.',
      },
    });
  });
});
