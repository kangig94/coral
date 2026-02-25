import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { handleToolCall, tools } from '../server-handlers.js';
import { applyBid, applyEnd, resolveWinner, startBidding, DEFAULT_BID_THRESHOLD } from '../state-machine.js';
import { _setDefaultPollMs } from '../wait.js';
import type { McpResult } from '../../shared/mcp-utils.js';
import type { DiscussState } from '../types.js';

const T = 0.1;
const sec = (s: number): number => Math.max(1, Math.round(s * T));

let tmpDir: string;
let store: SessionStore;

const AGENTS = [
  { name: 'alice', persona: 'Alice the architect' },
  { name: 'bob', persona: 'Bob the critic' },
];
const SAMPLE_SEED = {
  controversy_axes: [
    { axis: 'cost', positions: ['high', 'low'] },
    { axis: 'risk', positions: ['high', 'low'] },
  ],
  n: 4,
  seed: 42,
};
type SeedResult = {
  ok: boolean;
  value: {
    assignments: Array<{ persona_seed?: number; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-handlers-'));
  store = new SessionStore(tmpDir);
  _setDefaultPollMs(Math.round(500 * T));
});
afterEach(() => {
  _setDefaultPollMs(500);
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createSession() {
  const r = await handleToolCall(
    'discuss_lead',
    { op: '_2_create', topic: 'Test', agents: AGENTS },
    store,
  );
  const data = parseResult(r) as { session_id: string };
  const sid = data.session_id;

  const sessionDir = store.resolveDir(sid);
  if (!sessionDir) throw new Error('session missing after create');
  await store.withLock(sessionDir, async () => {
    const state = store.load(sessionDir);
    const started = startBidding(state, new Date().toISOString());
    if (started.ok) store.save(sessionDir, started.value);
  });
  return sid;
}

function parseResult(result: McpResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function startBidRound(sid: string, aliceScore = 80, bobScore = 50) {
  const aliceBid = handleToolCall(
    'discuss',
    { op: 'bid', session: sid, agent_name: 'alice', score: aliceScore, thought: 'alice thinking' },
    store,
  );
  const bobBid = handleToolCall(
    'discuss',
    { op: 'bid', session: sid, agent_name: 'bob', score: bobScore, thought: 'bob thinking' },
    store,
  );
  const step = handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);

  return { aliceBid, bobBid, step };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireSessionDir(sid: string): string {
  const sessionDir = store.resolveDir(sid);
  if (!sessionDir) throw new Error(`missing session: ${sid}`);
  return sessionDir;
}

async function overwriteState(sid: string, mutate: (state: DiscussState) => DiscussState): Promise<void> {
  const sessionDir = requireSessionDir(sid);
  await store.withLock(sessionDir, async () => {
    store.save(sessionDir, mutate(store.load(sessionDir)));
  });
}

async function makeSpeakingState(sid: string, aliceScore = 80, bobScore = 20): Promise<'alice' | 'bob'> {
  const sessionDir = requireSessionDir(sid);
  let winner: 'alice' | 'bob' = 'alice';

  await store.withLock(sessionDir, async () => {
    let state = store.load(sessionDir);
    if (state.status === 'setup') {
      const started = startBidding(state, new Date().toISOString());
      if (!started.ok) throw new Error('failed to start bidding');
      state = started.value;
    }
    if (state.status !== 'bidding') throw new Error(`expected bidding, got ${state.status}`);

    const withAlice = applyBid(state, 'alice', aliceScore, 'alice thinking', new Date().toISOString());
    if (!withAlice.ok) throw new Error(withAlice.error);
    const withBob = applyBid(withAlice.value, 'bob', bobScore, 'bob thinking', new Date().toISOString());
    if (!withBob.ok) throw new Error(withBob.error);

    const resolved = resolveWinner(withBob.value, new Date().toISOString());
    if (!resolved.ok) throw new Error(resolved.error);
    const [nextState, decision] = resolved.value;
    if (!('speaker_type' in decision)) throw new Error('expected resolved winner');
    winner = decision.winner as 'alice' | 'bob';
    store.save(sessionDir, nextState);
  });

  return winner;
}

function winnerFromStep(step: McpResult): 'alice' | 'bob' {
  const stepData = parseResult(step);
  return stepData.winner as 'alice' | 'bob';
}

function loserFromStep(step: McpResult, winner: 'alice' | 'bob'): 'alice' | 'bob' {
  return winner === 'alice' ? 'bob' : 'alice';
}

describe('tools', () => {
  it('should expose exactly two tools', () => {
    expect(tools).toHaveLength(2);
  });

  it('should expose discuss and discuss_lead', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(['discuss', 'discuss_lead']);
  });
});

describe('discuss creation protocol', () => {
  it('should reject create on discuss tool', async () => {
    const result = await handleToolCall('discuss', { op: 'create', topic: 'AI Ethics', agents: AGENTS }, store);
    expect(result.isError).toBe(false);
    const data = parseResult(result);
    expect(data).toHaveProperty('error', 'unknown_op');
  });

  it('should create session and return session fields from discuss_lead', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_2_create', topic: 'AI Ethics', agents: AGENTS }, store);
    const data = parseResult(result);
    expect(result.isError).toBe(false);
    expect(data).toHaveProperty('session_id');
    expect(data).toHaveProperty('status', 'setup');
    expect(data.bid_threshold).toBe(DEFAULT_BID_THRESHOLD);
  });

  it('should reject create with bad payload', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_2_create', topic: '', agents: AGENTS }, store);
    expect(result.isError).toBe(true);
  });
});

describe('discuss tool: bid / speak', () => {
  it('should accept bids in bidding status', async () => {
    const sid = await createSession();
    const { aliceBid, bobBid, step } = startBidRound(sid, 80, 50);
    const stepResult = await step;
    const stepData = parseResult(stepResult);
    expect(stepData.status).toBe('bidding');
    expect(stepData.phase).toBe('resolved');
    expect(stepData.winner).toBe('alice');

    const winner = stepData.winner === 'alice' ? 'alice' : 'bob';
    const loser = loserFromStep(stepResult, winner);
    const winnerBid = await (winner === 'alice' ? aliceBid : bobBid);
    const winnerSpeak = await handleToolCall(
      'discuss',
      { op: 'speak', session: sid, agent_name: winner, content: 'My argument.' },
      store,
    );
    const loserBid = await (loser === 'alice' ? aliceBid : bobBid);

    const winnerData = parseResult(winnerBid);
    const loserData = parseResult(loserBid);
    expect(parseResult(winnerSpeak)).toHaveProperty('status', 'bidding');

    expect(winnerData).toHaveProperty('action', 'speak');
    expect(loserData).toHaveProperty('action', 'listen');
  });

  it('should reject bid for unknown session', async () => {
    const result = await handleToolCall('discuss', { op: 'bid', session: 'bad-session', agent_name: 'alice', score: 75, thought: 'thinking' }, store);
    expect(result.isError).toBe(true);
  });

  it('should record a speech for the winner', async () => {
    const sid = await createSession();
    const { aliceBid, bobBid, step } = startBidRound(sid, 80, 50);
    const stepResult = await step;
    const stepData = parseResult(stepResult);
    expect(stepData.status).toBe('bidding');
    expect(stepData.phase).toBe('resolved');

    const winner = winnerFromStep(stepResult);
    const loser = loserFromStep(stepResult, winner);
    const winnerBid = await (winner === 'alice' ? aliceBid : bobBid);
    expect(parseResult(winnerBid)).toHaveProperty('action', 'speak');

    const speechResult = await handleToolCall(
      'discuss',
      { op: 'speak', session: sid, agent_name: winner, content: 'My argument.' },
      store,
    );
    const speechData = parseResult(speechResult);
    expect(speechData).toHaveProperty('status', 'bidding');
    expect(speechData).toHaveProperty('step', 2);

    const loserBid = await (loser === 'alice' ? aliceBid : bobBid);
    expect(parseResult(loserBid).action).toBe('listen');
  });

  it('should reject wrong speaker', async () => {
    const sid = await createSession();
    const { aliceBid, bobBid, step } = startBidRound(sid, 80, 50);
    const stepResult = await step;
    const winner = winnerFromStep(stepResult);
    const loser = loserFromStep(stepResult, winner);
    await (winner === 'alice' ? aliceBid : bobBid);

    const result = await handleToolCall('discuss', { op: 'speak', session: sid, agent_name: loser, content: 'Bad call.' }, store);
    const data = parseResult(result);
    expect(data).toHaveProperty('error', 'not_your_turn');

    const winnerSpeak = await handleToolCall(
      'discuss',
      { op: 'speak', session: sid, agent_name: winner, content: 'Proper turn.' },
      store,
    );
    expect(parseResult(winnerSpeak)).toHaveProperty('status', 'bidding');
    const loserBid = await (loser === 'alice' ? aliceBid : bobBid);
    expect(parseResult(loserBid).action).toBe('listen');
  });
});

describe('discuss_lead tool: _1_seed', () => {
  it('should return seed assignments with deterministic seed', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_1_seed', ...SAMPLE_SEED }, store);
    const data = parseResult(result) as SeedResult;
    expect(result.isError).toBe(false);
    expect(data).toHaveProperty('ok', true);
    expect(data.value).toHaveProperty('seed_used');
    expect(Array.isArray(data.value.assignments)).toBe(true);
  });

  it('should reject invalid seed payloads', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_1_seed', controversy_axes: [{ axis: 'a', positions: ['1'] }], n: 0 }, store);
    expect(result.isError).toBe(true);
  });

  it('should subsample and include subsampled fields when pool > 256', async () => {
    const axes = Array.from({ length: 3 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 7 }, (__, j) => `p${j}`),
    }));
    const result = await handleToolCall('discuss_lead', { op: '_1_seed', controversy_axes: axes, n: 1, seed: 1 }, store);
    const data = parseResult(result) as SeedResult;
    expect(result.isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.value.subsampled).toBe(true);
    expect(data.value.original_pool_size).toBe(343);
    expect(data.value.assignments).toHaveLength(1);
  });

  it('should include persona_seed in every assignment', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_1_seed', ...SAMPLE_SEED }, store);
    const data = parseResult(result) as SeedResult;
    expect(data.ok).toBe(true);
    for (const assignment of data.value.assignments) {
      expect(typeof assignment.persona_seed).toBe('number');
      expect(Number.isInteger(assignment.persona_seed)).toBe(true);
    }
  });

  it('should treat seed=0 as valid (not as falsy null) and produce deterministic output', async () => {
    const axes = [
      { axis: 'cost', positions: ['high', 'low'] },
      { axis: 'risk', positions: ['high', 'low'] },
    ];
    const r1 = await handleToolCall('discuss_lead', { op: '_1_seed', controversy_axes: axes, n: 2, seed: 0 }, store);
    const r2 = await handleToolCall('discuss_lead', { op: '_1_seed', controversy_axes: axes, n: 2, seed: 0 }, store);
    const d1 = parseResult(r1) as { ok: boolean; value: { seed_used: number; assignments: unknown[] } };
    const d2 = parseResult(r2) as { ok: boolean; value: { seed_used: number; assignments: unknown[] } };
    expect(d1.ok).toBe(true);
    expect(d1.value.seed_used).toBe(0);
    expect(JSON.stringify(d1.value.assignments)).toBe(JSON.stringify(d2.value.assignments));
  });
});

