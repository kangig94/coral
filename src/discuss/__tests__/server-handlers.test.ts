import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session-store.js';
import { handleToolCall, tools } from '../server-handlers.js';
import { startBidding } from '../state-machine.js';

let tmpDir: string;
let store: SessionStore;

const SESSION = '260221-1430-a3x7';
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
  const r = await handleToolCall('discuss', { op: 'create', topic: 'Test', agents: AGENTS }, store);
  const data = JSON.parse(r.content[0].text) as { session_id: string };
  const sid = data.session_id;
  // Transition setup -> bidding directly via store (no timeout needed)
  const sessionDir = store.resolveDir(sid)!;
  await store.withLock(sessionDir, async () => {
    const s = store.load(sessionDir);
    const res = startBidding(s, new Date().toISOString());
    if (res.ok) store.save(sessionDir, res.value);
  });
  return sid;
}

/** Submit all bids and auto-resolve via discuss wait (returns immediately when all bids in). */
async function bidAndResolve(sid: string, aliceScore: number, bobScore: number) {
  await handleToolCall('discuss', { op: 'bid', session: sid, agent_name: 'alice', score: aliceScore }, store);
  await handleToolCall('discuss', { op: 'bid', session: sid, agent_name: 'bob', score: bobScore }, store);
  return handleToolCall('discuss', { op: 'wait', session: sid, condition: 'all_bids', timeout_seconds: 5 }, store);
}

describe('tool registration and op contract', () => {
  it('should expose exactly two tools', () => {
    expect(tools).toHaveLength(2);
  });

  it('should expose discuss and discuss_persona_seed', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(['discuss', 'discuss_persona_seed']);
  });

  it('should return unknown_op for invalid op values', async () => {
    const result = await handleToolCall('discuss', { op: 'invalid_op' }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'unknown_op');
  });

  it('should treat missing op as validation error, not unknown_op', async () => {
    const result = await handleToolCall('discuss', {}, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('unknown_op');
  });
});

describe('discuss_create', () => {
  it('should create session and return session_id', async () => {
    const result = await handleToolCall('discuss', { op: 'create', topic: 'AI Ethics', agents: AGENTS }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.session_id).toMatch(/^\d{6}-\d{4}-[a-z0-9]{4}$/);
    expect(data.team_name).toContain('coral-dc-');
  });

  it('should return status=setup and bid_threshold=50', async () => {
    const result = await handleToolCall('discuss', { op: 'create', topic: 'AI Ethics', agents: AGENTS }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('setup');
    expect(data.bid_threshold).toBe(50);
  });

  it('should return Zod error for invalid input', async () => {
    const result = await handleToolCall('discuss', { op: 'create', topic: '', agents: AGENTS }, store);
    expect(result.isError).toBe(true);
  });

  it('should reject single agent', async () => {
    const result = await handleToolCall('discuss', { op: 'create', topic: 'x', agents: [AGENTS[0]] }, store);
    expect(result.isError).toBe(true);
  });
});

describe('discuss_bid', () => {
  it('should accept valid bid', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'bid', session: sid, agent_name: 'alice', score: 75 }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('all_bids_in');
  });

  it('should return error for invalid session ID format', async () => {
    const result = await handleToolCall('discuss', { op: 'bid', session: 'bad', agent_name: 'alice', score: 50 }, store);
    expect(result.isError).toBe(true);
  });

  it('should reject bid after speech when transcript not read', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    await handleToolCall('discuss', { op: 'speak', session: sid, agent_name: 'alice', content: 'My argument.' }, store);
    // Round 2: alice bids without reading transcript first
    const result = await handleToolCall('discuss', { op: 'bid', session: sid, agent_name: 'alice', score: 80 }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'read_transcript_first');
  });

  it('should accept bid after speech when transcript was read', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    await handleToolCall('discuss', { op: 'speak', session: sid, agent_name: 'alice', content: 'My argument.' }, store);
    // Alice reads transcript first
    await handleToolCall('discuss', { op: 'transcript', session: sid, agent_name: 'alice', mode: 'recent' }, store);
    // Now bid succeeds
    const result = await handleToolCall('discuss', { op: 'bid', session: sid, agent_name: 'alice', score: 80 }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('all_bids_in');
  });
});

