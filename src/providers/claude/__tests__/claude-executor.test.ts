import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../execution/engine.js', () => ({
  spawnCli: vi.fn(),
}));

import { spawnCli } from '../../../execution/engine.js';
import {
  executeClaudeOneShot,
  executeClaudeResume,
  ClaudeExecParseError,
} from '../claude-executor.js';

const mockSpawnCli = vi.mocked(spawnCli);
const baseArgs = ['-p', '--verbose', '--output-format', 'stream-json'];
const defaultEffort = process.env.CORAL_CLAUDE_EFFORT ?? process.env.CORAL_EFFORT ?? 'high';
const defaultEffortArgs = ['--effort', defaultEffort];

function mockCliResult(
  stdout: string,
  overrides: Partial<{ stderr: string; code: number; aborted: boolean }> = {},
): void {
  mockSpawnCli.mockResolvedValue({
    stdout,
    stderr: '',
    code: 0,
    aborted: false,
    ...overrides,
  });
}

function stream(...lines: string[]): string {
  return lines.join('\n');
}

describe('claude-executor', () => {
  beforeEach(() => {
    mockSpawnCli.mockReset();
  });

  it('sends one-shot prompt via stdin with stream-json output args', async () => {
    mockCliResult(stream(
      '{"type":"assistant","message":{"model":"claude-3-5-sonnet","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","result":"hello","session_id":"sess-1","total_cost_usd":0.02}',
    ));

    const result = await executeClaudeOneShot('Say hello', {
      environment: {},
      model: 'claude-3-5-sonnet',
      systemPrompt: 'You are precise',
      workingDirectory: '/tmp/work',
      sessionId: 'bootstrap-id',
    });

    expect(mockSpawnCli).toHaveBeenCalledWith({
      provider: 'claude',
      command: 'claude',
      args: [
        ...baseArgs,
        '--append-system-prompt',
        'You are precise',
        '--model',
        'claude-3-5-sonnet',
        ...defaultEffortArgs,
        '--session-id',
        'bootstrap-id',
      ],
      prompt: 'Say hello',
      cwd: '/tmp/work',
      extraEnv: {},
      signal: undefined,
      onEvent: undefined,
    });

    expect(result).toMatchObject({
      response: 'hello',
      sessionId: 'sess-1',
      model: 'claude-3-5-sonnet',
      costUsd: 0.02,
      aborted: false,
    });
  });

  it('adds --resume and optional --append-system-prompt when resuming', async () => {
    mockCliResult('{"type":"result","result":"done","session_id":"sess-2"}');

    const result = await executeClaudeResume('sess-1', 'Continue', {
      environment: {},
      model: 'claude-sonnet',
      systemPrompt: 'Resume mode',
      workingDirectory: '/tmp/project',
    });

    expect(mockSpawnCli).toHaveBeenCalledWith({
      provider: 'claude',
      command: 'claude',
      args: [
        ...baseArgs,
        '--resume',
        'sess-1',
        '--append-system-prompt',
        'Resume mode',
        '--model',
        'claude-sonnet',
        ...defaultEffortArgs,
      ],
      prompt: 'Continue',
      cwd: '/tmp/project',
      extraEnv: {},
      signal: undefined,
      onEvent: undefined,
    });

    expect(result.response).toBe('done');
    expect(result.sessionId).toBe('sess-2');
  });

  it('appends --effort when effort is set', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-effort"}');

    await executeClaudeOneShot('Use effort', { environment: {}, effort: 'high' });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--effort',
        'high',
      ],
    }));
  });

  it('passes max effort to --effort max', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-effort-map"}');

    await executeClaudeOneShot('Use max effort', { environment: {}, effort: 'max' });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--effort',
        'max',
      ],
    }));
  });

  it('includes --dangerously-skip-permissions for one-shot when bypassPermissions is true', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-5"}');

    await executeClaudeOneShot('Bypass one-shot', { environment: {}, bypassPermissions: true });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--dangerously-skip-permissions',
        ...defaultEffortArgs,
      ],
    }));
  });

  it('includes --dangerously-skip-permissions for resume when bypassPermissions is true', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-6"}');

    await executeClaudeResume('sess-6', 'Bypass resume', { environment: {}, bypassPermissions: true });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--resume',
        'sess-6',
        '--dangerously-skip-permissions',
        ...defaultEffortArgs,
      ],
    }));
  });

  it('parses assistant text blocks when result event has no response text', async () => {
    mockCliResult(stream(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line one\\nline two"}]}}',
      '{"type":"result","session_id":"sess-3","total_cost_usd":0.01}',
    ));

    const result = await executeClaudeOneShot('Emit lines', { environment: {} });

    expect(result.response).toBe('line one\nline two');
    expect(result.sessionId).toBe('sess-3');
  });

  it('returns null sessionId when stream output omits session_id', async () => {
    mockCliResult('{"type":"result","result":"ok"}');

    const result = await executeClaudeOneShot('No session id', { environment: {} });

    expect(result.sessionId).toBeNull();
    expect(result.response).toBe('ok');
  });

  it('passes onEvent callback to spawnCli', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-on-event"}');

    const onEvent = vi.fn();
    await executeClaudeOneShot('stream events', { environment: {}, onEvent });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      onEvent,
    }));
  });

  it('throws structured ClaudeExecParseError when stdout is fully unparseable', async () => {
    mockCliResult('not-json-output', { stderr: 'stderr text', code: 17 });

    const error = await executeClaudeOneShot('bad output', { environment: {} }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeExecParseError);
    if (!(error instanceof ClaudeExecParseError)) return;
    expect(error.failure).toEqual(expect.objectContaining({
      exitCode: 17,
      stdout: 'not-json-output',
      stderr: 'stderr text',
      parseError: 'Fully unparseable stream-json output',
    }));
  });

  it('throws structured ClaudeExecParseError when stdout is empty', async () => {
    mockCliResult('', { stderr: 'stderr text', code: 0 });

    const error = await executeClaudeOneShot('empty output', { environment: {} }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeExecParseError);
    if (!(error instanceof ClaudeExecParseError)) return;
    expect(error.failure).toEqual(expect.objectContaining({
      exitCode: 0,
      stdout: '',
      stderr: 'stderr text',
      parseError: 'Fully unparseable stream-json output',
    }));
  });
});
