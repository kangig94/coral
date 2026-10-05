import { expect, it } from 'vitest';
import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';

function fakeRuntime(state: { wall: number; mono: bigint }) {
  return {
    time: { now: () => state.wall, monotonicNow: () => state.mono } as never,
    env: { get: () => undefined } as never,
  };
}

it('distrusts a forward wall jump after a long idle gap', () => {
  const state = { wall: Date.parse('2026-10-01T00:00:00Z'), mono: 1_000_000n };
  const runtime = fakeRuntime(state);
  expect(trustedJobRetentionCutoff(runtime)).not.toBeNull();
  // idle 61 s of monotonic time, but the wall clock jumped forward by 30 days
  state.mono += 61_000n;
  state.wall += 61_000 + 30 * 86_400_000;
  const cutoff = trustedJobRetentionCutoff(runtime);
  expect(cutoff).toBeNull();
});

it('does not trust a detected clock jump after one second', () => {
  const state = { wall: Date.parse('2026-10-01T00:00:00Z'), mono: 5_000_000n };
  const runtime = fakeRuntime(state);
  trustedJobRetentionCutoff(runtime);
  state.mono += 1_000n;
  state.wall += 1_000 + 30 * 86_400_000;
  state.mono += 1_001n;
  state.wall += 1_001;
  const later = trustedJobRetentionCutoff(runtime);
  expect(later).toBeNull();
});

it('tolerates this host stepping forward three seconds every 35 seconds over hours', () => {
  const state = { wall: Date.parse('2026-10-01T00:00:00Z'), mono: 0n };
  const runtime = fakeRuntime(state);
  trustedJobRetentionCutoff(runtime);
  for (let step = 0; step < 1000; step++) {
    state.mono += 35000n;
    state.wall += 38000;
    expect(trustedJobRetentionCutoff(runtime)).not.toBeNull();
  }
  state.mono += 86400000n;
  state.wall += 86400000 + 30 * 86400000;
  expect(trustedJobRetentionCutoff(runtime)).toBeNull();
});

it('resumes retention after five stable minutes following suspend or a clock jump', () => {
  const state = { wall: Date.parse('2026-10-01T00:00:00Z'), mono: 0n };
  const runtime = fakeRuntime(state);
  trustedJobRetentionCutoff(runtime);
  state.wall += 30 * 86400000;
  expect(trustedJobRetentionCutoff(runtime)).toBeNull();
  state.mono += 299999n;
  state.wall += 299999;
  expect(trustedJobRetentionCutoff(runtime)).toBeNull();
  state.mono += 1n;
  state.wall += 1;
  expect(trustedJobRetentionCutoff(runtime)).not.toBeNull();
});

it('reanchors a trusted busy clock so a minute-scale jump after a day is still detected', () => {
  const state = { wall: Date.parse('2026-10-01T00:00:00Z'), mono: 0n };
  const runtime = fakeRuntime(state);
  for (let step = 0; step < 2880; step++) {
    trustedJobRetentionCutoff(runtime);
    state.wall += 30000;
    state.mono += 30000n;
  }
  state.wall += 120000;
  expect(trustedJobRetentionCutoff(runtime)).toBeNull();
});
