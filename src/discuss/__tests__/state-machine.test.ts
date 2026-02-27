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
  applySynthesis,
  endContent,
  computeEffectiveBids,
  findLastSpeaker,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
} from '../state-machine.js';
import { parseDisplayName, topicSlug, formatDateId } from '../util/string.js';
import type { AgentState, DiscussState, TranscriptEntry } from '../types.js';
import { noEligibleParticipants } from '../wait.js';

const NOW = '2026-02-21T10:00:00.000Z';
type SynthesisTranscriptEvent = Extract<TranscriptEntry, { type: 'session_event' }> & { event: 'synthesis' };

const TWO_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.', participation: 'required' as const },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.', participation: 'required' as const },
];

const BASE_INPUT = { topic: 'Test Topic', agents: TWO_AGENTS, min_bid_delay_ms: 0 };

const COLD_START_AGENTS = [
  { name: 'alice', persona: '# Alice Architect — Senior Architect\nExperienced architect.', participation: 'required' as const },
  { name: 'bob', persona: '# Bob Critic — Critical Thinker\nCritical mind.', participation: 'required' as const },
  { name: 'carol', persona: '# Carol Observer — Observer\nNotes and prompts.', participation: 'required' as const },
  { name: 'dave', persona: '# Dave Analyst — Analyst\nData minded.', participation: 'required' as const },
  { name: 'eve', persona: '# Eve Moderator — Moderator\nSession helper.', participation: 'required' as const },
  { name: 'frank', persona: '# Frank Synthesizer — Synthesizer\nFinal summarizer.', participation: 'required' as const },
];
const COLD_START_INPUT = { topic: 'Cold Start Topic', agents: COLD_START_AGENTS, min_bid_delay_ms: 0 };

function makeSession(input = BASE_INPUT): DiscussState {
  const init = initSession(input, NOW);
  init.session_id = '260221-1000-test';
  return init;
}

function startSession(input = BASE_INPUT): DiscussState {
  const state = makeSession(input);
  const res = startBidding(state, NOW);
  if (!res.ok) throw new Error('unreachable: failed to start bidding');
  return res.value;
}

function unwrapOk<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`unreachable: ${result.error}`);
  }
  return result.value;
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    persona: '',
    display_name: 'Test',
    participation: 'required',
    quota_remaining: 3,
    total_speaks: 0,
    fallback_used: false,
    banned: false,
    ...overrides,
  };
}

function assertBidsEntry(
  entry: TranscriptEntry | undefined,
): asserts entry is Extract<TranscriptEntry, { type: 'bids' }> {
  expect(entry?.type).toBe('bids');
}


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


describe('applyBid', () => {
  it('should record bid in bidding status', () => {
    const state = startSession();
    const res = unwrapOk(applyBid(state, 'alice', 75, 'alice thinking', NOW));
    expect(res.pending_bidders).not.toContain('alice');
    expect(res.current_bids['alice']).toBe(75);
    expect(res.pending_bidders).toContain('bob');
  });

  it('should allow bid in setup (no transcript read gate)', () => {
    const state = makeSession();
    const res = applyBid(state, 'alice', 75, 'alice thinking', NOW);
    expect(res.ok).toBe(true);
  });

  it('should return error for unknown agent', () => {
    const state = startSession();
    const res = applyBid(state, 'nobody', 50, 'nobody thinking', NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('agent_not_found');
  });

  it('should reject double bid from same agent', () => {
    const state = startSession();
    const first = unwrapOk(applyBid(state, 'alice', 75, 'alice thinking', NOW));
    const second = applyBid(first, 'alice', 80, 'alice thinking again', NOW);
    expect(second?.ok).toBe(false);
    if (!second || second.ok) return;
    expect(second.error).toBe('already_bid');
  });

  it('should store thought in current_thoughts', () => {
    const state = startSession();
    const res = unwrapOk(applyBid(state, 'alice', 75, 'alice wants to discuss scalability', NOW));
    expect(res.current_thoughts['alice']).toBe('alice wants to discuss scalability');
  });

  it('should include thoughts in transcript bids entry after resolveWinner', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thought here', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 50, 'bob thought here', NOW));
    const [resolved] = unwrapOk(resolveWinner(s2, NOW));
    const bidsEntry = resolved.transcript.find((e) => e.type === 'bids');
    expect(bidsEntry?.type === 'bids' && bidsEntry.thoughts?.['alice']).toBe('alice thought here');
    expect(bidsEntry?.type === 'bids' && bidsEntry.thoughts?.['bob']).toBe('bob thought here');
  });

  it('should clear current_thoughts after resetBids (via applySpeech)', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thought', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 50, 'bob thought', NOW));
    const [speaking] = unwrapOk(resolveWinner(s2, NOW));
    const afterSpeech = unwrapOk(applySpeech(speaking, 'alice', 'my speech', NOW));
    expect(afterSpeech.current_thoughts).toEqual({});
  });
});

