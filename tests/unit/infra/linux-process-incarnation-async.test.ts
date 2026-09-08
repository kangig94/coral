import type * as NodeFsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';

import { PROCESS_INCARNATION_PROBE_TIMEOUT_MS, probeProcessIncarnationAsync } from '#src/infra/node-process.js';

const mockedRead = vi.mocked(readFile);
const terminateProbeChild = vi.fn();

const BOOT_ID = '9f2a1c44-1f3e-4a8b-9d31-6c0f2b7e5a10';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const START_TICKS = '774219';

function statLine(options: { comm?: string; startTicks?: string } = {}): string {
  const afterComm = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 100))];
  return `4321 (${options.comm ?? 'node'}) ${afterComm.join(' ')} ${options.startTicks ?? START_TICKS} 0 0\n`;
}

function scriptLinux(overrides: { bootId?: string | Error; stat?: string | Error } = {}): void {
  mockedRead.mockReset();
  mockedRead.mockImplementation((async (path: string) => {
    const value = path === BOOT_ID_PATH ? (overrides.bootId ?? BOOT_ID) : (overrides.stat ?? statLine());
    if (value instanceof Error) throw value;
    return value;
  }) as unknown as typeof readFile);
}

describe('linux process incarnation (async)', () => {
  it('frames the start ticks with the boot id, without blocking the caller', async () => {
    let settleBootId!: () => void;
    let settleStartTicks!: () => void;
    mockedRead.mockReset();
    mockedRead.mockImplementation(
      ((path: string) =>
        new Promise<string>((resolve) => {
          if (path === BOOT_ID_PATH) {
            settleBootId = () => resolve(BOOT_ID);
          } else {
            settleStartTicks = () => resolve(statLine());
          }
        })) as unknown as typeof readFile,
    );

    let probeSettled = false;
    const probe = probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux').finally(() => {
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
    expect(mockedRead).toHaveBeenCalledTimes(1);

    settleBootId();
    await vi.waitFor(() => expect(mockedRead).toHaveBeenCalledTimes(2));
    settleStartTicks();

    await expect(probe).resolves.toBe(`linux:${BOOT_ID}:${START_TICKS}`);
    expect(mockedRead).toHaveBeenCalledWith(BOOT_ID_PATH, expect.objectContaining({ encoding: 'utf-8' }));
    expect(mockedRead).toHaveBeenCalledWith('/proc/4321/stat', expect.objectContaining({ encoding: 'utf-8' }));
  });

  it('holds both sequential reads to one end-to-end deadline', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    mockedRead.mockReset();
    mockedRead.mockImplementation(((path: string, options: { signal?: AbortSignal }) => {
      const signal = options.signal;
      if (signal === undefined) throw new Error('missing probe deadline');
      return new Promise<string>((resolve, reject) => {
        const rejectAborted = (): void => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener('abort', rejectAborted, { once: true });
        if (path === BOOT_ID_PATH) {
          setTimeout(() => {
            signal.removeEventListener('abort', rejectAborted);
            resolve(BOOT_ID);
          }, PROCESS_INCARNATION_PROBE_TIMEOUT_MS - 1);
        }
      });
    }) as unknown as typeof readFile);

    try {
      const probe = probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux');
      await vi.advanceTimersByTimeAsync(PROCESS_INCARNATION_PROBE_TIMEOUT_MS - 1);

      expect(mockedRead).toHaveBeenCalledTimes(2);
      expect((mockedRead.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal).toBe(
        (mockedRead.mock.calls[1]?.[1] as { signal?: AbortSignal }).signal,
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

  it('separates two processes that share a pid and a start tick across a reboot', async () => {
    scriptLinux();
    const before = await probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux');

    scriptLinux({ bootId: '00000000-0000-4000-8000-111111111111' });

    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux')).resolves.not.toBe(before);
  });

  it('reads the boot id every time rather than remembering it', async () => {
    scriptLinux({ bootId: new Error('EACCES') });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux')).resolves.toBeNull();

    scriptLinux();
    await expect(
      probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux'),
      'one failed read must not blind every later one',
    ).resolves.toBe(`linux:${BOOT_ID}:${START_TICKS}`);
  });

  it('is null, never a throw, when the stat read fails or times out', async () => {
    scriptLinux({ stat: new Error('ENOENT') });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux')).resolves.toBeNull();

    // What a `signal: AbortSignal.timeout(...)` abort actually rejects with in production; the read's own
    // `catch` treats it exactly like any other read failure.
    const timedOut = new Error('The operation was aborted.');
    timedOut.name = 'AbortError';
    scriptLinux({ stat: timedOut });
    await expect(probeProcessIncarnationAsync(4321, terminateProbeChild, 'linux')).resolves.toBeNull();
  });
});
