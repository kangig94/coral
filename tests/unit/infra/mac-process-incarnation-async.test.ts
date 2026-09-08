// Guardian and reaper process-incarnation probes must not block on either subprocess.

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type * as ProcessSupervision from '#src/infra/process-supervision.js';

const gracefulKillSpy = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('#src/infra/process-supervision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessSupervision>();
  return {
    ...actual,
    gracefulKill: vi.fn((...args: Parameters<typeof actual.gracefulKill>) => {
      gracefulKillSpy(...args);
      return actual.gracefulKill(...args);
    }),
  };
});

import { execFile } from 'node:child_process';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { gracefulKill } from '#src/infra/process-supervision.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import {
  createAsyncRecordedProcessObserver,
  observeProcessLiveness,
  PROCESS_INCARNATION_PROBE_TIMEOUT_MS,
  probeProcessIncarnationAsync,
  type ProcessIncarnation,
  processIncarnationProbeRegistrySize,
  type ProcessIncarnationProbeTerminator,
  snapshotProcessIncarnationProbeSubjects,
  terminateProcessIncarnationProbes,
} from '#src/infra/node-process.js';
import { createControlHolderAuthority, observeControlHolder } from '#src/provider-proxy/holder-lifecycle.js';

const mockedExecFile = vi.mocked(execFile);

const BOOT_SESSION = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const LSTART = 'Fri Nov 14 09:41:00 2025';
const EXEC_OPTIONS = expect.objectContaining({ encoding: 'utf-8' });
const PROBE_KILL_RUNTIME = {
  time: {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (handle: { unref?(): void } | null) => {
      if (handle !== null) clearTimeout(handle as NodeJS.Timeout);
    },
  },
};
const terminateProbeChild: ProcessIncarnationProbeTerminator = (child) => {
  gracefulKill(child as Parameters<typeof gracefulKill>[0], PROBE_KILL_RUNTIME, observeProcessLiveness);
};

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

class ProbeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid: number | undefined;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: NodeJS.Signals[] = [];
  private closed = false;

  constructor(options: { pid?: number } = { pid: process.pid }) {
    super();
    this.pid = options.pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => this.close(null, signal));
    return true;
  }

  close(
    code: number | null = this.signals.length === 0 ? 0 : null,
    signal: NodeJS.Signals | null = this.signals.at(-1) ?? null,
  ): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function complete(child: ProbeChild, callback: Callback, value: string | Error): void {
  queueMicrotask(() => {
    child.close();
    if (value instanceof Error) {
      callback(value, '', '');
    } else {
      callback(null, value, '');
    }
  });
}

function scriptDarwin(
  overrides: { bootSession?: string | Error; lstart?: string | Error } = {},
  children: ProbeChild[] = [],
): void {
  mockedExecFile.mockReset();
  mockedExecFile.mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
    const value = file === 'sysctl' ? (overrides.bootSession ?? BOOT_SESSION) : (overrides.lstart ?? LSTART);
    const child = new ProbeChild();
    children.push(child);
    complete(child, callback, value);
    return child as unknown as ChildProcess;
  }) as unknown as typeof execFile);
}

