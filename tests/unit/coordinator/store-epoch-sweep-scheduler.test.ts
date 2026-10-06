import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { createStoreEpochSweepScheduler } from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import {
  hintHistoricalHydration,
  onHistoricalHydrationHint,
  refreshHistoricalEpochs,
} from '#src/jobs/historical-reader.js';

import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type * as HistoricalReader from '#src/jobs/historical-reader.js';
import type * as StoreEpoch from '#src/store/epoch/index.js';

{
  vi.mock('#src/jobs/historical-reader.js', async (original) => ({
    ...(await original<typeof HistoricalReader>()),
    registerPresentHistoricalEpochs: vi.fn(),
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
  it('keeps active-epoch hints on the periodic cadence and stops cleanly', async () => {
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
      expect(timer.mock.calls.at(-1)?.[1]).toBe(5000);
      expect(refreshHistoricalEpochs).toHaveBeenCalledTimes(1);
      const hydration = vi.fn();
      onHistoricalHydrationHint(f.index, hydration);
      for (let hint = 0; hint < 40; hint++) hintHistoricalHydration(f.index, f.jobId);
      expect(hydration).not.toHaveBeenCalled();
      expect(timer.mock.calls.at(-1)?.[1]).toBe(5000);
      await vi.advanceTimersByTimeAsync(5000);
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
}

import * as historical from '#src/jobs/historical-reader.js';

it('spaces historical hydration hints and removes the listener on stop', async () => {
  vi.useFakeTimers();
  const subscribe = vi.spyOn(historical, 'onHistoricalHydrationHint');
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
    const listener = subscribe.mock.calls.at(-1)?.[1];
    expect(listener).toBeTypeOf('function');
    listener?.('historical-epoch');
    expect(timer.mock.calls.at(-1)?.[1]).toBe(5000);
    await vi.advanceTimersByTimeAsync(250);
    listener?.('historical-epoch');
    expect(refreshHistoricalEpochs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refreshHistoricalEpochs).toHaveBeenCalledTimes(2);
    listener?.(f.epochKey);
    expect(timer.mock.calls.at(-1)?.[1]).toBe(5000);
    await scheduler.stop();
    expect(subscribe).toHaveBeenLastCalledWith(f.index, null);
  } finally {
    await scheduler.stop();
    f.close();
  }
});

it('keeps a full idle interval after a long sweep when a polling wait hints hydration', async () => {
  vi.useFakeTimers();
  const subscribe = vi.spyOn(historical, 'onHistoricalHydrationHint');
  const f = createTerminalExportFixture();
  vi.mocked(refreshHistoricalEpochs).mockImplementation(async () => {
    f.advance(5000);
  });
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
    expect(refreshHistoricalEpochs).toHaveBeenCalledTimes(1);
    subscribe.mock.calls.at(-1)?.[1]?.('historical-epoch');
    expect(timer.mock.calls.at(-1)?.[1]).toBe(5000);
  } finally {
    await scheduler.stop();
    f.close();
  }
});

it('still runs retirement when one historical source throws', async () => {
  vi.useFakeTimers();
  const actual = await vi.importActual<typeof HistoricalReader>('#src/jobs/historical-reader.js');
  const epochs = await import('#src/store/epoch/index.js');
  const f = createTerminalExportFixture();
  const broken = {
    ...f.runtime.storage,
    lstatSync: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  };
  actual.seedHistoricalEpoch(
    f.runtime,
    f.index,
    f.epoch,
    JSON.stringify(f.epoch),
    currentCoralStoreFormat().fingerprint,
    f.runtime.paths.coral.exports.jobsRoot,
    broken,
  );
  expect(f.index.unknownLocationHolds()).toMatchObject([{ retryScheduled: true }]);
  vi.mocked(refreshHistoricalEpochs).mockImplementation(actual.refreshHistoricalEpochs);
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
    await setImmediate();
    expect(epochs.sweepStoreEpochsPostReady).toHaveBeenCalledOnce();
  } finally {
    await scheduler.stop();
    vi.mocked(refreshHistoricalEpochs).mockReset();
    f.close();
  }
});

it('registration runs first and its failure does not skip closure or retention', async () => {
  vi.useFakeTimers();
  const epochs = await import('#src/store/epoch/index.js');
  const closure = await import('#src/coordinator/services/recovery/epoch-closure.js');
  const f = createTerminalExportFixture();
  const order: string[] = [];
  vi.mocked(historical.registerPresentHistoricalEpochs).mockImplementation(() => {
    order.push('register');
    throw new Error('unobservable inventory');
  });
  vi.mocked(closure.settleSupersededEpochClosures).mockImplementation(async () => {
    order.push('closure');
    return [];
  });
  vi.mocked(epochs.sweepStoreEpochsPostReady).mockImplementation(async () => {
    order.push('sweep');
    return {} as never;
  });
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
    expect(order).toEqual(['register', 'closure', 'sweep']);
  } finally {
    await scheduler.stop();
    f.close();
    vi.mocked(historical.registerPresentHistoricalEpochs).mockReset();
  }
});

it('a persistently failing closure settlement does not skip historical refresh or retention', async () => {
  vi.useFakeTimers();
  const epochs = await import('#src/store/epoch/index.js');
  const closure = await import('#src/coordinator/services/recovery/epoch-closure.js');
  const f = createTerminalExportFixture();
  const order: string[] = [];
  vi.mocked(closure.settleSupersededEpochClosures).mockImplementation(async () => {
    order.push('closure');
    throw new Error('closure settlement failed');
  });
  vi.mocked(refreshHistoricalEpochs).mockImplementation(async () => {
    order.push('refresh');
  });
  vi.mocked(epochs.sweepStoreEpochsPostReady).mockImplementation(async () => {
    order.push('sweep');
    return {} as never;
  });
  const log = vi.fn();
  const scheduler = createStoreEpochSweepScheduler({
    runtime: f.runtime,
    world: { log },
    jobLocationIndex: f.index,
    selectedStoreEpochKey: () => f.epochKey,
    onOpen: vi.fn(),
    closeProxySetForEpochClosure: vi.fn(),
  });
  try {
    scheduler.schedule(f.epoch);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(order).toEqual(['closure', 'refresh', 'sweep', 'closure', 'refresh', 'sweep']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('closure settlement failed'));
  } finally {
    await scheduler.stop();
    f.close();
    vi.mocked(closure.settleSupersededEpochClosures).mockReset();
  }
});
