import { describe, expect, it, vi } from 'vitest';

import { MAX_PROVIDER_REPLAY_BYTES, MAX_PROXY_REPLAY_BYTES } from '#src/provider-proxy/ledger.js';
import { ReplayBudget } from '#src/provider-proxy/replay-budget.js';

const CAPACITY = MAX_PROXY_REPLAY_BYTES;
const RESERVATION = MAX_PROVIDER_REPLAY_BYTES;

function ordinary(identity: string, bytes = RESERVATION, signal?: AbortSignal) {
  return {
    identity,
    bytes,
    priority: 'ordinary' as const,
    canProduce: () => true,
    ...(signal === undefined ? {} : { signal }),
  };
}

function totalUsage(budget: ReplayBudget): number {
  const usage = budget.usage();
  return usage.bufferedBytes + usage.reservedBytes;
}

describe('provider-proxy replay budget', () => {
  it('keeps 128 simultaneous producers within committed plus reserved capacity', async () => {
    const budget = new ReplayBudget(CAPACITY);
    let maximumUsage = 0;
    const bytes = CAPACITY / 128;

    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        budget.reserve(ordinary(`operation-${index}`, bytes)).then((reservation) => {
          maximumUsage = Math.max(maximumUsage, totalUsage(budget));
          expect(totalUsage(budget)).toBeLessThanOrEqual(CAPACITY);
          budget.commit(reservation);
          maximumUsage = Math.max(maximumUsage, totalUsage(budget));
          expect(totalUsage(budget)).toBeLessThanOrEqual(CAPACITY);
          budget.releaseBuffered(bytes);
        }),
      ),
    );

    expect(maximumUsage).toBe(CAPACITY);
    expect(budget.usage()).toEqual({ bufferedBytes: 0, reservedBytes: 0, waiting: 0 });
  });

  it('wakes globally blocked producers in first-in-first-out order', async () => {
    const budget = new ReplayBudget(CAPACITY);
    const holders = await Promise.all(
      Array.from({ length: 4 }, (_, index) => budget.reserve(ordinary(`holder-${index}`))),
    );
    const admitted: string[] = [];
    const queued = ['first', 'second', 'third'].map((identity) =>
      budget.reserve(ordinary(identity)).then((reservation) => {
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
    const budget = new ReplayBudget(CAPACITY);
    const controller = new AbortController();
    const cancelled = await budget.reserve(ordinary('cancelled', RESERVATION, controller.signal));
    const holders = await Promise.all(
      Array.from({ length: 3 }, (_, index) => budget.reserve(ordinary(`holder-${index}`))),
    );
    let admitted = false;
    const waiting = budget.reserve(ordinary('waiting')).then((reservation) => {
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

  it('admits and accounts completion debt ahead of ordinary capacity waiters', async () => {
    const budget = new ReplayBudget(CAPACITY);
    const holders = await Promise.all(
      Array.from({ length: 4 }, (_, index) => budget.reserve(ordinary(`holder-${index}`))),
    );
    let ordinaryAdmitted = false;
    const waiting = budget.reserve(ordinary('waiting', 1)).then((reservation) => {
      ordinaryAdmitted = true;
      return reservation;
    });

    const completion = await budget.reserve({
      identity: 'completion',
      bytes: 7,
      priority: 'completion',
      canProduce: () => true,
    });
    expect(ordinaryAdmitted).toBe(false);
    expect(budget.usage()).toEqual({ bufferedBytes: 0, reservedBytes: CAPACITY + 7, waiting: 1 });

    budget.commit(completion);
    expect(budget.usage()).toEqual({ bufferedBytes: 7, reservedBytes: CAPACITY, waiting: 1 });
    holders[0]?.release();
    budget.releaseBuffered(7);
    await vi.waitFor(() => expect(ordinaryAdmitted).toBe(true));
    for (const reservation of [...holders.slice(1), await waiting]) reservation.release();
  });
});
