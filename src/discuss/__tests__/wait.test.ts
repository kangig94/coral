import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  waitForCondition,
  INFINITE_POLL,
  allBidsIn,
  bidReleased,
  isWinner,
  setupComplete,
  noEligibleParticipants,
  speechDelivered,
} from '../wait.js';
import { applyExpel, DEFAULT_BID_THRESHOLD } from '../state-machine.js';
import type { AgentState, DiscussState } from '../types.js';

let tmpDir: string;
const INTERVAL = 30;

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'coral-wait-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeState(overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    session_id: 'test',
    topic: 'Test',
    status: 'bidding',
    step: 1,
    epoch: 1,
    max_epochs: 2,
    quota_per_epoch: 3,
    cold_start: false,
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
    },
    current_bids: { alice: null },
    current_thoughts: {},
    pending_bidders: ['alice'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: DEFAULT_BID_THRESHOLD,
    min_bid_delay_ms: 0,
    ...overrides,
  };
}

function getStatePath(): string {
  return join(tmpDir, 'state.json');
}

function writeState(state: DiscussState): void {
  writeFileSync(getStatePath(), JSON.stringify(state));
}

const isEnded = (s: DiscussState) => s.status === 'ended';

describe('waitForCondition', () => {
  it('should return immediately when condition already true on first check', async () => {
    writeState(makeState({ status: 'ended' }));
    const result = await waitForCondition(getStatePath(), isEnded, 5000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.elapsed_ms).toBeLessThan(INTERVAL);
    expect(result.state!.status).toBe('ended');
  });

  it('should support infinite polling sentinel', async () => {
    writeState(makeState({ status: 'bidding' }));
    const running = waitForCondition(getStatePath(), isEnded, INFINITE_POLL, INTERVAL);
    const timedOut = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 120)),
    ]);
    expect(timedOut).toHaveProperty('timedOut', true);

    const writer = setTimeout(() => writeState(makeState({ status: 'ended' })), 150);
    const released = await running;
    clearTimeout(writer);
    expect(released.fulfilled).toBe(true);
    expect(released.state?.status).toBe('ended');
  });

  it('should poll until condition becomes true', async () => {
    writeState(makeState({ status: 'bidding' }));
    setTimeout(() => writeState(makeState({ status: 'ended' })), INTERVAL * 2 + 10);

    const result = await waitForCondition(getStatePath(), isEnded, 2000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.state!.status).toBe('ended');
  });

  it('should return fulfilled=false with lastKnownGood on timeout', async () => {
    writeState(makeState({ status: 'bidding' }));
    const result = await waitForCondition(getStatePath(), isEnded, 100, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBeNull();
    expect(result.state!.status).toBe('bidding');
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(100);
  });

  it('should return error=state_unavailable when file never exists', async () => {
    const result = await waitForCondition(getStatePath(), isEnded, 100, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBe('state_unavailable');
  });

  it('should survive transient corrupt reads and recover on valid state', async () => {
    writeState(makeState({ status: 'bidding' }));
    const path = getStatePath();

    setTimeout(() => writeFileSync(path, '{"partial":'), INTERVAL + 5);
    setTimeout(() => writeState(makeState({ status: 'ended' })), INTERVAL * 3 + 5);

    const result = await waitForCondition(path, isEnded, 2000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.state!.status).toBe('ended');
  });

  it('should keep lastKnownGood after permanent corrupt read', async () => {
    writeState(makeState({ status: 'bidding' }));
    const path = getStatePath();
    setTimeout(() => writeFileSync(path, 'not-json'), INTERVAL + 5);

    const result = await waitForCondition(path, isEnded, 150, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBeNull();
    expect(result.state!.status).toBe('bidding');
  });
});

function makeConditionState(overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    session_id: 'test',
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
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: DEFAULT_BID_THRESHOLD,
    min_bid_delay_ms: 0,
    ...overrides,
  };
}

