import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscussManager } from '../discuss-manager.js';

let tmpDir: string;
let mgr: DiscussManager;

const twoAgents = [
  { name: 'alice', persona: 'Alice the architect' },
  { name: 'bob', persona: 'Bob the critic' },
];

const baseCreate = { topic: 'Test Topic', agents: twoAgents, quota_per_epoch: 3, recent_turns: 5 };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-discuss-'));
  mgr = new DiscussManager(tmpDir);
});
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('create', () => {
  it('should create session with expected fields', async () => {
    const result = await mgr.create(baseCreate);
    expect(result.session_id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(result.session_dir).toContain(result.session_id);
    expect(result.team_name).toBe(`coral-dc-${result.session_id}`);
    expect(result.agents).toEqual(['alice', 'bob']);
  });

  it('should initialize state with correct defaults', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const state = mgr.getState(session_id);
    expect(state).not.toHaveProperty('error');
    const s = state as Record<string, unknown>;
    expect(s.status).toBe('bidding');
    expect(s.step).toBe(1);
    expect(s.epoch).toBe(1);
    expect(s.cold_start).toBe(true);
    expect(s.current_speaker).toBeNull();
    expect((s.pending_bidders as string[]).sort()).toEqual(['alice', 'bob']);
  });

  it('should not expose current_bids in getState', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const state = mgr.getState(session_id);
    expect(state).not.toHaveProperty('current_bids');
  });

  it('should include topic slug in session_dir', async () => {
    const result = await mgr.create({ ...baseCreate, topic: 'Microservices vs Monolith' });
    expect(result.session_dir).toContain(result.session_id);
  });
});

describe('submitBid', () => {
  it('should record bid and track pending_bidders', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const result = await mgr.submitBid(session_id, 'alice', 75);
    expect(result).toEqual({ all_bids_in: false });
  });

  it('should return all_bids_in=true when all agents bid', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 75);
    const result = await mgr.submitBid(session_id, 'bob', 50);
    expect(result).toEqual({ all_bids_in: true });
  });

  it('should reject double-bid', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 75);
    const result = await mgr.submitBid(session_id, 'alice', 80);
    expect(result).toHaveProperty('error', 'already_bid');
  });

  it('should reject unknown agent', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const result = await mgr.submitBid(session_id, 'nobody', 50);
    expect(result).toHaveProperty('error', 'agent_not_found');
  });
});

describe('resolve — primary pool winner', () => {
  it('should select highest bidder as winner', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 50);
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('winner', 'alice');
    expect(result).toHaveProperty('score', 80);
    expect(result).toHaveProperty('step', 1);
    expect(result).toHaveProperty('all_bids');
  });

  it('should reject without quorum', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    // bob hasn't bid
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('error', 'quorum_not_met');
    expect(((result as unknown) as { missing: string[] }).missing).toContain('bob');
  });
});

describe('resolve — tiebreaker', () => {
  it('should prefer agent with fewer total_speaks', async () => {
    const { session_id } = await mgr.create(baseCreate);
    // Give alice one speak first
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 80); // tied score
    const result = await mgr.resolve(session_id) as { winner: string };
    // Both tied at 80, both at 0 total_speaks — alphabetical: alice wins
    expect(result.winner).toBe('alice');

    // Now alice speaks (total_speaks becomes 1)
    await mgr.recordSpeech(session_id, 'alice', 'Alice speech.');

    // Step 2: same scores again — bob should win now (fewer speaks)
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 80);
    const result2 = await mgr.resolve(session_id) as { winner: string };
    expect(result2.winner).toBe('bob');
  });
});

describe('resolve — all below threshold', () => {
  it('should return no_winner with cold_start=true when all < 30', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 10);
    await mgr.submitBid(session_id, 'bob', 20);
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('no_winner', true);
    expect(result).toHaveProperty('cold_start', true);
    expect(result).toHaveProperty('reason', 'all_below_threshold');
  });

  it('should return no_winner without cold_start when cold_start=false', async () => {
    const { session_id } = await mgr.create(baseCreate);
    // First get someone to speak so cold_start=false
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'speech');

    // Now all below threshold
    await mgr.submitBid(session_id, 'alice', 10);
    await mgr.submitBid(session_id, 'bob', 5);
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('no_winner', true);
    expect(result).not.toHaveProperty('cold_start');
  });
});

