import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ExecResult, RuntimeExecOptions } from '#src/runtime/ports.js';
import { createClaudeDetectorForTest, createCodexDetectorForTest } from '#tests/unit/providers/__helpers__/cli-detection-fixtures.js';

type ExecResponder = () => ExecResult | Promise<ExecResult>;

function buildExecPort(responders: Record<string, ExecResponder>): {
  exec: (command: string, args: string[], options?: RuntimeExecOptions) => Promise<ExecResult>;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    exec: async (command, args) => {
      calls.push({ command, args: [...args] });
      const key = args.join(' ');
      const responder = responders[key];
      if (!responder) throw new Error(`Unexpected args: ${key}`);
      return responder();
    },
  };
}

function ok(stdout: string, stderr = ''): ExecResult {
  return { stdout, stderr, status: 0 };
}

function failed(stdout: string, stderr: string, error?: Error): ExecResult {
  return { stdout, stderr, status: error ? null : 1, ...(error ? { error } : {}) };
}

// ── Codex ──────────────────────────────────────
// Tests both codex-specific config and the shared createCliDetector mechanism
// (caching, concurrent dedup, re-check, reset).

describe('detectCodexCli', () => {
  let originalApiKey: string | undefined;
  let port: ReturnType<typeof buildExecPort>;
  let codexDetector = createCodexDetectorForTest({ exec: () => Promise.reject(new Error('not configured')) });

  function detectCodexCli() {
    return codexDetector.detect();
  }

  function resetCodexCliCache(): void {
    codexDetector.resetCache();
  }

  function setResponders(responders: Record<string, ExecResponder>): void {
    port = buildExecPort(responders);
    codexDetector = createCodexDetectorForTest({ exec: port.exec });
  }

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    port = buildExecPort({});
    codexDetector = createCodexDetectorForTest({ exec: port.exec });
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it('returns authenticated when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    setResponders({ '--version': () => ok('codex 1.2.3\n') });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'authenticated' });
    expect(port.calls).toHaveLength(1);
  });

  it('returns authenticated when whoami exits 0', async () => {
    setResponders({
      '--version': () => ok('codex 1.2.3\n'),
      whoami: () => ok('user@example.com\n'),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'authenticated' });
  });

  it('returns unauthenticated when stderr matches auth pattern', async () => {
    setResponders({
      '--version': () => ok('codex 1.2.3\n'),
      whoami: () => failed('', 'Not logged in'),
    });

    const result = await detectCodexCli();

    expect(result).toEqual(
      expect.objectContaining({
        available: true,
        authState: 'unauthenticated',
        authError: expect.stringContaining('codex login'),
      }),
    );
  });

  it('returns unauthenticated when stdout alone matches auth pattern', async () => {
    setResponders({
      '--version': () => ok('codex 1.2.3\n'),
      whoami: () => failed('Missing API key', ''),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('returns unknown when whoami fails without auth-pattern output', async () => {
    setResponders({
      '--version': () => ok('codex 1.2.3\n'),
      whoami: () => failed('', 'unsupported command'),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'unknown' });
  });

  it('returns unknown when whoami times out', async () => {
    setResponders({
      '--version': () => ok('codex 1.2.3\n'),
      whoami: () => ({ stdout: '', stderr: '', status: null, error: new Error('timeout: codex') }),
    });

    const result = await detectCodexCli();

    expect(result).toEqual({ available: true, version: 'codex 1.2.3', authState: 'unknown' });
  });

  it('returns unavailable when codex --version fails and skips auth probe', async () => {
    setResponders({
      '--version': () => ({ stdout: '', stderr: '', status: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
    });

    const result = await detectCodexCli();

    expect(result).toEqual(
      expect.objectContaining({
        available: false,
        error: expect.stringContaining('not found'),
      }),
    );
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.args).toEqual(['--version']);
  });

  it('caches positive auth permanently', async () => {
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => ok('user@example.com\n'),
    });

    await detectCodexCli();
    await detectCodexCli();

    expect(port.calls).toHaveLength(2);
    expect(port.calls.map((call) => call.args.join(' '))).toEqual(['--version', 'whoami']);
  });

  it('re-checks unauthenticated state on each call', async () => {
    let whoamiCalls = 0;
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => {
        whoamiCalls += 1;
        return failed('', 'authentication required');
      },
    });

    const first = await detectCodexCli();
    const second = await detectCodexCli();

    expect(first).toMatchObject({ available: true, authState: 'unauthenticated' });
    expect(second).toMatchObject({ available: true, authState: 'unauthenticated' });
    expect(whoamiCalls).toBe(2);
    expect(port.calls).toHaveLength(3);
  });

  it('re-checks unknown auth state on each call', async () => {
    let whoamiCalls = 0;
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => {
        whoamiCalls += 1;
        return failed('', 'network unstable');
      },
    });

    const first = await detectCodexCli();
    const second = await detectCodexCli();

    expect(first).toEqual({ available: true, version: 'codex 1.0.0', authState: 'unknown' });
    expect(second).toEqual({ available: true, version: 'codex 1.0.0', authState: 'unknown' });
    expect(whoamiCalls).toBe(2);
    expect(port.calls).toHaveLength(3);
  });

  it('deduplicates concurrent probes via a single in-flight promise', async () => {
    let versionCalls = 0;
    let whoamiCalls = 0;
    setResponders({
      '--version': async () => {
        versionCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return ok('codex 1.0.0\n');
      },
      whoami: async () => {
        whoamiCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return failed('', 'no api key');
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
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => failed('', 'not logged in'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('empty string OPENAI_API_KEY falls through to whoami probe', async () => {
    process.env.OPENAI_API_KEY = '';
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => ok('user@example.com'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'authenticated',
    });
  });

  it('AUTH_ERROR_PATTERN is case-insensitive', async () => {
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => failed('', 'UNAUTHORIZED'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('auth phrase matched mid-sentence triggers unauthenticated', async () => {
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => failed('', 'Request failed: user is not logged in to the platform'),
    });

    const result = await detectCodexCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('resetCodexCliCache then fresh call re-probes from scratch', async () => {
    let versionCallCount = 0;
    setResponders({
      '--version': () => {
        versionCallCount += 1;
        return ok('codex 1.0.0\n');
      },
      whoami: () => ok('user@example.com'),
    });

    await detectCodexCli();
    resetCodexCliCache();
    await detectCodexCli();

    expect(versionCallCount).toBe(2);
  });

  it('unknown-result batch allows re-probe in subsequent batch', async () => {
    let whoamiCalls = 0;
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => {
        whoamiCalls += 1;
        return failed('', 'network error');
      },
    });

    await Promise.all([detectCodexCli(), detectCodexCli()]);
    expect(whoamiCalls).toBe(1);

    await Promise.all([detectCodexCli(), detectCodexCli()]);
    expect(whoamiCalls).toBe(2);
  });

  it('resetCodexCliCache clears confirmed auth and allows later unauthenticated detection', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    setResponders({
      '--version': () => ok('codex 1.0.0\n'),
      whoami: () => failed('', 'not logged in'),
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
    expect(port.calls).toHaveLength(3);
  });
});

// ── Claude ─────────────────────────────────────
// Provider-specific tests only. Shared createCliDetector mechanism
// (caching, concurrent dedup, re-check) is proven by the codex suite above.

describe('detectClaudeCli', () => {
  let originalApiKey: string | undefined;
  let port: ReturnType<typeof buildExecPort>;
  let claudeDetector = createClaudeDetectorForTest({ exec: () => Promise.reject(new Error('not configured')) });

  function detectClaudeCli() {
    return claudeDetector.detect();
  }

  function setResponders(responders: Record<string, ExecResponder>): void {
    port = buildExecPort(responders);
    claudeDetector = createClaudeDetectorForTest({ exec: port.exec });
  }

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    port = buildExecPort({});
    claudeDetector = createClaudeDetectorForTest({ exec: port.exec });
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('returns authenticated when ANTHROPIC_API_KEY is set (fast path)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    setResponders({
      '--version': () => ok('2.1.63 (Claude Code)\n'),
    });

    const result = await detectClaudeCli();

    expect(result).toEqual({
      available: true,
      version: '2.1.63 (Claude Code)',
      authState: 'authenticated',
    });
    expect(port.calls).toHaveLength(1);
  });

  it('returns authenticated when auth status json says authenticated', async () => {
    setResponders({
      '--version': () => ok('2.1.63 (Claude Code)\n'),
      'auth status --json': () => ok('{"authenticated":true}\n'),
    });

    const result = await detectClaudeCli();

    expect(result).toEqual({
      available: true,
      version: '2.1.63 (Claude Code)',
      authState: 'authenticated',
    });
  });

  it('returns unauthenticated when auth probe reports not logged in', async () => {
    setResponders({
      '--version': () => ok('2.1.63 (Claude Code)\n'),
      'auth status --json': () => failed('', 'Not logged in'),
    });

    const result = await detectClaudeCli();

    expect(result).toMatchObject({
      available: true,
      authState: 'unauthenticated',
    });
  });

  it('returns unavailable when claude binary is missing', async () => {
    setResponders({
      '--version': () => ({ stdout: '', stderr: '', status: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
    });

    const result = await detectClaudeCli();

    expect(result).toEqual(
      expect.objectContaining({
        available: false,
        error: expect.stringContaining('not found'),
      }),
    );
    expect(port.calls).toHaveLength(1);
  });
});
