import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { handleToolCall, tools } from '../server-handlers.js';
import { startBidding, DEFAULT_BID_THRESHOLD } from '../state-machine.js';
import { _setDefaultPollMs } from '../wait.js';
import type { McpResult } from '../../shared/mcp-utils.js';

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