describe('resolveWinner', () => {
  it('should prefer highest scorer in primary pool', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 50, 'bob thinking', NOW));
    const [next, decision] = unwrapOk(resolveWinner(s2, NOW));
    expect(('speaker_type' in decision && decision.speaker_type)).toBe('quota');
    if ('winner' in decision) {
      expect(decision.winner).toBe('alice');
    }
    expect(next.current_speaker).toBe('alice');
    expect(next.status).toBe('speaking');
  });

  it('should auto-pick cold-start winner when all bids below threshold', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 10, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));
    expect(('speaker_type' in decision && decision.speaker_type)).toBe('cold_start');
    expect('speaker_type' in decision ? decision.winner : null).toBe('bob');
  });

  it('should decrement quota for cold-start speech', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 10, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const [resolved] = unwrapOk(resolveWinner(s2, NOW));
    expect(resolved.speaker_type).toBe('cold_start');
    const quotaBefore = resolved.agents.bob.quota_remaining;
    const afterSpeech = unwrapOk(applySpeech(resolved, 'bob', 'my speech', NOW));
    expect(afterSpeech.agents.bob.quota_remaining).toBe(quotaBefore - 1);
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

    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 90, 'bob thinking', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));
    if ('speaker_type' in decision) {
      expect(decision.winner).toBe('alice');
    }
  });

  it('should treat non-exhausted allBlocked when no quota speaker is available', () => {
    const state = startSession();
    state.agents.alice.quota_remaining = 0;
    state.agents.alice.fallback_used = true;
    state.agents.bob.total_speaks = 4;

    const s1 = unwrapOk(applyBid(state, 'alice', 70, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));
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

    const [nextState, decision] = unwrapOk(resolveWinner(state2, NOW));
    expect('no_winner' in decision && decision.no_winner).toBe(true);
    if (!('no_winner' in decision)) return;
    expect(decision.reason).toBe('epoch_transition');
    expect(nextState.epoch).toBe(2);
    expect(nextState.agents.alice.quota_remaining).toBe(3);
    expect(nextState.agents.bob.banned).toBe(true);
  });
});


describe('speech lifecycle', () => {
  function winningState(): DiscussState {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 40, 'bob thinking', NOW));
    return unwrapOk(resolveWinner(s2, NOW))[0];
  }

  it('should increment step and open release marker on applySpeech', () => {
    const state = winningState();
    const value = unwrapOk(applySpeech(state, 'alice', 'My speech.', NOW));
    expect(value.status).toBe('bidding');
    expect(value.step).toBe(2);
    expect(value.bid_release_step).toBe(1);
    expect(value.last_speech_step).toBe(1);
  });

  it('should decrement quota for normal speaker and increment total_speaks', () => {
    const state = winningState();
    const value = unwrapOk(applySpeech(state, 'alice', 'My speech.', NOW));
    expect(value.agents['alice'].quota_remaining).toBe(2);
    expect(value.agents['alice'].total_speaks).toBe(1);
  });

  it('should apply speech timeout with force semantics', () => {
    const state = winningState();
    const timeout = unwrapOk(applySpeechTimeout(state, NOW));
    expect(timeout.status).toBe('bidding');
    expect(timeout.agents.alice.total_speaks).toBe(1);
    expect(timeout.transcript.at(-1)?.type).toBe('speech');
    expect(timeout.bid_release_step).toBe(state.step);
  });

  it('should decrement quota for normal speaker on timeout', () => {
    const state = winningState();
    const quotaBefore = state.agents.alice.quota_remaining;
    const timeout = unwrapOk(applySpeechTimeout(state, NOW));
    expect(timeout.agents.alice.quota_remaining).toBe(quotaBefore - 1);
  });

  it('should decrement quota for cold-start speaker on timeout', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 10, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const [resolved] = unwrapOk(resolveWinner(s2, NOW));
    expect(resolved.speaker_type).toBe('cold_start');
    const quotaBefore = resolved.agents.bob.quota_remaining;
    const timeout = unwrapOk(applySpeechTimeout(resolved, NOW));
    expect(timeout.agents.bob.quota_remaining).toBe(quotaBefore - 1);
  });

  it('should not decrement fallback speaker quota on speech', () => {
    const state = startSession();
    const withFallback = {
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, quota_remaining: 0, fallback_used: false },
      },
    };
    const s1 = unwrapOk(applyBid(withFallback, 'alice', 80, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const [resolved] = unwrapOk(resolveWinner(s2, NOW));
    expect(resolved.speaker_type).toBe('fallback');
    const afterSpeech = unwrapOk(applySpeech(resolved, 'alice', 'fallback speech', NOW));
    expect(afterSpeech.agents.alice.quota_remaining).toBe(0);
    expect(afterSpeech.agents.alice.total_speaks).toBe(1);
  });

  it('should not decrement fallback speaker quota on timeout', () => {
    const state = startSession();
    const withFallback = {
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, quota_remaining: 0, fallback_used: false },
      },
    };

    const s1 = unwrapOk(applyBid(withFallback, 'alice', 80, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const nextState = unwrapOk(resolveWinner(s2, NOW))[0];
    const timed = unwrapOk(applySpeechTimeout(nextState, NOW));
    expect(timed.agents['alice'].quota_remaining).toBe(0);
    expect(timed.agents['alice'].total_speaks).toBe(1);
  });
});


describe('applyExpel', () => {
  it('should not ban in epoch1 step1 respawn case', () => {
    const state = startSession();
    const expelled = unwrapOk(applyExpel(state, ['alice'], NOW));
    expect(expelled.state.agents.alice.banned).toBe(false);
    expect(expelled.hint).toContain('Shutdown and respawn');
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
    const expelled = unwrapOk(applyExpel(state, ['alice'], NOW));
    expect(expelled.state.agents.alice.banned).toBe(true);
    expect(expelled.state.agents.alice.quota_remaining).toBe(0);
    expect(expelled.hint).toContain('Banned');
  });
});


