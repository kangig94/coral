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

function detector(options: { token?: string; exec: ReturnType<typeof vi.fn>; now?: () => number }) {
  return createCliDetector(
    { exec: options.exec } as never,
    { get: (key) => (key === 'FIXTURE_TOKEN' ? options.token : undefined) },
    CONFIG,
    { now: options.now ?? (() => 1_700_000_000_000) },
  );
}

/** How the exec port reports a launch that never produced an answer: an error carrying an errno. */
function launchFailure(code: string) {
  return { stdout: '', stderr: '', status: null, error: Object.assign(new Error(code), { code }) };
}

describe('provider-neutral CLI detection', () => {
  it('reports an unavailable executable without probing authentication', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'missing', status: 1 });

    await expect(detector({ exec }).detect()).resolves.toEqual({
      available: false,
      reason: 'not-found',
      error: 'fixture CLI unavailable',
    });
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

  // The whole point of the third answer. A probe that could not run is not a missing CLI, and the difference
  // reaches an operator: the collapsed version told someone whose machine was out of process slots to install
  // software they already had.
  it.each([['ETIMEDOUT'], ['EAGAIN'], ['EMFILE'], ['ENOMEM'], ['EWOULDBLOCKX']])(
    'reports %s as undetermined rather than as a missing CLI',
    async (code) => {
      const exec = vi.fn().mockResolvedValue(launchFailure(code));

      const info = await detector({ exec }).detect();

      expect(info).toMatchObject({ available: false, reason: 'undetermined' });
      expect(info.available === false && info.error, 'the message must not name a cause nobody observed').not.toBe(
        'fixture CLI unavailable',
      );
    },
  );

  // The default direction, which is the reverse of the one `git-sync.ts` takes on its own probe. Asserted
  // because it is a choice, not a consequence: nothing about a codeless error says the binary ran, and the
  // cost of guessing wrong here is a false instruction to an operator rather than a wasted fork.
  it('reports a launch error carrying no recognisable code as undetermined', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', status: null, error: new Error('boom') });

    await expect(detector({ exec }).detect()).resolves.toMatchObject({
      available: false,
      reason: 'undetermined',
    });
  });

  // Not a launch failure and not an answer: the port reports its own timeout as an error, so a null status is
  // a child killed by something else. The partial stdout it leaves behind is the same buffer the version is
  // read from, which is how a killed probe used to mint a version out of a truncated line.
  it('reports a probe killed by a signal as undetermined rather than as a version', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'fixt', stderr: '', status: null, signal: 'SIGKILL' });

    await expect(detector({ exec }).detect()).resolves.toMatchObject({
      available: false,
      reason: 'undetermined',
    });
  });

  it.each([
    ['ENOENT', 'the binary is not installed'],
    ['EACCES', 'this process may not execute it'],
  ])('reports %s as not-found, because %s does not change under a running daemon', async (code) => {
    const exec = vi.fn().mockResolvedValue(launchFailure(code));

    await expect(detector({ exec }).detect()).resolves.toEqual({
      available: false,
      reason: 'not-found',
      error: 'fixture CLI unavailable',
    });
  });

  it('does not remember an undetermined probe as an answer', async () => {
    let now = 1_700_000_000_000;
    const exec = vi
      .fn()
      .mockResolvedValueOnce(launchFailure('EAGAIN'))
      .mockResolvedValueOnce({ stdout: 'fixture 1.0', stderr: '', status: 0 });
    const subject = detector({ token: 'secret', exec, now: () => now });

    await expect(subject.detect()).resolves.toMatchObject({ reason: 'undetermined' });
    now += 60_001;

    await expect(subject.detect(), 'a recovered machine heals without a daemon restart').resolves.toMatchObject({
      available: true,
      version: 'fixture 1.0',
    });
  });

  it('holds an undetermined probe for the interval rather than re-forking per preflight', async () => {
    const exec = vi.fn().mockResolvedValue(launchFailure('EAGAIN'));
    const subject = detector({ exec });

    for (let call = 0; call < 5; call += 1) {
      await expect(subject.detect()).resolves.toMatchObject({ reason: 'undetermined' });
    }

    expect(exec, 'five preflights on a wedged machine must not cost five 10s probes').toHaveBeenCalledTimes(1);
  });

  it('still caches a decisive not-found for the process lifetime', async () => {
    const exec = vi.fn().mockResolvedValue(launchFailure('ENOENT'));
    const subject = detector({ exec });

    await subject.detect();
    await subject.detect();
    await subject.detect();

    expect(exec, 'a missing binary does not appear under a running daemon').toHaveBeenCalledTimes(1);
  });

  it('forgets a held undetermined probe on an explicit reset', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(launchFailure('ETIMEDOUT'))
      .mockResolvedValue({ stdout: 'fixture 1.0', stderr: '', status: 0 });
    const subject = detector({ token: 'secret', exec });

    await expect(subject.detect()).resolves.toMatchObject({ reason: 'undetermined' });
    subject.resetCache();

    await expect(subject.detect()).resolves.toMatchObject({ available: true });
  });
});
