import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../types.js';

vi.mock('../codex/codex-executor.js', () => ({
  executeOneShot: vi.fn(),
  executeResume: vi.fn(),
  executeFork: vi.fn(),
}));

vi.mock('../claude/claude-executor.js', () => {
  class MockClaudeExecParseError extends Error {
    readonly failure: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      parseError: string;
    };

    constructor(failure: { exitCode: number | null; stdout: string; stderr: string; parseError: string }) {
      super('mock parse error');
      this.name = 'ClaudeExecParseError';
      this.failure = failure;
    }
  }

  return {
    ClaudeExecParseError: MockClaudeExecParseError,
    executeClaudeOneShot: vi.fn(),
    executeClaudeResume: vi.fn(),
    executeClaudeFork: vi.fn(),
  };
});

import { executeFork, executeOneShot, executeResume } from '../codex/codex-executor.js';
import {
  ClaudeExecParseError,
  executeClaudeFork,
  executeClaudeOneShot,
  executeClaudeResume,
} from '../claude/claude-executor.js';
import { codexProvider } from '../codex/adapter.js';
import { claudeProvider } from '../claude/adapter.js';

const mockExecuteOneShot = vi.mocked(executeOneShot);
const mockExecuteResume = vi.mocked(executeResume);
const mockExecuteFork = vi.mocked(executeFork);
const mockExecuteClaudeOneShot = vi.mocked(executeClaudeOneShot);
const mockExecuteClaudeResume = vi.mocked(executeClaudeResume);
const mockExecuteClaudeFork = vi.mocked(executeClaudeFork);

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-1',
    prompt: 'Run checks',
    bypassPermissions: false,
    ...overrides,
  };
}

function makeRuntime() {
  const controller = new AbortController();
  const events: unknown[] = [];
  return {
    signal: controller.signal,
    events,
    runtime: {
      signal: controller.signal,
      onEvent: (event: unknown) => {
        events.push(event);
      },
    },
  };
}

function baseCodexResult(overrides: Partial<{
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  exitCode: number | null;
  errors: string[];
  warnings: string[];
  aborted: boolean;
}> = {}) {
  return {
    response: 'ok',
    sessionId: 'thread-1',
    model: 'o4-mini',
    durationMs: 10,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
    ...overrides,
  };
}

function baseClaudeResult(overrides: Partial<{
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  costUsd: number | null;
  aborted: boolean;
}> = {}) {
  return {
    response: 'ok',
    sessionId: 'claude-thread',
    model: 'sonnet',
    durationMs: 15,
    costUsd: 0,
    aborted: false,
    ...overrides,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Global setup for adversarial describes below. The describe-level beforeEach in the
// main provider describes overrides these for their own tests.
beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteOneShot.mockResolvedValue(baseCodexResult());
  mockExecuteResume.mockResolvedValue(baseCodexResult({ sessionId: 'thread-resume' }));
  mockExecuteFork.mockResolvedValue(baseCodexResult({ sessionId: 'thread-fork' }));
  mockExecuteClaudeOneShot.mockResolvedValue(baseClaudeResult());
  mockExecuteClaudeResume.mockResolvedValue(baseClaudeResult({ sessionId: 'claude-resume' }));
  mockExecuteClaudeFork.mockResolvedValue(baseClaudeResult({ sessionId: 'claude-fork' }));
});

