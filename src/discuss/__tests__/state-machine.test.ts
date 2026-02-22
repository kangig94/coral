/**
 * Pure state machine tests - no filesystem, no async.
 */

import { describe, it, expect } from 'vitest';
import {
  initSession,
  startBidding,
  applyBid,
  resolveWinner,
  applySpeech,
  applySpeechTimeout,
  applyExpel,
  applyEpochSummary,
  applyEnd,
  parseDisplayName,
  topicSlug,
  formatDateId,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
} from '../state-machine.js';
import type { DiscussState, TranscriptEntry } from '../types.js';

const NOW = '2026-02-21T10:00:00.000Z';

const TWO_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.' },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.' },
];

const BASE_INPUT = { topic: 'Test Topic', agents: TWO_AGENTS };

function makeSession(): DiscussState {
  const init = initSession(BASE_INPUT, NOW);
  init.session_id = '260221-1000-test';
  init.session_dir = '260221-1000-test-test-topic';
  init.team_name = 'coral-dc-260221-1000-test';
  return init;
}

function startSession(): DiscussState {
  const state = makeSession();
  const res = startBidding(state, NOW);
  if (!res.ok) throw new Error('unreachable: failed to start bidding');
  return res.value;
}

// ─── parseDisplayName ────────────────────────────────────────────────────────

describe('parseDisplayName', () => {
  it('should parse em-dash format', () => {
    expect(parseDisplayName('# Kim Jimin — Conservative Analyst', 'agent')).toBe('Kim Jimin');
  });

  it('should parse en-dash format', () => {
    expect(parseDisplayName('# Park Soojin – Economist', 'agent')).toBe('Park Soojin');
  });

  it('should parse without # prefix', () => {
    expect(parseDisplayName('Alice Architect — Senior Designer', 'agent')).toBe('Alice Architect');
  });

  it('should parse English multi-word names', () => {
    expect(parseDisplayName('# James Bond — Agent', 'agent')).toBe('James Bond');
  });

  it('should parse hyphenated names', () => {
    expect(parseDisplayName('# Mary-Jane — Scientist', 'agent')).toBe('Mary-Jane');
  });

  it('should fall back to agentName when no match', () => {
    expect(parseDisplayName('No header here', 'myAgent')).toBe('myAgent');
  });

  it('should never return empty string', () => {
    expect(parseDisplayName('', 'fallback')).toBe('fallback');
    expect(parseDisplayName('# — dash only', 'fallback')).toBe('fallback');
  });
});

// ─── topicSlug ───────────────────────────────────────────────────────────────

