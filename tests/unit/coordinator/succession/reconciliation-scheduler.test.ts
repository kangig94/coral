import { setImmediate } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { createRealTimePort } from '#src/infra/time.js';
import { createSuccessionReconciliationScheduler } from '#src/coordinator/succession/reconciliation-scheduler.js';

describe('succession reconciliation scheduler', () => {
  it('does not start a queued reconciliation after disposal', async () => {
    const runPass = vi.fn(async () => ({ kind: 'deferred' as const, reason: 'test' }));
    const scheduler = createSuccessionReconciliationScheduler({
      time: createRealTimePort(),
      retryIntervalMs: 60_000,
      runPass,
    });

    scheduler.notifyObligationChange();
    scheduler.dispose();
    await setImmediate();

    expect(runPass).not.toHaveBeenCalled();
  });
});

it('reconciles active notifications and drops timer and subscription wakes after disposal', async () => {
  const time = createRealTimePort();
  let wake!: () => void;
  let interval!: () => void;
  const clearInterval = vi.fn();
  const unsubscribe = vi.fn();
  const runPass = vi.fn(async () => ({ kind: 'deferred' as const, reason: 'test' }));
  const scheduler = createSuccessionReconciliationScheduler({
    time: {
      ...time,
      setInterval: (callback) => {
        interval = callback;
        return {};
      },
      clearInterval,
    },
    retryIntervalMs: 60_000,
    subscribe: (notify) => {
      wake = notify;
      return unsubscribe;
    },
    runPass,
  });
  await setImmediate();
  expect(runPass).toHaveBeenCalledOnce();
  wake();
  await setImmediate();
  expect(runPass).toHaveBeenCalledTimes(2);
  scheduler.dispose();
  wake();
  interval();
  expect(await scheduler.reconcile()).toMatchObject({ kind: 'deferred' });
  await setImmediate();
  expect(runPass).toHaveBeenCalledTimes(2);
  expect(clearInterval).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('drops a follow-up pass requested while an active pass settles after disposal', async () => {
  let finish!: (decision: { kind: 'deferred'; reason: string }) => void;
  const runPass = vi.fn(
    () =>
      new Promise<{ kind: 'deferred'; reason: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const log = vi.fn();
  const scheduler = createSuccessionReconciliationScheduler({
    time: createRealTimePort(),
    observation: { bootId: 'scheduler-boot', log },
    retryIntervalMs: 60_000,
    runPass,
  });
  const active = scheduler.reconcile();
  scheduler.notifyObligationChange();
  await setImmediate();
  scheduler.dispose();
  expect(log.mock.calls.filter(([line]) => line.includes('event=start'))).toHaveLength(1);
  expect(log.mock.calls.filter(([line]) => line.includes('event=finish'))).toHaveLength(0);
  finish({ kind: 'deferred', reason: 'test' });
  await active;
  await setImmediate();
  expect(runPass).toHaveBeenCalledOnce();
  expect(log.mock.calls.filter(([line]) => line.includes('event=finish outcome=complete'))).toHaveLength(1);
});

it('reports a failed pass and retries without changing the reported error', async () => {
  let interval!: () => void;
  const error = new Error('pass failed');
  const runPass = vi
    .fn<() => Promise<{ kind: 'deferred'; reason: string }>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ kind: 'deferred', reason: 'test' });
  const log = vi.fn();
  const onError = vi.fn();
  const scheduler = createSuccessionReconciliationScheduler({
    time: {
      ...createRealTimePort(),
      setInterval: (callback) => {
        interval = callback;
        return {};
      },
      clearInterval: () => {},
    },
    observation: { bootId: 'scheduler-boot', log },
    retryIntervalMs: 60_000,
    runPass,
    onError,
  });
  try {
    await setImmediate();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(log.mock.calls.filter(([line]) => line.includes('event=finish outcome=failed'))).toHaveLength(1);
    interval();
    await setImmediate();
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([line]) => line.includes('event=start'))).toHaveLength(2);
    expect(log.mock.calls.filter(([line]) => line.includes('event=finish outcome=complete'))).toHaveLength(1);
  } finally {
    scheduler.dispose();
  }
});