describe('codex provider adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteOneShot.mockResolvedValue({
      response: 'codex response',
      sessionId: 'codex-thread',
      model: 'o4-mini',
      durationMs: 25,
      exitCode: 0,
      errors: [],
      warnings: [],
      aborted: false,
    });
    mockExecuteResume.mockResolvedValue({
      response: 'codex resume',
      sessionId: 'codex-thread-resume',
      model: 'o4-mini',
      durationMs: 30,
      exitCode: 0,
      errors: [],
      warnings: [],
      aborted: false,
    });
    mockExecuteFork.mockResolvedValue({
      response: 'codex fork',
      sessionId: 'codex-thread-fork',
      model: 'o4-mini',
      durationMs: 35,
      exitCode: 0,
      errors: [],
      warnings: [],
      aborted: false,
    });
  });

  it('exec calls executeOneShot with instruction-prefixed prompt', async () => {
    const { runtime, signal } = makeRuntime();

    await codexProvider.execute(makeRequest({
      instruction: { channel: 'prompt', content: 'Follow the repo rules' },
      systemPrompt: 'System guidance',
      model: 'o4-mini',
      cwd: '/repo',
      effort: 'high',
      bypassPermissions: true,
    }), runtime);

    expect(mockExecuteOneShot).toHaveBeenCalledWith(
      'Follow the repo rules\n\n---\n\nSystem guidance\n\n---\n\nRun checks',
      'o4-mini',
      '/repo',
      'high',
      true,
      expect.any(Function),
      signal,
    );
  });

  it('exec passes prompt through unchanged when no instruction or systemPrompt is set', async () => {
    const { runtime } = makeRuntime();

    await codexProvider.execute(makeRequest({ prompt: 'Only the user prompt' }), runtime);

    expect(mockExecuteOneShot).toHaveBeenCalledWith(
      'Only the user prompt',
      undefined,
      undefined,
      undefined,
      false,
      expect.any(Function),
      runtime.signal,
    );
  });

  it('resume calls executeResume with conversationRef', async () => {
    const { runtime, signal } = makeRuntime();

    await codexProvider.execute(makeRequest({
      action: 'resume',
      conversationRef: 'codex-thread-123',
      prompt: 'Continue',
    }), runtime);

    expect(mockExecuteResume).toHaveBeenCalledWith(
      'codex-thread-123',
      'Continue',
      undefined,
      undefined,
      undefined,
      false,
      expect.any(Function),
      signal,
    );
  });

  it('fork calls executeFork with conversationRef', async () => {
    const { runtime, signal } = makeRuntime();

    await codexProvider.execute(makeRequest({
      action: 'fork',
      conversationRef: 'codex-thread-456',
      prompt: 'Fork this',
    }), runtime);

    expect(mockExecuteFork).toHaveBeenCalledWith(
      'codex-thread-456',
      'Fork this',
      undefined,
      undefined,
      undefined,
      false,
      expect.any(Function),
      signal,
    );
  });

  it('re-throws ClaudeExecParseError from codex exec', async () => {
    const error = new ClaudeExecParseError({
      exitCode: 99,
      stdout: 'bad',
      stderr: 'bad',
      parseError: 'bad output',
    });
    mockExecuteOneShot.mockRejectedValueOnce(error);

    await expect(codexProvider.execute(makeRequest(), makeRuntime().runtime)).rejects.toBe(error);
  });

  it('maps Codex executor output into ProviderResult fields', async () => {
    mockExecuteOneShot.mockResolvedValueOnce({
      response: 'mapped codex text',
      sessionId: 'thread-mapped',
      model: 'o4-mini',
      durationMs: 12,
      exitCode: 3,
      errors: ['executor warning'],
      warnings: ['be careful'],
      aborted: true,
    });

    const result = await codexProvider.execute(makeRequest(), makeRuntime().runtime);

    expect(result).toEqual({
      text: 'mapped codex text',
      conversationRef: 'thread-mapped',
      model: 'o4-mini',
      durationMs: 12,
      aborted: true,
      exitCode: 3,
      errors: ['executor warning'],
      warnings: ['be careful'],
    });
  });
});

