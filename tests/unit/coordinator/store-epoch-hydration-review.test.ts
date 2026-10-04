import { afterEach, expect, it, vi } from 'vitest';
import { createStoreEpochSweepScheduler } from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import { hintHistoricalHydration, refreshHistoricalEpochs } from '#src/jobs/historical-reader.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import type * as HistoricalReader from '#src/jobs/historical-reader.js';
import type * as StoreEpoch from '#src/store/epoch/index.js';

vi.mock('#src/jobs/historical-reader.js', async (original) => ({
  ...(await original<typeof HistoricalReader>()),
  retryUnknownHistoricalEpochs: vi.fn(),
  refreshHistoricalEpochs: vi.fn(),
}));
vi.mock('#src/store/epoch/index.js', async (original) => ({
  ...(await original<typeof StoreEpoch>()),
  sweepStoreEpochsPostReady: vi.fn(async () => undefined),
}));
vi.mock('#src/coordinator/services/recovery/epoch-closure.js', () => ({
  settleSupersededEpochClosures: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('wakes the historical hydration owner before its periodic sweep and unregisters on stop', async () => {
  vi.useFakeTimers();
  const f = createTerminalExportFixture();
  const timer = vi.spyOn(f.runtime.time, 'setTimeout');
  const scheduler = createStoreEpochSweepScheduler({
    runtime: f.runtime,
    world: { log: vi.fn() },
    jobLocationIndex: f.index,
    selectedStoreEpochKey: () => f.epochKey,
    onOpen: vi.fn(),
    closeProxySetForEpochClosure: vi.fn(),
  });
  try {
    scheduler.schedule(f.epoch);
    await vi.advanceTimersByTimeAsync(0);
    expect(timer.mock.calls.at(-1)?.[1]).toBe(5_000);
    expect(refreshHistoricalEpochs).toHaveBeenCalledTimes(1);
    hintHistoricalHydration(f.index, f.jobId);
    expect(timer.mock.calls.at(-1)?.[1]).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshHistoricalEpochs).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    const calls = timer.mock.calls.length;
    hintHistoricalHydration(f.index, f.jobId);
    expect(timer).toHaveBeenCalledTimes(calls);
  } finally {
    await scheduler.stop();
    f.close();
  }
});
