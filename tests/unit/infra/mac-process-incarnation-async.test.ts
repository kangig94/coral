// The non-blocking sibling of `mac-process-incarnation.test.ts`: the same boot-session/`lstart` framing, run
// through `execFile`'s callback form instead of `execFileSync` so a guardian/reaper answering loop never
// blocks on either subprocess. Runs anywhere: the platform is a parameter and both subprocesses are mocked.

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';

import { PROCESS_INCARNATION_PROBE_TIMEOUT_MS, probeProcessIncarnationAsync } from '#src/infra/node-process.js';

const mockedExecFile = vi.mocked(execFile);

const BOOT_SESSION = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const LSTART = 'Fri Nov 14 09:41:00 2025';
const BOUNDED = expect.objectContaining({ signal: expect.any(AbortSignal) });

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

function scriptDarwin(overrides: { bootSession?: string | Error; lstart?: string | Error } = {}): void {
  mockedExecFile.mockReset();
  mockedExecFile.mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
    const value = file === 'sysctl' ? (overrides.bootSession ?? BOOT_SESSION) : (overrides.lstart ?? LSTART);
    if (value instanceof Error) {
      callback(value, '', '');
    } else {
      callback(null, value, '');
    }
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

describe('darwin process incarnation (async)', () => {
  it('frames the start coordinate with the boot session id, and bounds both subprocess calls', async () => {
    scriptDarwin();

    await expect(probeProcessIncarnationAsync(4321, 'darwin')).resolves.toBe(
      `darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`,
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      1,
      'sysctl',
      ['-n', 'kern.bootsessionuuid'],
      BOUNDED,
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      2,
      'ps',
      ['-o', 'lstart=', '-p', '4321'],
      BOUNDED,
      expect.any(Function),
    );
  });

  it('holds both sequential subprocesses to one end-to-end deadline', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(((
      file: string,
      _args: string[],
      options: { signal?: AbortSignal },
      callback: Callback,
    ) => {
      const signal = options.signal;
      if (signal === undefined) throw new Error('missing probe deadline');
      const rejectAborted = (): void => callback(new Error('command aborted'), '', '');
      if (signal.aborted) {
        rejectAborted();
        return {} as ReturnType<typeof execFile>;
      }
      signal.addEventListener('abort', rejectAborted, { once: true });
      if (file === 'sysctl') {
        setTimeout(() => {
          signal.removeEventListener('abort', rejectAborted);
          callback(null, BOOT_SESSION, '');
        }, PROCESS_INCARNATION_PROBE_TIMEOUT_MS - 1);
      }
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    try {
      const probe = probeProcessIncarnationAsync(4321, 'darwin');
      await vi.advanceTimersByTimeAsync(PROCESS_INCARNATION_PROBE_TIMEOUT_MS - 1);

      expect(mockedExecFile).toHaveBeenCalledTimes(2);
      expect((mockedExecFile.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal).toBe(
        (mockedExecFile.mock.calls[1]?.[2] as { signal?: AbortSignal }).signal,
      );

      await vi.advanceTimersByTimeAsync(1);
      await expect(probe).resolves.toBeNull();
      expect(timeoutSpy).toHaveBeenCalledOnce();
      expect(timeoutSpy).toHaveBeenCalledWith(PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reads the boot session every time rather than remembering it', async () => {
    scriptDarwin({ bootSession: new Error('sysctl unavailable') });
    await expect(probeProcessIncarnationAsync(4321, 'darwin')).resolves.toBeNull();

    scriptDarwin();
    await expect(
      probeProcessIncarnationAsync(4321, 'darwin'),
      'one failed read must not blind every later one',
    ).resolves.toBe(`darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`);
  });

  it('separates two processes that share a pid and a displayed start second across a reboot', async () => {
    scriptDarwin();
    const before = await probeProcessIncarnationAsync(4321, 'darwin');

    scriptDarwin({ bootSession: 'A1B2C3D4-0000-4000-8000-000000000000' });

    await expect(probeProcessIncarnationAsync(4321, 'darwin')).resolves.not.toBe(before);
  });

  it('is null rather than a guess when either half is unreadable, including a probe timeout', async () => {
    scriptDarwin({ lstart: '' });
    await expect(probeProcessIncarnationAsync(4321, 'darwin')).resolves.toBeNull();

    scriptDarwin({ lstart: 'not a date' });
    await expect(probeProcessIncarnationAsync(4321, 'darwin')).resolves.toBeNull();

    scriptDarwin({ lstart: new Error('command timed out') });
    await expect(probeProcessIncarnationAsync(4321, 'darwin')).resolves.toBeNull();
  });

  it('does not block the event loop while a subprocess is in flight', async () => {
    let ticked = 0;
    const interval = setInterval(() => {
      ticked += 1;
    }, 1);
    try {
      mockedExecFile.mockReset();
      mockedExecFile.mockImplementation(((file: string, _args: string[], _options: unknown, callback: Callback) => {
        setTimeout(() => {
          callback(null, file === 'sysctl' ? BOOT_SESSION : LSTART, '');
        }, 30);
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      await probeProcessIncarnationAsync(4321, 'darwin');

      expect(ticked, 'a synchronous probe would have starved every other timer for its whole duration').toBeGreaterThan(
        0,
      );
    } finally {
      clearInterval(interval);
    }
  });
});