describe('applyEpochSummary', () => {
  it('should set bid_release_step when recording summary after epoch transition', () => {
    const state = startSession();
    const withSpeech = applySpeechTimeout(state, NOW);
    const base = withSpeech.ok ? withSpeech.value : state;
    // Simulate epoch transition (epoch_summary_written: null means summary is due)
    const transitioned: DiscussState = { ...base, epoch_summary_written: null };
    const summarized = unwrapOk(applyEpochSummary(transitioned, 'Phase one highlights.', NOW));
    expect(summarized.epoch_summary_written).toBe(1);
    expect(summarized.bid_release_step).toBe(transitioned.step);
  });

  it('should reject when no epoch transition has occurred', () => {
    const state = startSession();
    const r = applyEpochSummary(state, 'Too early', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('epoch_summary_not_due');
    expect(r.detail).toHaveProperty('hint');
  });

  it('should reject duplicate summary after epoch transition', () => {
    const state = startSession();
    // Simulate epoch transition by setting epoch_summary_written to null
    const transitioned: DiscussState = { ...state, epoch: 2, epoch_summary_written: null };
    const r1 = applyEpochSummary(transitioned, 'First', NOW);
    expect(r1.ok).toBe(true);
    const r2 = r1.ok ? applyEpochSummary(r1.value, 'Duplicate', NOW) : null;
    expect(r2?.ok).toBe(false);
    if (!r2 || r2.ok) return;
    expect(r2.error).toBe('epoch_summary_not_due');
  });

  it('should succeed after epoch transition', () => {
    const state = startSession();
    // epoch_summary_written: null signals an epoch transition requiring summary
    const transitioned: DiscussState = { ...state, epoch: 2, epoch_summary_written: null };
    const r = applyEpochSummary(transitioned, 'Epoch 1 recap.', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.epoch_summary_written).toBe(2);
  });
});

describe('applyEnd', () => {
  it('should end session and open release marker', () => {
    const state = startSession();
    const value = unwrapOk(applyEnd(state, {}, NOW));
    expect(value.status).toBe('ended');
    expect(value.bid_release_step).toBe(state.step);
  });

  it('should require force flag in normal speaking end', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 20, 'bob thinking', NOW));
    const speaking = unwrapOk(resolveWinner(s2, NOW))[0];
    const res = applyEnd(speaking, {}, NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('requires_force');
  });

  it('should be idempotent for already ended sessions', () => {
    const state = startSession();
    const ended = unwrapOk(applyEnd(state, {}, NOW));
    const second = unwrapOk(applyEnd(ended, {}, NOW));
    expect(second).toEqual(ended);
    expect(synthesisEntries(second)).toHaveLength(0);
  });

  it('should end active sessions without writing synthesis', () => {
    const state = startSession();
    const ended = unwrapOk(applyEnd(state, {}, NOW));
    expect(synthesisEntries(ended)).toHaveLength(0);
  });
});

