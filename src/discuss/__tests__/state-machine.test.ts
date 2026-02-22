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
  computeEffectiveBids,
  findLastSpeaker,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
} from '../state-machine.js';
import type { AgentState, DiscussState, TranscriptEntry } from '../types.js';

const NOW = '2026-02-21T10:00:00.000Z';

const TWO_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.' },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.' },
];

const BASE_INPUT = { topic: 'Test Topic', agents: TWO_AGENTS };

const COLD_START_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.' },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.' },
  { name: 'carol', persona: '# Carol Observer — Observer\nNotes and prompts.' },
  { name: 'dave', persona: '# Dave Analyst — Analyst\nData minded.' },
  { name: 'eve', persona: '# Eve Moderator — Moderator\nSession helper.' },
  { name: 'frank', persona: '# Frank Synthesizer — Synthesizer\nFinal summarizer.' },
];
const COLD_START_INPUT = { topic: 'Cold Start Topic', agents: COLD_START_AGENTS };

function makeSession(input = BASE_INPUT): DiscussState {
  const init = initSession(input, NOW);
  init.session_id = '260221-1000-test';
  init.session_dir = `260221-1000-test-${input.topic.toLowerCase().replace(/\s+/g, '-')}`;
  init.team_name = 'coral-dc-260221-1000-test';
  return init;
}

