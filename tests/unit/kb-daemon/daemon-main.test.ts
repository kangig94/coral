import { describe, expect, it, vi } from 'vitest';
import { isProcessAlive, resolveKbDaemonParentPid, startKbDaemonParentWatchdog } from '#src/kb-daemon/daemon-main.js';

describe('KB daemon main parent watchdog', () => {
  it('parses a valid parent pid and rejects invalid or self pids', () => {
    expect(resolveKbDaemonParentPid('123', 456)).toBe(123);
    expect(resolveKbDaemonParentPid(' 123 ', 456)).toBe(123);
    expect(resolveKbDaemonParentPid(undefined, 456)).toBeNull();
    expect(resolveKbDaemonParentPid('', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('0', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('-1', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('12.5', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('1e3', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('0x10', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('abc', 456)).toBeNull();
    expect(resolveKbDaemonParentPid('456', 456)).toBeNull();
  });

  it('treats EPERM from process.kill(pid, 0) as alive', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce((() => true) as typeof process.kill);
    expect(isProcessAlive(123)).toBe(true);
    expect(kill).toHaveBeenLastCalledWith(123, 0);

    const permissionError = new Error('permission denied') as NodeJS.ErrnoException;
    permissionError.code = 'EPERM';
    kill.mockImplementationOnce((() => {
      throw permissionError;
    }) as typeof process.kill);
    expect(isProcessAlive(124)).toBe(true);

    const missingError = new Error('missing') as NodeJS.ErrnoException;
    missingError.code = 'ESRCH';
    kill.mockImplementationOnce((() => {
      throw missingError;
    }) as typeof process.kill);
    expect(isProcessAlive(125)).toBe(false);

    kill.mockRestore();
  });

  it('does not start a watchdog when no parent pid is available', () => {
    const setIntervalFn = vi.fn();

    expect(
      startKbDaemonParentWatchdog({
        parentPid: null,
        setIntervalFn,
        onParentExit: vi.fn(),
      }),
    ).toBeNull();
    expect(
      startKbDaemonParentWatchdog({
        parentPid: 0,
        setIntervalFn,
        onParentExit: vi.fn(),
      }),
    ).toBeNull();
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it('keeps the watchdog alive while the original parent is still present', () => {
    let tick: (() => void) | undefined;
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearIntervalFn = vi.fn();
    const onParentExit = vi.fn();

    const watchdog = startKbDaemonParentWatchdog({
      parentPid: 123,
      intervalMs: 25,
      isAlive: () => true,
      getCurrentParentPid: () => 123,
      setIntervalFn: (fn, ms) => {
        tick = fn;
        expect(ms).toBe(25);
        return handle;
      },
      clearIntervalFn,
      onParentExit,
    });

    expect(watchdog).toBe(handle);
    expect(handle.unref).toHaveBeenCalledTimes(1);
    tick?.();
    expect(clearIntervalFn).not.toHaveBeenCalled();
    expect(onParentExit).not.toHaveBeenCalled();
  });

  it('stops the daemon when the parent pid is no longer the direct parent', () => {
    let tick: (() => void) | undefined;
    let currentParentPid = 123;
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const clearIntervalFn = vi.fn();
    const onParentExit = vi.fn();

    startKbDaemonParentWatchdog({
      parentPid: 123,
      isAlive: () => true,
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
      isAlive: () => alive,
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