describe('applySynthesis', () => {
  it('should reject synthesis when session is not ended', () => {
    const state = startSession();
    const result = applySynthesis(state, 'Final synthesis.', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not_ended');
  });

  it('should append synthesis on ended session', () => {
    const state = startSession();
    const ended = unwrapOk(applyEnd(state, {}, NOW));
    const withSynthesis = unwrapOk(applySynthesis(ended, 'Final synthesis.', NOW));
    const entries = synthesisEntries(withSynthesis);
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe('Final synthesis.');
  });

  it('should be idempotent on duplicate synthesis calls', () => {
    const state = startSession();
    const ended = unwrapOk(applyEnd(state, {}, NOW));
    const first = unwrapOk(applySynthesis(ended, 'First synthesis.', NOW));
    const second = unwrapOk(applySynthesis(first, 'Second synthesis should be ignored.', NOW));
    expect(second).toEqual(first);
  });
});

describe('termination/synthesis separation regression', () => {
  it('should enforce two-step flow with exactly one synthesis entry', () => {
    const state = startSession();
    const ended = unwrapOk(applyEnd(state, {}, NOW));
    const withSynthesis = unwrapOk(applySynthesis(ended, 'Final synthesis.', NOW));
    expect(synthesisEntries(withSynthesis)).toHaveLength(1);
  });

  it('should keep synthesis first-write-wins across multiple callers', () => {
    const state = startSession();
    const ended = unwrapOk(applyEnd(state, {}, NOW));
    const first = unwrapOk(applySynthesis(ended, 'Discuss-lead synthesis.', NOW));
    const second = unwrapOk(applySynthesis(first, 'Main-context synthesis.', NOW));
    const entries = synthesisEntries(second);
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe('Discuss-lead synthesis.');
  });
});


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


function placeBids(state: DiscussState, bids: Record<string, number>, thoughts?: Record<string, string>): DiscussState {
  let next = state;
  for (const [name, score] of Object.entries(bids)) {
    const thought = thoughts?.[name] ?? `${name} thinking`;
    const updated = applyBid(next, name, score, thought, NOW);
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

function makeAgentMap(rows: Array<{ name: string; total_speaks: number; banned?: boolean; participation?: 'required' | 'observer' }>): Record<string, AgentState> {
  return Object.fromEntries(
    rows.map(({ name, total_speaks, banned, participation }) => [
      name,
      {
        persona: '',
        display_name: name[0]!.toUpperCase() + name.slice(1),
        participation: participation ?? 'required',
        quota_remaining: 3,
        total_speaks,
        fallback_used: false,
        banned: !!banned,
      },
    ]),
  );
}


function makeAgents(speaks: Record<string, number>): Record<string, import('../types.js').AgentState> {
  return makeAgentMap(
    Object.entries(speaks).map(([name, total_speaks]) => ({ name, total_speaks })),
  );
}

describe('computeEffectiveBids', () => {
  it('should return raw bids unchanged when all speaks are equal', () => {
    const agents = makeAgents({ a: 0, b: 0, c: 0, d: 0 });
    const bids = { a: 80, b: 60, c: 70, d: 50 };
    const result = computeEffectiveBids(bids, agents, null);
    expect(result).toEqual(bids);
  });

  it('should penalize agent with more speaks than average', () => {
    const agents = makeAgents({ a: 2, b: 0, c: 1, d: 1 });
    const bids = { a: 80, b: 60, c: 60, d: 60 };
    const result = computeEffectiveBids(bids, agents, null);
    expect(result['a']).toBeCloseTo(80 - 25); // 55
  });

  it('should boost agent with fewer speaks than average', () => {
    const agents = makeAgents({ a: 0, b: 2, c: 1, d: 1 });
    const bids = { a: 60, b: 80, c: 80, d: 80 };
    const result = computeEffectiveBids(bids, agents, null);
    expect(result['a']).toBeCloseTo(60 + 25); // 85
  });

  it('should apply recency penalty to last speaker', () => {
    const agents = makeAgents({ a: 1, b: 1, c: 1, d: 1 });
    const bids = { a: 80, b: 80, c: 80, d: 80 };
    const result = computeEffectiveBids(bids, agents, 'a');
    expect(result['a']).toBeCloseTo(80 - 12.5);
    expect(result['b']).toBeCloseTo(80);
  });

  it('should combine imbalance penalty and recency penalty', () => {
    const agents = makeAgents({ a: 2, b: 0, c: 1, d: 1 });
    const bids = { a: 80, b: 60, c: 60, d: 60 };
    const result = computeEffectiveBids(bids, agents, 'a');
    expect(result['a']).toBeCloseTo(80 - 25 - 12.5); // 42.5
  });

  it('should scale P_BASE and P_RECENCY with N=2', () => {
    const agents = makeAgents({ a: 2, b: 0 });
    const bids = { a: 80, b: 60 };
    const result = computeEffectiveBids(bids, agents, null);
    expect(result['a']).toBeCloseTo(30);
    expect(result['b']).toBeCloseTo(110);
  });

  it('should scale P_BASE and P_RECENCY with N=8', () => {
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
    expect(result['a']).toBeCloseTo(70);
    expect(result['b']).toBeCloseTo(70);
  });
});


describe('resolveWinner with decay', () => {
  it('should flip winner when decay gives lower-bidder a higher effective score', () => {
    const state = startSession();
    state.agents.alice.total_speaks = 0;
    state.agents.bob.total_speaks = 2;
    const s1 = unwrapOk(applyBid(state, 'alice', 32, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 35, 'bob thinking', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));
    expect('winner' in decision && decision.winner).toBe('alice');
  });

  it('should use raw score for threshold filter, not effective score', () => {
    const state = startSession();
    state.agents.alice.total_speaks = 2;
    state.agents.bob.total_speaks = 0;
    state.cold_start = false;
    const s1 = unwrapOk(applyBid(state, 'alice', 40, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 5, 'bob thinking', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));
    expect('winner' in decision && decision.winner).toBe('alice');
  });

  it('should include effective_bids in cold-start transcript entry for audit', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 5, 'alice thinking', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 10, 'bob thinking', NOW));
    const [nextState, decision] = unwrapOk(resolveWinner(s2, NOW));
    expect('speaker_type' in decision && decision.speaker_type).toBe('cold_start');
    const bidsEntry = nextState.transcript.at(-1);
    assertBidsEntry(bidsEntry);
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

    const [nextState, decision] = unwrapOk(resolveWinner(state2, NOW));
    expect('no_winner' in decision && decision.reason).toBe('epoch_transition');
    const bidsEntry = nextState.transcript.find((e) => e.type === 'bids');
    assertBidsEntry(bidsEntry);
    expect(bidsEntry.effective_bids).toBeDefined();
  });
});


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
    const [, decision] = unwrapOk(resolveWinner(stateWithBids, NOW));
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
    const [nextState, decision] = unwrapOk(resolveWinner(stateWithBids, NOW));
    expect(nextState.status).toBe('speaking');
    expect('speaker_type' in decision ? decision.speaker_type : null).toBe('quota');
    expect('winner' in decision ? decision.winner : null).toBe('bob');
  });

  it('should include effective_bids on winning bids transcript entries', () => {
    const state = startSession();
    const stateWithBids = placeBids(state, { alice: 80, bob: 50 });
    const nextState = unwrapOk(resolveWinner(stateWithBids, NOW))[0];
    const lastEntry = nextState.transcript.at(-1);
    assertBidsEntry(lastEntry);
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
    const [nextState, decision] = unwrapOk(resolveWinner(stateWithBids, NOW));
    expect('speaker_type' in decision ? decision.speaker_type : null).toBe('cold_start');
    expect('winner' in decision ? decision.winner : null).toBe('alice');
    expect(nextState.current_speaker).toBe('alice');
    expect(decision).not.toEqual({ no_winner: true, reason: 'all_below_threshold' });
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
    const [nextState, decision] = unwrapOk(resolveWinner(state, NOW));
    expect('no_winner' in decision).toBe(true);
    if (!('no_winner' in decision)) return;
    expect(decision.reason).toBe('epoch_transition');
    const lastEntry = nextState.transcript.at(-1);
    assertBidsEntry(lastEntry);
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
    const [, decision] = unwrapOk(resolveWinner(stateWithBids, NOW));
    expect('speaker_type' in decision ? decision.speaker_type : null).toBe('quota');
    expect('winner' in decision ? decision.winner : null).toBe('bob');
  });
});

describe('sealed-bid principle', () => {
  it('should not return current thoughts in resolve result', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 80, 'alice thought', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 40, 'bob thought', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));

    expect(('current_thoughts' in decision)).toBe(false);
    expect(('thoughts' in decision)).toBe(false);
  });
});

