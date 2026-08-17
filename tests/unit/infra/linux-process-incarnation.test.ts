// The Linux half of process identity, which had no test of its own while the Darwin half did.
//
// The gap was not cosmetic. Deleting the boot frame — `linux:${startTicks}` instead of
// `linux:${bootId}:${startTicks}` — left the whole suite green, and start ticks alone are comparable only
// *within* one boot. After a reboot the pid space restarts at the low numbers a stale record is most likely
// to name, and a fresh process can genuinely reproduce a recorded `pid=1234, ticks=500`. That is a false
// match, on the platform where a match authorizes SIGKILL.
//
// The second thing pinned here is the field walk. `/proc/<pid>/stat` puts the executable name in field 2,
// parenthesised, and that name may itself contain spaces and parentheses — so fields are counted from the
// *last* `)`, never split from the start of the line. A comm of `(sh -c "x)")` is not exotic; it is what a
// shell wrapper looks like.

import type * as NodeFs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

import { probeProcessIncarnation } from '#src/infra/node-process.js';

const mockedRead = vi.mocked(readFileSync);

const BOOT_ID = '9f2a1c44-1f3e-4a8b-9d31-6c0f2b7e5a10';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const START_TICKS = '774219';

/**
 * A `/proc/<pid>/stat` line. Field 22 (1-based) is `starttime`; the probe reaches it as index 19 counting
 * from the first field after the comm, so the filler between them is load-bearing and stays explicit.
 */
function statLine(options: { comm?: string; startTicks?: string } = {}): string {
  const afterComm = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 100))];
  return `4321 (${options.comm ?? 'node'}) ${afterComm.join(' ')} ${options.startTicks ?? START_TICKS} 0 0\n`;
}

function scriptLinux(overrides: { bootId?: string | Error; stat?: string | Error } = {}): void {
  mockedRead.mockReset();
  mockedRead.mockImplementation(((path: string) => {
    const value = path === BOOT_ID_PATH ? (overrides.bootId ?? BOOT_ID) : (overrides.stat ?? statLine());
    if (value instanceof Error) throw value;
    return value;
  }) as unknown as typeof readFileSync);
}

describe('linux process incarnation', () => {
  it('frames the start ticks with the boot id', () => {
    scriptLinux();

    expect(probeProcessIncarnation(4321, 'linux')).toBe(`linux:${BOOT_ID}:${START_TICKS}`);
    expect(mockedRead).toHaveBeenCalledWith(BOOT_ID_PATH, 'utf-8');
    expect(mockedRead).toHaveBeenCalledWith('/proc/4321/stat', 'utf-8');
  });

  it('separates two processes that share a pid and a start tick across a reboot', () => {
    scriptLinux();
    const before = probeProcessIncarnation(4321, 'linux');

    // Identical pid, identical start ticks — which is the *likely* case after a reboot, not a contrived one,
    // because ticks are counted from boot and the pid space restarts at the same low numbers.
    scriptLinux({ bootId: '00000000-0000-4000-8000-111111111111' });

    expect(probeProcessIncarnation(4321, 'linux')).not.toBe(before);
  });

  it('reads the boot id every time rather than remembering it', () => {
    scriptLinux({ bootId: new Error('EACCES') });
    expect(probeProcessIncarnation(4321, 'linux')).toBeNull();

    scriptLinux();
    expect(probeProcessIncarnation(4321, 'linux'), 'one failed read must not blind every later one').toBe(
      `linux:${BOOT_ID}:${START_TICKS}`,
    );
  });

  it('counts fields from the last parenthesis, so a comm with spaces and parentheses still parses', () => {
    scriptLinux({ stat: statLine({ comm: 'sh -c (x) y' }) });

    expect(probeProcessIncarnation(4321, 'linux')).toBe(`linux:${BOOT_ID}:${START_TICKS}`);
  });

  it('is null rather than a guess when either half is unreadable', () => {
    scriptLinux({ bootId: '' });
    expect(probeProcessIncarnation(4321, 'linux'), 'an empty boot id is not a frame').toBeNull();

    scriptLinux({ stat: new Error('ENOENT') });
    expect(probeProcessIncarnation(4321, 'linux'), 'an absent process is not an identity').toBeNull();

    scriptLinux({ stat: 'no parenthesis here at all' });
    expect(probeProcessIncarnation(4321, 'linux'), 'a stat line with no comm cannot be walked').toBeNull();

    scriptLinux({ stat: statLine({ startTicks: 'not-a-number' }) });
    expect(probeProcessIncarnation(4321, 'linux'), 'a non-numeric start tick is refused, not coerced').toBeNull();
  });

  it('refuses a pid that is not a positive integer before reading anything', () => {
    scriptLinux();

    expect(probeProcessIncarnation(0, 'linux')).toBeNull();
    expect(probeProcessIncarnation(-1, 'linux')).toBeNull();
    expect(probeProcessIncarnation(1.5, 'linux')).toBeNull();
    expect(mockedRead).not.toHaveBeenCalled();
  });
});