describe('claude provider adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteClaudeOneShot.mockResolvedValue({
      response: 'claude response',
      sessionId: 'claude-thread',
      model: 'sonnet',
      durationMs: 20,
      costUsd: 0.001,
      aborted: false,
    });
    mockExecuteClaudeResume.mockResolvedValue({
      response: 'claude resume',
      sessionId: 'claude-thread-resume',
      model: 'sonnet',
      durationMs: 22,
      costUsd: 0.002,
      aborted: false,
    });
    mockExecuteClaudeFork.mockResolvedValue({
      response: 'claude fork',
      sessionId: 'claude-thread-fork',
      model: 'sonnet',
      durationMs: 24,
      costUsd: 0.003,
      aborted: false,
    });
  });

  it('exec combines system-channel instruction with systemPrompt', async () => {
    const { runtime, signal } = makeRuntime();

    await claudeProvider.execute(makeRequest({
      instruction: { channel: 'system', content: 'You are the architect agent' },
      systemPrompt: 'Honor repository policy',
      model: 'sonnet',
      cwd: '/repo',
      effort: 'medium',
      bypassPermissions: true,
    }), runtime);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith('Run checks', {
      model: 'sonnet',
      workingDirectory: '/repo',
      systemPrompt: 'You are the architect agent\n\nHonor repository policy',
      effort: 'medium',
      bypassPermissions: true,
      signal,
      onEvent: expect.any(Function),
    });
  });

  it('exec prepends prompt-channel instruction and keeps systemPrompt separate', async () => {
    const { runtime, signal } = makeRuntime();

    await claudeProvider.execute(makeRequest({
      instruction: { channel: 'prompt', content: 'First follow this instruction' },
      systemPrompt: 'System stays separate',
      model: 'sonnet',
    }), runtime);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith(
      'First follow this instruction\n\n---\n\nRun checks',
      {
        model: 'sonnet',
        workingDirectory: undefined,
        systemPrompt: 'System stays separate',
        effort: undefined,
        bypassPermissions: false,
        signal,
        onEvent: expect.any(Function),
      },
    );
  });

  it('exec passes systemPrompt through unchanged when no instruction is set', async () => {
    const { runtime, signal } = makeRuntime();

    await claudeProvider.execute(makeRequest({
      systemPrompt: 'Just the system prompt',
    }), runtime);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith('Run checks', {
      model: undefined,
      workingDirectory: undefined,
      systemPrompt: 'Just the system prompt',
      effort: undefined,
      bypassPermissions: false,
      signal,
      onEvent: expect.any(Function),
    });
  });

  it('resume calls executeClaudeResume with conversationRef', async () => {
    const { runtime, signal } = makeRuntime();

    await claudeProvider.execute(makeRequest({
      action: 'resume',
      conversationRef: 'claude-thread-123',
      prompt: 'Continue',
      systemPrompt: 'Restore persona',
    }), runtime);

    expect(mockExecuteClaudeResume).toHaveBeenCalledWith('claude-thread-123', 'Continue', {
      model: undefined,
      workingDirectory: undefined,
      systemPrompt: 'Restore persona',
      effort: undefined,
      bypassPermissions: false,
      signal,
      onEvent: expect.any(Function),
    });
  });

  it('returns nonResumable ProviderResult when Claude exec throws ClaudeExecParseError', async () => {
    mockExecuteClaudeOneShot.mockRejectedValueOnce(new ClaudeExecParseError({
      exitCode: 7,
      stdout: 'not json',
      stderr: 'stderr',
      parseError: 'parse failed',
    }));

    const result = await claudeProvider.execute(makeRequest({ model: 'sonnet' }), makeRuntime().runtime);

    expect(result).toEqual({
      text: '',
      notice: 'Claude CLI returned non-JSON output; result is non-resumable.',
      nonResumable: true,
      model: 'sonnet',
      exitCode: 7,
      errors: [{
        exitCode: 7,
        stdout: 'not json',
        stderr: 'stderr',
        parseError: 'parse failed',
      }],
    });
  });

  it('maps Claude executor output into ProviderResult fields including usage.costUsd', async () => {
    mockExecuteClaudeOneShot.mockResolvedValueOnce({
      response: 'mapped claude text',
      sessionId: 'claude-session-9',
      model: 'sonnet',
      durationMs: 18,
      costUsd: 0.42,
      aborted: true,
    });

    const result = await claudeProvider.execute(makeRequest({ model: 'sonnet' }), makeRuntime().runtime);

    expect(result).toEqual({
      text: 'mapped claude text',
      conversationRef: 'claude-session-9',
      model: 'sonnet',
      durationMs: 18,
      aborted: true,
      usage: { costUsd: 0.42 },
    });
  });
});

