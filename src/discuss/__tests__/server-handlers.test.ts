import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscussManager } from '../discuss-manager.js';
import { handleToolCall } from '../server-handlers.js';

let tmpDir: string;
let mgr: DiscussManager;

const SESSION = '20260221-143052-a3x7';
const AGENTS = [
  { name: 'alice', persona: 'Alice the architect' },
  { name: 'bob', persona: 'Bob the critic' },
];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-handlers-'));
  mgr = new DiscussManager(tmpDir);
});
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

async function createSession() {
  const r = await handleToolCall('discuss_create', { topic: 'Test', agents: AGENTS }, mgr);
  const data = JSON.parse(r.content[0].text) as { session_id: string };
  return data.session_id;
}

describe('discuss_create', () => {
  it('should create session and return session_id', async () => {
    const result = await handleToolCall('discuss_create', { topic: 'AI Ethics', agents: AGENTS }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(data.team_name).toContain('coral-dc-');
  });

  it('should return Zod error for invalid input', async () => {
    const result = await handleToolCall('discuss_create', { topic: '', agents: AGENTS }, mgr);
    expect(result.isError).toBe(true);
  });

  it('should reject single agent', async () => {
    const result = await handleToolCall('discuss_create', { topic: 'x', agents: [AGENTS[0]] }, mgr);
    expect(result.isError).toBe(true);
  });
});

describe('discuss_bid', () => {
  it('should accept valid bid', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 75 }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('all_bids_in');
  });

  it('should return error for invalid session ID format', async () => {
    const result = await handleToolCall('discuss_bid', { session: 'bad', agent_name: 'alice', score: 50 }, mgr);
    expect(result.isError).toBe(true);
  });
});

describe('discuss_resolve', () => {
  it('should reject without quorum', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, mgr);
    const result = await handleToolCall('discuss_resolve', { session: sid }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'quorum_not_met');
  });

  it('should return winner after all bids', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, mgr);
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'bob', score: 50 }, mgr);
    const result = await handleToolCall('discuss_resolve', { session: sid }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('winner', 'alice');
    expect(data).toHaveProperty('step');
  });
});

describe('discuss_speak', () => {
  it('should record speech for current speaker', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, mgr);
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'bob', score: 20 }, mgr);
    await handleToolCall('discuss_resolve', { session: sid }, mgr);
    const result = await handleToolCall('discuss_speak', { session: sid, agent_name: 'alice', content: 'My argument.' }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('step', 2);
    expect(data).toHaveProperty('status', 'bidding');
  });

  it('should reject wrong speaker', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, mgr);
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'bob', score: 20 }, mgr);
    await handleToolCall('discuss_resolve', { session: sid }, mgr);
    const result = await handleToolCall('discuss_speak', { session: sid, agent_name: 'bob', content: 'Unauthorized.' }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'not_your_turn');
  });
});

describe('discuss_transcript', () => {
  it('should return transcript in recent mode', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_transcript', { session: sid, mode: 'recent' }, mgr);
    expect(result.isError).toBe(false);
    expect(typeof result.content[0].text).toBe('string');
  });

  it('should reject full mode without agent_name (not ended)', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_transcript', { session: sid, mode: 'full' }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'full_transcript_requires_speaker_or_ended');
  });

  it('should allow full mode when status=ended (agent_name optional)', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_end', { session: sid }, mgr);
    const result = await handleToolCall('discuss_transcript', { session: sid, mode: 'full' }, mgr);
    expect(result.isError).toBe(false);
    expect(typeof result.content[0].text).toBe('string');
  });

  it('should reject full mode for non-current-speaker (not ended)', async () => {
    const sid = await createSession();
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'alice', score: 80 }, mgr);
    await handleToolCall('discuss_bid', { session: sid, agent_name: 'bob', score: 20 }, mgr);
    await handleToolCall('discuss_resolve', { session: sid }, mgr); // alice is speaker
    const result = await handleToolCall('discuss_transcript', { session: sid, agent_name: 'bob', mode: 'full' }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'full_transcript_speaker_only');
  });
});

describe('discuss_state', () => {
  it('should return state without current_bids', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_state', { session: sid }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).not.toHaveProperty('current_bids');
    expect(data).toHaveProperty('status', 'bidding');
    expect(data).toHaveProperty('pending_bidders');
  });
});

describe('discuss_end', () => {
  it('should end session normally', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_end', { session: sid }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('ok', true);
  });

  it('should return Zod error when force=true without reason', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_end', { session: sid, force: true }, mgr);
    expect(result.isError).toBe(true);
  });
});

describe('discuss_epoch_summary', () => {
  it('should append epoch summary', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_epoch_summary', { session: sid, epoch: 1, summary: 'Key points.' }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('ok', true);
  });

  it('should reject wrong epoch', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss_epoch_summary', { session: sid, epoch: 2, summary: 'Wrong epoch.' }, mgr);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'epoch_mismatch');
  });
});

describe('unknown tool', () => {
  it('should return error for unknown tool name', async () => {
    const result = await handleToolCall('discuss_unknown', {}, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