describe('thoughts omission behavior', () => {
  it('should omit thoughts field when current_thoughts is empty', () => {
    const state = startSession();
    const noThoughtsState: DiscussState = {
      ...state,
      current_bids: { ...state.current_bids, alice: 60, bob: 40 },
      current_thoughts: {},
      pending_bidders: [],
    };
    const [resolved] = unwrapOk(resolveWinner(noThoughtsState, NOW));
    const bidsEntry = resolved.transcript.find((entry) => entry.type === 'bids');
    assertBidsEntry(bidsEntry);

    expect(Object.prototype.hasOwnProperty.call(bidsEntry, 'thoughts')).toBe(false);
    expect(bidsEntry.thoughts).toBeUndefined();
  });
});

describe('thought isolation', () => {
  it('should isolate each agent thought in current_thoughts and bids transcript', () => {
    const state = startSession();
    const s1 = unwrapOk(applyBid(state, 'alice', 85, 'alice thinks about architecture', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 75, 'bob thinks about reliability', NOW));

    expect(s2.current_thoughts).toEqual({
      alice: 'alice thinks about architecture',
      bob: 'bob thinks about reliability',
    });

    const [resolved] = unwrapOk(resolveWinner(s2, NOW));
    const bidsEntry = resolved.transcript.find((entry) => entry.type === 'bids');
    assertBidsEntry(bidsEntry);
    expect(bidsEntry.thoughts).toEqual({
      alice: 'alice thinks about architecture',
      bob: 'bob thinks about reliability',
    });
  });
});

describe('alias handling', () => {
  it('should store alias bid thought under canonical agent key', () => {
    const state = startSession();
    const withBid = unwrapOk(applyBid(state, 'alice-1', 88, 'canonicalized alias thought', NOW));

    expect(withBid.current_thoughts['alice']).toBe('canonicalized alias thought');
    expect(Object.prototype.hasOwnProperty.call(withBid.current_thoughts, 'alice-1')).toBe(false);
  });
});

describe('multi-round thought lifecycle', () => {
  it('should clear thoughts between rounds after speech, then track only new round thoughts', () => {
    const firstRound = startSession();
    const firstBidAlice = unwrapOk(applyBid(firstRound, 'alice', 85, 'round one thought', NOW));
    const firstBidBob = unwrapOk(applyBid(firstBidAlice, 'bob', 75, 'ignore me after round one', NOW));
    const [speakingState] = unwrapOk(resolveWinner(firstBidBob, NOW));
    const afterSpeech = unwrapOk(applySpeech(speakingState, 'alice', 'I am speaking', NOW));

    expect(afterSpeech.current_thoughts).toEqual({});

    const secondRound = unwrapOk(applyBid(afterSpeech, 'alice', 90, 'round two thought', NOW));
    expect(secondRound.current_thoughts).toEqual({ alice: 'round two thought' });
    expect(secondRound.current_thoughts['bob']).toBeUndefined();
  });
});

describe('partial current_thoughts at resolve', () => {
  it('should include empty-string placeholder thought alongside real thoughts in transcript', () => {
    const state = startSession();
    const seeded = {
      ...state,
      current_bids: { ...state.current_bids, alice: 92, bob: 84 },
      current_thoughts: { alice: 'real thought', bob: '' },
      pending_bidders: [],
    };
    const [resolved] = unwrapOk(resolveWinner(seeded, NOW));
    const bidsEntry = resolved.transcript.find((entry) => entry.type === 'bids');
    assertBidsEntry(bidsEntry);

    expect(bidsEntry.thoughts).toEqual({ alice: 'real thought', bob: '' });
    expect(bidsEntry.thoughts?.['bob']).toBe('');
  });
});

