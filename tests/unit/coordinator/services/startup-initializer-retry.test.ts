import { afterEach, expect, it, vi } from 'vitest';

import {
  ProviderOperationReconciler,
  PROVIDER_OPERATION_STARTUP_BOUND_MS,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

afterEach(() => vi.useRealTimers());

it('red-startup-initializer-detach retains a visible automatic successor when a detached initializer rejects', async () => {
  vi.useFakeTimers();
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  let monotonic = 0n;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const errors: string[] = [];
  const initialize = vi
    .fn()
    .mockImplementationOnce(async () => {
      await pending;
      throw new Error('temporary lifecycle storage failure');
    })
    .mockRejectedValueOnce(new Error('second transient failure'))
    .mockResolvedValue(undefined);
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => ({ getDb: () => db }),
    initializeAtStartup: initialize,
    time: {
      now: () => 0,
      monotonicNow: () => monotonic,
      setTimeout,
      clearTimeout,
    },
    onError: (message: string) => errors.push(message),
  } as never);

  const startup = reconciler.reconcileAtStartup({ records: [] } as never, new AbortController().signal);
  await Promise.resolve();
  monotonic = BigInt(PROVIDER_OPERATION_STARTUP_BOUND_MS);
  await vi.advanceTimersByTimeAsync(PROVIDER_OPERATION_STARTUP_BOUND_MS);
  await expect(startup).resolves.toMatchObject({
    incidents: [{ kind: 'startup-initialization-detached' }],
  });

  release();
  await vi.waitFor(() =>
    expect(errors).toContain('Detached startup initialization failed: temporary lifecycle storage failure'),
  );

  expect(reconciler.startupStatus()).toMatchObject({
    phase: 'detached',
    initialization: expect.objectContaining({
      successor: 'provider-proxy-lifecycle-initialization',
    }),
  });

  await vi.advanceTimersByTimeAsync(25);
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(reconciler.startupStatus()?.initialization?.successor).toBe('provider-proxy-lifecycle-initialization');
  await vi.advanceTimersByTimeAsync(50);
  expect(initialize).toHaveBeenCalledTimes(3);
  expect(reconciler.startupStatus()).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(initialize).toHaveBeenCalledTimes(3);
  reconciler.stop();
  db.close();
  vi.useRealTimers();
});
