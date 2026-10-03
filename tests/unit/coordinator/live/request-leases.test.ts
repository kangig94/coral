import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestLeaseOwner, type RequestLeaseTiming } from '#src/coordinator/live/request-leases.js';

import { IdleTimer } from '#src/coordinator/live/idle.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

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
  it('reconciles an abandoned request to its terminal outcome', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let inflight = 0;
    const recorded = vi.fn();
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time: createRealTimePort(),
      timing,
      begin: () => {
        inflight += 1;
      },
      end: () => {
        inflight -= 1;
      },
      abandon: recorded,
    });
    const request = owner.begin('jobs.detail', 'request-late', { jobId: 'job-1' }).run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const rejected = expect(request).rejects.toMatchObject({ context: { outcome: 'continuing' } });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(recorded).toHaveBeenCalledWith({
      recordId: expect.any(String),
      method: 'jobs.detail',
      requestId: 'request-late',
      startedAt: expect.any(String),
      outcome: 'continuing',
      identity: { jobId: 'job-1' },
    });
    expect(inflight).toBe(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(inflight).toBe(0);
    expect(recorded).toHaveBeenLastCalledWith({
      recordId: expect.any(String),
      method: 'jobs.detail',
      requestId: 'request-late',
      startedAt: expect.any(String),
      outcome: 'completed',
      identity: { jobId: 'job-1' },
    });
  });

  it('aborts never-settling unary work without ending unrelated coordinator execution', async () => {
    vi.useFakeTimers();
    let inflight = 0;
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      begin: () => {
        inflight += 1;
      },
      end: () => {
        inflight -= 1;
      },
      abandon: vi.fn(),
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
        outcome: 'continuing',
      },
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(signals[0]?.aborted).toBe(true);
    expect(inflight).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(inflight).toBe(0);
  });

  it('reports cancelled when the request owner obeys the abort', async () => {
    vi.useFakeTimers();
    const end = vi.fn();
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time: createRealTimePort(),
      begin: () => {},
      end,
      abandon: vi.fn(),
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
  });

  it('returns the completed outcome when work settles during the deadline grace', async () => {
    vi.useFakeTimers();
    const recorded = vi.fn();
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time: createRealTimePort(),
      begin: () => {},
      end: () => {},
      abandon: recorded,
      timing,
    });
    let finish: ((value: string) => void) | undefined;
    const result = owner.begin('jobs.detail', 'request-4').run(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const completion = expect(result).resolves.toBe('accepted');
    await vi.advanceTimersByTimeAsync(40);
    finish?.('accepted');
    await completion;
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed' }));
  });

  it('keeps ownership when continuing status cannot be recorded, then releases after a successful retry', async () => {
    vi.useFakeTimers();
    let inflight = 0;
    let writes = 0;
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time: createRealTimePort(),
      timing: { ...timing, checkMs: 3 },
      begin: () => {
        inflight += 1;
      },
      end: () => {
        inflight -= 1;
      },
      abandon: () => {
        if (++writes === 1) throw new Error('disk full');
      },
    });
    const request = owner.begin('jobs.detail', 'record-failure').run(() => new Promise<never>(() => {}));
    const rejected = expect(request).rejects.toMatchObject({
      code: 'request_deadline_exceeded',
      context: { outcome: 'recording_failed' },
    });
    await vi.advanceTimersByTimeAsync(52);
    await rejected;
    expect(inflight).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(writes).toBe(2);
    expect(inflight).toBe(0);
  });
});

it.each([0, -3_600_000, 3_600_000])('drains an abandoned request despite a wall step of %s ms', async (step) => {
  const time = new VirtualTime();
  let offset = 0;
  const clock = Object.assign(time, { now: () => Number(time.monotonicNow()) + offset });
  const idle = new IdleTimer({ time: clock });
  const drained = vi.fn();
  idle.startWatching(() => false, drained);
  const owner = createRequestLeaseOwner({
    time: clock,
    begin: () => idle.beginRequest(),
    end: () => idle.endRequest(),
    newRecordId: () => 'clock-request',
    abandon: vi.fn(),
  });
  let signal: AbortSignal | undefined;
  const request = owner.begin('jobs.list', 'clock-request').run((owned) => {
    signal = owned;
    return new Promise<never>(() => {});
  });
  const rejected = expect(request).rejects.toMatchObject({ code: 'request_deadline_exceeded' });
  await flushMicrotasks();
  time.tick(10_000);
  idle.requestDrain('replaced');
  offset = step;
  time.tick(60_000);
  await flushMicrotasks();
  expect(signal?.aborted).toBe(true);
  expect(idle.inflightRequests).toBe(0);
  expect(drained).toHaveBeenCalledOnce();
  await rejected;
  idle.stopWatching();
});

it.each(['kb.source.create', 'kb.reindex'])('preserves the longer lease for %s', async (method) => {
  const time = new VirtualTime();
  const ended = vi.fn();
  const owner = createRequestLeaseOwner({
    time,
    timing,
    begin: vi.fn(),
    end: ended,
    abandon: vi.fn(),
    newRecordId: () => method,
  });
  let signal: AbortSignal | undefined;
  const request = owner.begin(method, method).run((owned) => {
    signal = owned;
    return new Promise<never>(() => {});
  });
  const rejected = expect(request).rejects.toMatchObject({ code: 'request_deadline_exceeded' });
  await flushMicrotasks();
  time.tick(50);
  expect(signal?.aborted).toBe(false);
  expect(ended).not.toHaveBeenCalled();
  time.tick(360);
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(ended).toHaveBeenCalledOnce();
});

it('allows a shared scheduling freeze without treating wall steps as a freeze', async () => {
  const time = new VirtualTime();
  const monotonic = time.monotonicNow.bind(time);
  let freeze = 0n;
  Object.assign(time, { monotonicNow: () => monotonic() + freeze });
  const ended = vi.fn();
  const owner = createRequestLeaseOwner({
    time,
    timing,
    begin: vi.fn(),
    end: ended,
    abandon: vi.fn(),
    newRecordId: () => 'freeze',
  });
  let signal: AbortSignal | undefined;
  const request = owner.begin('jobs.list', 'freeze').run((owned) => {
    signal = owned;
    return new Promise<never>(() => {});
  });
  const rejected = expect(request).rejects.toMatchObject({ code: 'request_deadline_exceeded' });
  await flushMicrotasks();
  time.tick(10);
  freeze = 1_000n;
  time.tick(30);
  expect(signal?.aborted).toBe(false);
  time.tick(2);
  expect(signal?.aborted).toBe(true);
  time.tick(10);
  await rejected;
  expect(ended).toHaveBeenCalledOnce();
});