describe('codex adapter: instruction channel mapping', () => {
  it("channel='system' is treated identically to channel='prompt' — content prepended to prompt", async () => {
    const { runtime, signal } = makeRuntime();

    await codexProvider.execute(makeRequest({
      instruction: { channel: 'system', content: 'System-style instruction' },
      prompt: 'User prompt',
    }), runtime);

    expect(mockExecuteOneShot).toHaveBeenCalledWith(
      'System-style instruction\n\n---\n\nUser prompt',
      undefined,
      undefined,
      undefined,
      false,
      expect.any(Function),
      signal,
    );
  });

  it("channel='system' with systemPrompt also prepends systemPrompt before base prompt", async () => {
    const { runtime, signal } = makeRuntime();

    await codexProvider.execute(makeRequest({
      instruction: { channel: 'system', content: 'Agent rules' },
      systemPrompt: 'System policy',
      prompt: 'Base prompt',
    }), runtime);

    expect(mockExecuteOneShot).toHaveBeenCalledWith(
      'Agent rules\n\n---\n\nSystem policy\n\n---\n\nBase prompt',
      undefined,
      undefined,
      undefined,
      false,
      expect.any(Function),
      signal,
    );
  });
});

describe('codex adapter: nonResumable mapping', () => {
  it('exec with null sessionId result sets nonResumable:true and no conversationRef', async () => {
    mockExecuteOneShot.mockResolvedValueOnce(baseCodexResult({ sessionId: null }));
    const { runtime } = makeRuntime();

    const result = await codexProvider.execute(makeRequest(), runtime);

    expect(result.nonResumable).toBe(true);
    expect(result.conversationRef).toBeUndefined();
  });

  it('fork with null sessionId result sets nonResumable:true and no conversationRef', async () => {
    mockExecuteFork.mockResolvedValueOnce(baseCodexResult({ sessionId: null }));
    const { runtime } = makeRuntime();

    const result = await codexProvider.execute(makeRequest({
      action: 'fork',
      conversationRef: 'thread-src',
    }), runtime);

    expect(result.nonResumable).toBe(true);
    expect(result.conversationRef).toBeUndefined();
  });

  it('resume with null sessionId result falls back to the request conversationRef', async () => {
    mockExecuteResume.mockResolvedValueOnce(baseCodexResult({ sessionId: null }));
    const { runtime } = makeRuntime();

    const result = await codexProvider.execute(makeRequest({
      action: 'resume',
      conversationRef: 'original-ref',
    }), runtime);

    expect(result.conversationRef).toBe('original-ref');
  });
});

describe('codex adapter: missing conversationRef guard', () => {
  it('resume without conversationRef throws immediately', async () => {
    const { runtime } = makeRuntime();

    await expect(
      codexProvider.execute(makeRequest({ action: 'resume', conversationRef: undefined }), runtime),
    ).rejects.toThrow('resume requires conversationRef');
  });

  it('fork without conversationRef throws immediately', async () => {
    const { runtime } = makeRuntime();

    await expect(
      codexProvider.execute(makeRequest({ action: 'fork', conversationRef: undefined }), runtime),
    ).rejects.toThrow('fork requires conversationRef');
  });
});

describe('codex adapter: effort values', () => {
  it("passes 'xhigh' effort through unchanged to executeOneShot", async () => {
    const { runtime, signal } = makeRuntime();

    await codexProvider.execute(makeRequest({ effort: 'xhigh' }), runtime);

    expect(mockExecuteOneShot).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      undefined,
      'xhigh',
      false,
      expect.any(Function),
      signal,
    );
  });
});

