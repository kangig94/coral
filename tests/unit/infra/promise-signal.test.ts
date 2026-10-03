import { getEventListeners } from 'node:events';
import { expect, it, vi } from 'vitest';
import { observePromise, raceObserved, raceWithSignal } from '#src/infra/promise-signal.js';
import { createDeferred } from '#tools/testing/deferred.js';

it('removes the current abort listener after success or failure', async () => {
  const abort = new AbortController();
  expect(await raceWithSignal(Promise.resolve(1), abort.signal, () => 2)).toBe(1);
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  const error = new Error('read failed');
  await expect(raceWithSignal(Promise.reject(error), abort.signal, () => 2)).rejects.toBe(error);
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
});

it('interrupts a pending read and honors a signal already aborted', async () => {
  const abort = new AbortController();
  const read = new Promise<never>(() => {});
  const pending = raceWithSignal(read, abort.signal, () => 'handover');
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1);
  abort.abort();
  expect(await pending).toBe('handover');
  expect(await raceWithSignal(read, abort.signal, () => 'handover')).toBe('handover');
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
});

it('skips cancellation setup without a signal', async () => {
  const onAbort = vi.fn();
  expect(await raceWithSignal(Promise.resolve('event'), undefined, onAbort)).toBe('event');
  expect(onAbort).not.toHaveBeenCalled();
});

it('observes each lifetime promise once and propagates its rejection', async () => {
  const deferred = createDeferred<number>();
  const first = observePromise(deferred.promise);
  expect(observePromise(deferred.promise)).toBe(first);
  expect(await raceObserved([deferred.promise, Promise.resolve(7)])).toBe(7);
  const failure = new Error('transport failed');
  const interrupted = raceObserved([deferred.promise, new Promise<never>(() => {})]);
  deferred.reject(failure);
  await expect(interrupted).rejects.toBe(failure);
});

it('honors the input order for settled promises', async () => {
  const first = Promise.resolve(1);
  const second = Promise.resolve(2);
  expect(await raceObserved([first, second])).toBe(1);
  expect(await raceObserved([second, first])).toBe(2);
});

it('preserves a non-Error rejection from an observed promise', async () => {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- This input intentionally rejects with a primitive.
  const input = Promise.reject('original rejection');
  await expect(raceObserved([input])).rejects.toBe('original rejection');
});
