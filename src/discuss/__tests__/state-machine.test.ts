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
  applyEnd,
  applyEpochSummary,
  parseDisplayName,
  topicSlug,
  formatDateId,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
} from '../state-machine.js';
import type { DiscussState } from '../types.js';

const NOW = '2026-02-21T10:00:00.000Z';

const TWO_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.' },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.' },
];

const BASE_INPUT = { topic: 'Test Topic', agents: TWO_AGENTS, quota_per_epoch: 3, recent_turns: 5 };

function makeSession(): DiscussState {
  const init = initSession(BASE_INPUT, NOW);
  init.session_id = '260221-1000-test';
  init.session_dir = '260221-1000-test-test-topic';
  init.team_name = 'coral-dc-260221-1000-test';
  const res = startBidding(init, NOW);
  if (!res.ok) throw new Error('unreachable: startBidding failed in test helper');
  return res.value;
}

/** Stamp transcript_read_step[agent] = state.step - simulates calling discuss_transcript. */
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

// ─── topicSlug ───────────────────────────────────────────────────────────────

describe('topicSlug', () => {
  it('should strip filesystem-unsafe characters', () => {
    expect(topicSlug('A/B testing?')).toBe('ab-testing');
  });

  it('should preserve Korean characters', () => {
    expect(topicSlug('한글 토픽')).toBe('한글-토픽');
  });

  it('should preserve CJK characters', () => {
    expect(topicSlug('日本語テスト')).toBe('日本語テスト');
  });

  it('should handle mixed scripts', () => {
    expect(topicSlug('Hello 世界!')).toBe('hello-世界');
  });

  it('should return untitled for empty result', () => {
    expect(topicSlug('!!!???')).toBe('untitled');
    expect(topicSlug('///\\\\:::')).toBe('untitled');
  });

  it('should collapse multiple hyphens', () => {
    expect(topicSlug('hello   world')).toBe('hello-world');
  });

  it('should strip leading/trailing hyphens', () => {
    expect(topicSlug(' hello ')).toBe('hello');
  });

  it('should truncate at word boundary around 40 chars', () => {
    const long = 'this is a very long topic that exceeds forty characters significantly';
    const slug = topicSlug(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
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

  it('should use DEFAULT_MAX_EPOCHS (2) when not specified', () => {
    const state = initSession(BASE_INPUT, NOW);
    expect(state.max_epochs).toBe(DEFAULT_MAX_EPOCHS);
    expect(state.max_epochs).toBe(2);
  });

  it('should accept custom maxEpochs parameter', () => {
    const state = initSession(BASE_INPUT, NOW, DEFAULT_BID_THRESHOLD, 3);
    expect(state.max_epochs).toBe(3);
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

// ─── resolveWinner - primary pool ────────────────────────────────────────────

describe('resolveWinner - primary pool', () => {
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

    // Step 2: same scores again - bob should win (fewer speaks)
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

// ─── resolveWinner - cold start ──────────────────────────────────────────────

describe('resolveWinner - cold start (auto-pick)', () => {
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

// ─── resolveWinner - fallback pool ───────────────────────────────────────────

describe('resolveWinner - fallback pool', () => {
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

  it('should return all_blocked when second fallback is impossible (not allExhausted)', () => {
    // alice: quota=0, fallback_used=true (exhausted), bob: quota=1, bid below threshold
    // allBelowThreshold=false (alice bids >= threshold), allExhausted=false (bob still has quota)
    // → no_winner, reason='all_blocked'
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

    // alice: quota=0, fallback_used=true; bob: quota=1, bid=20 (below threshold)
    const afterSp2b = withTranscriptRead(sp2.value, 'alice', 'bob');
    const s5 = applyBid(afterSp2b, 'alice', 50, NOW);
    const s6 = applyBid(s5.ok ? s5.value : afterSp2b, 'bob', 20, NOW);
    const r3 = resolveWinner(s6.ok ? s6.value : afterSp2b, NOW);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const [, result] = r3.value;
    expect('no_winner' in result && result.no_winner).toBe(true);
    if (!('no_winner' in result)) return;
    expect(result.reason).toBe('all_blocked');
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

// ─── resolveWinner - auto epoch transition ────────────────────────────────────

describe('resolveWinner - auto epoch transition', () => {
  /** Fabricate state where both agents are fully exhausted but still desire to speak. */
  function makeExhaustedState(epochNum: number, maxEpochs: number): DiscussState {
    const state = makeSession();
    return {
      ...state,
      epoch: epochNum,
      max_epochs: maxEpochs,
      agents: {
        alice: { ...state.agents['alice'], quota_remaining: 0, fallback_used: true },
        bob: { ...state.agents['bob'], quota_remaining: 0, fallback_used: true },
      },
      current_bids: { alice: 80, bob: 60 }, // both above threshold
      pending_bidders: [],
      last_speech_step: 1, // enforce read after first speech
      transcript_read_step: { alice: state.step, bob: state.step },
    };
  }

  it('should auto-transition to next epoch when allExhausted and epoch < max_epochs', () => {
    const state = makeExhaustedState(1, 2);
    const res = resolveWinner(state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [newState, result] = res.value;
    expect('no_winner' in result && result.no_winner).toBe(true);
    if (!('no_winner' in result)) return;
    expect(result.reason).toBe('epoch_transition');
    expect('new_epoch' in result && result.new_epoch).toBe(true);
    expect(result.epoch).toBe(2);
    expect(newState.epoch).toBe(2);
    expect(newState.status).toBe('bidding');
    expect(newState.cold_start).toBe(true);
    expect(newState.agents['alice'].quota_remaining).toBe(3); // quota_per_epoch reset
    expect(newState.agents['alice'].fallback_used).toBe(false);
    expect(newState.epoch_summary_written).toBeNull(); // reset for new epoch
  });

  it('should stamp transcript_read_step on epoch transition (no forced re-read)', () => {
    const state = makeExhaustedState(1, 2);
    const res = resolveWinner(state, NOW);
    if (!res.ok) return;
    const [newState] = res.value;
    // readStep stamped to new step - agents can bid without re-reading
    expect(newState.transcript_read_step['alice']).toBe(newState.step);
    expect(newState.transcript_read_step['bob']).toBe(newState.step);
    const bidRes = applyBid(newState, 'alice', 80, NOW);
    expect(bidRes.ok).toBe(true);
  });

  it('should return max_epochs_reached when epoch >= max_epochs', () => {
    const state = makeExhaustedState(2, 2); // already at max
    const res = resolveWinner(state, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, result] = res.value;
    expect('no_winner' in result && result.no_winner).toBe(true);
    if (!('no_winner' in result)) return;
    expect(result.reason).toBe('max_epochs_reached');
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

// ─── applyBid - transcript read enforcement ───────────────────────────────────

describe('applyBid - transcript read enforcement', () => {
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

  it('should NOT require re-read after auto epoch transition (readStep stamped to new step)', () => {
    // After epoch transition: step incremented AND readStep stamped to new step.
    // Agents arrive in epoch 2 with readStep >= step pre-satisfied - no forced re-read.
    const transitionedState: DiscussState = {
      ...makeSession(),
      step: 4, epoch: 2, max_epochs: 2,
      last_speech_step: 3, // enforcement active
      transcript_read_step: { alice: 4, bob: 4 }, // stamped by epoch transition
    };
    expect(applyBid(transitionedState, 'alice', 80, NOW).ok).toBe(true);
  });

  it('should reject bid when readStep is stale (general rule)', () => {
    // Stale readStep (not yet stamped or manually reset) still rejects
    const staleState: DiscussState = {
      ...makeSession(),
      step: 4, epoch: 2, max_epochs: 2,
      last_speech_step: 3,
      transcript_read_step: { alice: 3, bob: 3 }, // stale
    };
    const res = applyBid(staleState, 'alice', 80, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('read_transcript_first');
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

// ─── formatDateId ─────────────────────────────────────────────────────────────

describe('formatDateId', () => {
  it('should produce yymmdd-HHmm format', () => {
    const d = new Date('2026-02-21T15:20:00Z');
    expect(formatDateId(d)).toMatch(/^\d{6}-\d{4}$/);
  });

  it('should use 2-digit year', () => {
    const d = new Date('2026-02-21T15:20:00Z');
    const result = formatDateId(d);
    expect(result.startsWith('26')).toBe(true);
  });

  it('should zero-pad month, day, hours, minutes', () => {
    const d = new Date('2026-01-05T08:03:00Z');
    // Should be '260105-0803' (in local time - just verify format, not exact value)
    expect(formatDateId(d)).toMatch(/^\d{6}-\d{4}$/);
  });
});

// ─── last_activity_at propagation ────────────────────────────────────────────

describe('last_activity_at', () => {
  const LATER = '2026-02-21T11:00:00.000Z';

  it('should be set on initSession', () => {
    const state = initSession(BASE_INPUT, NOW);
    expect(state.last_activity_at).toBe(NOW);
  });

  it('should be updated by startBidding', () => {
    const init = initSession(BASE_INPUT, NOW);
    const res = startBidding(init, LATER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.last_activity_at).toBe(LATER);
  });

  it('should be updated by applySpeech (via appendEntry)', () => {
    const state = makeSession();
    const s1 = applyBid(state, 'alice', 80, NOW);
    const s2 = applyBid(s1.ok ? s1.value : state, 'bob', 50, NOW);
    const r = resolveWinner(s2.ok ? s2.value : state, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sp = applySpeech(r.value[0], 'alice', 'Hello', LATER);
    expect(sp.ok).toBe(true);
    if (!sp.ok) return;
    expect(sp.value.last_activity_at).toBe(LATER);
  });

  it('should be updated by applyBid', () => {
    const state = makeSession();
    const res = applyBid(state, 'alice', 80, LATER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.last_activity_at).toBe(LATER);
  });

  it('should be updated by applyEnd', () => {
    const state = makeSession();
    const res = applyEnd(state, {}, LATER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.last_activity_at).toBe(LATER);
  });
});
