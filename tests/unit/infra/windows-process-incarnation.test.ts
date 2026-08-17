// The Windows probe is defensive — win32 is not a supported host — but it is the only coverage this function
// has, and one of the three synchronous subprocess call sites that must carry a timeout. The subprocess is
// mocked, so this test is platform-independent and never invokes wmic.
//
// There is deliberately no "returns null when the probe times out" test here. The probe's `catch` is bare, so
// such a test passes whether or not the timeout option is present and proves nothing about the bound. The
// options assertion below is what fails if the timeout is ever dropped.

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';

import { probeProcessIncarnation } from '#src/infra/node-process.js';

const mockedExec = vi.mocked(execFileSync);

// Independent literal rather than the imported constant, so a changed bound cannot pass silently. Subset
// match so unrelated exec options stay free to change.
const BOUNDED = expect.objectContaining({ timeout: 2_000 });

describe('windows process incarnation', () => {
  it('derives a token from wmic output, and bounds the probe', () => {
    mockedExec.mockReturnValue('CreationDate=20250817123456.000000+540');

    expect(probeProcessIncarnation(4321, 'win32')).toBe('win32:20250817123456.000000+540');
    expect(mockedExec).toHaveBeenCalledWith(
      'wmic',
      ['process', 'where', 'ProcessId=4321', 'get', 'CreationDate', '/value'],
      BOUNDED,
    );
  });
});
