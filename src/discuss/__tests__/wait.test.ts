
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForCondition, INFINITE_POLL } from '../wait.js';
import { DEFAULT_BID_THRESHOLD } from '../state-machine.js';
import type { DiscussState } from '../types.js';

let tmpDir: string;
const INTERVAL = 30;

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
    max_epochs: 2,
    quota_per_epoch: 3,
    cold_start: false,
    agents: {
      alice: {
        persona: '',
        display_name: 'Alice',
        quota_remaining: 3,
        total_speaks: 0,
        fallback_used: false,
        banned: false,
      },
    },
    current_bids: { alice: null },
    current_thoughts: {},
    pending_bidders: ['alice'],
    current_speaker: null,
    speaker_type: null,
    epoch_summary_written: null,
    team_name: 'test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    last_speech_step: 0,
    hold_count: 0,
    bid_release_step: 0,
    end_reason_content: null,
    transcript: [],
    transcript_rendered: 0,
    bid_threshold: DEFAULT_BID_THRESHOLD,
    ...overrides,
  };
}

function writeState(state: DiscussState): void {
  writeFileSync(statePath(), JSON.stringify(state));
}

function statePath(): string {
  return join(tmpDir, 'state.json');
}

const isEnded = (s: DiscussState) => s.status === 'ended';

describe('waitForCondition', () => {
  it('should return immediately when condition already true on first check', async () => {
    writeState(makeState({ status: 'ended' }));
    const result = await waitForCondition(statePath(), isEnded, 5000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.elapsed_ms).toBeLessThan(INTERVAL);
    expect(result.state!.status).toBe('ended');
  });

  it('should support infinite polling sentinel', async () => {
    writeState(makeState({ status: 'bidding' }));
    const running = waitForCondition(statePath(), isEnded, INFINITE_POLL, INTERVAL);
    const timedOut = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 120)),
    ]);
    expect(timedOut).toHaveProperty('timedOut', true);

    const writer = setTimeout(() => writeState(makeState({ status: 'ended' })), 150);
    const released = await running;
    clearTimeout(writer);
    expect(released.fulfilled).toBe(true);
    expect(released.state?.status).toBe('ended');
  });

  it('should poll until condition becomes true', async () => {
    writeState(makeState({ status: 'bidding' }));
    setTimeout(() => writeState(makeState({ status: 'ended' })), INTERVAL * 2 + 10);

    const result = await waitForCondition(statePath(), isEnded, 2000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.state!.status).toBe('ended');
  });

  it('should return fulfilled=false with lastKnownGood on timeout', async () => {
    writeState(makeState({ status: 'bidding' }));
    const result = await waitForCondition(statePath(), isEnded, 100, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBeNull();
    expect(result.state!.status).toBe('bidding');
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(100);
  });

  it('should return error=state_unavailable when file never exists', async () => {
    const result = await waitForCondition(statePath(), isEnded, 100, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBe('state_unavailable');
  });

  it('should survive transient corrupt reads and recover on valid state', async () => {
    writeState(makeState({ status: 'bidding' }));
    const path = statePath();

    setTimeout(() => writeFileSync(path, '{"partial":'), INTERVAL + 5);
    setTimeout(() => writeState(makeState({ status: 'ended' })), INTERVAL * 3 + 5);

    const result = await waitForCondition(path, isEnded, 2000, INTERVAL);
    expect(result.fulfilled).toBe(true);
    expect(result.state!.status).toBe('ended');
  });

  it('should keep lastKnownGood after permanent corrupt read', async () => {
    writeState(makeState({ status: 'bidding' }));
    const path = statePath();
    setTimeout(() => writeFileSync(path, 'not-json'), INTERVAL + 5);

    const result = await waitForCondition(path, isEnded, 150, INTERVAL);
    expect(result.fulfilled).toBe(false);
    expect(result.error).toBeNull();
    expect(result.state!.status).toBe('bidding');
  });
});
