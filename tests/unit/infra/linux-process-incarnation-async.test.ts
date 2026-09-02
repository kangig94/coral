// The non-blocking sibling of `linux-process-incarnation.test.ts`: the same boot-id/start-tick framing, read
// through `fs.promises.readFile` instead of `readFileSync` so a guardian/reaper answering loop never blocks
// on it. Pins the same boot-frame and field-walk properties the sync test does, plus the bound each read is
// held to.

import type * as NodeFsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';

import { probeProcessIncarnationAsync } from '#src/infra/node-process.js';

const mockedRead = vi.mocked(readFile);

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
    scriptLinux();

    await expect(probeProcessIncarnationAsync(4321, 'linux')).resolves.toBe(`linux:${BOOT_ID}:${START_TICKS}`);
    expect(mockedRead).toHaveBeenCalledWith(BOOT_ID_PATH, expect.objectContaining({ encoding: 'utf-8' }));
    expect(mockedRead).toHaveBeenCalledWith('/proc/4321/stat', expect.objectContaining({ encoding: 'utf-8' }));
  });

  it('bounds each read with a fresh abort signal, one per read rather than one shared', async () => {
    scriptLinux();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await probeProcessIncarnationAsync(4321, 'linux');

    // Two reads (boot id, then stat), each minting its own bound — not one signal reused across both, which
    // could already be spent by the time the second read starts.
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 2_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 2_000);
    for (const call of mockedRead.mock.calls) {
      expect((call[1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    }
    timeoutSpy.mockRestore();
  });

  it('separates two processes that share a pid and a start tick across a reboot', async () => {
    scriptLinux();
    const before = await probeProcessIncarnationAsync(4321, 'linux');

    scriptLinux({ bootId: '00000000-0000-4000-8000-111111111111' });

    await expect(probeProcessIncarnationAsync(4321, 'linux')).resolves.not.toBe(before);
  });

  it('reads the boot id every time rather than remembering it', async () => {
    scriptLinux({ bootId: new Error('EACCES') });
    await expect(probeProcessIncarnationAsync(4321, 'linux')).resolves.toBeNull();

    scriptLinux();
    await expect(
      probeProcessIncarnationAsync(4321, 'linux'),
      'one failed read must not blind every later one',
    ).resolves.toBe(`linux:${BOOT_ID}:${START_TICKS}`);
  });

  it('is null, never a throw, when the stat read fails or times out', async () => {
    scriptLinux({ stat: new Error('ENOENT') });
    await expect(probeProcessIncarnationAsync(4321, 'linux')).resolves.toBeNull();

    // What a `signal: AbortSignal.timeout(...)` abort actually rejects with in production; the read's own
    // `catch` treats it exactly like any other read failure.
    const timedOut = new Error('The operation was aborted.');
    timedOut.name = 'AbortError';
    scriptLinux({ stat: timedOut });
    await expect(probeProcessIncarnationAsync(4321, 'linux')).resolves.toBeNull();
  });
});