describe('observer participation', () => {
  const MIXED_INPUT = {
    topic: 'Mixed Topic',
    agents: [
      { name: 'alice', persona: '# Alice — Analyst\nRequired.', participation: 'required' as const },
      { name: 'bob', persona: '# Bob — Critic\nRequired.', participation: 'required' as const },
      { name: 'user', persona: '# User — Human\nObserver.', participation: 'observer' as const },
    ],
    min_bid_delay_ms: 0,
  };

  it('should exclude observers from pending_bidders in initSession', () => {
    const state = initSession(MIXED_INPUT, NOW);
    expect(state.pending_bidders).toEqual(['alice', 'bob']);
    expect(state.pending_bidders).not.toContain('user');
  });

  it('should store participation field on each agent', () => {
    const state = initSession(MIXED_INPUT, NOW);
    expect(state.agents['alice']?.participation).toBe('required');
    expect(state.agents['bob']?.participation).toBe('required');
    expect(state.agents['user']?.participation).toBe('observer');
  });

  it('should store min_bid_delay_ms from input', () => {
    const state = initSession({ ...MIXED_INPUT, min_bid_delay_ms: 5000 }, NOW);
    expect(state.min_bid_delay_ms).toBe(5000);
  });

  it('should exclude observer from pending_bidders after resetBids (via resolveWinner)', () => {
    const state = initSession(MIXED_INPUT, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    // observer bids (optional)
    const s1 = unwrapOk(applyBid(bidding, 'alice', 80, 'alice thought', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 50, 'bob thought', NOW));
    // user bids (observer — optional)
    const s3 = unwrapOk(applyBid(s2, 'user', 70, 'user thought', NOW));
    // resolve: required agents (alice, bob) have bid
    const [nextState] = unwrapOk(resolveWinner(s3, NOW));
    // after speech resets bids, observer still excluded from pending_bidders
    const afterSpeech = unwrapOk(applySpeech(nextState, nextState.current_speaker!, 'My speech', NOW));
    expect(afterSpeech.pending_bidders).not.toContain('user');
    expect(afterSpeech.pending_bidders.sort()).toEqual(['alice', 'bob'].filter(n => !afterSpeech.agents[n]?.banned).sort());
  });

  it('should allow resolveWinner when required agents bid but observer has not', () => {
    const state = initSession(MIXED_INPUT, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    const s1 = unwrapOk(applyBid(bidding, 'alice', 80, 'alice thought', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 50, 'bob thought', NOW));
    // user (observer) has NOT bid — resolve should still succeed
    const result = resolveWinner(s2, NOW);
    expect(result.ok).toBe(true);
  });

  it('should include observer bid in scoring if submitted', () => {
    const state = initSession(MIXED_INPUT, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    const s1 = unwrapOk(applyBid(bidding, 'alice', 40, 'alice thought', NOW));
    const s2 = unwrapOk(applyBid(s1, 'bob', 35, 'bob thought', NOW));
    // user bids high — should influence winner selection
    const s3 = unwrapOk(applyBid(s2, 'user', 90, 'user thought', NOW));
    const [, decision] = unwrapOk(resolveWinner(s3, NOW));
    // user bid highest, should win
    expect('winner' in decision && decision.winner).toBe('user');
  });

  it('should not pick observer in coldStartPick', () => {
    const state = initSession({
      topic: 'Cold Start Mixed',
      agents: [
        { name: 'user', persona: '# User — Human\nObserver.', participation: 'observer' as const },
        { name: 'alice', persona: '# Alice — Agent\nRequired.', participation: 'required' as const },
      ],
      min_bid_delay_ms: 0,
    }, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    // all bids below threshold triggers cold_start
    const s1 = unwrapOk(applyBid(bidding, 'alice', 5, 'low', NOW));
    const s2 = unwrapOk(applyBid(s1, 'user', 5, 'low', NOW));
    const [, decision] = unwrapOk(resolveWinner(s2, NOW));
    expect('winner' in decision).toBe(true);
    if ('winner' in decision) {
      expect(decision.winner).toBe('alice');
      expect(decision.speaker_type).toBe('cold_start');
    }
  });

  it('should not expel observer via applyExpel', () => {
    const state = initSession(MIXED_INPUT, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    // observer is in pendingAgents by mistake (defensive guard test)
    const result = applyExpel(bidding, ['user'], NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // observer should not be banned
    expect(result.value.state.agents['user']?.banned).toBe(false);
  });

  it('noEligibleParticipants should be true when only observer survives', () => {
    const state = initSession(MIXED_INPUT, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    // exhaust required agents
    const modified = {
      ...bidding,
      agents: {
        ...bidding.agents,
        alice: { ...bidding.agents['alice']!, quota_remaining: 0, fallback_used: true },
        bob: { ...bidding.agents['bob']!, quota_remaining: 0, fallback_used: true },
      },
    };
    expect(noEligibleParticipants(modified)).toBe(true);
  });

  it('allExhausted only counts required agents — observer with quota does not block epoch transition', () => {
    const state = initSession(MIXED_INPUT, NOW);
    const bidding = unwrapOk(startBidding(state, NOW));
    // exhaust only required agents
    const withExhaustedRequired = {
      ...bidding,
      cold_start: false,
      agents: {
        ...bidding.agents,
        alice: { ...bidding.agents['alice']!, quota_remaining: 0, fallback_used: true },
        bob: { ...bidding.agents['bob']!, quota_remaining: 0, fallback_used: true },
        // user (observer) still has quota
      },
      current_bids: { alice: 80, bob: 70, user: 10 }, // below threshold — observer does not enter primary pool
      pending_bidders: [],
    };
    const [, decision] = unwrapOk(resolveWinner(withExhaustedRequired, NOW));
    // observer with quota should not block epoch transition
    expect('no_winner' in decision && decision.reason).toBe('epoch_transition');
  });

  // --- adversarial tests (red-attacker provenance) ---

  it('noEligibleParticipants vacuous truth when all agents are observers', () => {
    const state = initSession({
      topic: 'Observer Only',
      agents: [{ name: 'user', persona: 'User', participation: 'observer' as const }],
      min_bid_delay_ms: 0,
    }, NOW);
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('noEligibleParticipants true when required banned and observer remains active', () => {
    const bidding = unwrapOk(startBidding(initSession(MIXED_INPUT, NOW), NOW));
    const state = {
      ...bidding,
      agents: {
        alice: { ...bidding.agents['alice']!, banned: true },
        bob: { ...bidding.agents['bob']!, banned: true },
        user: makeAgent({ participation: 'observer' as const }),
      },
    };
    expect(noEligibleParticipants(state)).toBe(true);
  });

  it('noEligibleParticipants false when some required agents still active', () => {
    const bidding = unwrapOk(startBidding(initSession(MIXED_INPUT, NOW), NOW));
    const state = {
      ...bidding,
      agents: {
        alice: { ...bidding.agents['alice']!, quota_remaining: 0, fallback_used: true },
        bob: bidding.agents['bob']!,
        user: bidding.agents['user']!,
      },
    };
    expect(noEligibleParticipants(state)).toBe(false);
  });

  it('resolveWinner quorum_not_met when observer bid but required agents did not', () => {
    const bidding = unwrapOk(startBidding(initSession(MIXED_INPUT, NOW), NOW));
    const withOnlyObserverBid = unwrapOk(applyBid(bidding, 'user', 85, 'observer bid', NOW));
    const result = resolveWinner(withOnlyObserverBid, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('quorum_not_met');
  });

  it('resolveWinner epoch_transition when alice fallback unused and user exhausted', () => {
    const ALICE_USER = {
      topic: 'Alice + User',
      agents: [
        { name: 'alice', persona: '# Alice — Analyst\nRequired.', participation: 'required' as const },
        { name: 'user', persona: '# User — Human\nObserver.', participation: 'observer' as const },
      ],
      min_bid_delay_ms: 0,
    };
    const bidding = unwrapOk(startBidding(initSession(ALICE_USER, NOW), NOW));
    const s1 = unwrapOk(applyBid(bidding, 'alice', 20, 'required bid', NOW));
    const s2 = unwrapOk(applyBid(s1, 'user', 90, 'observer high', NOW));
    const depleting = {
      ...s2,
      agents: {
        alice: { ...s2.agents['alice']!, quota_remaining: 0, fallback_used: false },
        user: { ...s2.agents['user']!, quota_remaining: 0, fallback_used: true },
      },
    };
    const [, decision] = unwrapOk(resolveWinner(depleting, NOW));
    expect('no_winner' in decision && decision.reason).toBe('epoch_transition');
  });

  it('applyExpel bans required but not observer when both passed as pending', () => {
    const bidding = unwrapOk(startBidding(initSession(MIXED_INPUT, NOW), NOW));
    const result = applyExpel({
      ...bidding,
      step: 3,
      epoch: 2,
      pending_bidders: ['alice', 'user'],
    }, ['alice', 'user'], NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.agents['alice']?.banned).toBe(true);
    expect(result.value.state.agents['user']?.banned).toBe(false);
  });

  it('noEligibleParticipants true after required expelled even if observer has quota', () => {
    const ALICE_USER = {
      topic: 'Alice + User',
      agents: [
        { name: 'alice', persona: '# Alice — Analyst\nRequired.', participation: 'required' as const },
        { name: 'user', persona: '# User — Human\nObserver.', participation: 'observer' as const },
      ],
      min_bid_delay_ms: 0,
    };
    const bidding = unwrapOk(startBidding(initSession(ALICE_USER, NOW), NOW));
    const expelled = unwrapOk(applyExpel({
      ...bidding, step: 3, epoch: 2, pending_bidders: ['alice', 'user'],
    }, ['alice', 'user'], NOW));
    expect(expelled.state.agents['alice']?.banned).toBe(true);
    expect(noEligibleParticipants(expelled.state)).toBe(true);
    expect(expelled.state.agents['user']?.banned).toBe(false);
  });

  it('observer stays in current_bids but not pending_bidders across multi-round speech cycle', () => {
    const init = initSession(MIXED_INPUT, NOW);
    const started = unwrapOk(startBidding(init, NOW));

    const r1Alice = unwrapOk(applyBid(started, 'alice', 80, 'first round', NOW));
    const r1Bob = unwrapOk(applyBid(r1Alice, 'bob', 60, 'bob first', NOW));
    const r1Observer = unwrapOk(applyBid(r1Bob, 'user', 70, 'first observer bid', NOW));
    const [r1Resolved] = unwrapOk(resolveWinner(r1Observer, NOW));
    const r1Speech = unwrapOk(applySpeech(r1Resolved, r1Resolved.current_speaker!, 'first response', NOW));

    expect(r1Speech.current_bids['alice']).toBeNull();
    expect(r1Speech.current_bids['user']).toBeNull();
    expect(r1Speech.pending_bidders).toEqual(['alice', 'bob']);
    expect(r1Speech.pending_bidders).not.toContain('user');
  });

  it('endContent returns exact contract string for all_below_threshold', () => {
    expect(endContent('all_below_threshold')).toBe('All participants bid below the threshold. Ending discussion.');
  });

  it('endContent returns exact contract string for max_epochs_reached', () => {
    expect(endContent('max_epochs_reached')).toBe('Maximum epochs reached. Ending discussion.');
  });

  it('endContent returns exact contract string for all_blocked', () => {
    expect(endContent('all_blocked')).toBe('Discussion is structurally deadlocked. Agents who want to speak have no quota, and agents with quota do not want to speak.');
  });

  it('endContent returns exact contract string for no_participants', () => {
    expect(endContent('no_participants')).toBe('No eligible agents remaining. Ending discussion.');
  });
});

// adversarial tests (red-attacker provenance)
describe('endContent — pure function properties', () => {
  it('should return distinct strings for all four reasons', () => {
    const results = new Set(
      (['all_below_threshold', 'max_epochs_reached', 'all_blocked', 'no_participants'] as const).map(endContent),
    );
    expect(results.size).toBe(4);
  });

  it('should return the same string on repeated calls (pure function, no mutation)', () => {
    const first = endContent('all_blocked');
    const second = endContent('all_blocked');
    expect(first).toBe(second);
  });
});

// adversarial tests (red-attacker provenance)
describe('endContent integration: state machine leaves end_reason_content to caller', () => {
  function makeBiddingState(): DiscussState {
    const raw = initSession({ topic: 'End Test', agents: TWO_AGENTS, min_bid_delay_ms: 0 }, NOW);
    const started = startBidding(raw, NOW);
    if (!started.ok) throw new Error('startBidding failed');
    const s0 = started.value;
    const r1 = applyBid(s0, 'alice', 20, 'low bid', NOW);
    if (!r1.ok) throw new Error('applyBid alice failed');
    const r2 = applyBid(r1.value, 'bob', 15, 'low bid', NOW);
    if (!r2.ok) throw new Error('applyBid bob failed');
    return r2.value;
  }

  it('resolveWinner sets end_reason_content to null (endContent is applied by caller, not state machine)', () => {
    const state = makeBiddingState();
    const result = resolveWinner(state, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [nextState, decision] = result.value;
    if ('speaker_type' in decision) return; // low bids should produce no-winner path
    expect(nextState.end_reason_content).toBeNull();
  });

  it('end_reason_content on DiscussState is null until explicitly set by the caller', () => {
    const state = initSession({ topic: 'Content Test', agents: TWO_AGENTS, min_bid_delay_ms: 0 }, NOW);
    expect(state.end_reason_content).toBeNull();
  });
});

const LATER = '2026-02-21T11:00:00.000Z';

function makeEndedState(): DiscussState {
  return unwrapOk(applyEnd(startSession(), {}, NOW));
}

function makeSpeakingState(): DiscussState {
  return { ...startSession(), status: 'speaking' as const, current_speaker: 'alice', speaker_type: 'quota' as const };
}

function synthesisEntries(state: DiscussState): SynthesisTranscriptEvent[] {
  return state.transcript.filter(
    (e): e is SynthesisTranscriptEvent => e.type === 'session_event' && e.event === 'synthesis',
  );
}

// adversarial tests (red-attacker provenance)
describe('applySynthesis: non-ended status variants', () => {
  it('should return not_ended error when session is in setup status', () => {
    const state = makeSession();
    expect(state.status).toBe('setup');
    const result = applySynthesis(state, 'Premature synthesis.', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not_ended');
  });

  it('should return not_ended error when session is in speaking status', () => {
    const state = makeSpeakingState();
    expect(state.status).toBe('speaking');
    const result = applySynthesis(state, 'Mid-speech synthesis.', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not_ended');
  });
});

// adversarial tests (red-attacker provenance)
describe('applySynthesis: idempotent reference identity', () => {
  it('should return the exact same state object reference on second call', () => {
    const ended = makeEndedState();
    const first = applySynthesis(ended, 'First synthesis.', NOW);
    if (!first.ok) throw new Error('first applySynthesis failed');
    const second = applySynthesis(first.value, 'Second synthesis — must be ignored.', LATER);
    if (!second.ok) throw new Error('second applySynthesis failed');
    expect(second.value).toBe(first.value);
  });
});

// adversarial tests (red-attacker provenance)
describe('applySynthesis: transcript mutation boundaries', () => {
  it('should grow transcript by exactly one entry after synthesis', () => {
    const ended = makeEndedState();
    const priorLength = ended.transcript.length;
    const result = applySynthesis(ended, 'Synthesis text.', NOW);
    if (!result.ok) throw new Error('applySynthesis failed');
    expect(result.value.transcript).toHaveLength(priorLength + 1);
  });

  it('should preserve all prior transcript entries unchanged after synthesis', () => {
    const ended = makeEndedState();
    const priorEntries = [...ended.transcript];
    const result = applySynthesis(ended, 'Synthesis text.', NOW);
    if (!result.ok) throw new Error('applySynthesis failed');
    for (let i = 0; i < priorEntries.length; i++) {
      expect(result.value.transcript[i]).toEqual(priorEntries[i]);
    }
  });

  it('should not mutate the input state (pure function)', () => {
    const ended = makeEndedState();
    const originalLength = ended.transcript.length;
    applySynthesis(ended, 'Synthesis text.', NOW);
    expect(ended.transcript).toHaveLength(originalLength);
  });
});

// adversarial tests (red-attacker provenance)
describe('applySynthesis: synthesis transcript entry structure', () => {
  it('should produce a session_event entry with event=synthesis', () => {
    const ended = makeEndedState();
    const result = applySynthesis(ended, 'My synthesis.', NOW);
    if (!result.ok) throw new Error('applySynthesis failed');
    const last = result.value.transcript[result.value.transcript.length - 1];
    expect(last?.type).toBe('session_event');
    if (last?.type !== 'session_event') return;
    expect(last.event).toBe('synthesis');
  });

  it('should store the synthesis text verbatim in detail field', () => {
    const ended = makeEndedState();
    const synthesisText = 'Exact synthesis content — verbatim.';
    const result = applySynthesis(ended, synthesisText, NOW);
    if (!result.ok) throw new Error('applySynthesis failed');
    expect(synthesisEntries(result.value)[0]?.detail).toBe(synthesisText);
  });

  it('should record the ts field exactly as the now parameter', () => {
    const ended = makeEndedState();
    const result = applySynthesis(ended, 'Synthesis.', LATER);
    if (!result.ok) throw new Error('applySynthesis failed');
    expect(synthesisEntries(result.value)[0]?.ts).toBe(LATER);
  });

  it('should record the epoch field from state at time of synthesis call', () => {
    const ended = makeEndedState();
    expect(ended.epoch).toBe(1);
    const result = applySynthesis(ended, 'Synthesis.', NOW);
    if (!result.ok) throw new Error('applySynthesis failed');
    expect(synthesisEntries(result.value)[0]?.epoch).toBe(1);
  });
});

// adversarial tests (red-attacker provenance)
describe('applySynthesis: epoch correctness in multi-epoch session', () => {
  it('should record epoch 2 in synthesis entry when session ended during epoch 2', () => {
    const epoch2State: DiscussState = { ...startSession(), epoch: 2 };
    const ended = applyEnd(epoch2State, {}, NOW);
    if (!ended.ok) throw new Error('applyEnd failed');
    expect(ended.value.epoch).toBe(2);
    const result = applySynthesis(ended.value, 'Epoch-2 synthesis.', NOW);
    if (!result.ok) throw new Error('applySynthesis failed');
    expect(synthesisEntries(result.value)[0]?.epoch).toBe(2);
  });
});