describe('discuss_lead tool: _3_step (moderation loop)', () => {
  it('should return resolved winner after all bids arrive', async () => {
    const sid = await createSession();
    const { step } = startBidRound(sid, 80, 30);

    const result = await step;
    const data = parseResult(result);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('resolved');
    expect(data.winner).toBe('alice');
  });

  it('should mark no_winner and proceed to epoch_transition when all bids above threshold and exhausted', async () => {
    const sid = await createSession();
    const first = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const firstData = parseResult(first);
    expect(firstData.status).toBe('bidding');
    expect(firstData.phase).toBe('bidding');
    const second = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const secondData = parseResult(second);
    expect(secondData.status).toBe('bidding');
    expect(secondData.phase).toBe('expelled');
    expect(Array.isArray(secondData.agents)).toBe(true);
  });

  it('should wait for speech or timeout with speech_pending phase', async () => {
    const sid = await createSession();
    const { aliceBid, bobBid, step } = startBidRound(sid, 80, 20);
    const resolved = await step;
    const winner = winnerFromStep(resolved);
    const loser = loserFromStep(resolved, winner);
    await (winner === 'alice' ? aliceBid : bobBid);

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('speaking');
    expect(data.phase).toBe('speech_pending');

    const winnerSpeak = await handleToolCall(
      'discuss',
      { op: 'speak', session: sid, agent_name: winner, content: 'My argument.' },
      store,
    );
    expect(parseResult(winnerSpeak)).toHaveProperty('status', 'bidding');
    const loserBid = await (loser === 'alice' ? aliceBid : bobBid);
    expect(parseResult(loserBid).action).toBe('listen');
  });

  it('should short-circuit when session already ended', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);

    await store.withLock(sessionDir, async () => {
      const ended = applyEnd(store.load(sessionDir), {}, new Date().toISOString());
      if (!ended.ok) throw new Error(ended.error);
      store.save(sessionDir, ended.value);
    });

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('ended');
    expect(data.phase).toBe('ended');
    expect(data.reason).toBe('already_ended');
  });

  it('should end with no_participants before expel when no eligible required agents exist', async () => {
    const sid = await createSession();

    await overwriteState(sid, (state) => ({
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, banned: true, quota_remaining: 0, fallback_used: true },
        bob: { ...state.agents.bob, banned: true, quota_remaining: 0, fallback_used: true },
      },
    }));

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('ended');
    expect(data.reason).toBe('no_participants');
  });

  it('should end with no_participants after expel removes the last eligible required agent', async () => {
    const sid = await createSession();

    await overwriteState(sid, (state) => ({
      ...state,
      step: 2,
      hold_count: 1,
      pending_bidders: ['alice'],
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, banned: false, quota_remaining: 1, fallback_used: false },
        bob: { ...state.agents.bob, banned: true, quota_remaining: 0, fallback_used: true },
      },
    }));

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('ended');
    expect(data.reason).toBe('no_participants');
  });

  it('should surface expected_speech_entry when speaking wait transitions to bidding without speech transcript entry', async () => {
    const sid = await createSession();
    await makeSpeakingState(sid);
    const sessionDir = requireSessionDir(sid);

    const stepPromise = handleToolCall(
      'discuss_lead',
      { op: '_3_step', session: sid, timeout_seconds: sec(5), force_stop: false },
      store,
    );
    await sleep(20);

    await store.withLock(sessionDir, async () => {
      const current = store.load(sessionDir);
      store.save(sessionDir, {
        ...current,
        status: 'bidding',
        last_speech_step: current.step - 1,
      });
      await sleep(120);
    });

    const result = await stepPromise;
    const data = parseResult(result);
    expect(data.error).toBe('expected_speech_entry');
  });

  it('should return speech_not_done when speaking wait predicate is met but speaker is still pending and force_stop is false', async () => {
    const sid = await createSession();
    await makeSpeakingState(sid);
    const sessionDir = requireSessionDir(sid);

    const stepPromise = handleToolCall(
      'discuss_lead',
      { op: '_3_step', session: sid, timeout_seconds: sec(5), force_stop: false },
      store,
    );
    await sleep(20);

    await store.withLock(sessionDir, async () => {
      const speakingState = store.load(sessionDir);
      store.save(sessionDir, {
        ...speakingState,
        status: 'bidding',
        last_speech_step: speakingState.step - 1,
      });
      await sleep(120);
      store.save(sessionDir, speakingState);
    });

    const result = await stepPromise;
    const data = parseResult(result);
    expect(data.error).toBe('speech_not_done');
  });

  it('should force speech_timeout when speaking remains pending and force_stop is true', async () => {
    const sid = await createSession();
    const winner = await makeSpeakingState(sid);
    const sessionDir = requireSessionDir(sid);

    const stepPromise = handleToolCall(
      'discuss_lead',
      { op: '_3_step', session: sid, timeout_seconds: sec(5), force_stop: true },
      store,
    );
    await sleep(20);

    await store.withLock(sessionDir, async () => {
      const speakingState = store.load(sessionDir);
      store.save(sessionDir, {
        ...speakingState,
        status: 'bidding',
        last_speech_step: speakingState.step - 1,
      });
      await sleep(120);
      store.save(sessionDir, speakingState);
    });

    const result = await stepPromise;
    const data = parseResult(result);
    expect(data.status).toBe('speaking');
    expect(data.phase).toBe('speech_timeout');
    expect(data.speaker).toBe(winner);
  });

  it('should surface bids_not_complete when all-bids predicate flips before resolve lock', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);

    const stepPromise = handleToolCall(
      'discuss_lead',
      { op: '_3_step', session: sid, timeout_seconds: sec(5), force_stop: false },
      store,
    );
    await sleep(20);

    await store.withLock(sessionDir, async () => {
      const state = store.load(sessionDir);
      const allIn = {
        ...state,
        pending_bidders: [],
        current_bids: { ...state.current_bids, alice: 80, bob: 70 },
      };
      store.save(sessionDir, allIn);
      await sleep(120);
      store.save(sessionDir, {
        ...allIn,
        pending_bidders: ['bob'],
        current_bids: { ...allIn.current_bids, bob: null },
      });
    });

    const result = await stepPromise;
    const data = parseResult(result);
    expect(data.error).toBe('bids_not_complete');
    expect(Array.isArray(data.pending_bidders)).toBe(true);
    expect(data.pending_bidders).toContain('bob');
  });

  it('should return epoch_transition when resolveWinner transitions epoch after wait', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);

    const stepPromise = handleToolCall(
      'discuss_lead',
      { op: '_3_step', session: sid, timeout_seconds: sec(5), force_stop: false },
      store,
    );
    await sleep(20);

    await store.withLock(sessionDir, async () => {
      const state = store.load(sessionDir);
      store.save(sessionDir, {
        ...state,
        cold_start: false,
        pending_bidders: [],
        current_bids: { ...state.current_bids, alice: 80, bob: 70 },
        agents: {
          ...state.agents,
          alice: { ...state.agents.alice, quota_remaining: 0, fallback_used: true },
          bob: { ...state.agents.bob, quota_remaining: 0, fallback_used: true },
        },
      });
      await sleep(120);
    });

    const result = await stepPromise;
    const data = parseResult(result);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('epoch_transition');
    expect(data.epoch).toBe(2);
  });
});