describe('claude adapter: ClaudeExecParseError handling', () => {
  it('resume with ClaudeExecParseError returns nonResumable ProviderResult (no rethrow)', async () => {
    mockExecuteClaudeResume.mockRejectedValueOnce(new ClaudeExecParseError({
      exitCode: 3,
      stdout: 'garbage',
      stderr: '',
      parseError: 'unexpected token',
    }));
    const { runtime } = makeRuntime();

    const result = await claudeProvider.execute(makeRequest({
      action: 'resume',
      conversationRef: 'claude-ref',
      model: 'sonnet',
    }), runtime);

    expect(result.nonResumable).toBe(true);
    expect(result.exitCode).toBe(3);
    expect(result.text).toBe('');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toHaveLength(1);
  });

  it('fork with ClaudeExecParseError returns nonResumable ProviderResult (no rethrow)', async () => {
    mockExecuteClaudeFork.mockRejectedValueOnce(new ClaudeExecParseError({
      exitCode: 5,
      stdout: 'not json',
      stderr: 'err',
      parseError: 'bad parse',
    }));
    const { runtime } = makeRuntime();

    const result = await claudeProvider.execute(makeRequest({
      action: 'fork',
      conversationRef: 'claude-ref',
      model: 'opus',
    }), runtime);

    expect(result.nonResumable).toBe(true);
    expect(result.exitCode).toBe(5);
    expect(result.model).toBe('opus');
  });

  it('non-ClaudeExecParseError on exec is re-thrown, not swallowed', async () => {
    const networkError = new Error('ECONNREFUSED');
    mockExecuteClaudeOneShot.mockRejectedValueOnce(networkError);
    const { runtime } = makeRuntime();

    await expect(
      claudeProvider.execute(makeRequest(), runtime),
    ).rejects.toBe(networkError);
  });

  it('non-ClaudeExecParseError on resume is re-thrown, not swallowed', async () => {
    const timeoutError = new Error('spawn timeout');
    mockExecuteClaudeResume.mockRejectedValueOnce(timeoutError);
    const { runtime } = makeRuntime();

    await expect(
      claudeProvider.execute(makeRequest({
        action: 'resume',
        conversationRef: 'ref-1',
      }), runtime),
    ).rejects.toBe(timeoutError);
  });
});

describe('claude adapter: systemPrompt edge cases', () => {
  it('with no instruction and no systemPrompt passes undefined systemPrompt', async () => {
    const { runtime, signal } = makeRuntime();

    await claudeProvider.execute(makeRequest({ prompt: 'bare prompt' }), runtime);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith('bare prompt', {
      model: undefined,
      workingDirectory: undefined,
      systemPrompt: undefined,
      effort: undefined,
      bypassPermissions: false,
      signal,
      onEvent: expect.any(Function),
    });
  });

  it('prompt-channel instruction without systemPrompt leaves systemPrompt undefined', async () => {
    const { runtime, signal } = makeRuntime();

    await claudeProvider.execute(makeRequest({
      instruction: { channel: 'prompt', content: 'Prepend me' },
    }), runtime);

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith(
      'Prepend me\n\n---\n\nRun checks',
      expect.objectContaining({
        systemPrompt: undefined,
        signal,
      }),
    );
  });
});

describe('claude adapter: usage.costUsd mapping', () => {
  it('null costUsd from executor produces no usage field in ProviderResult', async () => {
    mockExecuteClaudeOneShot.mockResolvedValueOnce(baseClaudeResult({ costUsd: null }));
    const { runtime } = makeRuntime();

    const result = await claudeProvider.execute(makeRequest(), runtime);

    expect(result.usage).toBeUndefined();
  });

  it('zero costUsd produces usage.costUsd: 0', async () => {
    mockExecuteClaudeOneShot.mockResolvedValueOnce(baseClaudeResult({ costUsd: 0 }));
    const { runtime } = makeRuntime();

    const result = await claudeProvider.execute(makeRequest(), runtime);

    expect(result.usage).toEqual({ costUsd: 0 });
  });
});

describe('claude adapter: nonResumable when sessionId is null', () => {
  it('exec with null sessionId sets nonResumable:true', async () => {
    mockExecuteClaudeOneShot.mockResolvedValueOnce(baseClaudeResult({ sessionId: null }));
    const { runtime } = makeRuntime();

    const result = await claudeProvider.execute(makeRequest(), runtime);

    expect(result.nonResumable).toBe(true);
    expect(result.conversationRef).toBeUndefined();
  });

  it('fork with null sessionId sets nonResumable:true', async () => {
    mockExecuteClaudeFork.mockResolvedValueOnce(baseClaudeResult({ sessionId: null }));
    const { runtime } = makeRuntime();

    const result = await claudeProvider.execute(makeRequest({
      action: 'fork',
      conversationRef: 'ref-src',
    }), runtime);

    expect(result.nonResumable).toBe(true);
    expect(result.conversationRef).toBeUndefined();
  });
});
