import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../shared/types.js';

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
    executeClaudeFork: vi.fn(),
    executeClaudeOneShot: vi.fn(),
    executeClaudeResume: vi.fn(),
  };
});

import {
  ClaudeExecParseError,
  executeClaudeFork,
  executeClaudeOneShot,
  executeClaudeResume,
} from '../claude/claude-executor.js';
import { claudeProvider, OUTPUT_STYLE_OVERRIDE } from '../claude/adapter.js';

const mockExecuteClaudeOneShot = vi.mocked(executeClaudeOneShot);
const mockExecuteClaudeResume = vi.mocked(executeClaudeResume);
const mockExecuteClaudeFork = vi.mocked(executeClaudeFork);

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-1',
    prompt: 'Run checks',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeRuntime() {
  const controller = new AbortController();
  const runCli = vi.fn();
  return {
    runCli,
    runtime: {
      signal: controller.signal,
      onEvent: () => {},
      runCli,
    },
  };
}

function baseClaudeResult(
  overrides: Partial<{
    response: string;
    sessionId: string | null;
    model: string;
    durationMs: number;
    costUsd: number | null;
    aborted: boolean;
  }> = {},
): {
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  costUsd: number | null;
  aborted: boolean;
} {
  return {
    response: 'ok',
    sessionId: 'claude-thread',
    model: 'sonnet',
    durationMs: 15,
    costUsd: 0,
    aborted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteClaudeOneShot.mockResolvedValue(baseClaudeResult());
  mockExecuteClaudeResume.mockResolvedValue(baseClaudeResult({ sessionId: 'claude-resume' }));
  mockExecuteClaudeFork.mockResolvedValue(baseClaudeResult({ sessionId: 'claude-fork' }));
});

describe('claude provider adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteClaudeOneShot.mockResolvedValue(
      baseClaudeResult({
        response: 'claude response',
        durationMs: 20,
        costUsd: 0.001,
      }),
    );
    mockExecuteClaudeResume.mockResolvedValue(
      baseClaudeResult({
        response: 'claude resume',
        sessionId: 'claude-thread-resume',
        durationMs: 22,
        costUsd: 0.002,
      }),
    );
    mockExecuteClaudeFork.mockResolvedValue(
      baseClaudeResult({
        response: 'claude fork',
        sessionId: 'claude-thread-fork',
        durationMs: 24,
        costUsd: 0.003,
      }),
    );
  });

  it('exec combines system-channel instruction with systemPrompt', async () => {
    const { runtime, runCli } = makeRuntime();

    await claudeProvider.execute(
      makeRequest({
        instruction: { channel: 'system', content: 'You are the architect agent' },
        systemPrompt: 'Honor repository policy',
        model: 'sonnet',
        cwd: '/repo',
        effort: 'medium',
        bypassPermissions: true,
      }),
      runtime,
    );

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith('Run checks', {
      model: 'sonnet',
      workingDirectory: '/repo',
      systemPrompt: `You are the architect agent\n\nHonor repository policy\n\n${OUTPUT_STYLE_OVERRIDE}`,
      effort: 'medium',
      bypassPermissions: true,
      environment: {},
      runCli,
      onEvent: expect.any(Function),
    });
  });

  it('exec prepends prompt-channel instruction and keeps systemPrompt separate', async () => {
    const { runtime, runCli } = makeRuntime();

    await claudeProvider.execute(
      makeRequest({
        instruction: { channel: 'prompt', content: 'First follow this instruction' },
        systemPrompt: 'System stays separate',
        model: 'sonnet',
      }),
      runtime,
    );

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith('First follow this instruction\n\n---\n\nRun checks', {
      model: 'sonnet',
      workingDirectory: undefined,
      systemPrompt: `System stays separate\n\n${OUTPUT_STYLE_OVERRIDE}`,
      effort: undefined,
      bypassPermissions: false,
      environment: {},
      runCli,
      onEvent: expect.any(Function),
    });
  });

  it('exec passes systemPrompt through unchanged when no instruction is set', async () => {
    const { runtime, runCli } = makeRuntime();

    await claudeProvider.execute(
      makeRequest({
        systemPrompt: 'Just the system prompt',
      }),
      runtime,
    );

    expect(mockExecuteClaudeOneShot).toHaveBeenCalledWith('Run checks', {
      model: undefined,
      workingDirectory: undefined,
      systemPrompt: `Just the system prompt\n\n${OUTPUT_STYLE_OVERRIDE}`,
      effort: undefined,
      bypassPermissions: false,
      environment: {},
      runCli,
      onEvent: expect.any(Function),
    });
  });

  it('resume calls executeClaudeResume with conversationRef', async () => {
    const { runtime, runCli } = makeRuntime();

    await claudeProvider.execute(
      makeRequest({
        action: 'resume',
        conversationRef: 'claude-thread-123',
        prompt: 'Continue',
        systemPrompt: 'Restore persona',
      }),
      runtime,
    );

    expect(mockExecuteClaudeResume).toHaveBeenCalledWith('claude-thread-123', 'Continue', {
      model: undefined,
      workingDirectory: undefined,
      systemPrompt: `Restore persona\n\n${OUTPUT_STYLE_OVERRIDE}`,
      effort: undefined,
      bypassPermissions: false,
      environment: {},
      runCli,
      onEvent: expect.any(Function),
    });
  });

  it('returns nonResumable ProviderResult when Claude exec throws ClaudeExecParseError', async () => {
    mockExecuteClaudeOneShot.mockRejectedValueOnce(
      new ClaudeExecParseError({
        exitCode: 7,
        stdout: 'not json',
        stderr: 'stderr',
        parseError: 'parse failed',
      }),
    );

    const result = await claudeProvider.execute(makeRequest({ model: 'sonnet' }), makeRuntime().runtime);

    expect(result).toEqual({
      content: '',
      notice: 'Claude CLI returned non-JSON output; result is non-resumable.',
      nonResumable: true,
      model: 'sonnet',
      exitCode: 7,
      errors: [
        {
          exitCode: 7,
          stdout: 'not json',
          stderr: 'stderr',
          parseError: 'parse failed',
        },
      ],
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
      content: 'mapped claude text',
      conversationRef: 'claude-session-9',
      model: 'sonnet',
      durationMs: 18,
      aborted: true,
      usage: { costUsd: 0.42 },
    });
  });
});