describe('allBidsIn', () => {
  it('returns true when all bids are submitted in bidding status', () => {
    const state = makeConditionState({ current_bids: { alice: 75, bob: 50 }, pending_bidders: [] });
    expect(allBidsIn(state)).toBe(true);
  });

  it('returns false when any bid is missing', () => {
    const state = makeConditionState({ current_bids: { alice: 75, bob: null }, pending_bidders: ['bob'] });
    expect(allBidsIn(state)).toBe(false);
  });

  it('returns false when status is not bidding', () => {
    const state = makeConditionState({
      status: 'speaking',
      current_bids: { alice: 75, bob: 80 },
      pending_bidders: [],
    });
    expect(allBidsIn(state)).toBe(false);
  });
});

describe('speechDelivered', () => {
  it('returns true after a speech is recorded', () => {
    const state = makeConditionState({ status: 'bidding', step: 2, last_speech_step: 1 });
    expect(speechDelivered(state)).toBe(true);
  });

  it('returns false if no speech was delivered for this step', () => {
    const state = makeConditionState({ status: 'bidding', step: 2, last_speech_step: 0 });
    expect(speechDelivered(state)).toBe(false);
  });

  it('returns false while speaking', () => {
    const state = makeConditionState({ status: 'speaking', step: 2, last_speech_step: 1 });
    expect(speechDelivered(state)).toBe(false);
  });
});

describe('bidReleased', () => {
  it('returns true for bid release step threshold', () => {
    const state = makeConditionState({ bid_release_step: 3 });
    expect(bidReleased('alice', 3)(state)).toBe(true);
    expect(bidReleased('alice', 4)(state)).toBe(false);
  });

  it('returns true when session ended', () => {
    const state = makeConditionState({ status: 'ended' });
    expect(bidReleased('alice', 999)(state)).toBe(true);
  });

  it('returns true when winner is banned', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
      agents: { ...baseState.agents, alice: { ...baseState.agents.alice, banned: true } },
    });
    expect(bidReleased('alice', 10)(state)).toBe(true);
  });
});

describe('isWinner', () => {
  it('returns true for current speaker while speaking', () => {
    const state = makeConditionState({ status: 'speaking', current_speaker: 'alice' });
    expect(isWinner('alice')(state)).toBe(true);
  });

  it('returns false for non-speaker', () => {
    const state = makeConditionState({ status: 'speaking', current_speaker: 'alice' });
    expect(isWinner('bob')(state)).toBe(false);
  });
});

describe('setupComplete', () => {
  it('returns true after setup', () => {
    const state = makeConditionState({ status: 'bidding' });
    expect(setupComplete(state)).toBe(true);
  });

  it('returns false during setup', () => {
    const state = makeConditionState({ status: 'setup' });
    expect(setupComplete(state)).toBe(false);
  });
});

describe('noEligibleParticipants', () => {
  it('returns false when one active participant remains', () => {
    const state = makeConditionState();
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true when all participants are exhausted/banned', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
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
    const baseState = makeConditionState();
    const state = makeConditionState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 0, fallback_used: false },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: false },
      },
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns false when any required agent has quota>0 regardless of fallback_used', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 1, fallback_used: true },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: true },
      },
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true when every required agent is banned OR (quota=0 AND fallback_used)', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
      agents: {
        alice: { ...baseState.agents.alice, banned: true },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: true },
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('ignores observer agents — observer with quota does not prevent the condition', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
      agents: {
        alice: { ...baseState.agents.alice, quota_remaining: 0, fallback_used: true },
        bob: { ...baseState.agents.bob, quota_remaining: 0, fallback_used: true },
        carol: {
          ...baseState.agents.alice,
          participation: 'observer' as const,
          quota_remaining: 3,
          fallback_used: false,
        },
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('returns false for a single active required agent', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
      agents: { alice: { ...baseState.agents.alice, quota_remaining: 2 } },
      pending_bidders: ['alice'],
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true for an empty agents map (vacuously true)', () => {
    const state = makeConditionState({ agents: {} });
    expect(noEligibleParticipants(state)).toBe(true);
  });
});

