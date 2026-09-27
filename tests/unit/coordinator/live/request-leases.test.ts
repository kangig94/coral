import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestLeaseOwner, type RequestLeaseTiming } from '#src/coordinator/live/request-leases.js';
import { IdleTimer } from '#src/coordinator/live/idle.js';
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
  it('keeps a live provider job through abandonment and retires after its terminal outcome', async () => {
    vi.useFakeTimers();
    const time = createRealTimePort();
    const idleTimer = new IdleTimer({ time, timeoutMs: 1 });
    const retired = vi.fn();
    let jobRunning = true;
    let jobOutcome: 'running' | 'completed' = 'running';
    idleTimer.startWatching(() => !jobRunning, retired);
    setTimeout(() => {
      jobOutcome = 'completed';
      jobRunning = false;
    }, 61_000);
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time,
      timing,
      begin: () => idleTimer.beginRequest(),
      end: () => idleTimer.endRequest(),
    });
    const request = owner.begin('jobs.detail', 'provider-neighbor').run(() => new Promise<never>(() => {}));
    const rejected = expect(request).rejects.toMatchObject({ context: { outcome: 'continuing' } });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(idleTimer.inflightRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobOutcome).toBe('running');
    expect(retired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobOutcome).toBe('completed');
    expect(retired).toHaveBeenCalledWith('idle');
    idleTimer.stopWatching();
  });

  it('releases idle shutdown after an abandoned request ignores its cancellation signal', async () => {
    vi.useFakeTimers();
    const time = createRealTimePort();
    const idleTimer = new IdleTimer({ time, timeoutMs: 60_000 });
    const drained = vi.fn();
    idleTimer.startWatching(() => true, drained);
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time,
      begin: () => idleTimer.beginRequest(),
      end: () => idleTimer.endRequest(),
      timing,
    });
    const result = owner.begin('transport.kb.restart', 'abandoned-request').run(() => new Promise<never>(() => {}));
    const rejection = expect(result).rejects.toMatchObject({ code: 'request_deadline_exceeded' });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    idleTimer.requestDrain('idle');
    expect(drained).toHaveBeenCalledOnce();
    expect(idleTimer.inflightRequests).toBe(0);
    idleTimer.stopWatching();
  });

  it('retires passively after an abandoned request when no jobs are running', async () => {
    vi.useFakeTimers();
    const time = createRealTimePort();
    const idleTimer = new IdleTimer({ time, timeoutMs: 1 });
    const retired = vi.fn();
    idleTimer.startWatching(() => true, retired);
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time,
      timing,
      begin: () => idleTimer.beginRequest(),
      end: () => idleTimer.endRequest(),
    });
    const request = owner.begin('jobs.detail', 'passive-idle').run(() => new Promise<never>(() => {}));
    const rejected = expect(request).rejects.toMatchObject({ context: { outcome: 'continuing' } });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(retired).toHaveBeenCalledWith('idle');
    idleTimer.stopWatching();
  });

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
  it('lets a live provider job reach a terminal result beside a stalled unary request', async () => {
    vi.useFakeTimers();
    let finishJob!: (outcome: 'completed' | 'terminated') => void;
    const providerJob = new Promise<'completed' | 'terminated'>((resolve) => {
      finishJob = resolve;
      setTimeout(() => resolve('completed'), 60);
    });
    const leaseOptions = {
      newRecordId: randomUUID,
      begin: () => {},
      end: () => {},
      time: createRealTimePort(),
      timing,
      shutdown: () => finishJob('terminated'),
    };
    const owner = createRequestLeaseOwner(leaseOptions);
    const request = owner
      .begin('coordinator.recovery_quarantine.clear', 'request-provider')
      .run(() => new Promise<never>(() => {}));
    const rejection = expect(request).rejects.toMatchObject({ code: 'request_deadline_exceeded' });
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
    await expect(providerJob).resolves.toBe('completed');
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

  it('keeps the one-hour KB mutation allowance', async () => {
    vi.useFakeTimers();
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      begin: () => {},
      end: () => {},
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
    const owner = createRequestLeaseOwner({
      newRecordId: randomUUID,
      time: createRealTimePort(),
      begin: () => {},
      end,
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
});
