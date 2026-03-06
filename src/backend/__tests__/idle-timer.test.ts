import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_TIMEOUT_MS, IdleTimer } from '../idle-timer.js';

describe('IdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tracks inflight requests with beginRequest and endRequest', () => {
    const timer = new IdleTimer();

    timer.beginRequest();
    timer.beginRequest();
    expect(timer.inflightRequests).toBe(2);

    timer.endRequest();
    expect(timer.inflightRequests).toBe(1);

    timer.endRequest();
    expect(timer.inflightRequests).toBe(0);
  });

  it('does not decrement below zero', () => {
    const timer = new IdleTimer();

    timer.endRequest();
    timer.endRequest();

    expect(timer.inflightRequests).toBe(0);
  });

  it('fires idle when the timeout expires and conditions are met', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => true, onIdle);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1_000);

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not fire idle while requests are still inflight', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.beginRequest();
    timer.startWatching(() => true, onIdle);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1_000);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('stopWatching prevents idle from firing', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => true, onIdle);
    timer.stopWatching();

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1_000);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('does not fire idle when checkIdle returns false even after timeout elapses', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => false, onIdle);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 5_000);

    expect(onIdle).not.toHaveBeenCalled();
    timer.stopWatching();
  });

  it('fires idle when checkIdle transitions from false to true after the timeout', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();
    let canIdle = false;

    timer.startWatching(() => canIdle, onIdle);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 2_000);
    expect(onIdle).not.toHaveBeenCalled();

    canIdle = true;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onIdle).toHaveBeenCalledTimes(1);
    timer.stopWatching();
  });

  it('fires idle exactly once even when the interval ticks many times after the deadline', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => true, onIdle);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 60_000);

    expect(onIdle).toHaveBeenCalledTimes(1);
    timer.stopWatching();
  });

  it('allows a second idle cycle after beginRequest + endRequest resets the timer', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => true, onIdle);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    timer.beginRequest();
    timer.endRequest();

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 2_000);
    expect(onIdle).toHaveBeenCalledTimes(2);

    timer.stopWatching();
  });

  it('does not fire idle twice when startWatching is called twice', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => true, onIdle);
    timer.startWatching(() => true, onIdle);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 5_000);

    expect(onIdle).toHaveBeenCalledTimes(1);
    timer.stopWatching();
  });

  it('does not fire idle just before the timeout elapses', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.startWatching(() => true, onIdle);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);

    expect(onIdle).not.toHaveBeenCalled();
    timer.stopWatching();
  });

  it('resets the idle window when the last inflight request completes', async () => {
    const timer = new IdleTimer();
    const onIdle = vi.fn();

    timer.beginRequest();
    timer.startWatching(() => true, onIdle);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
    expect(onIdle).not.toHaveBeenCalled();

    timer.endRequest();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);

    timer.stopWatching();
  });

  it('inflightRequests stays at zero after many begin+end pairs', () => {
    const timer = new IdleTimer();

    for (let i = 0; i < 100; i++) { timer.beginRequest(); }
    for (let i = 0; i < 100; i++) { timer.endRequest(); }

    expect(timer.inflightRequests).toBe(0);
  });

  it('inflightRequests counts correctly with interleaved begin and end', () => {
    const timer = new IdleTimer();

    timer.beginRequest();
    timer.beginRequest();
    timer.endRequest();
    timer.beginRequest();
    timer.endRequest();
    timer.endRequest();

    expect(timer.inflightRequests).toBe(0);
  });

  it('stopWatching called multiple times does not throw', () => {
    const timer = new IdleTimer();
    expect(() => {
      timer.stopWatching();
      timer.stopWatching();
      timer.stopWatching();
    }).not.toThrow();
  });
});
