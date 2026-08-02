import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleTimer } from '#src/coordinator/live/idle.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { TimePort } from '#src/infra/port-types.js';

/**
 * Drives `IdleTimer`'s poll by hand. The timer is the top of its own stack in
 * production — nothing above it catches, and the process installs no
 * `uncaughtException` listener — so these tests invoke the captured interval
 * callback directly and assert on whether it throws.
 */
function createTimeHarness(): { time: TimePort; tick: () => void; advance: (ms: number) => void } {
  let nowMs = 1_000;
  let intervalFn: (() => void) | null = null;
  const time = {
    now: () => nowMs,
    sleep: async () => undefined,
    setTimeout: () => ({}),
    clearTimeout: () => undefined,
    setInterval: (fn: () => void) => {
      intervalFn = fn;
      return { unref: () => undefined };
    },
    clearInterval: () => {
      intervalFn = null;
    },
  } as unknown as TimePort;

  return {
    time,
    tick: () => {
      if (intervalFn === null) throw new Error('Expected startWatching to register an interval');
      intervalFn();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('IdleTimer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should retire when the predicate reports idle', () => {
    const harness = createTimeHarness();
    const timer = new IdleTimer({ time: harness.time, timeoutMs: 0 });
    const onIdle = vi.fn<(reason: string) => void>();

    timer.startWatching(() => true, onIdle);
    harness.advance(1);
    harness.tick();

    expect(onIdle).toHaveBeenCalledWith('idle');
  });

  it('should treat a throwing predicate as active instead of exiting the process', () => {
    const harness = createTimeHarness();
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const timer = new IdleTimer({ time: harness.time, timeoutMs: 0 });
    const onIdle = vi.fn<(reason: string) => void>();

    timer.startWatching(() => {
      throw new Error('projection row decode failed');
    }, onIdle);
    harness.advance(1);

    // The throw must not escape the poll: in production this frame has no handler
    // above it, so an escape exits a daemon that booted successfully.
    expect(() => harness.tick()).not.toThrow();
    expect(onIdle).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Idle probe failed — treating the daemon as active',
      expect.objectContaining({ message: 'projection row decode failed' }),
    );
  });

  it('should report a sticky predicate failure once per transition, not once per poll', () => {
    const harness = createTimeHarness();
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const timer = new IdleTimer({ time: harness.time, timeoutMs: 0 });
    let failing = true;

    timer.startWatching(() => {
      if (failing) throw new Error('still broken');
      return false;
    }, vi.fn());
    harness.advance(1);

    harness.tick();
    harness.tick();
    harness.tick();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Recovering and failing again is a new transition, so it reports again.
    failing = false;
    harness.tick();
    failing = true;
    harness.tick();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('should still honour an explicit drain request when the predicate throws', () => {
    const harness = createTimeHarness();
    vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const timer = new IdleTimer({ time: harness.time, timeoutMs: 0 });
    const onIdle = vi.fn<(reason: string) => void>();

    timer.startWatching(() => {
      throw new Error('projection row decode failed');
    }, onIdle);
    harness.advance(1);
    harness.tick();
    expect(onIdle).not.toHaveBeenCalled();

    // A broken probe must never make the daemon unkillable: drain bypasses it.
    timer.requestDrain('test-drain');

    expect(onIdle).toHaveBeenCalledWith('test-drain');
  });
});
