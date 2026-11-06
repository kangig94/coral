import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { createStoreEpochSweepScheduler } from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import { refreshHistoricalEpochs } from '#src/jobs/historical-reader.js';

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
    sweepStoreEpochsPostReady: vi.fn(async () => 'complete' as const),
  }));
  vi.mock('#src/coordinator/services/recovery/epoch-closure.js', () => ({
    settleSupersededEpochClosures: vi.fn(async () => undefined),
  }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
}

import * as historical from '#src/jobs/historical-reader.js';

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
    bootId: 'test-boot',
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
    return 'complete';
  });
  const log = vi.fn();
  const scheduler = createStoreEpochSweepScheduler({
    bootId: 'test-boot',
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
    expect(order).toEqual(['register', 'closure', 'sweep']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('event=finish outcome=failed'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(order).toEqual(['register', 'closure', 'sweep', 'register', 'closure', 'sweep']);
    expect(log.mock.calls.filter(([line]) => line.includes('event=finish outcome=failed'))).toHaveLength(1);
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
    return 'complete';
  });
  const log = vi.fn();
  const scheduler = createStoreEpochSweepScheduler({
    bootId: 'test-boot',
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
    expect(log.mock.calls.filter(([line]) => line.includes('event=finish outcome=failed'))).toHaveLength(1);
  } finally {
    await scheduler.stop();
    f.close();
    vi.mocked(closure.settleSupersededEpochClosures).mockReset();
  }
});

it('reports each sweep hold transition once and keeps cancellation and shutdown silent', async () => {
  vi.useFakeTimers();
  const epochs = await import('#src/store/epoch/index.js');
  const f = createTerminalExportFixture();
  const log = vi.fn();
  const scheduler = createStoreEpochSweepScheduler({
    bootId: 'hold-test',
    runtime: { ...f.runtime, time: { ...f.runtime.time, monotonicNow: () => 0n } },
    world: { log },
    jobLocationIndex: f.index,
    selectedStoreEpochKey: () => f.epochKey,
    onOpen: vi.fn(),
    closeProxySetForEpochClosure: vi.fn(),
  });
  const sweep = vi.mocked(epochs.sweepStoreEpochsPostReady);
  const cases = [
    ['complete', null],
    ['unobservable-metadata', 'unobservable-metadata'],
    ['unobservable-metadata', null],
    ['live-holder', 'live-holder'],
    ['live-holder', null],
    ['cancelled', null],
    ['complete', 'cleared'],
    ['complete', null],
    ['live-holder', 'live-holder'],
  ] as const;
  let finishSweep: ((result: 'complete') => void) | undefined;
  try {
    for (const [index, [result, reported]] of cases.entries()) {
      sweep.mockResolvedValue(result);
      if (index === 0) scheduler.schedule(f.epoch);
      await vi.advanceTimersByTimeAsync(index === 0 ? 0 : 5_000);
      expect(sweep).toHaveBeenCalledTimes(index + 1);
      if (reported === null) {
        expect(log).not.toHaveBeenCalled();
      } else {
        expect(log.mock.calls.filter(([line]) => line.includes('event=finish'))).toHaveLength(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(reported));
      }
      log.mockClear();
    }
    sweep.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSweep = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(cases.length + 1);
    const stopped = scheduler.stop();
    finishSweep?.('complete');
    await stopped;
    expect(log).not.toHaveBeenCalled();
  } finally {
    finishSweep?.('complete');
    await scheduler.stop();
    sweep.mockReset();
    f.close();
  }
});
