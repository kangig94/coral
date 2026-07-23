import { describe, expect, it, vi } from 'vitest';

import { detectClaudeCli } from '#src/providers/claude/cli-detection.js';

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
    ['{"authenticated":true}', 'authenticated'],
    ['{"authenticated":false}', 'unauthenticated'],
    ['{"status":"logged_in"}', 'authenticated'],
    ['{"auth_status":"expired"}', 'unauthenticated'],
    ['not-json', 'unknown'],
  ])('interprets Claude auth/status output %s', async (output, authState) => {
    const subject = probe(output);
    await expect(subject.detect()).resolves.toMatchObject({
      available: true,
      version: 'claude 2.0',
      authState,
    });
  });

  it('keeps detector caches isolated by process and environment ports', async () => {
    const missingExec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'missing', status: 1 });
    const availableExec = vi.fn().mockResolvedValue({ stdout: 'claude 2.0', stderr: '', status: 0 });

    await expect(detectClaudeCli({ exec: missingExec } as never, { get: () => undefined })).resolves.toMatchObject({
      available: false,
    });
    await expect(detectClaudeCli({ exec: availableExec } as never, { get: () => 'token' })).resolves.toMatchObject({
      available: true,
      authState: 'authenticated',
    });
  });
});
