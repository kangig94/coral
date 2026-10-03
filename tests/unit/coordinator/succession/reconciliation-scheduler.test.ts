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
  const scheduler = createSuccessionReconciliationScheduler({
    time: createRealTimePort(),
    retryIntervalMs: 60_000,
    runPass,
  });
  const active = scheduler.reconcile();
  scheduler.notifyObligationChange();
  await setImmediate();
  scheduler.dispose();
  finish({ kind: 'deferred', reason: 'test' });
  await active;
  await setImmediate();
  expect(runPass).toHaveBeenCalledOnce();
});
