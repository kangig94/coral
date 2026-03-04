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

describe('claude-executor', () => {
  beforeEach(() => {
    mockSpawnCli.mockReset();
  });

  it('sends one-shot prompt via stdin with stream-json output args', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: [
        '{"type":"assistant","message":{"model":"claude-3-5-sonnet","content":[{"type":"text","text":"hello"}]}}',
        '{"type":"result","result":"hello","session_id":"sess-1","total_cost_usd":0.02}',
      ].join('\n'),
      stderr: '',
      code: 0,
      aborted: false,
    });

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
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
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
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"done","session_id":"sess-2"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    const result = await executeClaudeResume('sess-1', 'Continue', {
      model: 'claude-sonnet',
      systemPrompt: 'Resume mode',
      workingDirectory: '/tmp/project',
    });

    expect(mockSpawnCli).toHaveBeenCalledWith({
      provider: 'claude',
      command: 'claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
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
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"ok","session_id":"sess-effort"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    await executeClaudeOneShot('Use effort', { effort: 'high' });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--effort',
        'high',
      ],
    }));
  });

  it('maps xhigh effort to --effort high', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"ok","session_id":"sess-effort-map"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    await executeClaudeOneShot('Use max effort', { effort: 'xhigh' });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--effort',
        'high',
      ],
    }));
  });

  it('includes --dangerously-skip-permissions for one-shot when bypassPermissions is true', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"ok","session_id":"sess-5"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    await executeClaudeOneShot('Bypass one-shot', { bypassPermissions: true });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
      ],
    }));
  });

  it('includes --dangerously-skip-permissions for resume when bypassPermissions is true', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"ok","session_id":"sess-6"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    await executeClaudeResume('sess-6', 'Bypass resume', { bypassPermissions: true });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--resume',
        'sess-6',
        '--dangerously-skip-permissions',
      ],
    }));
  });

  it('parses assistant text blocks when result event has no response text', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"line one\\nline two"}]}}',
        '{"type":"result","session_id":"sess-3","total_cost_usd":0.01}',
      ].join('\n'),
      stderr: '',
      code: 0,
      aborted: false,
    });

    const result = await executeClaudeOneShot('Emit lines');

    expect(result.response).toBe('line one\nline two');
    expect(result.sessionId).toBe('sess-3');
  });

  it('returns null sessionId when stream output omits session_id', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"ok"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    const result = await executeClaudeOneShot('No session id');

    expect(result.sessionId).toBeNull();
    expect(result.response).toBe('ok');
  });

  it('passes onEvent callback to spawnCli', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: '{"type":"result","result":"ok","session_id":"sess-on-event"}',
      stderr: '',
      code: 0,
      aborted: false,
    });

    const onEvent = vi.fn();
    await executeClaudeOneShot('stream events', { onEvent });

    expect(mockSpawnCli).toHaveBeenCalledWith(expect.objectContaining({
      onEvent,
    }));
  });

  it('throws structured ClaudeExecParseError when stdout is fully unparseable', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: 'not-json-output',
      stderr: 'stderr text',
      code: 17,
      aborted: false,
    });

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