function startSession(input = BASE_INPUT): DiscussState {
  const state = makeSession(input);
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
    const s2 = applyBid(s1.ok ? s1.value : withFallback, 'bob', 20, NOW);
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

// ─── helpers for adversarial tests ────────────────────────────────────────

function placeBids(state: DiscussState, bids: Record<string, number>): DiscussState {
  let next = state;
  for (const [name, score] of Object.entries(bids)) {
    const updated = applyBid(next, name, score, NOW);
    if (!updated.ok) throw new Error(`unreachable: ${updated.error}`);
    next = updated.value;
  }
  return next;
}

function speechEntry(agent: string): TranscriptEntry {
  return {
    type: 'speech',
    step: 1,
    epoch: 1,
    ts: NOW,
    agent,
    display_name: agent[0]!.toUpperCase() + agent.slice(1),
    content: `${agent} spoke earlier.`,
  };
}

function makeAgentMap(rows: Array<{ name: string; total_speaks: number; banned?: boolean }>): Record<string, AgentState> {
  return Object.fromEntries(
    rows.map(({ name, total_speaks, banned }) => [
      name,
      {
        persona: '',
        display_name: name[0]!.toUpperCase() + name.slice(1),
        quota_remaining: 3,
        total_speaks,
        fallback_used: false,
        banned: !!banned,
      },
    ]),
  );
}

// ─── computeEffectiveBids ──────────────────────────────────────────────────

function makeAgents(speaks: Record<string, number>): Record<string, import('../types.js').AgentState> {
  return Object.fromEntries(
    Object.entries(speaks).map(([name, total_speaks]) => [
      name,
      { persona: '', display_name: name, quota_remaining: 3, total_speaks, fallback_used: false, banned: false },
    ]),
  );
}

describe('computeEffectiveBids', () => {
  it('should return raw bids unchanged when all speaks are equal', () => {
    const agents = makeAgents({ a: 0, b: 0, c: 0, d: 0 });
    const bids = { a: 80, b: 60, c: 70, d: 50 };
    const result = computeEffectiveBids(bids, agents, null);
    // avg=0, my=0, imbalance=0; no recency -> effective = raw
    expect(result).toEqual(bids);
  });

  it('should penalize agent with more speaks than average', () => {
    // avg = (2+0+1+1)/4 = 1; a has 2 speaks -> imbalance = 25 * (1 - 2) = -25
    const agents = makeAgents({ a: 2, b: 0, c: 1, d: 1 });
    const bids = { a: 80, b: 60, c: 60, d: 60 };
    const result = computeEffectiveBids(bids, agents, null);
    expect(result['a']).toBeCloseTo(80 - 25); // 55
  });

  it('should boost agent with fewer speaks than average', () => {
    // avg = (0+2+1+1)/4 = 1; a has 0 speaks -> imbalance = 25 * (1 - 0) = +25
    const agents = makeAgents({ a: 0, b: 2, c: 1, d: 1 });
    const bids = { a: 60, b: 80, c: 80, d: 80 };
    const result = computeEffectiveBids(bids, agents, null);
    expect(result['a']).toBeCloseTo(60 + 25); // 85
  });

  it('should apply recency penalty to last speaker', () => {
    // N=4, P_RECENCY = 50/4 = 12.5; all equal speaks -> only recency affects 'a'
    const agents = makeAgents({ a: 1, b: 1, c: 1, d: 1 });
    const bids = { a: 80, b: 80, c: 80, d: 80 };
    const result = computeEffectiveBids(bids, agents, 'a');
    expect(result['a']).toBeCloseTo(80 - 12.5);
    expect(result['b']).toBeCloseTo(80);
  });

  it('should combine imbalance penalty and recency penalty', () => {
    // avg = (2+0+1+1)/4 = 1; a has 2 speaks, just spoke -> -25 (imbalance) -12.5 (recency) = 42.5
    const agents = makeAgents({ a: 2, b: 0, c: 1, d: 1 });
    const bids = { a: 80, b: 60, c: 60, d: 60 };
    const result = computeEffectiveBids(bids, agents, 'a');
    expect(result['a']).toBeCloseTo(80 - 25 - 12.5); // 42.5
  });

  it('should scale P_BASE and P_RECENCY with N=2', () => {
    // N=2, P_BASE=50, P_RECENCY=25
    const agents = makeAgents({ a: 2, b: 0 });
    const bids = { a: 80, b: 60 };
    // avg=1, a: -50*(1) = -50 -> 30; b: +50*(1) = +50 -> 110
    const result = computeEffectiveBids(bids, agents, null);
    expect(result['a']).toBeCloseTo(30);
    expect(result['b']).toBeCloseTo(110);
  });

  it('should scale P_BASE and P_RECENCY with N=8', () => {
    // N=8, P_BASE=12.5, P_RECENCY=6.25; all equal speaks -> no imbalance
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const agents = makeAgents(Object.fromEntries(names.map((n) => [n, 1])));
    const bids = Object.fromEntries(names.map((n) => [n, 50]));
    const result = computeEffectiveBids(bids, agents, 'a');
    expect(result['a']).toBeCloseTo(50 - 6.25); // only recency
    expect(result['b']).toBeCloseTo(50);
  });

  it('should return raw bids unchanged for N=1', () => {
    const agents = makeAgents({ a: 5 });
    const bids = { a: 80 };
    expect(computeEffectiveBids(bids, agents, 'a')).toEqual({ a: 80 });
  });

  it('should not penalize anyone when lastSpeaker is null', () => {
    const agents = makeAgents({ a: 0, b: 0 });
    const bids = { a: 70, b: 70 };
    const result = computeEffectiveBids(bids, agents, null);
    // no last speaker, no recency penalty; all equal speaks, no imbalance
    expect(result['a']).toBeCloseTo(70);
    expect(result['b']).toBeCloseTo(70);
  });
});

// ─── resolveWinner with decay ─────────────────────────────────────────────

describe('resolveWinner with decay', () => {
  it('should flip winner when decay gives lower-bidder a higher effective score', () => {
    // alice bids 32 with 0 speaks; bob bids 35 with 2 speaks; N=2, avg=1
    // alice effective: 32 + 50*(1-0) = 82; bob effective: 35 + 50*(1-2) = -15
    const state = startSession();
    state.agents.alice.total_speaks = 0;
    state.agents.bob.total_speaks = 2;
    const s1 = applyBid(state, 'alice', 32, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 35, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, decision] = res.value;
    // alice should win despite lower raw bid (higher effective score)
    expect('winner' in decision && decision.winner).toBe('alice');
  });

  it('should use raw score for threshold filter, not effective score', () => {
    // bob bids 5 (below threshold=30), alice bids 40; bob has 0 speaks (boost)
    // bob effective would be high, but raw=5 < threshold -> not in primary pool
    const state = startSession();
    state.agents.alice.total_speaks = 2;
    state.agents.bob.total_speaks = 0;
    state.cold_start = false;
    const s1 = applyBid(state, 'alice', 40, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 5, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, decision] = res.value;
    // alice should win because bob's raw bid is below threshold
    expect('winner' in decision && decision.winner).toBe('alice');
  });

  it('should include effective_bids in cold-start transcript entry for audit', () => {
    const state = startSession();
    // both below threshold -> cold start
    const s1 = applyBid(state, 'alice', 5, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 10, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [nextState, decision] = res.value;
    expect('speaker_type' in decision && decision.speaker_type).toBe('cold_start');
    const bidsEntry = nextState.transcript.at(-1);
    expect(bidsEntry?.type).toBe('bids');
    if (bidsEntry?.type !== 'bids') return;
    expect(bidsEntry.effective_bids).toBeDefined();
  });

  it('should include effective_bids in epoch-transition transcript entry', () => {
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

    const res = resolveWinner(state2, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [nextState, decision] = res.value;
    expect('no_winner' in decision && decision.reason).toBe('epoch_transition');
    // find the bids entry appended before epoch transition
    const bidsEntry = nextState.transcript.find((e) => e.type === 'bids');
    expect(bidsEntry?.type).toBe('bids');
    if (bidsEntry?.type !== 'bids') return;
    expect(bidsEntry.effective_bids).toBeDefined();
  });
});

// ─── adversarial: computeEffectiveBids ───────────────────────────────────────

describe('computeEffectiveBids (adversarial)', () => {
  it('should return raw score for single active agent when not last speaker', () => {
    const allBids = { alice: 80 };
    const agents = makeAgentMap([{ name: 'alice', total_speaks: 0 }]);
    const effective = computeEffectiveBids(allBids, agents, null);
    expect(effective).toEqual({ alice: 80 });
  });

  it('should return raw bid unchanged for single active agent (N<=1 guard)', () => {
    const allBids = { alice: 80 };
    const agents = makeAgentMap([{ name: 'alice', total_speaks: 0 }]);
    const effective = computeEffectiveBids(allBids, agents, 'alice');
    expect(effective).toEqual({ alice: 80 });
  });

  it('should return empty object for empty bids', () => {
    const effective = computeEffectiveBids({}, {}, null);
    expect(effective).toEqual({});
  });

  it('should preserve raw scores when all agents have the same speaking count', () => {
    const allBids = { alice: 70, bob: 20, carol: 55 };
    const agents = makeAgentMap([
      { name: 'alice', total_speaks: 2 },
      { name: 'bob', total_speaks: 2 },
      { name: 'carol', total_speaks: 2 },
    ]);
    const effective = computeEffectiveBids(allBids, agents, null);
    expect(effective).toEqual(allBids);
  });

  it('should give catch-up bonus to silent agent and penalty to verbose agents', () => {
    const allBids = { alice: 10, bob: 20, carol: 30 };
    const agents = makeAgentMap([
      { name: 'alice', total_speaks: 0 },
      { name: 'bob', total_speaks: 2 },
      { name: 'carol', total_speaks: 2 },
    ]);
    const effective = computeEffectiveBids(allBids, agents, null);
    expect(effective.alice).toBeCloseTo(54.4, 1);
    expect(effective.bob).toBeCloseTo(-2.2, 1);
    expect(effective.carol).toBeCloseTo(7.8, 1);
  });

  it('should apply recency penalty of 50/N to just-spoke agents', () => {
    const allBids = { alice: 60, bob: 60 };
    const agents = makeAgentMap([{ name: 'alice', total_speaks: 0 }, { name: 'bob', total_speaks: 0 }]);
    const effective = computeEffectiveBids(allBids, agents, 'alice');
    expect(effective.alice).toBe(35);
    expect(effective.bob).toBe(60);
  });

  it('should ignore lastSpeaker if it is absent from bids', () => {
    const allBids = { alice: 10, bob: 20 };
    const agents = makeAgentMap([{ name: 'alice', total_speaks: 0 }, { name: 'bob', total_speaks: 0 }]);
    const effective = computeEffectiveBids(allBids, agents, 'carol');
    expect(effective).toEqual(allBids);
  });

  it('should return raw bid unchanged for lone speaker with N<=1 guard', () => {
    const allBids = { alice: 10 };
    const agents = makeAgentMap([{ name: 'alice', total_speaks: 0 }]);
    const effective = computeEffectiveBids(allBids, agents, 'alice');
    expect(effective.alice).toBe(10);
  });

  it('should exclude banned agents from avg_speaks so they do not inflate the mean', () => {
    const allBids = { alice: 20 };
    const agents = makeAgentMap([
      { name: 'alice', total_speaks: 0 },
      { name: 'bob', total_speaks: 100, banned: true },
    ]);
    const effective = computeEffectiveBids(allBids, agents, null);
    expect(effective.alice).toBe(20);
  });
});

// ─── adversarial: findLastSpeaker ────────────────────────────────────────────

describe('findLastSpeaker (adversarial)', () => {
  it('should return null for empty transcript', () => {
    expect(findLastSpeaker([])).toBeNull();
  });

  it('should return null when no speech entries exist', () => {
    const transcript: TranscriptEntry[] = [
      { type: 'bids', step: 1, epoch: 1, ts: NOW, bids: { alice: 10 }, winner: null, resolve_type: 'no_winner' },
      { type: 'epoch_summary', epoch: 1, ts: NOW, summary: 'No speech yet.' },
    ];
    expect(findLastSpeaker(transcript)).toBeNull();
  });

  it('should return agent from most recent speech entry', () => {
    const transcript: TranscriptEntry[] = [
      speechEntry('alice'),
      speechEntry('bob'),
    ];
    expect(findLastSpeaker(transcript)).toBe('bob');
  });

  it('should keep last speech speaker even when bids appear later', () => {
    const transcript: TranscriptEntry[] = [
      speechEntry('alice'),
      {
        type: 'bids',
        step: 2,
        epoch: 1,
        ts: NOW,
        bids: { alice: 10, bob: 5 },
        winner: 'alice',
        resolve_type: 'normal',
      },
    ];
    expect(findLastSpeaker(transcript)).toBe('alice');
  });
});

// ─── adversarial: resolveWinner with decay ───────────────────────────────────

describe('resolveWinner with decay (adversarial)', () => {
  it('should flip winner order when decay changes effective bids', () => {
    let state = startSession();
    state = {
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, total_speaks: 5 },
        bob: { ...state.agents.bob, total_speaks: 0 },
      },
    };
    const stateWithBids = placeBids(state, { alice: 70, bob: 60 });
    const resolved = resolveWinner(stateWithBids, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const [, decision] = resolved.value;
    expect(('speaker_type' in decision && decision.speaker_type)).toBe('quota');
    expect('winner' in decision ? decision.winner : null).toBe('bob');
  });

  it('should keep threshold check on raw bid despite decay effects', () => {
    let state = startSession();
    state = {
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, total_speaks: 5 },
        bob: { ...state.agents.bob, total_speaks: 0 },
      },
    };
    const stateWithBids = placeBids(state, { alice: 25, bob: 50 });
    const resolved = resolveWinner(stateWithBids, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value[0].status).toBe('speaking');
    expect('speaker_type' in resolved.value[1] ? resolved.value[1].speaker_type : null).toBe('quota');
    expect('winner' in resolved.value[1] ? resolved.value[1].winner : null).toBe('bob');
  });

  it('should include effective_bids on winning bids transcript entries', () => {
    const state = startSession();
    const stateWithBids = placeBids(state, { alice: 80, bob: 50 });
    const resolved = resolveWinner(stateWithBids, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const lastEntry = resolved.value[0].transcript.at(-1);
    expect(lastEntry && lastEntry.type).toBe('bids');
    if (!lastEntry || lastEntry.type !== 'bids') return;
    expect(lastEntry.effective_bids).toEqual({ alice: 80, bob: 50 });
  });

  it('should keep cold-start path based on raw bids and quota history', () => {
    let state = startSession(COLD_START_INPUT);
    state = {
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, total_speaks: 0 },
        bob: { ...state.agents.bob, total_speaks: 1 },
        carol: { ...state.agents.carol, total_speaks: 0 },
        dave: { ...state.agents.dave, total_speaks: 0 },
        eve: { ...state.agents.eve, total_speaks: 0 },
        frank: { ...state.agents.frank, total_speaks: 0 },
      },
    };
    const stateWithBids = placeBids(state, {
      alice: 0,
      bob: 29,
      carol: 0,
      dave: 0,
      eve: 0,
      frank: 0,
    });
    const resolved = resolveWinner(stateWithBids, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect('speaker_type' in resolved.value[1] ? resolved.value[1].speaker_type : null).toBe('cold_start');
    expect('winner' in resolved.value[1] ? resolved.value[1].winner : null).toBe('alice');
    expect(resolved.value[0].current_speaker).toBe('alice');
    expect(resolved.value[1]).not.toEqual({ no_winner: true, reason: 'all_below_threshold', });
    expect(DEFAULT_BID_THRESHOLD).toBe(30);
  });

  it('should include effective_bids on epoch-transition bids entries', () => {
    let state = startSession();
    state = {
      ...state,
      cold_start: false,
      current_bids: { alice: 80, bob: 50 },
      pending_bidders: [],
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, quota_remaining: 0, fallback_used: true },
        bob: { ...state.agents.bob, quota_remaining: 0, fallback_used: true },
      },
    };
    const resolved = resolveWinner(state, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect('no_winner' in resolved.value[1]).toBe(true);
    if (!('no_winner' in resolved.value[1])) return;
    expect(resolved.value[1].reason).toBe('epoch_transition');
    const lastEntry = resolved.value[0].transcript.at(-1);
    expect(lastEntry && lastEntry.type).toBe('bids');
    if (!lastEntry || lastEntry.type !== 'bids') return;
    expect(lastEntry.effective_bids).toEqual({ alice: 80, bob: 50 });
  });

  it('should select winner by effective score when raw bids tie', () => {
    let stateWithSpeech = startSession();
    stateWithSpeech = {
      ...stateWithSpeech,
      transcript: [speechEntry('alice')],
      agents: {
        ...stateWithSpeech.agents,
        alice: { ...stateWithSpeech.agents.alice, total_speaks: 5 },
        bob: { ...stateWithSpeech.agents.bob, total_speaks: 0 },
      },
    };
    const stateWithBids = placeBids(stateWithSpeech, { alice: 80, bob: 80 });
    const resolved = resolveWinner(stateWithBids, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect('speaker_type' in resolved.value[1] ? resolved.value[1].speaker_type : null).toBe('quota');
    expect('winner' in resolved.value[1] ? resolved.value[1].winner : null).toBe('bob');
  });
});