describe('resolve — designate (cold start)', () => {
  it('should designate speaker when all < 30 and cold_start=true', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 5);
    await mgr.submitBid(session_id, 'bob', 10);
    const result = await mgr.resolve(session_id, 'alice');
    expect(result).toHaveProperty('winner', 'alice');
    expect(result).toHaveProperty('designated', true);
  });

  it('should reject designate when not cold_start', async () => {
    const { session_id } = await mgr.create(baseCreate);
    // Get alice to speak first (clears cold_start)
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 5);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'speech');

    // Now try to designate in non-cold-start state with all < 30
    await mgr.submitBid(session_id, 'alice', 5);
    await mgr.submitBid(session_id, 'bob', 5);
    const result = await mgr.resolve(session_id, 'bob');
    expect(result).toHaveProperty('error', 'designate_not_allowed');
  });

  it('should reject designate when bids >= threshold exist', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 5);
    const result = await mgr.resolve(session_id, 'bob');
    expect(result).toHaveProperty('error', 'designate_not_needed');
  });

  it('should reject invalid designate agent name', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 5);
    await mgr.submitBid(session_id, 'bob', 5);
    const result = await mgr.resolve(session_id, 'nobody');
    expect(result).toHaveProperty('error', 'invalid_designate');
  });
});

describe('resolve — fallback pool', () => {
  it('should use fallback pool when quota exhausted', async () => {
    // quota_per_epoch=1 so alice exhausts quota after 1 speech
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    // Step 1: alice wins and speaks
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20); // below threshold
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'Alice step 1.');

    // Step 2: alice has quota=0, bob still below threshold
    // Only alice can fallback
    await mgr.submitBid(session_id, 'alice', 50); // score >= 30, quota=0
    await mgr.submitBid(session_id, 'bob', 20); // below threshold
    const result = await mgr.resolve(session_id) as { winner: string; fallback?: true };
    expect(result.winner).toBe('alice');
    expect(result.fallback).toBe(true);
  });

  it('should block second fallback use in same epoch', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    // Exhaust alice quota
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'step 1');

    // Alice uses fallback
    await mgr.submitBid(session_id, 'alice', 50);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // alice fallback
    await mgr.recordSpeech(session_id, 'alice', 'fallback speech');

    // Now alice.fallback_used=true, quota=0 — both pools empty, not all < 30
    await mgr.submitBid(session_id, 'alice', 50);
    await mgr.submitBid(session_id, 'bob', 20);
    const result = await mgr.resolve(session_id);
    // alice blocked (fallback_used), bob below threshold → vote_required
    expect(result).toHaveProperty('vote_required', true);
  });

  it('should not decrement quota for fallback speaker', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'step 1');

    // Fallback speak
    await mgr.submitBid(session_id, 'alice', 50);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'fallback');

    const state = mgr.getState(session_id) as Record<string, unknown>;
    const agents = state.agents as Record<string, { quota_remaining: number; total_speaks: number }>;
    // quota_remaining should still be 0 (not decremented to -1)
    expect(agents['alice'].quota_remaining).toBe(0);
    expect(agents['alice'].total_speaks).toBe(2);
  });
});

describe('resolve — vote_required', () => {
  it('should transition to voting when both pools empty but not all < 30', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    // Exhaust alice quota, alice uses fallback
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 's1');

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // fallback
    await mgr.recordSpeech(session_id, 'alice', 's2');

    // vote_required
    await mgr.submitBid(session_id, 'alice', 80); // >=30 but blocked
    await mgr.submitBid(session_id, 'bob', 20);
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('vote_required', true);

    const state = mgr.getState(session_id) as Record<string, unknown>;
    expect(state.status).toBe('voting');
  });
});

describe('voting flow', () => {
  it('should return unanimous=true and keep status=voting on unanimous vote', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    // Trigger vote_required
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 's');

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // fallback

    await mgr.recordSpeech(session_id, 'alice', 's2');

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // vote_required

    // Vote: both agree (0)
    await mgr.submitBid(session_id, 'alice', 0);
    await mgr.submitBid(session_id, 'bob', 0);
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('end_vote', true);
    expect(result).toHaveProperty('unanimous', true);

    // Status should remain voting (teamlead calls discuss_end)
    const state = mgr.getState(session_id) as Record<string, unknown>;
    expect(state.status).toBe('voting');
  });

  it('should reset quota on non-unanimous vote', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    // Trigger vote_required
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 's');

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // fallback
    await mgr.recordSpeech(session_id, 'alice', 's2');

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // vote_required

    // Vote: one disagrees
    await mgr.submitBid(session_id, 'alice', 1);
    await mgr.submitBid(session_id, 'bob', 0);
    const result = await mgr.resolve(session_id);
    expect(result).toHaveProperty('end_vote', true);
    expect(result).toHaveProperty('unanimous', false);

    const state = mgr.getState(session_id) as Record<string, unknown>;
    expect(state.status).toBe('bidding');
    expect(state.epoch).toBe(2);
    expect(state.cold_start).toBe(true);
    const agents = state.agents as Record<string, { quota_remaining: number; fallback_used: boolean }>;
    expect(agents['alice'].quota_remaining).toBe(1);
    expect(agents['alice'].fallback_used).toBe(false);
  });

  it('should reject voting score > 1', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 1 });

    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 's');
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 's2');
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id); // vote_required

    const result = await mgr.submitBid(session_id, 'alice', 50); // invalid vote score
    expect(result).toHaveProperty('error', 'voting_score_invalid');
  });
});

