import { describe, expect, it, vi } from 'vitest';

import { createCliDetector, type CliDetectorConfig } from '#src/providers/cli-detection.js';

const CONFIG: CliDetectorConfig = {
  binaryName: 'fixture-cli',
  versionArgs: ['version'],
  notFoundMessage: 'fixture CLI unavailable',
  authEnvVar: 'FIXTURE_TOKEN',
  authCommand: ['auth', 'status'],
  authErrorPattern: /sign in required/iu,
  authErrorMessage: 'fixture authentication required',
  parseAuthOutput: (stdout) =>
    stdout.trim() === 'yes'
      ? { authState: 'authenticated' }
      : stdout.trim() === 'no'
        ? { authState: 'unauthenticated', authError: 'fixture authentication required' }
        : null,
};

function detector(options: { token?: string; exec: ReturnType<typeof vi.fn> }) {
  return createCliDetector(
    { exec: options.exec } as never,
    { get: (key) => (key === 'FIXTURE_TOKEN' ? options.token : undefined) },
    CONFIG,
  );
}

describe('provider-neutral CLI detection', () => {
  it('reports an unavailable executable without probing authentication', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'missing', status: 1 });

    await expect(detector({ exec }).detect()).resolves.toEqual({ available: false, error: 'fixture CLI unavailable' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit provider-owned token as authenticated evidence', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'fixture 1.0', stderr: '', status: 0 });

    await expect(detector({ token: 'secret', exec }).detect()).resolves.toEqual({
      available: true,
      version: 'fixture 1.0',
      authState: 'authenticated',
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('delegates successful auth output interpretation to the provider parser', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'fixture 1.0\n', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: 'no', stderr: '', status: 0 });

    await expect(detector({ exec }).detect()).resolves.toEqual({
      available: true,
      version: 'fixture 1.0',
      authState: 'unauthenticated',
      authError: 'fixture authentication required',
    });
  });

  it('maps provider-owned auth error patterns and leaves unrelated failures unknown', async () => {
    const denied = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'fixture 1.0', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'sign in required', status: 1 });
    const unknown = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'fixture 1.0', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'network unavailable', status: 1 });

    await expect(detector({ exec: denied }).detect()).resolves.toMatchObject({ authState: 'unauthenticated' });
    await expect(detector({ exec: unknown }).detect()).resolves.toMatchObject({ authState: 'unknown' });
  });

  it('coalesces concurrent probes and caches confirmed authentication', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'fixture 1.0', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: 'yes', stderr: '', status: 0 });
    const subject = detector({ exec });

    const [first, second] = await Promise.all([subject.detect(), subject.detect()]);
    expect(first).toEqual(second);
    await subject.detect();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('resets all cached state explicitly', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'fixture 1.0', stderr: '', status: 0 });
    const subject = detector({ token: 'secret', exec });
    await subject.detect();
    subject.resetCache();
    await subject.detect();
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