describe('discuss_lead tool: transcript/state/epoch/end', () => {
  it('should read recent transcript', async () => {
    const sid = await createSession();
    const r1 = await handleToolCall('discuss_lead', { op: '_4_transcript', session: sid, mode: 'recent' }, store);
    expect(r1.isError).toBe(false);
    expect(typeof r1.content[0].text).toBe('string');
  });

  it('should record epoch summary', async () => {
    const sid = await createSession();
    const r = await handleToolCall('discuss_lead', { op: '_5_epoch', session: sid, summary: 'Key points.' }, store);
    const data = parseResult(r);
    expect(data).toHaveProperty('recorded', true);
  });

  it('should expose state via _6_state', async () => {
    const sid = await createSession();
    const r = await handleToolCall('discuss_lead', { op: '_6_state', session: sid }, store);
    const data = parseResult(r);
    expect(data).toHaveProperty('session_id', sid);
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('agents');
  });

  it('should end normally', async () => {
    const sid = await createSession();
    const r = await handleToolCall('discuss_lead', { op: '_7_end', session: sid }, store);
    const data = parseResult(r);
    expect(data).toHaveProperty('status', 'ended');
  });

  it('should require reason when force=true', async () => {
    const sid = await createSession();
    const r = await handleToolCall('discuss_lead', { op: '_7_end', session: sid, force: true }, store);
    expect(r.isError).toBe(true);
  });
});

