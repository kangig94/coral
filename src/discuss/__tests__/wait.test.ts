/**
 * waitForCondition tests — async file polling with real tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForCondition } from '../wait.js';
import type { DiscussState } from '../types.js';

let tmpDir: string;
const INTERVAL = 30; // fast poll for tests

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'coral-wait-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeState(overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    session_id: 'test',
    session_dir: tmpDir,
    topic: 'Test',
    status: 'bidding',
    step: 1,
    epoch: 1,
    quota_per_epoch: 3,
    cold_start: false,
    recent_turns: 5,
    agents: {
      alice: { persona: '', display_name: 'Alice', quota_remaining: 3, total_speaks: 0, fallback_used: false },
    },
    current_bids: { alice: null },
    pending_bidders: ['alice'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    team_name: 'test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    transcript: [],
    transcript_rendered: 0,
    bid_threshold: 50,
    transcript_read_step: {},
    ...overrides,
  };
}

function writeState(state: DiscussState): void {
  writeFileSync(join(tmpDir, 'state.json'), JSON.stringify(state));
}

const isEnded = (s: DiscussState) => s.status === 'ended';

describe('waitForCondition', () => {
  it('should return immediately when condition already true on first check', async () => {
    writeState(makeState({ status: 'ended' }));
    const result = await waitForCondition(join(tmpDir, 'state.json'), isEnded, 5000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.elapsed_ms).toBeLessThan(INTERVAL); // resolved before first poll
    expect(result.state!.status).toBe('ended');
  });

  it('should poll until condition becomes true', async () => {
    writeState(makeState({ status: 'bidding' }));
    const statePath = join(tmpDir, 'state.json');

    // Update state after 2 poll intervals
    setTimeout(() => writeState(makeState({ status: 'ended' })), INTERVAL * 2 + 10);

    const result = await waitForCondition(statePath, isEnded, 2000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.state!.status).toBe('ended');
  });

  it('should return fulfilled=false with lastKnownGood on timeout', async () => {
    writeState(makeState({ status: 'bidding' }));
    const result = await waitForCondition(join(tmpDir, 'state.json'), isEnded, 100, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBeNull();
    expect(result.state!.status).toBe('bidding'); // lastKnownGood state
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(100);
  });

  it('should return error=state_unavailable when file never exists', async () => {
    // No state.json written — file does not exist at all
    const result = await waitForCondition(join(tmpDir, 'state.json'), isEnded, 100, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBe('state_unavailable');
  });

  it('should survive transient corrupt reads and recover on valid state', async () => {
    writeState(makeState({ status: 'bidding' }));
    const statePath = join(tmpDir, 'state.json');

    // Write corrupt JSON mid-way, then recover
    setTimeout(() => writeFileSync(statePath, '{"partial":'), INTERVAL + 5);
    setTimeout(() => writeState(makeState({ status: 'ended' })), INTERVAL * 3 + 5);

    const result = await waitForCondition(statePath, isEnded, 2000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.state!.status).toBe('ended');
  });

  it('should use lastKnownGood on timeout after transient read errors', async () => {
    writeState(makeState({ status: 'bidding' }));
    const statePath = join(tmpDir, 'state.json');

    // Replace with unparseable content — stays corrupt until timeout
    setTimeout(() => writeFileSync(statePath, 'not-json'), INTERVAL + 5);

    const result = await waitForCondition(statePath, isEnded, 150, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBeNull(); // lastKnownGood exists from initial read
    expect(result.state!.status).toBe('bidding');
  });
});
