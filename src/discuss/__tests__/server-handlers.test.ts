import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { handleToolCall, tools } from '../server-handlers.js';
import { applyBid, applyEnd, resolveWinner, startBidding, DEFAULT_BID_THRESHOLD } from '../state-machine.js';
import { _setDefaultPollMs } from '../wait.js';
import { resultToMcp, type McpResult } from '../../shared/mcp-utils.js';
import type { DiscussState, Result } from '../types.js';

const T = 0.1;
const sec = (s: number): number => Math.max(1, Math.round(s * T));
type SynthesisTranscriptEvent = Extract<DiscussState['transcript'][number], { type: 'session_event' }> & {
  event: 'synthesis';
};

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

function synthesisEvents(state: DiscussState): SynthesisTranscriptEvent[] {
  return state.transcript.filter(
    (entry): entry is SynthesisTranscriptEvent =>
      entry.type === 'session_event' && entry.event === 'synthesis',
  );
}

function expectSingleSynthesis(state: DiscussState, expectedDetail?: string): void {
  const events = synthesisEvents(state);
  expect(events).toHaveLength(1);
  if (expectedDetail !== undefined) {
    expect(events[0].detail).toBe(expectedDetail);
  }
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

function loserFromWinner(winner: 'alice' | 'bob'): 'alice' | 'bob' {
  return winner === 'alice' ? 'bob' : 'alice';
}

describe('tools', () => {
  const getDiscussLeadInputSchema = (): { properties: Record<string, { enum?: string[]; description?: string }> } => {
    const discussLeadTool = tools.find((tool) => tool.name === 'discuss_lead');
    if (!discussLeadTool) throw new Error('missing discuss_lead tool');
    return discussLeadTool.inputSchema as unknown as {
      properties: Record<string, { enum?: string[]; description?: string }>;
    };
  };

  it('should expose exactly two tools', () => {
    expect(tools).toHaveLength(2);
  });

  it('should expose discuss and discuss_lead', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(['discuss', 'discuss_lead']);
  });

  it('should list _8_synthesize in discuss_lead tool description', () => {
    const discussLeadTool = tools.find((tool) => tool.name === 'discuss_lead');
    expect(discussLeadTool?.description).toContain('_8_synthesize');
  });

  it('should intentionally omit _8_synthesize from discuss_lead inputSchema enum', () => {
    const inputSchema = getDiscussLeadInputSchema();
    expect(inputSchema.properties.op?.enum).not.toContain('_8_synthesize');
  });

  it('should document synthesis property as _8_synthesize payload', () => {
    const inputSchema = getDiscussLeadInputSchema();
    expect(inputSchema.properties.synthesis?.description).toContain('_8_synthesize');
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
    const data = parseResult(result) as {
      session_id: string;
      session_dir: string;
      team_name: string;
      topic: string;
      status: string;
      bid_threshold: number;
      max_epochs: number;
      min_bid_delay_ms: number;
      agents: string[];
    };
    expect(result.isError).toBe(false);
    expect(data.session_id).toBeTruthy();
    expect(data.session_dir).toBe(store.resolveDir(data.session_id));
    expect(data.team_name).toBe(`coral-dc-${data.session_id}`);
    expect(data.topic).toBe('AI Ethics');
    expect(data.status).toBe('setup');
    expect(data.bid_threshold).toBe(DEFAULT_BID_THRESHOLD);
    expect(data.max_epochs).toBeGreaterThan(0);
    expect(data.min_bid_delay_ms).toBe(0);
    expect(data.agents).toEqual(['alice', 'bob']);
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
    const loser = loserFromWinner(winner);
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
    const loser = loserFromWinner(winner);
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
    const loser = loserFromWinner(winner);
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

  it('should expel pending bidders after hold_count >= 2 in later rounds (step > 1)', async () => {
    const sid = await createSession();
    await overwriteState(sid, (state) => ({
      ...state,
      step: 2,
      hold_count: 1,
      pending_bidders: ['bob'],
      current_bids: { ...state.current_bids, alice: 50 },
    }));
    const result = await handleToolCall('discuss_lead', { op: '_3_step', session: sid, timeout_seconds: sec(5) }, store);
    const data = parseResult(result);
    expect(data.status).toBe('bidding');
    expect(data.phase).toBe('expelled');
    expect(Array.isArray(data.agents)).toBe(true);
  });

  it('should wait for speech or timeout with speech_pending phase', async () => {
    const sid = await createSession();
    const { aliceBid, bobBid, step } = startBidRound(sid, 80, 20);
    const resolved = await step;
    const winner = winnerFromStep(resolved);
    const loser = loserFromWinner(winner);
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

  it('should record epoch summary after epoch transition', async () => {
    const sid = await createSession();
    // Simulate epoch transition: set epoch_summary_written to null (summary is due)
    await overwriteState(sid, (state) => ({ ...state, epoch_summary_written: null }));
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
    const endedState = store.load(requireSessionDir(sid));
    expect(synthesisEvents(endedState)).toHaveLength(0);
  });

  it('should require reason when force=true', async () => {
    const sid = await createSession();
    const r = await handleToolCall('discuss_lead', { op: '_7_end', session: sid, force: true }, store);
    expect(r.isError).toBe(true);
  });

  it('should record synthesis through _8_synthesize after end', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_lead', { op: '_7_end', session: sid }, store);
    const result = await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Final synthesis.' }, store);
    expect(parseResult(result)).toHaveProperty('status', 'ended');
    expectSingleSynthesis(store.load(requireSessionDir(sid)), 'Final synthesis.');
  });

  it('should reject _8_synthesize when session is not ended', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Too early.' }, store);
    const data = parseResult(result);
    expect(data.error).toBe('not_ended');
  });

  it('should keep first synthesis on duplicate _8_synthesize calls', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_lead', { op: '_7_end', session: sid }, store);
    await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'First synthesis.' }, store);
    await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Second synthesis.' }, store);
    expectSingleSynthesis(store.load(requireSessionDir(sid)), 'First synthesis.');
  });
});