// adversarial test (red-attacker provenance)
describe('_2_create observer-only guard', () => {
  it('should reject _2_create with all observers at handler level', async () => {
    const r = await handleToolCall('discuss_lead', {
      op: '_2_create',
      topic: 'Observer-Only',
      agents: [
        { name: 'user', persona: '# User — Human\nObserver', participation: 'observer' },
        { name: 'spectator', persona: '# Spectator — Observer\nSilent', participation: 'observer' },
      ],
    }, store);
    const data = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect(r.isError).toBe(false);
    expect(data.error).toBe('no_required_agents');
  });
});

// adversarial tests (red-attacker provenance)
describe('stepBidding endNoParticipants state correctness', () => {
  it('saves ended state with hold_count incremented (next, not pre-increment) when no participants before expel', async () => {
    const sid = await createSession();

    await overwriteState(sid, (state) => ({
      ...state,
      hold_count: 0,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, banned: true, quota_remaining: 0, fallback_used: true },
        bob: { ...state.agents.bob, banned: true, quota_remaining: 0, fallback_used: true },
      },
    }));

    await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(3) }, store);

    const sessionDir = requireSessionDir(sid);
    const savedState = store.load(sessionDir);
    expect(savedState.status).toBe('ended');
    // stepBidding increments hold_count to produce `next` before calling noEligibleParticipants
    expect(savedState.hold_count).toBe(1);
  });

  it('saves ended state using expel.value.state (hold_count reset) when expel triggers no_participants', async () => {
    const sid = await createSession();

    await overwriteState(sid, (state) => ({
      ...state,
      step: 2,
      hold_count: 1,
      pending_bidders: ['alice'],
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, banned: false, quota_remaining: 1, fallback_used: false },
        bob: { ...state.agents.bob, banned: true, quota_remaining: 0, fallback_used: true },
      },
    }));

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(3) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('ended');
    expect(data.reason).toBe('no_participants');

    const sessionDir = requireSessionDir(sid);
    const savedState = store.load(sessionDir);
    expect(savedState.status).toBe('ended');
    // applyExpel resets hold_count to 0 via resetBids; endNoParticipants saves expel.value.state
    expect(savedState.hold_count).toBe(0);
  });
});

