import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectCodexCli, resetCliCache } from '../cli-detection.js';

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
    if (!responder) throw new Error(`Unexpected codex args: ${key}`);
    responder(callback as ExecFileCallback);
    return undefined as never;
  });
}

describe('detectCodexCli', () => {
  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetCliCache();
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

    expect(first.available && first.authState).toBe('unauthenticated');
    expect(second.available && second.authState).toBe('unauthenticated');
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

    expect(a.available && a.authState).toBe('unauthenticated');
    expect(b.available && b.authState).toBe('unauthenticated');
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

  it('resetCliCache then fresh call re-probes from scratch', async () => {
    let versionCallCount = 0;
    mockExecByArgs({
      '--version': (cb) => { versionCallCount += 1; cb(null, 'codex 1.0.0\n', ''); },
      'whoami': (cb) => cb(null, 'user@example.com', ''),
    });

    await detectCodexCli();
    resetCliCache();
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

  it('resetCliCache clears confirmed auth and allows later unauthenticated detection', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    mockExecByArgs({
      '--version': (cb) => cb(null, 'codex 1.0.0\n', ''),
      'whoami': (cb) => cb(new Error('exit 1'), '', 'not logged in'),
    });

    const first = await detectCodexCli();
    expect(first).toEqual({ available: true, version: 'codex 1.0.0', authState: 'authenticated' });

    resetCliCache();
    delete process.env.OPENAI_API_KEY;

    const second = await detectCodexCli();
    expect(second).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });
});
