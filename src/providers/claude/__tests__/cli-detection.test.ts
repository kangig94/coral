import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectClaudeCli, resetClaudeCliCache } from '../cli-detection.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

let originalApiKey: string | undefined;

function mockExecByArgs(responders: Record<string, (cb: ExecFileCallback) => void>): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
    const key = Array.isArray(args) ? args.join(' ') : '';
    const responder = responders[key];
    if (!responder) throw new Error(`Unexpected claude args: ${key}`);
    responder(callback as ExecFileCallback);
    return undefined as never;
  });
}

describe('detectClaudeCli', () => {
  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    resetClaudeCliCache();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('returns authenticated when ANTHROPIC_API_KEY is set (fast path)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockExecByArgs({
      '--version': (cb) => cb(null, '2.1.63 (Claude Code)\n', ''),
    });

    const result = await detectClaudeCli();

    expect(result).toEqual({
      available: true,
      version: '2.1.63 (Claude Code)',
      authState: 'authenticated',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns authenticated when auth status json says authenticated', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, '2.1.63 (Claude Code)\n', ''),
      'auth status --json': (cb) => cb(null, '{"authenticated":true}\n', ''),
    });

    const result = await detectClaudeCli();

    expect(result).toEqual({
      available: true,
      version: '2.1.63 (Claude Code)',
      authState: 'authenticated',
    });
  });

  it('returns unauthenticated when auth probe reports not logged in', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, '2.1.63 (Claude Code)\n', ''),
      'auth status --json': (cb) => cb(new Error('exit 1'), '', 'Not logged in'),
    });

    const result = await detectClaudeCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('returns unavailable when claude binary is missing', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(new Error('ENOENT'), '', ''),
    });

    const result = await detectClaudeCli();

    expect(result).toEqual(expect.objectContaining({
      available: false,
      error: expect.stringContaining('not found'),
    }));
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent probes with one in-flight promise', async () => {
    let versionCalls = 0;
    let authCalls = 0;

    mockExecByArgs({
      '--version': (cb) => {
        versionCalls += 1;
        setTimeout(() => cb(null, '2.1.63 (Claude Code)\n', ''), 5);
      },
      'auth status --json': (cb) => {
        authCalls += 1;
        setTimeout(() => cb(null, '{"authenticated":false}', ''), 5);
      },
    });

    const [first, second] = await Promise.all([detectClaudeCli(), detectClaudeCli()]);

    expect(first).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
    expect(second).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
    expect(versionCalls).toBe(1);
    expect(authCalls).toBe(1);
  });
});
