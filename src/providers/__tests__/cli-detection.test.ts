import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectCodexCli, resetCodexCliCache,
  detectClaudeCli, resetClaudeCliCache,
} from '../cli-detection.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockExecByArgs(responders: Record<string, (cb: ExecFileCallback) => void>): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
    const key = Array.isArray(args) ? args.join(' ') : '';
    const responder = responders[key];
    if (!responder) throw new Error(`Unexpected args: ${key}`);
    responder(callback as ExecFileCallback);
    return undefined as never;
  });
}

// ── Codex ──────────────────────────────────────
// Tests both codex-specific config and the shared createCliDetector mechanism
// (caching, concurrent dedup, re-check, reset).

describe('detectCodexCli', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetCodexCliCache();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it('returns authenticated when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.2.3\n', ''),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'authenticated' });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns authenticated when whoami exits 0', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.2.3\n', ''),
      'whoami': (cb) => cb(null, 'user@example.com\n', ''),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'authenticated' });
  });

  it('returns unauthenticated when stderr matches auth pattern', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.2.3\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'Not logged in'),
    });

    const result = await detectCodexCli();

    expect(result).toEqual(expect.objectContaining({
      available: true,
      authState: 'unauthenticated',
      authError: expect.stringContaining('codex login'),
    }));
  });

  it('returns unauthenticated when stdout alone matches auth pattern', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.2.3\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), 'Missing API key', ''),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('returns unknown when whoami fails without auth-pattern output', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.2.3\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'unsupported command'),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'unknown' });
  });

  it('returns unknown when whoami times out', async () => {
    const timeoutError = Object.assign(new Error('ETIMEDOUT'), { killed: true });
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.2.3\n', ''),
      'whoami': (cb) => cb(timeoutError, '', ''),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'unknown' });
  });

  it('returns unavailable when codex --version fails and skips auth probe', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(new Error('ENOENT'), '', ''),
    });

    const result = await detectCodexCli();

    expect(result).toEqual(expect.objectContaining({
      available: false,
      error: expect.stringContaining('not found'),
    }));
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual(['--version']);
  });

  it('caches positive auth permanently', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(null, 'user@example.com\n', ''),
    });

    await detectCodexCli();
    await detectCodexCli();

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls.map((call) => (call[1] as string[]).join(' '))).toEqual(['--version', 'whoami']);
  });

  it('re-checks unauthenticated state on each call', async () => {
    let whoamiCalls = 0;
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => {
        whoamiCalls += 1;
        cb(new Error('exit 1'), '', 'authentication required');
      },
    });

    const first = await detectCodexCli();
    const second = await detectCodexCli();

    expect(first).toMatchObject({ available: true, authState: 'unauthenticated' });
    expect(second).toMatchObject({ available: true, authState: 'unauthenticated' });
    expect(whoamiCalls).toBe(2);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('re-checks unknown auth state on each call', async () => {
    let whoamiCalls = 0;
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => {
        whoamiCalls += 1;
        cb(new Error('exit 1'), '', 'network unstable');
      },
    });

    const first = await detectCodexCli();
    const second = await detectCodexCli();

    expect(first).toEqual({ available: true, version: 'codex 1.0.0', authState: 'unknown' });
    expect(second).toEqual({ available: true, version: 'codex 1.0.0', authState: 'unknown' });
    expect(whoamiCalls).toBe(2);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent probes via a single in-flight promise', async () => {
    let versionCalls = 0;
    let whoamiCalls = 0;
    mockExecByArgs({
      '--version': (cb) => {
        versionCalls += 1;
        setTimeout(() => cb(null, 'codex 1.0.0\n', ''), 5);
      },
      'whoami': (cb) => {
        whoamiCalls += 1;
        setTimeout(() => cb(new Error('exit 1'), '', 'no api key'), 5);
      },
    });

    const [a, b] = await Promise.all([detectCodexCli(), detectCodexCli()]);

    expect(a).toMatchObject({ available: true, authState: 'unauthenticated' });
    expect(b).toMatchObject({ available: true, authState: 'unauthenticated' });
    expect(versionCalls).toBe(1);
    expect(whoamiCalls).toBe(1);
  });

  it('whitespace-only OPENAI_API_KEY falls through to whoami probe', async () => {
    process.env.OPENAI_API_KEY = '   ';
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'not logged in'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('empty string OPENAI_API_KEY falls through to whoami probe', async () => {
    process.env.OPENAI_API_KEY = '';
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(null, 'user@example.com', ''),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'authenticated',
    });
  });

  it('AUTH_ERROR_PATTERN is case-insensitive', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'UNAUTHORIZED'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('auth phrase matched mid-sentence triggers unauthenticated', async () => {
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'Request failed: user is not logged in to the platform'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('resetCodexCliCache then fresh call re-probes from scratch', async () => {
    let versionCallCount = 0;
    mockExecByArgs({
      '--version': (cb) => { versionCallCount += 1; cb(null, 'codex 1.0.0\n', ''); },
      'whoami': (cb) => cb(null, 'user@example.com', ''),
    });

    await detectCodexCli();
    resetCodexCliCache();
    await detectCodexCli();

    expect(versionCallCount).toBe(2);
  });

  it('unknown-result batch allows re-probe in subsequent batch', async () => {
    let whoamiCalls = 0;
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => { whoamiCalls += 1; cb(new Error('exit 1'), '', 'network error'); },
    });

    await Promise.all([detectCodexCli(), detectCodexCli()]);
    expect(whoamiCalls).toBe(1);

    await Promise.all([detectCodexCli(), detectCodexCli()]);
    expect(whoamiCalls).toBe(2);
  });

  it('resetCodexCliCache clears confirmed auth and allows later unauthenticated detection', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'not logged in'),
    });

    const first = await detectCodexCli();
    expect(first).toEqual({ available: true, version: 'codex 1.0.0', authState: 'authenticated' });

    resetCodexCliCache();
    delete process.env.OPENAI_API_KEY;

    const second = await detectCodexCli();
    expect(second).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });
});

// ── Claude ─────────────────────────────────────
// Provider-specific tests only. Shared createCliDetector mechanism
// (caching, concurrent dedup, re-check) is proven by the codex suite above.

describe('detectClaudeCli', () => {
  let originalApiKey: string | undefined;

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
});
