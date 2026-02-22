
import { describe, it, expect } from 'vitest';
import { allBidsIn, bidReleased, isWinner, setupComplete, noParticipants, speechDelivered } from '../conditions.js';
import { DEFAULT_BID_THRESHOLD } from '../state-machine.js';
import type { DiscussState } from '../types.js';

function makeState(overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    session_id: 'test',
    session_dir: 'test',
    topic: 'Test',
    status: 'bidding',
    step: 1,
    epoch: 1,
    max_epochs: 2,
    quota_per_epoch: 3,
    cold_start: true,
    agents: {
      alice: {
        persona: '',
        display_name: 'Alice',
        quota_remaining: 3,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
      bob: {
        persona: '',
        display_name: 'Bob',
        quota_remaining: 3,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
    },
    current_bids: { alice: null, bob: null },
    pending_bidders: ['alice', 'bob'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    team_name: 'test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    transcript_rendered: 0,
    bid_threshold: DEFAULT_BID_THRESHOLD,
    ...overrides,
  };
}

describe('allBidsIn', () => {
  it('returns true when all bids are submitted in bidding status', () => {
    const state = makeState({ current_bids: { alice: 75, bob: 50 }, pending_bidders: [] });
    expect(allBidsIn(state)).toBe(true);
  });

  it('returns false when any bid is missing', () => {
    const state = makeState({ current_bids: { alice: 75, bob: null }, pending_bidders: ['bob'] });
    expect(allBidsIn(state)).toBe(false);
  });

  it('returns false when status is not bidding', () => {
    const state = makeState({ status: 'speaking', current_bids: { alice: 75, bob: 80 }, pending_bidders: [] });
    expect(allBidsIn(state)).toBe(false);
  });
});

describe('speechDelivered', () => {
  it('returns true after a speech is recorded', () => {
    const state = makeState({ status: 'bidding', step: 2, last_speech_step: 1 });
    expect(speechDelivered(state)).toBe(true);
  });

  it('returns false if no speech was delivered for this step', () => {
    const state = makeState({ status: 'bidding', step: 2, last_speech_step: 0 });
    expect(speechDelivered(state)).toBe(false);
  });

  it('returns false while speaking', () => {
    const state = makeState({ status: 'speaking', step: 2, last_speech_step: 1 });
    expect(speechDelivered(state)).toBe(false);
  });
});

describe('bidReleased', () => {
  it('returns true for bid release step threshold', () => {
    const state = makeState({ bid_release_step: 3 });
    expect(bidReleased('alice', 3)(state)).toBe(true);
    expect(bidReleased('alice', 4)(state)).toBe(false);
  });

  it('returns true when session ended', () => {
    const state = makeState({ status: 'ended' });
    expect(bidReleased('alice', 999)(state)).toBe(true);
  });

  it('returns true when winner is banned', () => {
    const base = makeState();
    const state = makeState({ agents: { ...base.agents, alice: { ...base.agents.alice, banned: true } } });
    expect(bidReleased('alice', 10)(state)).toBe(true);
  });
});

describe('isWinner', () => {
  it('returns true for current speaker while speaking', () => {
    const state = makeState({ status: 'speaking', current_speaker: 'alice' });
    expect(isWinner('alice')(state)).toBe(true);
  });

  it('returns false for non-speaker', () => {
    const state = makeState({ status: 'speaking', current_speaker: 'alice' });
    expect(isWinner('bob')(state)).toBe(false);
  });
});

describe('setupComplete', () => {
  it('returns true after setup', () => {
    const state = makeState({ status: 'bidding' });
    expect(setupComplete(state)).toBe(true);
  });

  it('returns false during setup', () => {
    const state = makeState({ status: 'setup' });
    expect(setupComplete(state)).toBe(false);
  });
});

describe('noParticipants', () => {
  it('returns false when one active participant remains', () => {
    const state = makeState();
    expect(noParticipants(state)).toBe(false);
  });

  it('returns true when all participants are exhausted/banned', () => {
    const base = makeState();
    const state = makeState({
      agents: {
        alice: { ...base.agents.alice, quota_remaining: 0, fallback_used: true },
        bob: { ...base.agents.bob, quota_remaining: 0, fallback_used: true },
      },
    });
    expect(noParticipants(state)).toBe(true);
  });
});
