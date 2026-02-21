import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { handleToolCall } from '../server-handlers.js';
import { startBidding } from '../state-machine.js';

let tmpDir: string;
let store: SessionStore;

const SESSION = '20260221-143052-a3x7';
const AGENTS = [
  { name: 'alice', persona: 'Alice the architect' },
  { name: 'bob', persona: 'Bob the critic' },
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-handlers-'));
  store = new SessionStore(tmpDir);
});
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

async function createSession() {
  const r = await handleToolCall('discuss_create', { topic: 'Test', agents: AGENTS }, store);
  const data = JSON.parse(r.content[0].text) as { session_id: string };
  const sid = data.session_id;
  // Transition setup → bidding directly via store (no timeout needed)
  const sessionDir = store.resolveDir(sid)!;
  await store.withLock(sessionDir, async () => {
    const s = store.load(sessionDir);
    const res = startBidding(s, new Date().toISOString());
    if (res.ok) store.save(sessionDir, res.value);
  });
  return sid;
}

/** Submit all bids and auto-resolve via discuss_wait (returns immediately when all bids in). */
async function bidAndResolve(sid: string, aliceScore: number, bobScore: number) {
  await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: aliceScore }, store);
  await handleToolCall('discuss_bid', { session: sid, agent_name: 'bob', score: bobScore }, store);
  return handleToolCall('discuss_wait', { session: sid, condition: 'all_bids', timeout_seconds: 5 }, store);
}

describe('discuss_create', () => {
  it('should create session and return session_id', async () => {
    const result = await handleToolCall('discuss_create', { topic: 'AI Ethics', agents: AGENTS }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(data.team_name).toContain('coral-dc-');
  });

  it('should return status=setup and bid_threshold=50', async () => {
    const result = await handleToolCall('discuss_create', { topic: 'AI Ethics', agents: AGENTS }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('setup');
    expect(data.bid_threshold).toBe(50);
  });

  it('should return Zod error for invalid input', async () => {
    const result = await handleToolCall('discuss_create', { topic: '', agents: AGENTS }, store);
    expect(result.isError).toBe(true);
  });

  it('should reject single agent', async () => {
    const result = await handleToolCall('discuss_create', { topic: 'x', agents: [AGENTS[0]] }, store);
    expect(result.isError).toBe(true);
  });
});

describe('discuss_bid', () => {
  it('should accept valid bid', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 75 }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('all_bids_in');
  });

  it('should return error for invalid session ID format', async () => {
    const result = await handleToolCall('discuss_bid', { session: 'bad', agent_name: 'alice', score: 50 }, store);
    expect(result.isError).toBe(true);
  });

  it('should reject bid after speech when transcript not read', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    await handleToolCall('discuss_speak', { session: sid, agent_name: 'alice', content: 'My argument.' }, store);
    // Round 2: alice bids without reading transcript first
    const result = await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'read_transcript_first');
  });

  it('should accept bid after speech when transcript was read', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    await handleToolCall('discuss_speak', { session: sid, agent_name: 'alice', content: 'My argument.' }, store);
    // Alice reads transcript first
    await handleToolCall('discuss_transcript', { session: sid, agent_name: 'alice', mode: 'recent' }, store);
    // Now bid succeeds
    const result = await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('all_bids_in');
  });
});

describe('discuss_wait', () => {
  it('should return session_not_found for unknown session', async () => {
    const result = await handleToolCall('discuss_wait', { session: SESSION, condition: 'all_bids', timeout_seconds: 1 }, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('session_not_found');
  });

  it('should return agent_not_found for unknown agent with action_needed', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_wait', { session: sid, condition: 'action_needed', agent_name: 'nobody', timeout_seconds: 1 }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'agent_not_found');
  });

  it('should auto-resolve winner when all bids already submitted', async () => {
    const sid = await createSession();
    const result = await bidAndResolve(sid, 80, 50);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('fulfilled', true);
    expect(data).toHaveProperty('winner', 'alice'); // higher bid wins
    expect(data).toHaveProperty('resolve_type', 'normal');
  });

  it('should auto-pick cold start winner when all bids below threshold', async () => {
    const sid = await createSession();
    // All below 30 — cold_start=true at session start → auto-pick alice (fewer speaks, same)
    const result = await bidAndResolve(sid, 5, 3);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('fulfilled', true);
    expect(data).toHaveProperty('winner'); // cold_start auto-pick
    expect(data).toHaveProperty('resolve_type', 'cold_start');
  });
});

describe('discuss_speak', () => {
  it('should record speech for current speaker', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    const result = await handleToolCall('discuss_speak', { session: sid, agent_name: 'alice', content: 'My argument.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('step', 2);
    expect(data).toHaveProperty('status', 'bidding');
  });

  it('should reject wrong speaker', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    const result = await handleToolCall('discuss_speak', { session: sid, agent_name: 'bob', content: 'Unauthorized.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'not_your_turn');
  });
});

describe('discuss_transcript', () => {
  it('should return transcript in recent mode', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_transcript', { session: sid, mode: 'recent' }, store);
    expect(result.isError).toBe(false);
    expect(typeof result.content[0].text).toBe('string');
  });

  it('should reject full mode without agent_name (not ended)', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_transcript', { session: sid, mode: 'full' }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'full_transcript_requires_speaker_or_ended');
  });

  it('should allow full mode when status=ended (agent_name optional)', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_end', { session: sid }, store);
    const result = await handleToolCall('discuss_transcript', { session: sid, mode: 'full' }, store);
    expect(result.isError).toBe(false);
    expect(typeof result.content[0].text).toBe('string');
  });

  it('should reject full mode for non-current-speaker (not ended)', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins → status=speaking
    const result = await handleToolCall('discuss_transcript', { session: sid, agent_name: 'bob', mode: 'full' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'full_transcript_speaker_only');
  });

  it('should track transcript_read_step when agent_name provided', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_transcript', { session: sid, agent_name: 'alice', mode: 'recent' }, store);
    const sessionDir = store.resolveDir(sid)!;
    const state = store.load(sessionDir);
    expect(state.transcript_read_step['alice']).toBe(state.step);
  });
});

describe('discuss_state', () => {
  it('should return state without current_bids', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_state', { session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).not.toHaveProperty('current_bids');
    expect(data).toHaveProperty('status', 'bidding');
    expect(data).toHaveProperty('pending_bidders');
  });

  it('should include bid_threshold in state', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_state', { session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('bid_threshold', 50);
  });

  it('should include display_name in agent info', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_state', { session: sid }, store);
    const data = JSON.parse(result.content[0].text) as { agents: Record<string, { display_name: string }> };
    expect(data.agents['alice']).toHaveProperty('display_name');
  });
});

describe('discuss_end', () => {
  it('should end session normally', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_end', { session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('ok', true);
  });

  it('should return Zod error when force=true without reason', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_end', { session: sid, force: true }, store);
    expect(result.isError).toBe(true);
  });
});

describe('discuss_epoch_summary', () => {
  it('should append epoch summary', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_epoch_summary', { session: sid, epoch: 1, summary: 'Key points.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('ok', true);
  });

  it('should reject wrong epoch', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_epoch_summary', { session: sid, epoch: 2, summary: 'Wrong epoch.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'epoch_mismatch');
  });
});

describe('unknown tool', () => {
  it('should return error for unknown tool name', async () => {
    const result = await handleToolCall('discuss_unknown', {}, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
