import { describe, expect, it } from 'vitest';

import { MAX_PROVIDER_REPLAY_BYTES, MAX_PROXY_REPLAY_BYTES } from '#src/provider-proxy/ledger.js';
import { ReplayBudget } from '#src/provider-proxy/replay-budget.js';

const CAPACITY = MAX_PROXY_REPLAY_BYTES;
const RESERVATION = MAX_PROVIDER_REPLAY_BYTES;

function totalUsage(budget: ReplayBudget): number {
  const usage = budget.usage();
  return usage.bufferedBytes + usage.reservedBytes;
}

describe('provider-proxy replay budget', () => {
  it('keeps 128 simultaneous producers within committed plus reserved capacity', async () => {
    const budget = new ReplayBudget(CAPACITY, RESERVATION);
    let maximumUsage = 0;

    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        budget
          .reserve(`operation-${index}`, () => true)
          .then((reservation) => {
            maximumUsage = Math.max(maximumUsage, totalUsage(budget));
            expect(totalUsage(budget)).toBeLessThanOrEqual(CAPACITY);
            budget.commit(reservation, 1);
            maximumUsage = Math.max(maximumUsage, totalUsage(budget));
            expect(totalUsage(budget)).toBeLessThanOrEqual(CAPACITY);
            budget.releaseBuffered(1);
          }),
      ),
    );

    expect(maximumUsage).toBe(CAPACITY);
    expect(budget.usage()).toEqual({ bufferedBytes: 0, reservedBytes: 0, waiting: 0 });
  });

  it('wakes globally blocked producers in first-in-first-out order', async () => {
    const budget = new ReplayBudget(CAPACITY, RESERVATION);
    const holders = await Promise.all(
      Array.from({ length: 4 }, (_, index) => budget.reserve(`holder-${index}`, () => true)),
    );
    const admitted: string[] = [];
    const queued = ['first', 'second', 'third'].map((identity) =>
      budget
        .reserve(identity, () => true)
        .then((reservation) => {
          admitted.push(identity);
          return reservation;
        }),
    );

    holders[0]?.release();
    await Promise.resolve();
    expect(admitted).toEqual(['first']);
    holders[1]?.release();
    await Promise.resolve();
    expect(admitted).toEqual(['first', 'second']);
    holders[2]?.release();
    await Promise.resolve();

    expect(admitted).toEqual(['first', 'second', 'third']);
    const [first, second, third] = await Promise.all(queued);
    for (const reservation of [...holders.slice(3), first, second, third]) reservation?.release();
  });

  it('returns an aborted active reservation to the next waiter', async () => {
    const budget = new ReplayBudget(CAPACITY, RESERVATION);
    const controller = new AbortController();
    const cancelled = await budget.reserve('cancelled', () => true, controller.signal);
    const holders = await Promise.all(
      Array.from({ length: 3 }, (_, index) => budget.reserve(`holder-${index}`, () => true)),
    );
    let admitted = false;
    const waiting = budget
      .reserve('waiting', () => true)
      .then((reservation) => {
        admitted = true;
        return reservation;
      });

    expect(budget.usage()).toEqual({ bufferedBytes: 0, reservedBytes: CAPACITY, waiting: 1 });
    controller.abort();
    await Promise.resolve();

    expect(admitted).toBe(true);
    expect(cancelled.release).not.toThrow();
    expect(budget.usage()).toEqual({ bufferedBytes: 0, reservedBytes: CAPACITY, waiting: 0 });
    for (const reservation of [...holders, await waiting]) reservation.release();
  });
});
