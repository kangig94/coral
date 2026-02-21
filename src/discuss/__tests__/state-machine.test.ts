/**
 * Pure state machine tests — no filesystem, no async (except resolveWinner in voting flow).
 */

import { describe, it, expect } from 'vitest';
import {
  initSession,
  startBidding,
  applyBid,
  resolveWinner,
  applySpeech,
  applyEnd,
  applyEpochSummary,
  parseDisplayName,
  DEFAULT_BID_THRESHOLD,
} from '../state-machine.js';
import { normalizeState } from '../session-store.js';
import type { DiscussState } from '../types.js';

const NOW = '2026-02-21T10:00:00.000Z';

const TWO_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.' },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.' },
];

const BASE_INPUT = { topic: 'Test Topic', agents: TWO_AGENTS, quota_per_epoch: 3, recent_turns: 5 };

function makeSession(): DiscussState {
  const init = initSession(BASE_INPUT, NOW);
  init.session_id = '20260221-100000-test';
  init.session_dir = '20260221-100000-test_test-topic';
  init.team_name = 'coral-dc-20260221-100000-test';
  const res = startBidding(init, NOW);
  if (!res.ok) throw new Error('unreachable: startBidding failed in test helper');
  return res.value;
}

/** Stamp transcript_read_step[agent] = state.step — simulates calling discuss_transcript. */
function withTranscriptRead(state: DiscussState, ...agents: string[]): DiscussState {
  const trs = { ...state.transcript_read_step };
  for (const a of agents) trs[a] = state.step;
  return { ...state, transcript_read_step: trs };
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

// ─── initSession ─────────────────────────────────────────────────────────────

describe('initSession', () => {
  it('should return setup status (gates bidding until teamlead starts)', () => {
    const state = initSession(BASE_INPUT, NOW);
    expect(state.status).toBe('setup');
  });

  it('should use default bid_threshold of 50', () => {
    const state = initSession(BASE_INPUT, NOW);
    expect(state.bid_threshold).toBe(DEFAULT_BID_THRESHOLD);
    expect(state.bid_threshold).toBe(50);
  });

  it('should accept custom bid_threshold', () => {
    const state = initSession(BASE_INPUT, NOW, 70);
    expect(state.bid_threshold).toBe(70);
  });

  it('should create state with correct defaults (after startBidding)', () => {
    const state = makeSession(); // includes startBidding
    expect(state.status).toBe('bidding');
    expect(state.step).toBe(1);
    expect(state.epoch).toBe(1);
    expect(state.cold_start).toBe(true);
    expect(state.current_speaker).toBeNull();
    expect(state.last_speech_step).toBe(0);
    expect(state.transcript).toEqual([]);
    expect(state.transcript_rendered).toBe(0);
  });

  it('should populate pending_bidders with all agents', () => {
    const state = makeSession();
    expect(state.pending_bidders.sort()).toEqual(['alice', 'bob']);
  });

  it('should parse display_name from persona', () => {
    const state = makeSession();
    expect(state.agents['alice'].display_name).toBe('Alice Architect');
    expect(state.agents['bob'].display_name).toBe('Bob Critic');
  });

  it('should not expose current_bids (all null)', () => {
    const state = makeSession();
    expect(state.current_bids['alice']).toBeNull();
    expect(state.current_bids['bob']).toBeNull();
  });
});

// ─── startBidding ─────────────────────────────────────────────────────────────

describe('startBidding', () => {
  it('should transition setup → bidding', () => {
    const init = initSession(BASE_INPUT, NOW);
    const res = startBidding(init, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('bidding');
  });

  it('should reject if not in setup status', () => {
    const state = makeSession(); // already bidding
    const res = startBidding(state, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_in_setup');
  });
});

// ─── applyBid ────────────────────────────────────────────────────────────────

describe('applyBid', () => {
  it('should record bid and track pending_bidders', () => {
    const state = makeSession();
    const res = applyBid(state, 'alice', 75, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.pending_bidders).not.toContain('alice');
    expect(res.value.current_bids['alice']).toBe(75);
    expect(res.value.pending_bidders).toContain('bob');
  });

  it('should return error for double-bid', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 75, NOW);
    expect(s1.ok).toBe(true);
    const s2 = applyBid(s1.ok ? s1.value : state, 'alice', 80, NOW);
    expect(s2.ok).toBe(false);
    if (s2.ok) return;
    expect(s2.error).toBe('already_bid');
  });

  it('should return error for unknown agent', () => {
    const state = makeSession();
    const res = applyBid(state, 'nobody', 50, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('agent_not_found');
  });

  it('should reject invalid voting score', () => {
    const state = makeSession();
    // Put into voting status
    const votingState = { ...state, status: 'voting' as const };
    const res = applyBid(votingState, 'alice', 50, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('voting_score_invalid');
  });

  it('should reject bid in setup status', () => {
    const state = initSession(BASE_INPUT, NOW); // status=setup
    const res = applyBid(state, 'alice', 75, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('invalid_status');
  });

  it('should reject bid in non-bidding status', () => {
    const state = makeSession();
    const speakingState = { ...state, status: 'speaking' as const };
    const res = applyBid(speakingState, 'alice', 75, NOW);
    expect(res.ok).toBe(false);
  });
});

// ─── resolveWinner — primary pool ────────────────────────────────────────────

describe('resolveWinner — primary pool', () => {
  function bidBoth(state: DiscussState, aliceScore: number, bobScore: number): DiscussState {
    const s1 = applyBid(state, 'alice', aliceScore, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', bobScore, NOW);
    return s2.ok ? s2.value : state;
  }

  it('should select highest bidder as winner', () => {
    const state = bidBoth(makeSession(), 80, 50);
    const res = resolveWinner(state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState, result] = res.value;
    expect('winner' in result && result.winner).toBe('alice');
    expect('resolve_type' in result && result.resolve_type).toBe('normal');
    expect(newState.status).toBe('speaking');
    expect(newState.current_speaker).toBe('alice');
    expect(newState.cold_start).toBe(false);
  });

  it('should reject without quorum', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const res = resolveWinner(s1.ok ? s1.value : state, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('quorum_not_met');
  });

  it('should prefer agent with fewer total_speaks on tie', () => {
    // Give alice one speak first
    let state = makeSession();
    state = bidBoth(state, 80, 80); // tied
    const r1 = resolveWinner(state, NOW);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const [afterResolve1] = r1.value;
    expect(afterResolve1.current_speaker).toBe('alice'); // alphabetical tiebreak

    // Alice speaks
    const r2 = applySpeech(afterResolve1, 'alice', 'Alice speech.', NOW);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Step 2: same scores again — bob should win (fewer speaks)
    const afterSpeech = r2.value;
    const state2 = bidBoth(withTranscriptRead(afterSpeech, 'alice', 'bob'), 80, 80);
    const res2 = resolveWinner(state2, NOW);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.value[1]).toMatchObject({ winner: 'bob' });
  });

  it('should append bids entry to transcript', () => {
    const state = bidBoth(makeSession(), 80, 50);
    const res = resolveWinner(state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState] = res.value;
    const bidsEntry = newState.transcript.find((e) => e.type === 'bids');
    expect(bidsEntry).toBeDefined();
    expect(bidsEntry?.type).toBe('bids');
  });
});

// ─── resolveWinner — cold start ──────────────────────────────────────────────

describe('resolveWinner — cold start (auto-pick)', () => {
  it('should auto-pick speaker on cold start when all below threshold', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 5, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 10, NOW);
    const biddedState = s2.ok ? s2.value : state;
    // cold_start=true, all < 50 (threshold) → should auto-pick

    const res = resolveWinner(biddedState, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState, result] = res.value;
    // bob bid higher (10 > 5) → bob picked (desire second after fairness)
    expect('winner' in result && result.winner).toBe('bob');
    expect('resolve_type' in result && result.resolve_type).toBe('cold_start');
    expect(newState.speaker_type).toBe('cold_start');
    expect(newState.cold_start).toBe(false);
  });

  it('should return no_winner when all below threshold and cold_start=false', () => {
    // First get someone to speak so cold_start=false
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 20, NOW);
    const afterBid = s2.ok ? s2.value : state;
    const r1 = resolveWinner(afterBid, NOW);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const [afterResolve] = r1.value;
    const r2 = applySpeech(afterResolve, 'alice', 'speech', NOW);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const afterSpeech = r2.value; // cold_start is false now

    // Now all below threshold
    const readAfterSpeech = withTranscriptRead(afterSpeech, 'alice', 'bob');
    const s3 = applyBid(readAfterSpeech, 'alice', 10, NOW);
    const s4 = applyBid(s3.ok ? s3.value : readAfterSpeech, 'bob', 5, NOW);
    const afterBid2 = s4.ok ? s4.value : readAfterSpeech;
    const res = resolveWinner(afterBid2, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, result] = res.value;
    expect('no_winner' in result && result.no_winner).toBe(true);
  });
});

// ─── resolveWinner — fallback pool ───────────────────────────────────────────

describe('resolveWinner — fallback pool', () => {
  it('should use fallback pool when quota exhausted', () => {
    // quota=1, alice exhausts quota after 1 speech
    const input = { ...BASE_INPUT, quota_per_epoch: 1 };
    const init0 = initSession(input, NOW);
    init0.session_id = 'test'; init0.session_dir = 'test'; init0.team_name = 'test';
    const sb0 = startBidding(init0, NOW);
    if (!sb0.ok) throw new Error('unreachable');
    const state0 = sb0.value;

    // Step 1: alice wins and speaks
    const s1 = applyBid(state0, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state0, 'bob', 20, NOW);
    const r1 = resolveWinner(s2.ok ? s2.value : state0, NOW);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const sp1 = applySpeech(r1.value[0], 'alice', 'Alice step 1.', NOW);
    expect(sp1.ok).toBe(true);
    if (!sp1.ok) return;

    // Step 2: alice has quota=0, should use fallback
    const afterSp1 = withTranscriptRead(sp1.value, 'alice', 'bob');
    const s3 = applyBid(afterSp1, 'alice', 50, NOW); // score >= 30, quota=0
    const s4 = applyBid(s3.ok ? s3.value : afterSp1, 'bob', 20, NOW);
    const r2 = resolveWinner(s4.ok ? s4.value : afterSp1, NOW);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const [, result] = r2.value;
    expect('winner' in result && result.winner).toBe('alice');
    expect('resolve_type' in result && result.resolve_type).toBe('fallback');
  });

  it('should block second fallback (vote_required)', () => {
    const input = { ...BASE_INPUT, quota_per_epoch: 1 };
    const init0 = initSession(input, NOW);
    init0.session_id = 'test'; init0.session_dir = 'test'; init0.team_name = 'test';
    const sb0 = startBidding(init0, NOW);
    if (!sb0.ok) throw new Error('unreachable');
    const state0 = sb0.value;

    // alice uses quota
    const s1 = applyBid(state0, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state0, 'bob', 20, NOW);
    const r1 = resolveWinner(s2.ok ? s2.value : state0, NOW);
    if (!r1.ok) return;
    const sp1 = applySpeech(r1.value[0], 'alice', 'step 1', NOW);
    if (!sp1.ok) return;

    // alice uses fallback
    const afterSp1b = withTranscriptRead(sp1.value, 'alice', 'bob');
    const s3 = applyBid(afterSp1b, 'alice', 50, NOW);
    const s4 = applyBid(s3.ok ? s3.value : afterSp1b, 'bob', 20, NOW);
    const r2 = resolveWinner(s4.ok ? s4.value : afterSp1b, NOW);
    if (!r2.ok) return;
    const sp2 = applySpeech(r2.value[0], 'alice', 'fallback speech', NOW);
    if (!sp2.ok) return;

    // alice.fallback_used=true, bob below threshold → vote_required
    const afterSp2b = withTranscriptRead(sp2.value, 'alice', 'bob');
    const s5 = applyBid(afterSp2b, 'alice', 50, NOW);
    const s6 = applyBid(s5.ok ? s5.value : afterSp2b, 'bob', 20, NOW);
    const r3 = resolveWinner(s6.ok ? s6.value : afterSp2b, NOW);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const [, result] = r3.value;
    expect('vote_required' in result && result.vote_required).toBe(true);
  });

  it('should not decrement quota for fallback speaker', () => {
    const input = { ...BASE_INPUT, quota_per_epoch: 1 };
    const init0 = initSession(input, NOW);
    init0.session_id = 'test'; init0.session_dir = 'test'; init0.team_name = 'test';
    const sb0 = startBidding(init0, NOW);
    if (!sb0.ok) throw new Error('unreachable');
    const state0 = sb0.value;

    const s1 = applyBid(state0, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state0, 'bob', 20, NOW);
    const r1 = resolveWinner(s2.ok ? s2.value : state0, NOW);
    if (!r1.ok) return;
    const sp1 = applySpeech(r1.value[0], 'alice', 'step 1', NOW);
    if (!sp1.ok) return;

    const afterSp1c = withTranscriptRead(sp1.value, 'alice', 'bob');
    const s3 = applyBid(afterSp1c, 'alice', 50, NOW);
    const s4 = applyBid(s3.ok ? s3.value : afterSp1c, 'bob', 20, NOW);
    const r2 = resolveWinner(s4.ok ? s4.value : afterSp1c, NOW);
    if (!r2.ok) return;
    const sp2 = applySpeech(r2.value[0], 'alice', 'fallback', NOW);
    expect(sp2.ok).toBe(true);
    if (!sp2.ok) return;

    // quota should still be 0 (not decremented to -1)
    expect(sp2.value.agents['alice'].quota_remaining).toBe(0);
    expect(sp2.value.agents['alice'].total_speaks).toBe(2);
  });
});

// ─── applySpeech ─────────────────────────────────────────────────────────────

describe('applySpeech', () => {
  function withSpeaker(): DiscussState {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 50, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    return r.ok ? r.value[0] : state;
  }

  it('should increment step and reset for next bid', () => {
    const state = withSpeaker();
    const res = applySpeech(state, 'alice', 'My speech.', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.step).toBe(2);
    expect(res.value.status).toBe('bidding');
    expect(res.value.current_speaker).toBeNull();
    expect(res.value.pending_bidders.sort()).toEqual(['alice', 'bob']);
  });

  it('should set last_speech_step correctly (monotonic marker)', () => {
    const state = withSpeaker(); // step=1
    const res = applySpeech(state, 'alice', 'speech', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // last_speech_step=1, step=2 → speechDelivered predicate: 1 === 2-1 = true
    expect(res.value.last_speech_step).toBe(1);
    expect(res.value.step).toBe(2);
  });

  it('should decrement quota for normal speaker', () => {
    const state = withSpeaker();
    const res = applySpeech(state, 'alice', 'speech', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.agents['alice'].quota_remaining).toBe(2); // was 3
  });

  it('should reject speech from wrong agent', () => {
    const state = withSpeaker();
    const res = applySpeech(state, 'bob', 'unauthorized', NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_your_turn');
  });

  it('should reject speech in non-speaking status', () => {
    const state = makeSession(); // status=bidding
    const res = applySpeech(state, 'alice', 'unauthorized', NOW);
    expect(res.ok).toBe(false);
  });

  it('should append speech entry to transcript', () => {
    const state = withSpeaker();
    const res = applySpeech(state, 'alice', 'My argument.', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const speechEntry = res.value.transcript.find((e) => e.type === 'speech');
    expect(speechEntry).toBeDefined();
    if (speechEntry?.type !== 'speech') return;
    expect(speechEntry.content).toBe('My argument.');
    expect(speechEntry.agent).toBe('alice');
    expect(speechEntry.display_name).toBe('Alice Architect');
  });
});

// ─── voting flow ──────────────────────────────────────────────────────────────

describe('voting flow', () => {
  function reachVoteRequired(): DiscussState {
    const input = { ...BASE_INPUT, quota_per_epoch: 1 };
    const init = initSession(input, NOW);
    init.session_id = 'test'; init.session_dir = 'test'; init.team_name = 'test';
    const sb = startBidding(init, NOW);
    if (!sb.ok) throw new Error('unreachable');
    let state = sb.value;

    const bid = (s: DiscussState, a: number, b: number) => {
      const s1 = applyBid(s, 'alice', a, NOW);
      const s2 = applyBid(s1.ok ? s1.value : s, 'bob', b, NOW);
      return s2.ok ? s2.value : s;
    };

    // alice exhausts quota
    state = bid(state, 80, 20);
    const r1 = resolveWinner(state, NOW);
    if (!r1.ok) throw new Error('r1 failed');
    const sp1 = applySpeech(r1.value[0], 'alice', 's', NOW);
    if (!sp1.ok) throw new Error('sp1 failed');

    // alice uses fallback
    state = bid(withTranscriptRead(sp1.value, 'alice', 'bob'), 80, 20);
    const r2 = resolveWinner(state, NOW);
    if (!r2.ok) throw new Error('r2 failed');
    const sp2 = applySpeech(r2.value[0], 'alice', 's2', NOW);
    if (!sp2.ok) throw new Error('sp2 failed');

    // vote_required
    state = bid(withTranscriptRead(sp2.value, 'alice', 'bob'), 80, 20);
    const r3 = resolveWinner(state, NOW);
    if (!r3.ok) throw new Error('r3 failed');
    return r3.value[0]; // status=voting
  }

  it('should transition to voting when both pools empty', () => {
    const state = reachVoteRequired();
    expect(state.status).toBe('voting');
  });

  it('should return unanimous=true and keep status=voting on unanimous vote', () => {
    const state = reachVoteRequired();
    const s1 = applyBid(state, 'alice', 0, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 0, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState, result] = res.value;
    expect('end_vote' in result && result.end_vote).toBe(true);
    expect('unanimous' in result && result.unanimous).toBe(true);
    expect(newState.status).toBe('voting'); // stays voting
  });

  it('should reset quota on non-unanimous vote', () => {
    const state = reachVoteRequired();
    const s1 = applyBid(state, 'alice', 1, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 0, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState, result] = res.value;
    expect('end_vote' in result && result.end_vote).toBe(true);
    expect('unanimous' in result && result.unanimous).toBe(false);
    expect(newState.status).toBe('bidding');
    expect(newState.epoch).toBe(2);
    expect(newState.cold_start).toBe(true);
    expect(newState.agents['alice'].quota_remaining).toBe(1);
    expect(newState.agents['alice'].fallback_used).toBe(false);
  });

  it('should reject voting score > 1', () => {
    const state = reachVoteRequired();
    const res = applyBid(state, 'alice', 50, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('voting_score_invalid');
  });

  it('should append vote transcript entry', () => {
    const state = reachVoteRequired();
    const s1 = applyBid(state, 'alice', 0, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 0, NOW);
    const res = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState] = res.value;
    const voteEntry = newState.transcript.find((e) => e.type === 'vote');
    expect(voteEntry).toBeDefined();
    if (voteEntry?.type !== 'vote') return;
    expect(voteEntry.unanimous).toBe(true);
  });
});

// ─── applyEpochSummary ───────────────────────────────────────────────────────

describe('applyEpochSummary', () => {
  it('should reject summary in setup status', () => {
    const init = initSession(BASE_INPUT, NOW);
    const res = applyEpochSummary(init, 1, 'Too early', NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('session_not_started');
  });

  it('should accept valid epoch summary', () => {
    const state = makeSession();
    const res = applyEpochSummary(state, 1, 'Key points...', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.epoch_summary_written).toBe(1);
    const entry = res.value.transcript.find((e) => e.type === 'epoch_summary');
    expect(entry).toBeDefined();
  });

  it('should reject wrong epoch', () => {
    const state = makeSession();
    const res = applyEpochSummary(state, 2, 'wrong', NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('epoch_mismatch');
    expect(res.detail?.expected).toBe(1);
  });

  it('should reject duplicate epoch summary', () => {
    const state = makeSession();
    const r1 = applyEpochSummary(state, 1, 'First', NOW);
    expect(r1.ok).toBe(true);
    const r2 = applyEpochSummary(r1.ok ? r1.value : state, 1, 'Duplicate', NOW);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('epoch_summary_duplicate');
  });
});

// ─── applyEnd ────────────────────────────────────────────────────────────────

describe('applyEnd', () => {
  it('should end session in bidding status', () => {
    const state = makeSession();
    const res = applyEnd(state, {}, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('ended');
  });

  it('should reject ending during speech without force', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 20, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    const speakingState = r.ok ? r.value[0] : state;
    const res = applyEnd(speakingState, {}, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('requires_force');
  });

  it('should end during speech with force=true+reason', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 20, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    const speakingState = r.ok ? r.value[0] : state;
    const res = applyEnd(speakingState, { force: true, reason: 'timeout' }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('ended');
  });

  it('should reject already-ended session', () => {
    const state = makeSession();
    const r1 = applyEnd(state, {}, NOW);
    const r2 = applyEnd(r1.ok ? r1.value : state, {}, NOW);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('already_ended');
  });

  it('should append synthesis as session_event', () => {
    const state = makeSession();
    const res = applyEnd(state, { synthesis: 'Summary text.' }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const synthEntry = res.value.transcript.find((e) => e.type === 'session_event' && e.event === 'synthesis');
    expect(synthEntry).toBeDefined();
    if (synthEntry?.type !== 'session_event') return;
    expect(synthEntry.detail).toBe('Summary text.');
  });
});

// ─── applyBid — transcript read enforcement ───────────────────────────────────

describe('applyBid — transcript read enforcement', () => {
  function makeAfterSpeech(): DiscussState {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 50, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    if (!r.ok) throw new Error('unreachable');
    const sp = applySpeech(r.value[0], 'alice', 'speech', NOW);
    if (!sp.ok) throw new Error('unreachable');
    return sp.value; // step=2, last_speech_step=1
  }

  it('should reject bid when transcript not read after speech', () => {
    const state = makeAfterSpeech();
    const res = applyBid(state, 'alice', 80, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('read_transcript_first');
  });

  it('should allow bid on first round (no speeches yet)', () => {
    const state = makeSession(); // last_speech_step=0 → exempt
    const res = applyBid(state, 'alice', 80, NOW);
    expect(res.ok).toBe(true);
  });

  it('should allow bid after reading transcript (transcript_read_step >= step)', () => {
    const afterSpeech = makeAfterSpeech(); // step=2
    const state = withTranscriptRead(afterSpeech, 'alice');
    const res = applyBid(state, 'alice', 80, NOW);
    expect(res.ok).toBe(true);
  });

  it('should allow voting without transcript read (status=voting)', () => {
    const afterSpeech = makeAfterSpeech();
    const votingState = { ...afterSpeech, status: 'voting' as const };
    const res = applyBid(votingState, 'alice', 0, NOW);
    expect(res.ok).toBe(true);
  });

  it('should enforce transcript read at epoch 2 boundary (step incremented by resolveVote)', () => {
    // Simulate state after non-unanimous vote: resolveVote increments step to 4,
    // but alice's readStep is still 3 from the previous epoch.
    const epoch2State: DiscussState = {
      ...makeSession(),
      step: 4, epoch: 2,
      last_speech_step: 3, // enforcement active (> 0)
      transcript_read_step: { alice: 3, bob: 3 }, // stale readStep from epoch 1
    };
    // Bid rejected — readStep(3) < step(4)
    const rejected = applyBid(epoch2State, 'alice', 80, NOW);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toBe('read_transcript_first');
    // After reading, bid succeeds
    const readState = withTranscriptRead(epoch2State, 'alice');
    expect(applyBid(readState, 'alice', 80, NOW).ok).toBe(true);
  });
});

// ─── normalizeState migration ─────────────────────────────────────────────────

describe('normalizeState — migration', () => {
  it('should add transcript_read_step: {} to legacy state', () => {
    const legacy = {
      session_id: 'test', session_dir: 'test', topic: 'T',
      status: 'bidding', step: 1, epoch: 1, quota_per_epoch: 3, cold_start: false, recent_turns: 5,
      agents: { alice: { persona: '', display_name: 'Alice', quota_remaining: 3, total_speaks: 0, fallback_used: false } },
      current_bids: {}, pending_bidders: [], current_speaker: null, speaker_type: null,
      epoch_summary_written: null, team_name: 't', created_at: '', updated_at: '',
      last_speech_step: 0, transcript: [], transcript_rendered: 0, bid_threshold: 50,
      // transcript_read_step intentionally absent (legacy state)
    };
    const normalized = normalizeState(legacy as Record<string, unknown>);
    expect(normalized.transcript_read_step).toEqual({});
  });
});

// ─── pending_bidders invariant ────────────────────────────────────────────────

describe('pending_bidders invariant', () => {
  it('should match all agent keys after create', () => {
    const state = makeSession();
    expect(state.pending_bidders.sort()).toEqual(['alice', 'bob']);
  });

  it('should be all agents after applySpeech', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 50, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sp = applySpeech(r.value[0], 'alice', 'speech', NOW);
    expect(sp.ok).toBe(true);
    if (!sp.ok) return;
    expect(sp.value.pending_bidders.sort()).toEqual(['alice', 'bob']); // all reset
  });
});