describe('handle1Seed null seed fallback', () => {
  const axes = [
    { axis: 'cost', positions: ['high', 'low'] },
    { axis: 'risk', positions: ['high', 'low'] },
  ];

  it('produces a valid result when seed is omitted (null → Math.random fallback)', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_1_seed', controversy_axes: axes, n: 2 }, store);
    expect(result.isError).toBe(false);
    const data = parseResult(result) as { ok: boolean; value: { seed_used: number; assignments: unknown[] } };
    expect(data.ok).toBe(true);
    expect(Number.isInteger(data.value.seed_used)).toBe(true);
    expect(data.value.seed_used).toBeGreaterThanOrEqual(0);
    expect(data.value.assignments).toHaveLength(2);
  });

  it('produces a valid result when seed is explicitly null', async () => {
    const result = await handleToolCall('discuss_lead', { op: '_1_seed', controversy_axes: axes, n: 2, seed: null }, store);
    expect(result.isError).toBe(false);
    const data = parseResult(result) as { ok: boolean; value: { seed_used: number; assignments: unknown[] } };
    expect(data.ok).toBe(true);
    expect(typeof data.value.seed_used).toBe('number');
    expect(data.value.assignments).toHaveLength(2);
  });
});

describe('bootstrapFromSetup with non-setup states', () => {
  it('proceeds to stepSpeaking when session is already in speaking state', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);

    await store.withLock(sessionDir, async () => {
      const state = store.load(sessionDir);
      store.save(sessionDir, {
        ...state,
        status: 'speaking',
        current_speaker: 'alice',
        speaker_type: 'quota',
      });
    });

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(2) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('speaking');
    expect(data.phase).toBe('speech_pending');
  });

  it('short-circuits with ended phase when state is already ended at bootstrap time', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);

    await store.withLock(sessionDir, async () => {
      const state = store.load(sessionDir);
      const ended = applyEnd(state, {}, new Date().toISOString());
      if (!ended.ok) throw new Error(ended.error);
      store.save(sessionDir, ended.value);
    });

    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(2) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('ended');
    expect(data.phase).toBe('ended');
    expect(data.reason).toBe('already_ended');
  });
});

