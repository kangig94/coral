import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestLeaseOwner, type RequestLeaseTiming } from '#src/coordinator/live/request-leases.js';
import { createRealTimePort } from '#src/infra/time.js';

const timing: RequestLeaseTiming = {
  defaultMs: 40,
  kbMutationMs: 400,
  settleMs: 10,
  checkMs: 2,
  schedulingGapMs: 20,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('coordinator request leases', () => {
  it('aborts never-settling unary work and invokes shutdown without waiting for inflight to clear', async () => {
    vi.useFakeTimers();
    let inflight = 0;
    const shutdown = vi.fn();
    const owner = createRequestLeaseOwner({
      begin: () => {
        inflight += 1;
      },
      end: () => {
        inflight -= 1;
      },
      shutdown,
      time: createRealTimePort(),
      timing,
    });
    const signals: AbortSignal[] = [];
    const result = owner.begin('jobs.detail', 'request-1').run((ownedSignal) => {
      signals.push(ownedSignal);
      return new Promise<never>(() => {});
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: 'request_deadline_exceeded',
      context: {
        method: 'jobs.detail',
        requestId: 'request-1',
        outcome: 'unknown',
      },
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(signals[0]?.aborted).toBe(true);
    expect(inflight).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(inflight).toBe(1);
  });

  it('keeps the one-hour KB mutation allowance', async () => {
    vi.useFakeTimers();
    const owner = createRequestLeaseOwner({
      begin: () => {},
      end: () => {},
      shutdown: vi.fn(),
      time: createRealTimePort(),
      timing,
    });
    const finishes: Array<(value: string) => void> = [];
    const result = owner.begin('kb.source.create', 'request-2').run(
      () =>
        new Promise<string>((resolve) => {
          finishes.push(resolve);
        }),
    );
    await vi.advanceTimersByTimeAsync(50);
    finishes[0]?.('accepted');
    await expect(result).resolves.toBe('accepted');
  });

  it('reports cancelled when the request owner obeys the abort', async () => {
    vi.useFakeTimers();
    const end = vi.fn();
    const shutdown = vi.fn();
    const owner = createRequestLeaseOwner({
      time: createRealTimePort(),
      begin: () => {},
      end,
      shutdown,
      timing,
    });
    const result = owner.begin('jobs.detail', 'request-3').run(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: 'request_deadline_exceeded',
      context: { outcome: 'cancelled' },
    });
    await vi.advanceTimersByTimeAsync(40);
    await rejection;
    expect(end).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('reports continuing when work completes after its deadline', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const owner = createRequestLeaseOwner({
      time: createRealTimePort(),
      begin: () => {},
      end: () => {},
      shutdown,
      timing,
    });
    let finish: (() => void) | undefined;
    const result = owner.begin('jobs.detail', 'request-4').run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: 'request_deadline_exceeded',
      context: { outcome: 'continuing' },
    });
    await vi.advanceTimersByTimeAsync(40);
    finish?.();
    await rejection;
    expect(shutdown).not.toHaveBeenCalled();
  });
});
