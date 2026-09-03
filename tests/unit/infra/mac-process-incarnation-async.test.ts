// The non-blocking sibling of `mac-process-incarnation.test.ts`: the same boot-session/`lstart` framing, run
// through `execFile`'s callback form instead of `execFileSync` so a guardian/reaper answering loop never
// blocks on either subprocess. Runs anywhere: the platform is a parameter and both subprocesses are mocked.

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
      actual.gracefulKill(...args);
    }),
  };
});

import { execFile } from 'node:child_process';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { gracefulKill } from '#src/infra/process-supervision.js';
import {
  observeProcessLiveness,
  PROCESS_INCARNATION_PROBE_TIMEOUT_MS,
  probeProcessIncarnationAsync,
  processIncarnationProbeRegistrySize,
  type ProcessIncarnationProbeTerminator,
  terminateProcessIncarnationProbes,
} from '#src/infra/node-process.js';

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
    if (signal === 'SIGKILL') queueMicrotask(() => this.close());
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', null, null);
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

      terminateProcessIncarnationProbes();
      expect(child.signals).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
      await expect(probe).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - PROCESS_INCARNATION_PROBE_TIMEOUT_MS);

      expect(child.signals).toEqual(['SIGTERM']);
      expect(processIncarnationProbeRegistrySize()).toBe(1);

      terminateProcessIncarnationProbes();
      expect(child.signals).toEqual(['SIGTERM', 'SIGTERM']);

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
    let ticked = 0;
    const interval = setInterval(() => {
      ticked += 1;
    }, 1);
    try {
      mockedExecFile.mockReset();
      mockedExecFile.mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
        const child = new ProbeChild();
        setTimeout(() => {
          complete(child, callback, file === 'sysctl' ? BOOT_SESSION : LSTART);
        }, 30);
        return child as unknown as ChildProcess;
      }) as unknown as typeof execFile);

      await probeProcessIncarnationAsync(4321, terminateProbeChild, 'darwin');

      expect(ticked, 'a synchronous probe would have starved every other timer for its whole duration').toBeGreaterThan(
        0,
      );
    } finally {
      clearInterval(interval);
    }
  });
});