describe('handleSynthesize integration', () => {
  it('persists first-write-wins when _8_synthesize is called twice via handleToolCall', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_lead', { op: '_7_end', session: sid }, store);

    await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller A synthesis.' }, store);
    await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller B synthesis.' }, store);

    expectSingleSynthesis(store.load(requireSessionDir(sid)), 'Caller A synthesis.');
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

describe('handleSeed null seed fallback', () => {
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

describe('timestamp freshness', () => {
  it('ended state has last_activity_at no earlier than the state before end was applied', async () => {
    const sid = await createSession();
    const sessionDir = requireSessionDir(sid);
    const beforeState = store.load(sessionDir);
    const beforeTs = new Date(beforeState.last_activity_at).getTime();

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
    expect(new Date(afterState.last_activity_at).getTime()).toBeGreaterThanOrEqual(beforeTs);
  });
});

describe('resultToMcp', () => {
  it('should return JSON with value fields for ok result', () => {
    const result: Result<{ status: string }> = { ok: true, value: { status: 'bidding' } };
    const mcp = resultToMcp(result);
    expect(mcp.isError).toBe(false);
    const parsed = parseResult(mcp);
    expect(parsed.status).toBe('bidding');
  });

  it('should return JSON with error field for error result', () => {
    const result: Result<never> = { ok: false, error: 'agent_not_found' };
    const mcp = resultToMcp(result);
    expect(mcp.isError).toBe(false);
    const parsed = parseResult(mcp);
    expect(parsed.error).toBe('agent_not_found');
  });

  it('should spread detail fields into the response for error result with detail', () => {
    const result: Result<never> = {
      ok: false,
      error: 'invalid_status',
      detail: { current: 'speaking', expected: 'bidding' },
    };
    const mcp = resultToMcp(result);
    const parsed = parseResult(mcp);
    expect(parsed.error).toBe('invalid_status');
    expect(parsed.current).toBe('speaking');
    expect(parsed.expected).toBe('bidding');
  });

  it('should handle error result with no detail field (detail is optional)', () => {
    const result: Result<never> = { ok: false, error: 'not_bidding' };
    expect(() => resultToMcp(result)).not.toThrow();
    const mcp = resultToMcp(result);
    const parsed = parseResult(mcp);
    expect(parsed.error).toBe('not_bidding');
  });

  it('should produce content array with exactly one text entry', () => {
    const mcp = resultToMcp({ ok: true, value: { x: 1 } });
    expect(mcp.content).toHaveLength(1);
    expect(mcp.content[0].type).toBe('text');
    expect(typeof mcp.content[0].text).toBe('string');
  });
});

async function createEndedSession(): Promise<string> {
  const r = await handleToolCall('discuss_lead', { op: '_2_create', topic: 'Red Test', agents: AGENTS }, store);
  const sid = (parseResult(r) as { session_id: string }).session_id;
  await handleToolCall('discuss_lead', { op: '_7_end', session: sid }, store);
  return sid;
}

// adversarial tests (red-attacker provenance)
describe('handler: _7_end with synthesis field defense-in-depth', () => {
  it('should return MCP error when _7_end carries synthesis field', async () => {
    const sid = await createEndedSession();
    const result = await handleToolCall(
      'discuss_lead',
      { op: '_7_end', session: sid, synthesis: 'sneaky synthesis' } as never,
      store,
    );
    expect(result.isError).toBe(true);
  });

  it('should not write synthesis to transcript when _7_end carries synthesis field', async () => {
    const r = await handleToolCall('discuss_lead', { op: '_2_create', topic: 'Defense Test', agents: AGENTS }, store);
    const sid = (parseResult(r) as { session_id: string }).session_id;
    await handleToolCall('discuss_lead', { op: '_7_end', session: sid, synthesis: 'injected synthesis' } as never, store);
    const sessionDir = store.resolveDir(sid);
    if (sessionDir) {
      expect(synthesisEvents(store.load(sessionDir))).toHaveLength(0);
    }
  });
});

// adversarial tests (red-attacker provenance)
describe('handler: _8_synthesize on unknown session', () => {
  it('should return MCP error when session ID does not exist', async () => {
    const result = await handleToolCall(
      'discuss_lead',
      { op: '_8_synthesize', session: '260101-0000-xxxx', synthesis: 'Orphan synthesis.' },
      store,
    );
    expect(result.isError).toBe(true);
  });
});

// adversarial tests (red-attacker provenance)
describe('handler: concurrent _8_synthesize calls (race condition)', () => {
  it('should persist exactly one synthesis entry when two callers race via Promise.all', async () => {
    const sid = await createEndedSession();
    const [r1, r2] = await Promise.all([
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller A synthesis.' }, store),
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller B synthesis.' }, store),
    ]);
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    const sessionDir = store.resolveDir(sid);
    if (!sessionDir) throw new Error('missing session');
    expectSingleSynthesis(store.load(sessionDir));
  });

  it('should not corrupt the synthesis text across concurrent callers', async () => {
    const sid = await createEndedSession();
    await Promise.all([
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Alpha synthesis.' }, store),
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Beta synthesis.' }, store),
    ]);
    const sessionDir = store.resolveDir(sid);
    if (!sessionDir) throw new Error('missing session');
    const synth = synthesisEvents(store.load(sessionDir));
    const validTexts = new Set(['Alpha synthesis.', 'Beta synthesis.']);
    expect(validTexts.has(synth[0]?.detail ?? '')).toBe(true);
  });

  it('should persist exactly one synthesis entry with three concurrent callers', async () => {
    const sid = await createEndedSession();
    await Promise.all([
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller 1.' }, store),
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller 2.' }, store),
      handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Caller 3.' }, store),
    ]);
    const sessionDir = store.resolveDir(sid);
    if (!sessionDir) throw new Error('missing session');
    expectSingleSynthesis(store.load(sessionDir));
  });
});

// adversarial tests (red-attacker provenance)
describe('handler: _8_synthesize response shape', () => {
  it('should return { status: "ended" } on first successful synthesis call', async () => {
    const sid = await createEndedSession();
    const result = await handleToolCall(
      'discuss_lead',
      { op: '_8_synthesize', session: sid, synthesis: 'Shape test synthesis.' },
      store,
    );
    expect(result.isError).toBe(false);
    expect(parseResult(result).status).toBe('ended');
  });

  it('should return { status: "ended" } on idempotent second synthesis call', async () => {
    const sid = await createEndedSession();
    await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'First synthesis.' }, store);
    const second = await handleToolCall('discuss_lead', { op: '_8_synthesize', session: sid, synthesis: 'Second synthesis.' }, store);
    expect(second.isError).toBe(false);
    expect(parseResult(second).status).toBe('ended');
  });

  it('should produce content array with exactly one text entry', async () => {
    const sid = await createEndedSession();
    const result = await handleToolCall(
      'discuss_lead',
      { op: '_8_synthesize', session: sid, synthesis: 'Content shape test.' },
      store,
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
  });
});
