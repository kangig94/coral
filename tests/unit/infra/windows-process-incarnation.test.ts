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

  it('is null rather than a partial token when wmic answers nothing it can parse', () => {
    // Tokens are compared only by equality, so a token assembled from a creation date wmic did not supply
    // would equal every other token assembled the same way — one identity shared by unrelated processes.
    mockedExec.mockReturnValue('CreationDate=');
    expect(probeProcessIncarnation(4321, 'win32')).toBeNull();

    // And the probe answers rather than throws, because `null` is the value a caller branches on when it
    // could not observe an identity.
    mockedExec.mockImplementation((() => {
      throw new Error('wmic is not on PATH');
    }) as unknown as typeof execFileSync);
    expect(probeProcessIncarnation(4321, 'win32')).toBeNull();
  });
});
