import { backendLog } from '#src/infra/backend-log.js';
import { EventEmitter } from 'node:events';
import * as syncFs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  classifyPsi,
  classifyMacPressure,
  combineHostPressure,
  createHostPressureMonitor,
} from '#src/infra/host-pressure.js';
import * as fs from 'node:fs/promises';
import type { TimePort } from '#src/infra/port-types.js';
import * as childProcess from 'node:child_process';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn(() => '2\n') }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'full avg10=12 avg60=0 avg300=0 total=1') }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});
const time: Pick<TimePort, 'monotonicNow' | 'setTimeout' | 'clearTimeout'> = {
  monotonicNow: () => BigInt(Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
const observeEnv = { get: () => 'observe' };
const psi = (value: string) =>
  `some avg10=99.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=${value} avg60=0.00 avg300=0.00 total=1\n`;

describe('host pressure', () => {
  it.each([undefined, 'observe'])('observes pressure when CORAL_HOST_PRESSURE is %s', async (mode) => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    vi.mocked(fs.readFile).mockResolvedValue(psi('12'));
    const monitor = createHostPressureMonitor('linux', time, {
      get: (key) => (key === 'CORAL_HOST_PRESSURE' ? mode : undefined),
    });
    await monitor.refresh();
    expect(monitor.read()).toEqual({ kind: 'pressured', signal: 'memory', reading: 'full avg10=12' });
    expect(warn).not.toHaveBeenCalled();
    await monitor.stop();
  });

  it.each(['linux', 'darwin'] as const)('ignores pressure honestly without %s probes', async (platform) => {
    vi.useFakeTimers();
    const monitor = createHostPressureMonitor(platform, time, {
      get: (key) => (key === 'CORAL_HOST_PRESSURE' ? 'ignore' : undefined),
    });
    expect(monitor.read()).toEqual({ kind: 'unobservable', reason: 'ignored' });
    await monitor.refresh();
    await monitor.refresh();
    expect(monitor.read()).toEqual({ kind: 'unobservable', reason: 'ignored' });
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await monitor.stop();
  });

  it.each(['invalid', '', 'IGNORE'])('warns once and observes for invalid CORAL_HOST_PRESSURE=%s', async (mode) => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    vi.mocked(fs.readFile).mockResolvedValue(psi('12'));
    const monitor = createHostPressureMonitor('linux', time, {
      get: (key) => (key === 'CORAL_HOST_PRESSURE' ? mode : undefined),
    });
    await monitor.refresh();
    expect(monitor.read().kind).toBe('pressured');
    await monitor.refresh();
    expect(monitor.read().kind).toBe('pressured');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Invalid CORAL_HOST_PRESSURE; expected "observe" or "ignore". Using "observe".',
    );
    await monitor.stop();
  });

  it.each(['memory', 'io'] as const)('uses full avg10 for %s', (signal) => {
    expect(classifyPsi(signal, psi('9.99'))).toEqual({ kind: 'calm' });
    expect(classifyPsi(signal, psi('10.00'))).toEqual({ kind: 'pressured', signal, reading: 'full avg10=10.00' });
  });
  it.each([null, '', 'some avg10=99', psi('NaN'), psi('-1'), psi('101'), 'full avg10=10', psi('10') + psi('10')])(
    'fails open for malformed/missing PSI %s',
    (text) => {
      expect(classifyPsi('memory', text).kind).toBe('unobservable');
    },
  );
  it.each([
    [0, 'calm'],
    [1, 'calm'],
    [2, 'pressured'],
    [4, 'pressured'],
  ])('maps sysctl %s', (level, kind) => {
    expect(classifyMacPressure(`${level}\n`).kind).toBe(kind);
  });
  it.each([null, '', 'unknown', '-1', '2junk'])('rejects invalid sysctl %s', (text) => {
    expect(classifyMacPressure(text).kind).toBe('unobservable');
  });
  it('lets either pressured signal decide despite unavailable evidence', () => {
    const unknown = classifyPsi('memory', null);
    const pressured = classifyPsi('io', psi('12'));
    expect(combineHostPressure([unknown, pressured])).toEqual(pressured);
    expect(combineHostPressure([pressured, unknown])).toEqual(pressured);
    expect(combineHostPressure([unknown, unknown]).kind).toBe('unobservable');
    expect(combineHostPressure([unknown, { kind: 'calm' }]).kind).toBe('unobservable');
    expect(combineHostPressure([{ kind: 'calm' }, { kind: 'calm' }]).kind).toBe('calm');
  });
  it.each(['linux', 'darwin'] as const)('reads the %s cache without synchronous or asynchronous IO', (platform) => {
    const monitor = createHostPressureMonitor(platform, time, observeEnv);
    expect(monitor.read().kind).toBe('unobservable');
    expect(monitor.read().kind).toBe('unobservable');
    expect(syncFs.readFileSync).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    void monitor.stop();
  });

  it('reads Linux asynchronously, combining missing memory with pressured IO', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (path) => {
      if (path === '/proc/pressure/io') return psi('12');
      throw new Error('ENOENT');
    });
    const monitor = createHostPressureMonitor('linux', time, observeEnv);
    expect(monitor.read().kind).toBe('unobservable');
    expect(fs.readFile).not.toHaveBeenCalled();
    await monitor.refresh();
    expect(monitor.read()).toEqual({ kind: 'pressured', signal: 'io', reading: 'full avg10=12' });
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    void monitor.stop();
  });

  it('expires observations at ten seconds without synchronous IO', async () => {
    vi.useFakeTimers();
    vi.mocked(fs.readFile).mockResolvedValue(psi('12'));
    const monitor = createHostPressureMonitor('linux', time, observeEnv);
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(9999);
    expect(monitor.read().kind).toBe('pressured');
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.read()).toEqual({ kind: 'unobservable', reason: 'pressure observation stale' });
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    void monitor.stop();
  });

  it('bounds stalled Linux reads and prevents overlapping probes even after timeout', async () => {
    vi.useFakeTimers();
    let complete = (_value: string) => {};
    vi.mocked(fs.readFile).mockReturnValue(
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
    );
    const monitor = createHostPressureMonitor('linux', time, observeEnv);
    const first = monitor.refresh();
    expect(monitor.refresh()).toBe(first);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(monitor.read()).toEqual({ kind: 'unobservable', reason: 'pressure probe timed out' });
    expect(monitor.refresh()).toBe(first);
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    void monitor.stop();
    complete(psi('99'));
    await Promise.resolve();
    expect(monitor.read().kind).toBe('unobservable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a pressured Linux signal when its sibling read stalls', async () => {
    vi.useFakeTimers();
    let complete = (_value: string) => {};
    vi.mocked(fs.readFile).mockImplementation((path) =>
      path === '/proc/pressure/memory'
        ? Promise.resolve(psi('12'))
        : new Promise<string>((resolve) => {
            complete = resolve;
          }),
    );
    const monitor = createHostPressureMonitor('linux', time, observeEnv);
    const pending = monitor.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(monitor.read()).toEqual({ kind: 'pressured', signal: 'memory', reading: 'full avg10=12' });
    void monitor.stop();
    complete(psi('0'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps sysctl ownership through close, independently of callback and refresh settlement', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(childProcess.execFile).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const monitor = createHostPressureMonitor('darwin', time, observeEnv);
    const pending = monitor.refresh();
    const call = vi.mocked(childProcess.execFile).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
      (error: Error | null, stdout: string) => void,
    ];
    expect(call[0]).toBe('/usr/sbin/sysctl');
    expect(call[1]).toEqual(['-n', 'kern.memorystatus_vm_pressure_level']);
    expect(call[2]).toEqual({ encoding: 'utf-8', maxBuffer: 1024 });
    call[3](null, '2\n');
    await Promise.resolve();
    expect(monitor.refresh()).toBe(pending);
    child.emit('close', 0, null);
    await pending;
    expect(monitor.read().kind).toBe('pressured');
    expect(vi.getTimerCount()).toBe(0);
    await monitor.stop();
  });

  it('releases deadline waiters but escalates and retains sysctl until close', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(childProcess.execFile).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const monitor = createHostPressureMonitor('darwin', time, observeEnv);
    const pending = monitor.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(monitor.read().kind).toBe('unobservable');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const callback = vi.mocked(childProcess.execFile).mock.calls[0]?.[3] as unknown as (
      error: Error,
      stdout: string,
    ) => void;
    callback(new Error('early callback'), '');
    await Promise.resolve();
    expect(monitor.refresh()).toBe(pending);
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const stopped = monitor.stop();
    child.emit('close', null, 'SIGKILL');
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });
});