describe('topicSlug', () => {
  it('should strip filesystem-unsafe characters', () => {
    expect(topicSlug('A/B testing?')).toBe('ab-testing');
  });

  it('should preserve Korean characters', () => {
    expect(topicSlug('한글 토픽')).toBe('한글-토픽');
  });

  it('should handle long topics with truncation', () => {
    const long = 'this is a very long topic that exceeds forty characters significantly';
    const slug = topicSlug(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
});

// ─── initSession / startBidding ────────────────────────────────────────────

describe('initSession', () => {
  it('should initialize setup state with bidding defaults', () => {
    const state = makeSession();
    expect(state.status).toBe('setup');
    expect(state.step).toBe(1);
    expect(state.epoch).toBe(1);
    expect(state.hold_count).toBe(0);
    expect(state.bid_release_step).toBe(0);
    expect(state.end_reason_content).toBeNull();
    expect(state.agents['alice'].banned).toBe(false);
    expect(state.current_bids).toEqual({ alice: null, bob: null });
    expect(state.pending_bidders.sort()).toEqual(['alice', 'bob']);
  });

  it('should use default bid_threshold and max_epochs', () => {
    const state = makeSession();
    expect(state.bid_threshold).toBe(DEFAULT_BID_THRESHOLD);
    expect(state.max_epochs).toBe(DEFAULT_MAX_EPOCHS);
  });

  it('should start in bidding state via startBidding', () => {
    const state = startSession();
    expect(state.status).toBe('bidding');
    expect(state.last_speech_step).toBe(0);
  });
});

// ─── applyBid / resolveWinner ───────────────────────────────────────────────

describe('applyBid', () => {
  it('should record bid in bidding status', () => {
    const state = startSession();
    const res = applyBid(state, 'alice', 75, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.pending_bidders).not.toContain('alice');
    expect(res.value.current_bids['alice']).toBe(75);
    expect(res.value.pending_bidders).toContain('bob');
  });

  it('should allow bid in setup (no transcript read gate)', () => {
    const state = makeSession();
    const res = applyBid(state, 'alice', 75, NOW);
    expect(res.ok).toBe(true);
  });

  it('should return error for unknown agent', () => {
    const state = startSession();
    const res = applyBid(state, 'nobody', 50, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('agent_not_found');
  });

  it('should reject double bid from same agent', () => {
    const state = startSession();
    const first = applyBid(state, 'alice', 75, NOW);
    expect(first.ok).toBe(true);
    const second = first.ok ? applyBid(first.value, 'alice', 80, NOW) : null;
    expect(second?.ok).toBe(false);
    if (!second || second.ok) return;
    expect(second.error).toBe('already_bid');
  });
});

describe('resolveWinner', () => {
  it('should prefer highest scorer in primary pool', () => {
    const state = startSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 50, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [next, decision] = res.value;
    expect(('speaker_type' in decision && decision.speaker_type)).toBe('quota');
    if ('winner' in decision) {
      expect(decision.winner).toBe('alice');
    }
    expect(next.current_speaker).toBe('alice');
    expect(next.status).toBe('speaking');
  });

  it('should auto-pick cold-start winner when all bids below threshold', () => {
    const state = startSession();
    const s1 = applyBid(state, 'alice', 10, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 20, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, decision] = res.value;
    expect(('speaker_type' in decision && decision.speaker_type)).toBe('cold_start');
    expect('speaker_type' in decision ? decision.winner : null).toBe('bob');
  });

  it('should skip banned agents in quorum and fallback checks', () => {
    let state = startSession();
    state = {
      ...state,
      agents: {
        ...state.agents,
        bob: { ...state.agents.bob, banned: true },
      },
    };

    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 90, NOW);
    const resolved = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    if ('speaker_type' in resolved.value[1]) {
      expect(resolved.value[1].winner).toBe('alice');
    }
  });

  it('should treat non-exhausted allBlocked when no quota speaker is available', () => {
    const state = startSession();
    state.agents.alice.quota_remaining = 0;
    state.agents.alice.fallback_used = true;
    state.agents.bob.total_speaks = 4;

    const s1 = applyBid(state, 'alice', 70, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 20, NOW);
    const resolved = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const [, decision] = resolved.value;
    expect(('no_winner' in decision && decision.no_winner)).toBe(true);
    if (!('no_winner' in decision)) return;
    expect(decision.reason).toBe('all_blocked');
  });

  it('should auto-transition epoch and reset quotas for non-banned agents', () => {
    const state = startSession();
    state.agents.alice.quota_remaining = 0;
    state.agents.alice.fallback_used = true;
    state.agents.bob.banned = true;

    const state2 = {
      ...state,
      cold_start: false,
      current_bids: { alice: 80, bob: 80 },
      pending_bidders: [],
    };

    const resolved = resolveWinner(state2, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const [nextState, decision] = resolved.value;
    expect('no_winner' in decision && decision.no_winner).toBe(true);
    if (!('no_winner' in decision)) return;
    expect(decision.reason).toBe('epoch_transition');
    expect(nextState.epoch).toBe(2);
    expect(nextState.agents.alice.quota_remaining).toBe(3);
    expect(nextState.agents.bob.banned).toBe(true);
  });
});

// ─── speech lifecycle ─────────────────────────────────────────────────────

describe('speech lifecycle', () => {
  function winningState(): DiscussState {
    const state = startSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 40, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    return r.ok ? r.value[0] : state;
  }

  it('should increment step and open release marker on applySpeech', () => {
    const state = winningState();
    const res = applySpeech(state, 'alice', 'My speech.', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('bidding');
    expect(res.value.step).toBe(2);
    expect(res.value.bid_release_step).toBe(1);
    expect(res.value.last_speech_step).toBe(1);
  });

  it('should decrement quota for normal speaker and increment total_speaks', () => {
    const state = winningState();
    const res = applySpeech(state, 'alice', 'My speech.', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.agents['alice'].quota_remaining).toBe(2);
    expect(res.value.agents['alice'].total_speaks).toBe(1);
  });

  it('should apply speech timeout with force semantics', () => {
    const state = winningState();
    const timeout = applySpeechTimeout(state, NOW);
    expect(timeout.ok).toBe(true);
    if (!timeout.ok) return;
    expect(timeout.value.status).toBe('bidding');
    expect(timeout.value.agents.alice.total_speaks).toBe(1);
    expect(timeout.value.transcript.at(-1)?.type).toBe('speech');
    expect(timeout.value.bid_release_step).toBe(state.step);
  });

  it('should not decrement fallback speaker quota on timeout/speech', () => {
    const state = startSession();
    const withFallback = {
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, quota_remaining: 0, fallback_used: false },
      },
    };

    const s1 = applyBid(withFallback, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : withFallback, 'bob', 40, NOW);
    const r = resolveWinner(s2.ok ? s2.value : withFallback, NOW);
    if (!r.ok) return;

    const timed = applySpeechTimeout(r.value[0], NOW);
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;
    expect(timed.value.agents['alice'].quota_remaining).toBe(0);
    expect(timed.value.agents['alice'].total_speaks).toBe(1);
  });
});

// ─── applyExpel ────────────────────────────────────────────────────────────

describe('applyExpel', () => {
  it('should not ban in epoch1 step1 respawn case', () => {
    const state = startSession();
    const expelled = applyExpel(state, ['alice'], NOW);
    expect(expelled.ok).toBe(true);
    if (!expelled.ok) return;
    expect(expelled.value.state.agents.alice.banned).toBe(false);
    expect(expelled.value.hint).toContain('Shutdown and respawn');
  });

  it('should ban and clear quota after step2 and beyond', () => {
    const state = {
      ...startSession(),
      step: 3,
      epoch: 2,
      current_speaker: null,
      speaker_type: null,
      hold_count: 0,
    };
    const expelled = applyExpel(state, ['alice'], NOW);
    expect(expelled.ok).toBe(true);
    if (!expelled.ok) return;
    expect(expelled.value.state.agents.alice.banned).toBe(true);
    expect(expelled.value.state.agents.alice.quota_remaining).toBe(0);
    expect(expelled.value.hint).toContain('Banned');
  });
});

// ─── epoch summary / end / time fields ────────────────────────────────────

describe('applyEpochSummary', () => {
  it('should set bid_release_step when recording summary', () => {
    const state = startSession();
    const withSpeech = applySpeechTimeout(state, NOW);
    const base = withSpeech.ok ? withSpeech.value : state;
    const summarized = applyEpochSummary(base, 'Phase one highlights.', NOW);
    expect(summarized.ok).toBe(true);
    if (!summarized.ok) return;
    expect(summarized.value.epoch_summary_written).toBe(1);
    expect(summarized.value.bid_release_step).toBe(base.step);
  });

  it('should reject duplicate summary for same epoch', () => {
    const state = startSession();
    const r1 = applyEpochSummary(state, 'First', NOW);
    expect(r1.ok).toBe(true);
    const r2 = r1.ok ? applyEpochSummary(r1.value, 'Duplicate', NOW) : null;
    expect(r2?.ok).toBe(false);
    if (!r2 || r2.ok) return;
    expect(r2.error).toBe('epoch_summary_duplicate');
  });
});

describe('applyEnd', () => {
  it('should end session and open release marker', () => {
    const state = startSession();
    const res = applyEnd(state, {}, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('ended');
    expect(res.value.bid_release_step).toBe(state.step);
  });

  it('should require force flag in normal speaking end', () => {
    const state = startSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 20, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    const speaking = r.ok ? r.value[0] : state;
    const res = applyEnd(speaking, {}, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('requires_force');
  });

  it('should be idempotent for already ended sessions', () => {
    const state = startSession();
    const ended = applyEnd(state, {}, NOW);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    const second = applyEnd(ended.value, {}, NOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual(ended.value);
  });

  it('should append synthesis only once on already-ended session', () => {
    const state = startSession();
    const ended = applyEnd(state, {}, NOW);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;

    const first = applyEnd(ended.value, { synthesis: 'Final conclusion.' }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applyEnd(first.value, { synthesis: 'Another conclusion should be ignored.' }, NOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const synthCount = second.value.transcript.filter(
      (e): e is Extract<TranscriptEntry, { type: 'session_event'; event: 'synthesis'; detail: string }> =>
        e.type === 'session_event' && e.event === 'synthesis',
    ).length;
    expect(synthCount).toBe(1);
  });
});

// ─── formatDateId / updated timestamps ────────────────────────────────────

describe('formatDateId', () => {
  it('should produce yymmdd-HHmm format', () => {
    const d = new Date('2026-02-21T15:20:00Z');
    expect(formatDateId(d)).toMatch(/^\d{6}-\d{4}$/);
  });

  it('should use two-digit year and zero padding', () => {
    const d = new Date('2026-01-05T08:03:00Z');
    expect(formatDateId(d)).toMatch(/^\d{6}-\d{4}$/);
  });
});