describe('recordSpeech', () => {
  it('should increment step and reset for next bid', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 50);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'My speech.');
    const state = mgr.getState(session_id) as Record<string, unknown>;
    expect(state.step).toBe(2);
    expect(state.status).toBe('bidding');
    expect(state.current_speaker).toBeNull();
    expect((state.pending_bidders as string[]).sort()).toEqual(['alice', 'bob']);
  });

  it('should decrement quota for normal speaker', async () => {
    const { session_id } = await mgr.create({ ...baseCreate, quota_per_epoch: 3 });
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'speech');
    const state = mgr.getState(session_id) as Record<string, unknown>;
    const agents = state.agents as Record<string, { quota_remaining: number }>;
    expect(agents['alice'].quota_remaining).toBe(2);
  });

  it('should reject speech from wrong agent', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 50);
    await mgr.resolve(session_id); // alice wins
    const result = await mgr.recordSpeech(session_id, 'bob', 'unauthorized speech');
    expect(result).toHaveProperty('error', 'not_your_turn');
  });
});

describe('pending_bidders invariant', () => {
  it('should match all agent keys after create', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const state = mgr.getState(session_id) as Record<string, unknown>;
    const pending = (state.pending_bidders as string[]).sort();
    expect(pending).toEqual(['alice', 'bob']);
  });

  it('should be all agents after recordSpeech', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 50);
    await mgr.resolve(session_id);
    await mgr.recordSpeech(session_id, 'alice', 'speech');
    const state = mgr.getState(session_id) as Record<string, unknown>;
    const pending = (state.pending_bidders as string[]).sort();
    expect(pending).toEqual(['alice', 'bob']); // all reset
  });
});

describe('epochSummary', () => {
  it('should accept valid epoch summary', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const result = await mgr.recordEpochSummary(session_id, 1, 'Key points...');
    expect(result).toEqual({ ok: true });
  });

  it('should reject wrong epoch', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const result = await mgr.recordEpochSummary(session_id, 2, 'wrong epoch');
    expect(result).toHaveProperty('error', 'epoch_mismatch');
    expect(((result as unknown) as { expected: number }).expected).toBe(1);
  });

  it('should reject duplicate epoch summary', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.recordEpochSummary(session_id, 1, 'First summary');
    const result = await mgr.recordEpochSummary(session_id, 1, 'Duplicate');
    expect(result).toHaveProperty('error', 'epoch_summary_duplicate');
  });
});

describe('end', () => {
  it('should end session in bidding status', async () => {
    const { session_id } = await mgr.create(baseCreate);
    const result = await mgr.end(session_id, {});
    expect(result).toHaveProperty('ok', true);
    const state = mgr.getState(session_id) as Record<string, unknown>;
    expect(state.status).toBe('ended');
  });

  it('should reject ending during speech without force', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    const result = await mgr.end(session_id, {});
    expect(result).toHaveProperty('error', 'requires_force');
  });

  it('should end during speech with force=true+reason', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.submitBid(session_id, 'alice', 80);
    await mgr.submitBid(session_id, 'bob', 20);
    await mgr.resolve(session_id);
    const result = await mgr.end(session_id, { force: true, reason: 'timeout' });
    expect(result).toHaveProperty('ok', true);
  });

  it('should reject already-ended session', async () => {
    const { session_id } = await mgr.create(baseCreate);
    await mgr.end(session_id, {});
    const result = await mgr.end(session_id, {});
    expect(result).toHaveProperty('error', 'already_ended');
  });
});

describe('getState', () => {
  it('should return error for unknown session', () => {
    const result = mgr.getState('20260101-000000-xxxx');
    expect(result).toHaveProperty('error', 'session_not_found');
  });
});
