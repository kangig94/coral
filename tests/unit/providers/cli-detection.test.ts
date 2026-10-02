import { describe, expect, it, vi } from 'vitest';

import { createCliDetector, type CliDetectorConfig } from '#src/providers/cli-detection.js';

const CONFIG: CliDetectorConfig = {
  binaryName: 'fixture-cli',
  versionArgs: ['version'],
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

function detector(options: {
  token?: string;
  exec: ReturnType<typeof vi.fn>;
  cwd?: string;
  cwdState?: 'directory' | 'missing' | 'not-directory' | 'unobserved';
  statSync?: ReturnType<typeof vi.fn>;
  cwdTraversability?: 'traversable' | 'denied' | 'unobserved';
  observeDirectoryTraversabilitySync?: ReturnType<typeof vi.fn>;
}) {
  const cwdState = options.cwdState ?? 'directory';
  const statSync =
    options.statSync ??
    vi.fn(() => {
      if (cwdState === 'missing') throw errno('ENOENT');
      if (cwdState === 'unobserved') throw errno('EACCES');
      return {
        size: 0,
        mtimeMs: 0,
        isDirectory: () => cwdState === 'directory',
        isFile: () => cwdState === 'not-directory',
      };
    });
  return createCliDetector(
    {
      exec: options.exec,
      cwd: options.cwd ?? '/workspace/project',
      storage: {
        statSync,
        observeDirectoryTraversabilitySync:
          options.observeDirectoryTraversabilitySync ?? vi.fn(() => options.cwdTraversability ?? 'traversable'),
      },
    } as never,
    { get: (key) => (key === 'FIXTURE_TOKEN' ? options.token : undefined) },
    CONFIG,
  );
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** How the exec port reports a launch that never produced an answer: an error carrying an errno. */
function launchFailure(code: string) {
  return { stdout: '', stderr: '', status: null, error: Object.assign(new Error(code), { code }) };
}

describe('provider-neutral CLI detection', () => {
  it('reports and caches a failed version check without probing authentication', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'missing', status: 1 });
    const subject = detector({ exec });

    await expect(subject.detect()).resolves.toMatchObject({
      available: false,
      error:
        '`fixture-cli version` exited with status 1 instead of reporting a version; ensure `fixture-cli` runs correctly for the user running the Coral daemon, then retry.',
    });
    await subject.detect();
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

  // The whole point of the third answer. A probe that could not run is not a missing CLI, and the difference
  // reaches an operator: the collapsed version told someone whose machine was out of process slots to install
  // software they already had.
  it.each([['ETIMEDOUT']])('reports %s as undetermined rather than as a missing CLI', async (code) => {
    const exec = vi.fn().mockResolvedValue(launchFailure(code));

    const info = await detector({ exec }).detect();

    expect(info).toMatchObject({ available: false, reason: 'undetermined' });
    expect(info.available === false && info.error, 'the message must not name a cause nobody observed').not.toMatch(
      /not found|install it/iu,
    );
  });

  it('reports and caches ENOENT only as a command that could not start after verifying the working directory', async () => {
    const exec = vi.fn().mockResolvedValue(launchFailure('ENOENT'));
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const subject = detector({ exec, statSync });

    await expect(subject.detect()).resolves.toMatchObject({
      available: false,
      error:
        "Could not start `fixture-cli version` using the Coral daemon's PATH (ENOENT); ensure `fixture-cli` is installed and runnable at a location on that PATH, and restart the Coral backend after changing that PATH before retrying.",
    });
    await subject.detect();
    expect(statSync).toHaveBeenCalledWith('/workspace/project');
    expect(exec).toHaveBeenCalledOnce();
  });

  it('reports EACCES as a request-specific refusal when the working directory is not traversable', async () => {
    const exec = vi.fn().mockResolvedValue(launchFailure('EACCES'));
    const cwd = '/workspace/untraversable-project';
    const info = await detector({ exec, cwd, cwdTraversability: 'denied' }).detect();

    expect(info).toEqual({
      available: false,
      reason: 'invalid-working-directory',
      error: expect.stringMatching(/not traversable/iu),
    });
    if (info.available) throw new Error('expected unavailable');
    expect(info.error).toContain(cwd);
    expect(info.error).not.toMatch(/execute permissions on `fixture-cli`/iu);
  });

  it('never remembers an undetermined probe, so a recovered machine heals on the next call', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(launchFailure('EAGAIN'))
      .mockResolvedValueOnce({ stdout: 'fixture 1.0', stderr: '', status: 0 });
    const subject = detector({ token: 'secret', exec });

    await expect(subject.detect()).resolves.toMatchObject({ reason: 'undetermined' });
    await expect(subject.detect(), 'no restart, no interval to wait out').resolves.toMatchObject({
      available: true,
      version: 'fixture 1.0',
    });
  });
});
