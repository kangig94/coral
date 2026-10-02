import { describe, expect, it, vi } from 'vitest';
import {
  createKbDaemonTerminalWindowAuthority,
  handleKbDaemonExpansionRpcRequest,
  startKbDaemonParentWatchdog,
} from '#src/kb-daemon/daemon-main.js';

describe('KB daemon main parent watchdog', () => {
  it('stops the daemon when the parent pid is no longer the direct parent', () => {
    let tick: (() => void) | undefined;
    let currentParentPid = 123;
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearIntervalFn = vi.fn();
    const onParentExit = vi.fn();

    startKbDaemonParentWatchdog({
      parentPid: 123,
      observeLiveness: () => 'alive' as const,
      getCurrentParentPid: () => currentParentPid,
      setIntervalFn: (fn) => {
        tick = fn;
        return handle;
      },
      clearIntervalFn,
      onParentExit,
    });

    currentParentPid = 1;
    tick?.();
    tick?.();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
    expect(onParentExit).toHaveBeenCalledTimes(1);
  });

  it('stops the daemon when the parent process no longer exists', () => {
    let tick: (() => void) | undefined;
    let alive = true;
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearIntervalFn = vi.fn();
    const onParentExit = vi.fn();

    startKbDaemonParentWatchdog({
      parentPid: 123,
      observeLiveness: () => (alive ? 'alive' : 'absent'),
      getCurrentParentPid: () => 123,
      setIntervalFn: (fn) => {
        tick = fn;
        return handle;
      },
      clearIntervalFn,
      onParentExit,
    });

    alive = false;
    tick?.();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(onParentExit).toHaveBeenCalledTimes(1);
  });
});

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

  it('aborts cooperative disposal first, then exits the process', () => {
    const { scheduled, setTimeoutFn } = scheduler();
    const exit = vi.fn();
    const log = vi.fn();

    const window = createKbDaemonTerminalWindowAuthority({
      disposeAbortMs: 40,
      terminalExitMs: 100,
      setTimeoutFn,
      exit,
      log,
    }).open(7);

    expect(scheduled.map((entry) => entry.ms)).toEqual([40, 100]);
    expect(window.signal.aborted).toBe(false);

    scheduled[0].fire();
    expect(window.signal.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    scheduled[1].fire();
    expect(exit).toHaveBeenCalledWith(7);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('100ms'));
  });

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

describe('KB daemon expansion RPC authorization', () => {
  it('calls the runtime host for principals with expansion:manage', async () => {
    const expansionRpc = vi.fn(async () => ({ ok: true as const, data: { status: 'equipped' } }));
    const request = {
      method: 'equipExpansion' as const,
      args: { name: 'vector' },
      ctx: {
        principal: {
          subject: 'operator' as const,
          binding: { kind: 'unbound' as const },
          attenuatedCaps: ['liveness', 'expansion:manage'] as const,
        },
      },
    };

    await expect(handleKbDaemonExpansionRpcRequest(request, { expansionRpc })).resolves.toEqual({
      ok: true,
      data: { status: 'equipped' },
    });
    expect(expansionRpc).toHaveBeenCalledWith(request);
  });
});