describe('applyExpel -> noEligibleParticipants integration', () => {
  it('detects no_participants after expelling the last required non-banned agent', () => {
    const baseState = makeConditionState();
    const state = makeConditionState({
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
    const baseState = makeConditionState();
    const state = makeConditionState({
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

// ---------------------------------------------------------------------------
// Adversarial tests (red-attacker provenance)
// ---------------------------------------------------------------------------

function makeBaseState(overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    session_id: 'test-session',
    topic: 'Test Topic',
    status: 'bidding',
    step: 1,
    epoch: 1,
    max_epochs: 2,
    quota_per_epoch: 3,
    cold_start: false,
    agents: {
      alice: {
        persona: '', display_name: 'Alice', participation: 'required',
        quota_remaining: 3, total_speaks: 0, fallback_used: false, banned: false,
      },
      bob: {
        persona: '', display_name: 'Bob', participation: 'required',
        quota_remaining: 3, total_speaks: 0, fallback_used: false, banned: false,
      },
    },
    current_bids: { alice: null, bob: null },
    current_thoughts: {},
    pending_bidders: ['alice', 'bob'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    bid_threshold: DEFAULT_BID_THRESHOLD,
    min_bid_delay_ms: 0,
    ...overrides,
  };
}

describe('speechDelivered initial-state boundary', () => {
  it('returns true at step=1 with last_speech_step=0 (arithmetic: step-1=0 matches; safe because stepSpeaking only runs when status=speaking, which requires step≥2)', () => {
    // step=1, last_speech_step=0 → 1-1=0 === 0 → true by arithmetic
    // This is only safe in practice because speechDelivered is only polled from
    // stepSpeaking, which requires current status='speaking'. By the time status is
    // 'speaking', step has advanced to ≥2 via resolveWinner, so this boundary never
    // fires in a real session flow.
    const state = makeBaseState({ status: 'bidding', step: 1, last_speech_step: 0 });
    expect(speechDelivered(state)).toBe(true);
  });

  it('returns false at step=1 with last_speech_step=0 while status is speaking', () => {
    const state = makeBaseState({ status: 'speaking', step: 1, last_speech_step: 0 });
    expect(speechDelivered(state)).toBe(false);
  });

  it('returns false at step=2 with last_speech_step=0 (speech at step 1 not yet delivered)', () => {
    const state = makeBaseState({ status: 'bidding', step: 2, last_speech_step: 0 });
    expect(speechDelivered(state)).toBe(false);
  });

  it('returns true at step=3 with last_speech_step=2 (speech for step 2 was delivered)', () => {
    const state = makeBaseState({ status: 'bidding', step: 3, last_speech_step: 2 });
    expect(speechDelivered(state)).toBe(true);
  });

  it('returns false at step=3 with last_speech_step=1 (speech is two steps old, not the previous step)', () => {
    const state = makeBaseState({ status: 'bidding', step: 3, last_speech_step: 1 });
    expect(speechDelivered(state)).toBe(false);
  });
});

describe('bidReleased boundary conditions', () => {
  it('returns true when bid_release_step === bidStep (exact boundary)', () => {
    const state = makeBaseState({ bid_release_step: 5 });
    expect(bidReleased('alice', 5)(state)).toBe(true);
  });

  it('returns true when bid_release_step > bidStep (past the release point)', () => {
    const state = makeBaseState({ bid_release_step: 6 });
    expect(bidReleased('alice', 5)(state)).toBe(true);
  });

  it('returns false when bid_release_step < bidStep (not yet released)', () => {
    const state = makeBaseState({ bid_release_step: 4 });
    expect(bidReleased('alice', 5)(state)).toBe(false);
  });

  it('returns true when bid_release_step=0 and bidStep=0 (zero boundary: 0 >= 0)', () => {
    const state = makeBaseState({ bid_release_step: 0 });
    expect(bidReleased('alice', 0)(state)).toBe(true);
  });

  it('returns false when bid_release_step=0 and bidStep=1 (agent bid at step 1, not yet released)', () => {
    const state = makeBaseState({ bid_release_step: 0 });
    expect(bidReleased('alice', 1)(state)).toBe(false);
  });

  it('returns true for a non-existent agent (?.banned returns undefined, not true, falls through to step check)', () => {
    const state = makeBaseState({ bid_release_step: 5 });
    expect(bidReleased('nonexistent', 5)(state)).toBe(true);
  });

  it('returns false for a non-existent agent when step not yet released', () => {
    const state = makeBaseState({ bid_release_step: 2 });
    expect(bidReleased('nonexistent', 5)(state)).toBe(false);
  });
});

describe('isWinner boundary conditions', () => {
  it('returns false when status is bidding even if current_speaker is set', () => {
    const state = makeBaseState({ status: 'bidding', current_speaker: 'alice' });
    expect(isWinner('alice')(state)).toBe(false);
  });

  it('returns false when status is ended even if current_speaker matches', () => {
    const state = makeBaseState({ status: 'ended', current_speaker: 'alice' });
    expect(isWinner('alice')(state)).toBe(false);
  });

  it('returns false when current_speaker is null and status is speaking', () => {
    const state = makeBaseState({ status: 'speaking', current_speaker: null });
    expect(isWinner('alice')(state)).toBe(false);
  });
});

describe('noEligibleParticipants observer+banned mixing', () => {
  function makeAgent(overrides: Partial<AgentState>): AgentState {
    return {
      persona: '', display_name: 'Agent', participation: 'required',
      quota_remaining: 3, total_speaks: 0, fallback_used: false, banned: false,
      ...overrides,
    };
  }

  it('returns true when only agent is an observer (no required agents at all)', () => {
    const state = makeBaseState({
      agents: { observer1: makeAgent({ participation: 'observer', quota_remaining: 5 }) },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('returns true when observer is banned AND the only required agent is exhausted', () => {
    const state = makeBaseState({
      agents: {
        alice: makeAgent({ participation: 'required', quota_remaining: 0, fallback_used: true }),
        carol: makeAgent({ participation: 'observer', banned: true, quota_remaining: 0 }),
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('returns false when one required agent has quota>0 and another required agent is exhausted+banned', () => {
    const state = makeBaseState({
      agents: {
        alice: makeAgent({ participation: 'required', quota_remaining: 2 }),
        bob: makeAgent({ participation: 'required', quota_remaining: 0, fallback_used: true, banned: true }),
      },
    });
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('returns true when all required agents have quota=0 and fallback_used=true, regardless of observer state', () => {
    const state = makeBaseState({
      agents: {
        alice: makeAgent({ participation: 'required', quota_remaining: 0, fallback_used: true }),
        bob: makeAgent({ participation: 'required', quota_remaining: 0, fallback_used: true }),
        carol: makeAgent({ participation: 'observer', quota_remaining: 99 }),
      },
    });
    expect(noEligibleParticipants(state)).toBe(true);
  });
});

describe('allBidsIn with banned agents', () => {
  it('returns true when pending_bidders is empty even if banned agent has null bid (allBidsIn trusts pending_bidders, not current_bids)', () => {
    const state = makeBaseState({
      status: 'bidding',
      pending_bidders: [],
      current_bids: { alice: 50, bob: null },
      agents: {
        alice: { persona: '', display_name: 'Alice', participation: 'required', quota_remaining: 3, total_speaks: 0, fallback_used: false, banned: false },
        bob: { persona: '', display_name: 'Bob', participation: 'required', quota_remaining: 0, total_speaks: 0, fallback_used: true, banned: true },
      },
    });
    expect(allBidsIn(state)).toBe(true);
  });

  it('returns true when all agents are banned and pending_bidders is empty', () => {
    const state = makeBaseState({
      status: 'bidding',
      pending_bidders: [],
      current_bids: { alice: null, bob: null },
      agents: {
        alice: { persona: '', display_name: 'Alice', participation: 'required', quota_remaining: 0, total_speaks: 0, fallback_used: true, banned: true },
        bob: { persona: '', display_name: 'Bob', participation: 'required', quota_remaining: 0, total_speaks: 0, fallback_used: true, banned: true },
      },
    });
    expect(allBidsIn(state)).toBe(true);
  });

  it('returns false when status is ended and pending_bidders is empty', () => {
    const state = makeBaseState({ status: 'ended', pending_bidders: [] });
    expect(allBidsIn(state)).toBe(false);
  });
});
