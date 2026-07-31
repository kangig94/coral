import { describe, expect, it, vi } from 'vitest';

import { detectClaudeCli } from '#src/providers/claude/cli-detection.js';

const AUTH_ERROR_MESSAGE =
  'Claude CLI is not authenticated. Run "claude auth login" with the same CLAUDE_CONFIG_DIR, then retry.';

function probe(authOutput: string) {
  const exec = vi
    .fn()
    .mockResolvedValueOnce({ stdout: 'claude 2.0\n', stderr: '', status: 0 })
    .mockResolvedValueOnce({ stdout: authOutput, stderr: '', status: 0 });
  return {
    exec,
    detect: () => detectClaudeCli({ exec } as never, { get: () => undefined }),
  };
}

describe('Claude CLI detection', () => {
  it.each([
    [
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'team' }),
      { authState: 'authenticated' },
    ],
    [JSON.stringify({ loggedIn: false }), { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE }],
    [JSON.stringify({ authenticated: true }), { authState: 'authenticated' }],
    [JSON.stringify({ authenticated: false }), { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE }],
    [JSON.stringify({ loggedIn: true, authenticated: false }), { authState: 'unknown' }],
    [JSON.stringify({ loggedIn: true, authenticated: true }), { authState: 'authenticated' }],
    [JSON.stringify({ loggedIn: true, status: 'unauthenticated' }), { authState: 'unknown' }],
    [JSON.stringify({ status: ' LOGGED-IN ' }), { authState: 'authenticated' }],
    [JSON.stringify({ status: 'not-authenticated' }), { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE }],
    [JSON.stringify({ status: 'active', auth_status: 'expired' }), { authState: 'unknown' }],
    [JSON.stringify({ futureAuthState: 'unauthenticated' }), { authState: 'unknown' }],
    ['not-json', { authState: 'unknown' }],
    ['[]', { authState: 'unknown' }],
    ['null', { authState: 'unknown' }],
    ['', { authState: 'unknown' }],
  ])('interprets Claude auth/status output %s', async (output, auth) => {
    const subject = probe(output);
    await expect(subject.detect()).resolves.toEqual({
      available: true,
      version: 'claude 2.0',
      ...auth,
    });
  });

  it.each(['authenticated', 'logged_in', 'loggedin', 'active'])(
    'accepts the legacy authenticated status %s',
    async (status) => {
      await expect(probe(JSON.stringify({ status })).detect()).resolves.toMatchObject({
        authState: 'authenticated',
      });
    },
  );

  it.each(['unauthenticated', 'logged_out', 'loggedout', 'not_authenticated', 'missing', 'expired', 'inactive'])(
    'rejects the legacy unauthenticated status %s',
    async (status) => {
      await expect(probe(JSON.stringify({ auth_status: status })).detect()).resolves.toMatchObject({
        authState: 'unauthenticated',
        authError: AUTH_ERROR_MESSAGE,
      });
    },
  );

  it('probes the selected Claude profile without API-key evidence', async () => {
    const subject = probe(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));

    await expect(subject.detect()).resolves.toEqual({
      available: true,
      version: 'claude 2.0',
      authState: 'authenticated',
    });
    expect(subject.exec.mock.calls).toEqual([
      ['claude', ['--version'], { timeout: 10_000, encoding: 'utf-8' }],
      ['claude', ['auth', 'status', '--json'], { timeout: 5_000, encoding: 'utf-8' }],
    ]);
  });

  it('keeps detector caches isolated by process port', async () => {
    const envPort = { get: () => undefined };
    const missingExec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'missing', status: 1 });
    const availableExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'claude 2.0', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true }), stderr: '', status: 0 });

    await expect(detectClaudeCli({ exec: missingExec } as never, envPort)).resolves.toMatchObject({
      available: false,
    });
    await expect(detectClaudeCli({ exec: availableExec } as never, envPort)).resolves.toMatchObject({
      available: true,
      authState: 'authenticated',
    });
    expect(availableExec).toHaveBeenCalledTimes(2);
  });

  it('keeps detector caches isolated by environment port', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'claude profile-a', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: false }), stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: 'claude profile-b', stderr: '', status: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: true }), stderr: '', status: 0 });
    const processPort = { exec } as never;

    await expect(detectClaudeCli(processPort, { get: () => undefined })).resolves.toMatchObject({
      version: 'claude profile-a',
      authState: 'unauthenticated',
    });
    await expect(detectClaudeCli(processPort, { get: () => undefined })).resolves.toMatchObject({
      version: 'claude profile-b',
      authState: 'authenticated',
    });
    expect(exec).toHaveBeenCalledTimes(4);
  });
});
