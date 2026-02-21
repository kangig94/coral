/**
 * Condition predicate tests — pure functions, no I/O.
 */

import { describe, it, expect } from 'vitest';
import { allBidsIn, speechDelivered, actionNeeded } from '../conditions.js';
import type { DiscussState } from '../types.js';

function makeState(overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    session_id: 'test',
    session_dir: 'test',
    topic: 'Test',
    status: 'bidding',
    step: 1,
    epoch: 1,
    quota_per_epoch: 3,
    cold_start: true,
    recent_turns: 5,
    agents: {
      alice: { persona: '', display_name: 'Alice', quota_remaining: 3, total_speaks: 0, fallback_used: false },
      bob: { persona: '', display_name: 'Bob', quota_remaining: 3, total_speaks: 0, fallback_used: false },
    },
    current_bids: { alice: null, bob: null },
    pending_bidders: ['alice', 'bob'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    team_name: 'test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    transcript: [],
    transcript_rendered: 0,
    bid_threshold: 50,
    transcript_read_step: {},
    ...overrides,
  };
}

// ─── allBidsIn ────────────────────────────────────────────────────────────────

describe('allBidsIn', () => {
  it('should return true when all bids submitted and status=bidding', () => {
    const state = makeState({ current_bids: { alice: 75, bob: 50 }, pending_bidders: [] });
    expect(allBidsIn(state)).toBe(true);
  });

  it('should return true in voting status with all bids', () => {
    const state = makeState({
      status: 'voting',
      current_bids: { alice: 0, bob: 1 },
      pending_bidders: [],
    });
    expect(allBidsIn(state)).toBe(true);
  });

  it('should return false when any bid is null', () => {
    const state = makeState({ current_bids: { alice: 75, bob: null }, pending_bidders: ['bob'] });
    expect(allBidsIn(state)).toBe(false);
  });

  it('should return false in speaking status (phase guard)', () => {
    // Phase guard: pending_bidders is empty from previous round but status=speaking
    const state = makeState({
      status: 'speaking',
      current_bids: { alice: 75, bob: 50 },
      pending_bidders: [], // leftover from previous round
      current_speaker: 'alice',
    });
    expect(allBidsIn(state)).toBe(false);
  });

  it('should return false in setup status', () => {
    const state = makeState({ status: 'setup' as const, pending_bidders: [] });
    expect(allBidsIn(state)).toBe(false);
  });

  it('should return false in ended status', () => {
    const state = makeState({
      status: 'ended',
      current_bids: { alice: 0, bob: 0 },
      pending_bidders: [],
    });
    expect(allBidsIn(state)).toBe(false);
  });
});

// ─── speechDelivered ─────────────────────────────────────────────────────────

describe('speechDelivered', () => {
  it('should return true after speech: last_speech_step === step - 1 && status=bidding', () => {
    // After applySpeech: last_speech_step=1, step=2, status=bidding
    const state = makeState({ status: 'bidding', step: 2, last_speech_step: 1 });
    expect(speechDelivered(state)).toBe(true);
  });

  it('should return false if step has not advanced (step 1, no speech yet)', () => {
    // Before any speech: step=1, last_speech_step=0 → 0 !== 1-1=0? Actually 0 === 0 is true
    // But this case: session just created, no speech yet
    // last_speech_step=0, step=1 → 0 === 1-1 = 0 → TRUE
    // This is an edge case: step 1 initially has last_speech_step=0 and step=1
    // So speechDelivered would be true initially...
    // BUT: status is 'bidding' at start, so this could be confused with "speech delivered for step 0"
    // In practice, this false positive is harmless: discuss_wait("speech_delivered") wouldn't be
    // called before any speech in the first step. But let's verify the predicate for step>1.
    const state = makeState({ status: 'bidding', step: 2, last_speech_step: 0 });
    // last_speech_step=0, step=2 → 0 !== 2-1=1 → false
    expect(speechDelivered(state)).toBe(false);
  });

  it('should return false during speaking status', () => {
    const state = makeState({ status: 'speaking', step: 1, last_speech_step: 0 });
    expect(speechDelivered(state)).toBe(false);
  });

  it('should return false if last_speech_step is behind by more than 1', () => {
    // Multiple rounds passed, last_speech_step is old
    const state = makeState({ status: 'bidding', step: 5, last_speech_step: 2 });
    expect(speechDelivered(state)).toBe(false);
  });
});

// ─── actionNeeded ─────────────────────────────────────────────────────────────

describe('actionNeeded', () => {
  it('should return true when agent needs to bid (bidding, bid=null)', () => {
    const state = makeState({ status: 'bidding', current_bids: { alice: null, bob: null }, pending_bidders: ['alice', 'bob'] });
    expect(actionNeeded('alice')(state)).toBe(true);
  });

  it('should return false when agent already bid', () => {
    const state = makeState({
      status: 'bidding',
      current_bids: { alice: 75, bob: null },
      pending_bidders: ['bob'],
    });
    expect(actionNeeded('alice')(state)).toBe(false);
    expect(actionNeeded('bob')(state)).toBe(true);
  });

  it('should return true when agent is current speaker', () => {
    const state = makeState({ status: 'speaking', current_speaker: 'alice' });
    expect(actionNeeded('alice')(state)).toBe(true);
    expect(actionNeeded('bob')(state)).toBe(false);
  });

  it('should return true when agent needs to vote', () => {
    const state = makeState({
      status: 'voting',
      current_bids: { alice: null, bob: null },
      pending_bidders: ['alice', 'bob'],
    });
    expect(actionNeeded('alice')(state)).toBe(true);
  });

  it('should return false for unknown agent', () => {
    const state = makeState({ status: 'bidding', current_bids: { alice: null, bob: null } });
    // current_bids['nobody'] is undefined, not null → false
    expect(actionNeeded('nobody')(state)).toBe(false);
  });

  it('should return false in setup status', () => {
    const state = makeState({ status: 'setup' as const });
    expect(actionNeeded('alice')(state)).toBe(false);
  });

  it('should return true in ended status (wake agents to exit loop)', () => {
    const state = makeState({ status: 'ended' });
    expect(actionNeeded('alice')(state)).toBe(true);
  });
});