describe('discuss_wait', () => {
  it('should return session_not_found for unknown session', async () => {
    const result = await handleToolCall('discuss', { op: 'wait', session: SESSION, condition: 'all_bids', timeout_seconds: 1 }, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('session_not_found');
  });

  it('should return agent_not_found for unknown agent with action_needed', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'wait', session: sid, condition: 'action_needed', agent_name: 'nobody', timeout_seconds: 1 }, store);
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
    // All below threshold and cold_start=true -> auto-pick by fairness/desire tie-break
    const result = await bidAndResolve(sid, 5, 3);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('fulfilled', true);
    expect(data).toHaveProperty('winner');
    expect(data).toHaveProperty('resolve_type', 'cold_start');
  });

  it('should enforce wait timeout limits at handler layer', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'wait', session: sid, condition: 'all_bids', timeout_seconds: 61 }, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timeout_seconds exceeds 60s limit for all_bids');
  });
});

describe('discuss_speak', () => {
  it('should record speech for current speaker', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    const result = await handleToolCall('discuss', { op: 'speak', session: sid, agent_name: 'alice', content: 'My argument.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('step', 2);
    expect(data).toHaveProperty('status', 'bidding');
  });

  it('should reject wrong speaker', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins
    const result = await handleToolCall('discuss', { op: 'speak', session: sid, agent_name: 'bob', content: 'Unauthorized.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'not_your_turn');
  });
});

describe('discuss_transcript', () => {
  it('should return transcript in recent mode', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'transcript', session: sid, mode: 'recent' }, store);
    expect(result.isError).toBe(false);
    expect(typeof result.content[0].text).toBe('string');
  });

  it('should reject full mode without agent_name (not ended)', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'transcript', session: sid, mode: 'full' }, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'full_transcript_requires_speaker_or_ended');
  });

  it('should allow full mode when status=ended (agent_name optional)', async () => {
    const sid = await createSession();
    await handleToolCall('discuss', { op: 'end', session: sid }, store);
    const result = await handleToolCall('discuss', { op: 'transcript', session: sid, mode: 'full' }, store);
    expect(result.isError).toBe(false);
    expect(typeof result.content[0].text).toBe('string');
  });

  it('should reject full mode for non-current-speaker (not ended)', async () => {
    const sid = await createSession();
    await bidAndResolve(sid, 80, 20); // alice wins -> status=speaking
    const result = await handleToolCall('discuss', { op: 'transcript', session: sid, agent_name: 'bob', mode: 'full' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'full_transcript_speaker_only');
  });

  it('should track transcript_read_step when agent_name provided', async () => {
    const sid = await createSession();
    await handleToolCall('discuss', { op: 'transcript', session: sid, agent_name: 'alice', mode: 'recent' }, store);
    const sessionDir = store.resolveDir(sid)!;
    const state = store.load(sessionDir);
    expect(state.transcript_read_step['alice']).toBe(state.step);
  });
});

describe('discuss_state', () => {
  it('should return state without current_bids', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'state', session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).not.toHaveProperty('current_bids');
    expect(data).toHaveProperty('status', 'bidding');
    expect(data).toHaveProperty('pending_bidders');
  });

  it('should include bid_threshold in state', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'state', session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('bid_threshold', 50);
  });

  it('should include display_name in agent info', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'state', session: sid }, store);
    const data = JSON.parse(result.content[0].text) as { agents: Record<string, { display_name: string }> };
    expect(data.agents['alice']).toHaveProperty('display_name');
  });

  it('should not expose sealed-bid fields after bids', async () => {
    const sid = await createSession();
    await handleToolCall('discuss', { op: 'bid', session: sid, agent_name: 'alice', score: 80 }, store);
    const result = await handleToolCall('discuss', { op: 'state', session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).not.toHaveProperty('current_bids');
    expect(data).not.toHaveProperty('scores');
  });
});

describe('discuss_end', () => {
  it('should end session normally', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'end', session: sid }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('ok', true);
  });

  it('should enforce force+reason at handler layer', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'end', session: sid, force: true }, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reason is required when force=true');
  });
});

