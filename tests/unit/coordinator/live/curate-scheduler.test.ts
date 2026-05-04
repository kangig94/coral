import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';
import {
  createCoordinatorCurateScheduler,
  createCurateSchedulerHealthBridge,
} from '#src/coordinator/live/curate-scheduler.js';
import type { DegradedReason } from '#src/coordinator/subsystems/contract.js';

function createInnerScheduler() {
  return {
    start: vi.fn(async () => {}),
    schedule: vi.fn(() => {}),
    scheduleDeferredCommit: vi.fn(() => {}),
    stop: vi.fn(async () => {}),
    isRunning: vi.fn(() => false),
  };
}

describe('coordinator curate scheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('ticks on the configured cadence and updates last_run_day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T12:00:00.000Z'));
    const runtime = createRealRuntime('prod');
    const db = openStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
    });
    const inner = createInnerScheduler();
    const scheduler = createCoordinatorCurateScheduler({
      scheduler: inner,
      db,
      runtime,
      intervalMs: 1_000,
    });

    await scheduler.start();
    expect(inner.start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(inner.schedule).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(inner.schedule).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT last_run_day FROM kb_curate_scheduler WHERE id = 1').get()).toEqual({
      last_run_day: '2026-04-19',
    });

    await scheduler.stop();
    expect(inner.stop).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('routes corpus publish failures past the threshold to a transition callback', () => {
    let lastReason: DegradedReason | null | undefined = undefined;
    const bridge = createCurateSchedulerHealthBridge(3);
    bridge.attach((reason) => {
      lastReason = reason;
    });

    bridge.onCorpusPublishFailure({
      stage: 'publish',
      error: new Error('boom'),
      consecutivePublishFailureCount: 2,
    } as never);
    expect(lastReason).toBeUndefined();

    bridge.onCorpusPublishFailure({
      stage: 'publish',
      error: new Error('boom'),
      consecutivePublishFailureCount: 3,
    } as never);
    expect(lastReason).toEqual({ kind: 'curate-publish', consecutiveFailures: 3, lastError: 'boom' });

    bridge.onCorpusPublishSuccess();
    expect(lastReason).toBeNull();
  });

  it('rejects double attach until detach clears listener and degraded state', () => {
    const bridge = createCurateSchedulerHealthBridge(3);
    const first = vi.fn();
    const second = vi.fn();

    bridge.attach(first);
    expect(() => bridge.attach(second)).toThrow(/already attached/);

    bridge.onCorpusPublishFailure({
      stage: 'publish',
      error: new Error('boom'),
      consecutivePublishFailureCount: 3,
    } as never);
    expect(first).toHaveBeenCalledWith({ kind: 'curate-publish', consecutiveFailures: 3, lastError: 'boom' });

    bridge.detach();
    bridge.onCorpusPublishSuccess();
    expect(first).toHaveBeenCalledTimes(1);

    bridge.attach(second);
    bridge.onCorpusPublishSuccess();
    expect(second).not.toHaveBeenCalled();
  });

  it('respects CORAL_CURATE_INTERVAL_MS overrides', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T08:00:00.000Z'));
    vi.stubEnv('CORAL_CURATE_INTERVAL_MS', '2500');
    const runtime = createRealRuntime('prod');
    const db = openStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
    });
    const inner = createInnerScheduler();
    const scheduler = createCoordinatorCurateScheduler({
      scheduler: inner,
      db,
      runtime,
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(inner.schedule).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(inner.schedule).toHaveBeenCalledTimes(1);

    db.close();
  });
});