describe('stepBidding min_bid_delay_ms branch', () => {
  it('resolves winner when min_bid_delay_ms > 0 and all agents have bid before step runs', async () => {
    const r = await handleToolCall(
      'discuss_lead',
      { op: '_2_create', topic: 'Delay Test', agents: AGENTS, min_bid_delay_ms: 200 },
      store,
    );
    const createData = parseResult(r) as { session_id: string };
    const sid = createData.session_id;
    const sessionDir = requireSessionDir(sid);

    await store.withLock(sessionDir, async () => {
      const state = store.load(sessionDir);
      const started = startBidding(state, new Date().toISOString());
      if (started.ok) store.save(sessionDir, started.value);
    });

    // Pre-apply both bids so allBidsIn and allAgentsBid are immediately true
    await store.withLock(sessionDir, async () => {
      let state = store.load(sessionDir);
      const now = new Date().toISOString();
      const r1 = applyBid(state, 'alice', 80, 'alice thinking', now);
      if (!r1.ok) throw new Error(r1.error);
      state = r1.value;
      const r2 = applyBid(state, 'bob', 40, 'bob thinking', now);
      if (!r2.ok) throw new Error(r2.error);
      store.save(sessionDir, r2.value);
    });

    const stepResult = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: 5 }, store);
    const data = parseResult(stepResult);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('resolved');
    expect(data.winner).toBe('alice');
  }, 10000);
});

