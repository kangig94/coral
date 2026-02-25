import { describe, it, expect } from 'vitest';
import { allBidsIn, bidReleased, isWinner, setupComplete, noEligibleParticipants, speechDelivered } from '../conditions.js';
import { applyExpel, DEFAULT_BID_THRESHOLD } from '../state-machine.js';
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
        participation: 'required' as const,
        quota_remaining: 3,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
      bob: {
        persona: '',
        display_name: 'Bob',
        participation: 'required' as const,
        quota_remaining: 3,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
    },
    current_bids: { alice: null, bob: null },
    current_thoughts: {},
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
    min_bid_delay_ms: 0,
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
    const baseState = makeState();
    const state = makeState({ agents: { ...baseState.agents, alice: { ...baseState.agents.alice, banned: true } } });
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

describe('noEligibleParticipants', () => {
  it('returns false when one active participant remains', () => {
    const state = makeState();
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true when all participants are exhausted/banned', () => {
    const baseState = makeState();
    const state = makeState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 0, fallback_used: true },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: true },
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });
});

describe('noEligibleParticipants edge cases', () => {
  it('returns false when quota=0 but fallback_used=false (fallback still available)', () => {
    const baseState = makeState();
    const state = makeState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 0, fallback_used: false },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: false },
      },
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns false when any required agent has quota>0 regardless of fallback_used', () => {
    const baseState = makeState();
    const state = makeState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 1, fallback_used: true },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: true },
      },
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true when every required agent is banned OR (quota=0 AND fallback_used)', () => {
    const baseState = makeState();
    const state = makeState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 0, fallback_used: true },
        bob: { ...baseState.agents.bob, banned: true },
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('ignores observer agents — observer with quota does not prevent the condition', () => {
    const baseState = makeState();
    const state = makeState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 0, fallback_used: true },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: true },
        carol: { ...baseState.agents.alice, participation: 'observer' as const, quota_remaining: 3, fallback_used: false },
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('returns false for a single active required agent', () => {
    const baseState = makeState();
    const state = makeState({
      agents: { alice: { ...baseState.agents.alice, quota_remaining: 2 } },
      pending_bidders: ['alice'],
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true for an empty agents map (vacuously true)', () => {
    const state = makeState({ agents: {} });
    expect(noEligibleParticipants(state)).toBe(true);
  });
});

describe('applyExpel → noEligibleParticipants integration', () => {
  it('detects no_participants after expelling the last required non-banned agent', () => {
    const baseState = makeState();
    const state = makeState({
      step: 2,
      hold_count: 2,
      pending_bidders: ['alice'],
      agents: {
        alice: { ...baseState.agents.alice, banned: false, quota_remaining: 1, fallback_used: false },
        bob: { ...baseState.agents.bob, banned: true, quota_remaining: 0, fallback_used: true },
      },
    });
    const expelled = applyExpel(state, ['alice'], new Date().toISOString());
    expect(expelled.ok).toBe(true);
    if (!expelled.ok) return;
    expect(noEligibleParticipants(expelled.value.state)).toBe(true);
  });

  it('does not detect no_participants when a non-banned required agent with quota remains after expel', () => {
    const baseState = makeState();
    const state = makeState({
      step: 2,
      hold_count: 2,
      pending_bidders: ['alice'],
      agents: {
        alice: { ...baseState.agents.alice, banned: false, quota_remaining: 1, fallback_used: false },
        bob: { ...baseState.agents.bob, banned: false, quota_remaining: 2, fallback_used: false },
      },
    });
    const expelled = applyExpel(state, ['alice'], new Date().toISOString());
    expect(expelled.ok).toBe(true);
    if (!expelled.ok) return;
    expect(noEligibleParticipants(expelled.value.state)).toBe(false);
  });
});