describe('discuss_epoch_summary', () => {
  it('should append epoch summary', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'epoch_summary', session: sid, epoch: 1, summary: 'Key points.' }, store);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('ok', true);
  });

  it('should reject wrong epoch', async () => {
    const sid = await createSession();
    const result = await handleToolCall('discuss', { op: 'epoch_summary', session: sid, epoch: 2, summary: 'Wrong epoch.' }, store);
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

describe('discuss_persona_seed', () => {
  const validInput = {
    controversy_axes: [
      { axis: 'cost', positions: ['high', 'low'] },
      { axis: 'risk', positions: ['high', 'low'] },
    ],
    n: 4,
    seed: 1234,
  };

  it('should appear in tools array', () => {
    expect(tools.some((tool) => tool.name === 'discuss_persona_seed')).toBe(true);
  });

  it('should return seed_used and assignments for valid input', async () => {
    const result = await handleToolCall('discuss_persona_seed', validInput, store);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('seed_used');
    expect(data).toHaveProperty('assignments');
    expect(Array.isArray(data.assignments)).toBe(true);
  });

  it('should return Zod error for invalid input', async () => {
    const result = await handleToolCall('discuss_persona_seed', { ...validInput, n: 0 }, store);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error:');
  });

  it('should replay identical result when reusing returned seed_used', async () => {
    const first = await handleToolCall('discuss_persona_seed', { ...validInput, seed: null }, store);
    const firstData = JSON.parse(first.content[0].text);
    expect(typeof firstData.seed_used).toBe('number');

    const second = await handleToolCall('discuss_persona_seed', { ...validInput, seed: firstData.seed_used }, store);
    const secondData = JSON.parse(second.content[0].text);

    expect(secondData.seed_used).toBe(firstData.seed_used);
    expect(secondData.assignments).toEqual(firstData.assignments);
  });

  it('should return structured pool_degenerate error', async () => {
    const result = await handleToolCall(
      'discuss_persona_seed',
      {
        controversy_axes: [
          { axis: 'only1', positions: ['x'] },
          { axis: 'only2', positions: ['y'] },
        ],
        n: 2,
      },
      store,
    );

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'pool_degenerate');
    expect(data).toHaveProperty('pool_size', 1);
  });

  it('should return structured pool_too_large error', async () => {
    const result = await handleToolCall(
      'discuss_persona_seed',
      {
        controversy_axes: [
          { axis: 'a', positions: ['1', '2', '3', '4'] },
          { axis: 'b', positions: ['1', '2', '3', '4'] },
          { axis: 'c', positions: ['1', '2', '3', '4'] },
          { axis: 'd', positions: ['1', '2', '3', '4', '5'] },
        ],
        n: 4,
      },
      store,
    );

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveProperty('error', 'pool_too_large');
    expect(data).toHaveProperty('actual_pool_size', 320);
    expect(data).toHaveProperty('max_pool_size', 256);
  });

  it('should allow 256 combinations and reject >256 combinations', async () => {
    const atBoundary = await handleToolCall(
      'discuss_persona_seed',
      {
        controversy_axes: [
          { axis: 'a', positions: ['1', '2', '3', '4'] },
          { axis: 'b', positions: ['1', '2', '3', '4'] },
          { axis: 'c', positions: ['1', '2', '3', '4'] },
          { axis: 'd', positions: ['1', '2', '3', '4'] },
        ],
        n: 1,
      },
      store,
    );
    const atBoundaryData = JSON.parse(atBoundary.content[0].text);
    expect(atBoundaryData).toHaveProperty('pool_size', 256);
    expect(atBoundaryData).not.toHaveProperty('error');

    const aboveBoundary = await handleToolCall(
      'discuss_persona_seed',
      {
        controversy_axes: [
          { axis: 'a', positions: ['1', '2', '3', '4'] },
          { axis: 'b', positions: ['1', '2', '3', '4'] },
          { axis: 'c', positions: ['1', '2', '3', '4'] },
          { axis: 'd', positions: ['1', '2', '3', '4', '5'] },
        ],
        n: 1,
      },
      store,
    );
    const aboveBoundaryData = JSON.parse(aboveBoundary.content[0].text);
    expect(aboveBoundaryData).toHaveProperty('error', 'pool_too_large');
  });
});