describe('darwin process incarnation (async)', () => {
  it('reports settled cleanup when no probe children are tracked', async () => {
    await expect(terminateProcessIncarnationProbes()).resolves.toEqual({ disposition: 'settled' });
  });

  it('reports the exact child whose cleanup attempt failed', async () => {
    const child = new ProbeChild({ pid: 4_242 });
    const failure = new Error('termination failed');
    let callback!: Callback;
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(((_file: string, _args: string[], _options: unknown, next: Callback) => {
      callback = next;
      return child as unknown as ChildProcess;
    }) as unknown as typeof execFile);

    const probe = probeProcessIncarnationAsync(
      4_242,
      () => {
        throw failure;
      },
      'darwin',
    );
    expect(snapshotProcessIncarnationProbeSubjects()).toEqual([{ pid: 4_242 }, { key: 'darwin:4242' }]);

    const cleanup = await terminateProcessIncarnationProbes();
    expect(cleanup).toMatchObject({
      disposition: 'hold',
      unsettled: [
        {
          child,
          pid: 4_242,
          reason: 'termination-failed',
          exit: 'child-close',
          error: failure,
        },
      ],
    });
    if (cleanup.disposition !== 'hold') throw new Error('failed cleanup unexpectedly settled');
    expect(processIncarnationProbeRegistrySize()).toBe(1);

    child.close();
    callback(new Error('terminated'), '', '');
    await cleanup.untilSettled;
    await expect(probe).resolves.toBeNull();
    expect(processIncarnationProbeRegistrySize()).toBe(0);
  });

  it('enrolls a lease between sequential children and prevents its next child from escaping cleanup', async () => {
    const child = new ProbeChild({ pid: 4_242 });
    let callback!: Callback;
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(((_file: string, _args: string[], _options: unknown, next: Callback) => {
      callback = next;
      return child as unknown as ChildProcess;
    }) as unknown as typeof execFile);

    const probe = probeProcessIncarnationAsync(4_242, terminateProbeChild, 'darwin');
    child.close();
    expect(processIncarnationProbeRegistrySize()).toBe(1);

    const cleanupDeadline = new AbortController();
    cleanupDeadline.abort();
    const cleanup = await terminateProcessIncarnationProbes(cleanupDeadline.signal);
    expect(cleanup).toEqual({
      disposition: 'hold',
      unsettled: [
        {
          child: null,
          pid: undefined,
          key: 'darwin:4242',
          reason: 'probe-unsettled',
          exit: 'probe-settlement',
        },
      ],
      untilSettled: expect.any(Promise),
    });
    if (cleanup.disposition !== 'hold') throw new Error('active lease cleanup unexpectedly settled');

    callback(null, BOOT_SESSION, '');
    await expect(probe).resolves.toBeNull();
    await cleanup.untilSettled;
    expect(mockedExecFile).toHaveBeenCalledOnce();
    expect(processIncarnationProbeRegistrySize()).toBe(0);
  });

  it('frames the start coordinate with the boot session id, and bounds both subprocess calls', async () => {
    scriptDarwin();

    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin')).resolves.toBe(
      `darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`,
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      1,
      'sysctl',
      ['-n', 'kern.bootsessionuuid'],
      EXEC_OPTIONS,
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      2,
      'ps',
      ['-o', 'lstart=', '-p', '4321'],
      EXEC_OPTIONS,
      expect.any(Function),
    );
    expect(mockedExecFile.mock.calls[0]?.[2]).not.toHaveProperty('signal');
    expect(mockedExecFile.mock.calls[1]?.[2]).not.toHaveProperty('signal');
    expect(processIncarnationProbeRegistrySize()).toBe(0);
  });

  it('owns a timed-out child through sanctioned escalation until close', async () => {
    vi.useFakeTimers();
    gracefulKillSpy.mockClear();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const children: ProbeChild[] = [];
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
      const child = new ProbeChild();
      children.push(child);
      if (file === 'sysctl') {
        setTimeout(() => {
          complete(child, callback, BOOT_SESSION);
        }, PROCESS_INCARNATION_PROBE_TIMEOUT_MS - 1);
      }
      return child as unknown as ChildProcess;
    }) as unknown as typeof execFile);

    try {
      const probe = probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin');
      await vi.advanceTimersByTimeAsync(PROCESS_INCARNATION_PROBE_TIMEOUT_MS - 1);

      expect(mockedExecFile).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      await expect(probe).resolves.toBeNull();
      expect(timeoutSpy).toHaveBeenCalledOnce();
      expect(timeoutSpy).toHaveBeenCalledWith(PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
      expect(gracefulKillSpy).toHaveBeenCalledOnce();
      expect(children[1]?.signals).toEqual(['SIGTERM']);
      expect(processIncarnationProbeRegistrySize()).toBe(1);

      await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);

      expect(children[1]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(processIncarnationProbeRegistrySize()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('lets shutdown retain an unobservable child without authorizing SIGKILL', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const child = new ProbeChild({});
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(() => child as unknown as ChildProcess);

    try {
      const probe = probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin');
      expect(processIncarnationProbeRegistrySize()).toBe(1);

      const cleanup = terminateProcessIncarnationProbes();
      expect(child.signals).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
      await expect(probe).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - PROCESS_INCARNATION_PROBE_TIMEOUT_MS);

      expect(child.signals).toEqual(['SIGTERM']);
      expect(processIncarnationProbeRegistrySize()).toBe(1);
      const disposition = await cleanup;
      expect(disposition).toMatchObject({
        disposition: 'hold',
        unsettled: [
          {
            child,
            pid: undefined,
            reason: 'close-unobserved',
            exit: 'child-close',
          },
        ],
      });
      if (disposition.disposition !== 'hold') throw new Error('held cleanup unexpectedly settled');

      child.close();
      await disposition.untilSettled;
      await expect(terminateProcessIncarnationProbes()).resolves.toEqual({ disposition: 'settled' });
      expect(child.signals).toEqual(['SIGTERM']);
      expect(processIncarnationProbeRegistrySize()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('returns unobservable for repeated target observations until the timed-out helper closes', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const child = new ProbeChild();
    const terminate = vi.fn();
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(() => child as unknown as ChildProcess);
    const observer = createAsyncRecordedProcessObserver({
      readIncarnation: (pid) => probeProcessIncarnationAsync(pid, terminate, 'darwin'),
      observeLiveness: () => 'alive',
    });
    const authority = createControlHolderAuthority();
    authority.install({
      controlEpoch: 1,
      holder: {
        instanceId: 'coordinator',
        pid: 4_321,
        incarnation: `darwin:${BOOT_SESSION}:0` as ProcessIncarnation,
      },
    });
    const clockScope: unique symbol = Symbol('probe-coalescing-clock');
    const clock = createMonotonicClock(clockScope, { readMilliseconds: () => 0n });
    const observe = () => observeControlHolder(authority, observer, clock);

    try {
      const first = observe();
      await vi.advanceTimersByTimeAsync(PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
      await expect(first).resolves.toMatchObject({ disposition: 'unobservable' });

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await expect(observe()).resolves.toMatchObject({ disposition: 'unobservable' });
      }

      expect(mockedExecFile).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
      expect(processIncarnationProbeRegistrySize()).toBe(1);

      child.close();
      expect(processIncarnationProbeRegistrySize()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reads the boot session every time rather than remembering it', async () => {
    scriptDarwin({ bootSession: new Error('sysctl unavailable') });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin')).resolves.toBeNull();

    scriptDarwin();
    await expect(
      probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin'),
      'one failed read must not blind every later one',
    ).resolves.toBe(`darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`);
  });

  it('separates two processes that share a pid and a displayed start second across a reboot', async () => {
    scriptDarwin();
    const before = await probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin');

    scriptDarwin({ bootSession: 'A1B2C3D4-0000-4000-8000-000000000000' });

    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin')).resolves.not.toBe(before);
  });

  it('is null rather than a guess when either half is unreadable, including a probe timeout', async () => {
    scriptDarwin({ lstart: '' });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin')).resolves.toBeNull();

    scriptDarwin({ lstart: 'not a date' });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin')).resolves.toBeNull();

    scriptDarwin({ lstart: new Error('command timed out') });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin')).resolves.toBeNull();
  });

  it('does not block the event loop while a subprocess is in flight', async () => {
    const pending: Array<{ callback: Callback; child: ProbeChild; value: string }> = [];
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
      const child = new ProbeChild();
      pending.push({ callback, child, value: file === 'sysctl' ? BOOT_SESSION : LSTART });
      return child as unknown as ChildProcess;
    }) as unknown as typeof execFile);

    let probeSettled = false;
    const probe = probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin').finally(() => {
      probeSettled = true;
    });
    const unrelatedWork = vi.fn();
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        unrelatedWork();
        resolve();
      });
    });

    expect(unrelatedWork).toHaveBeenCalledOnce();
    expect(probeSettled).toBe(false);
    expect(pending).toHaveLength(1);

    const bootSessionRead = pending.shift();
    if (bootSessionRead === undefined) throw new Error('boot session read did not start');
    complete(bootSessionRead.child, bootSessionRead.callback, bootSessionRead.value);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const processStartRead = pending.shift();
    if (processStartRead === undefined) throw new Error('process start read did not start');
    complete(processStartRead.child, processStartRead.callback, processStartRead.value);

    await expect(probe).resolves.toBe(`darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`);
  });
});
