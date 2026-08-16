// The macOS half of process identity, which had no test at all while it authorized signals.
//
// It is the same rule as Linux's — a per-boot frame plus a per-process start coordinate — but assembled from
// two `execFileSync` calls instead of two file reads, and the frame is the part that has been wrong twice.
// `kern.boottime` was the first attempt and is derived from calendar time, so XNU moves it when the clock is
// set; a frame that shifts with the clock cannot frame a wall-clock start time. `kern.bootsessionuuid` is
// minted once per boot and moves for nothing.
//
// Runs anywhere: the platform is a parameter and the two subprocesses are mocked, so a Linux host exercises
// the Darwin path exactly as a Mac would.

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';

import { probeProcessIncarnation } from '#src/infra/node-process.js';

const mockedExec = vi.mocked(execFileSync);

const BOOT_SESSION = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const LSTART = 'Fri Nov 14 09:41:00 2025';

function scriptDarwin(overrides: { bootSession?: string | Error; lstart?: string | Error } = {}): void {
  mockedExec.mockReset();
  mockedExec.mockImplementation(((file: string) => {
    const value = file === 'sysctl' ? (overrides.bootSession ?? BOOT_SESSION) : (overrides.lstart ?? LSTART);
    if (value instanceof Error) throw value;
    return value;
  }) as unknown as typeof execFileSync);
}

describe('darwin process incarnation', () => {
  it('frames the start coordinate with the boot session id', () => {
    scriptDarwin();

    expect(probeProcessIncarnation(4321, 'darwin')).toBe(`darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`);
    expect(mockedExec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.bootsessionuuid'], expect.anything());
    expect(mockedExec).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '4321'], expect.anything());
  });

  it('reads the boot session every time rather than remembering it', () => {
    // A cache here has to answer what a transient failure means, and both answers are wrong: remembering
    // `null` blinds every later probe until the process restarts, and remembering a value asserts across a
    // boundary this function cannot see. Linux rereads `boot_id` per probe; this must match it.
    scriptDarwin({ bootSession: new Error('sysctl unavailable') });
    expect(probeProcessIncarnation(4321, 'darwin')).toBeNull();

    scriptDarwin();
    expect(probeProcessIncarnation(4321, 'darwin'), 'one failed read must not blind every later one').toBe(
      `darwin:${BOOT_SESSION}:${Date.parse(LSTART)}`,
    );
  });

  it('separates two processes that share a pid across a reboot', () => {
    scriptDarwin();
    const before = probeProcessIncarnation(4321, 'darwin');

    // Same pid, same displayed start second, different boot. Without the frame these would be one identity —
    // and a pid space restarting after a reboot lands on exactly the values a stale record names.
    scriptDarwin({ bootSession: 'A1B2C3D4-0000-4000-8000-000000000000' });

    expect(probeProcessIncarnation(4321, 'darwin')).not.toBe(before);
  });

  it('is null rather than a guess when either half is unreadable', () => {
    scriptDarwin({ lstart: '' });
    expect(probeProcessIncarnation(4321, 'darwin')).toBeNull();

    scriptDarwin({ lstart: 'not a date' });
    expect(probeProcessIncarnation(4321, 'darwin')).toBeNull();

    scriptDarwin({ lstart: new Error('no such process') });
    expect(probeProcessIncarnation(4321, 'darwin')).toBeNull();
  });
});
