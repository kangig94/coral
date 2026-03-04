import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../runner/engine.js', () => ({
  spawnCli: vi.fn(),
}));

import { spawnCli } from '../../../runner/engine.js';
import {
  executeClaudeOneShot,
  executeClaudeResume,
  ClaudeExecParseError,
} from '../claude-executor.js';

const mockSpawnCli = vi.mocked(spawnCli);
const baseArgs = ['-p', '--verbose', '--output-format', 'stream-json'];

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
        '--session-id',
        'bootstrap-id',
      ],
      prompt: 'Say hello',
      cwd: '/tmp/work',
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
      ],
      prompt: 'Continue',
      cwd: '/tmp/project',
      signal: undefined,
      onEvent: undefined,
    });

    expect(result.response).toBe('done');
    expect(result.sessionId).toBe('sess-2');
  });

  it('appends --effort when effort is set', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-effort"}');

    await executeClaudeOneShot('Use effort', { effort: 'high' });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--effort',
        'high',
      ],
    }));
  });

  it('maps xhigh effort to --effort high', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-effort-map"}');

    await executeClaudeOneShot('Use max effort', { effort: 'xhigh' });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--effort',
        'high',
      ],
    }));
  });

  it('includes --dangerously-skip-permissions for one-shot when bypassPermissions is true', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-5"}');

    await executeClaudeOneShot('Bypass one-shot', { bypassPermissions: true });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--dangerously-skip-permissions',
      ],
    }));
  });

  it('includes --dangerously-skip-permissions for resume when bypassPermissions is true', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-6"}');

    await executeClaudeResume('sess-6', 'Bypass resume', { bypassPermissions: true });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        ...baseArgs,
        '--resume',
        'sess-6',
        '--dangerously-skip-permissions',
      ],
    }));
  });

  it('parses assistant text blocks when result event has no response text', async () => {
    mockCliResult(stream(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"line one\\nline two"}]}}',
      '{"type":"result","session_id":"sess-3","total_cost_usd":0.01}',
    ));

    const result = await executeClaudeOneShot('Emit lines');

    expect(result.response).toBe('line one\nline two');
    expect(result.sessionId).toBe('sess-3');
  });

  it('returns null sessionId when stream output omits session_id', async () => {
    mockCliResult('{"type":"result","result":"ok"}');

    const result = await executeClaudeOneShot('No session id');

    expect(result.sessionId).toBeNull();
    expect(result.response).toBe('ok');
  });

  it('passes onEvent callback to spawnCli', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-on-event"}');

    const onEvent = vi.fn();
    await executeClaudeOneShot('stream events', { onEvent });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      onEvent,
    }));
  });

  it('throws structured ClaudeExecParseError when stdout is fully unparseable', async () => {
    mockCliResult('not-json-output', { stderr: 'stderr text', code: 17 });

    const error = await executeClaudeOneShot('bad output').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeExecParseError);
    if (!(error instanceof ClaudeExecParseError)) return;
    expect(error.failure).toEqual(expect.objectContaining({
      exitCode: 17,
      stdout: 'not-json-output',
      stderr: 'stderr text',
      parseError: 'Fully unparseable stream-json output',
    }));
  });
});
