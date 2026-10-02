import { describe, expect, it, vi } from 'vitest';
import { createKbDaemonTerminalWindowAuthority } from '#src/kb-daemon/daemon-main.js';

describe('KB daemon terminal window', () => {
  const scheduler = (): {
    scheduled: { ms: number; fire: () => void; unref: ReturnType<typeof vi.fn> }[];
    setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  } => {
    const scheduled: { ms: number; fire: () => void; unref: ReturnType<typeof vi.fn> }[] = [];
    return {
      scheduled,
      setTimeoutFn: (fn, ms) => {
        const unref = vi.fn();
        scheduled.push({ ms, fire: fn, unref });
        return { unref } as unknown as ReturnType<typeof setTimeout>;
      },
    };
  };

  /**
   * The load-bearing one. Every stop trigger calls `open`, so a window that re-armed per call would let a
   * teardown that is already overrunning postpone its own deadline indefinitely — the same shape as the
   * `settled` latch this window exists to escape, only inverted.
   */
  it('gives a later stop request the deadline already running, never a fresh one', () => {
    const { scheduled, setTimeoutFn } = scheduler();
    const exit = vi.fn();

    const authority = createKbDaemonTerminalWindowAuthority({
      disposeAbortMs: 40,
      terminalExitMs: 100,
      setTimeoutFn,
      exit,
      log: vi.fn(),
    });

    const first = authority.open(0);
    const second = authority.open(3);

    expect(second).toBe(first);
    expect(scheduled).toHaveLength(2);

    scheduled[1].fire();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