describe('stepBidding race: session ended between hold increment and bid wait', () => {
  it('returns ended phase when session ends externally during the bid-waiting period', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);

    const stepPromise = handleToolCall(
      'discuss_lead',
      { op: '_3_step', session: sid, timeout_seconds: sec(5) },
      store,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await store.withLock(sessionDir, async () => {
      const state = store.load(sessionDir);
      if (state.status === 'bidding') {
        const ended = applyEnd(state, {}, new Date().toISOString());
        if (ended.ok) store.save(sessionDir, ended.value);
      }
    });

    const result = await stepPromise;
    const data = parseResult(result);
    expect(data.status).toBe('ended');
    expect(data.phase).toBe('ended');
  });
});

describe('nowIsoString timestamp freshness', () => {
  it('ended state has updated_at no earlier than the state before end was applied', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);
    const beforeState = store.load(sessionDir);
    const beforeTs = new Date(beforeState.updated_at).getTime();

    await overwriteState(sid, (state) => ({
      ...state,
      agents: {
        ...state.agents,
        alice: { ...state.agents.alice, banned: true, quota_remaining: 0, fallback_used: true },
        bob: { ...state.agents.bob, banned: true, quota_remaining: 0, fallback_used: true },
      },
    }));

    await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(3) }, store);

    const afterState = store.load(sessionDir);
    expect(afterState.status).toBe('ended');
    expect(new Date(afterState.updated_at).getTime()).toBeGreaterThanOrEqual(beforeTs);
  });
});
