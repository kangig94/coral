import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../runner/engine.js', () => ({
  spawnCli: vi.fn(),
}));

import { spawnCli } from '../../runner/engine.js';
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

  it('sends one-shot prompt via stdin with json output args', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: JSON.stringify({
        type: 'result',
        result: 'hello',
        session_id: 'sess-1',
        total_cost_usd: 0.02,
        model: 'claude-3-5-sonnet',
      }),
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
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
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
      stdout: JSON.stringify({ type: 'result', result: { response: 'done' }, session_id: 'sess-2' }),
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
        '--output-format',
        'json',
        '--dangerously-skip-permissions',
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
    });

    expect(result.response).toBe('done');
    expect(result.sessionId).toBe('sess-2');
  });

  it('parses nested content-array text output', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: JSON.stringify({
        result: {
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
          ],
        },
        session_id: 'sess-3',
      }),
      stderr: '',
      code: 0,
      aborted: false,
    });

    const result = await executeClaudeOneShot('Emit lines');

    expect(result.response).toBe('line one\nline two');
    expect(result.sessionId).toBe('sess-3');
  });

  it('returns null sessionId when JSON output omits session_id', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: JSON.stringify({ type: 'result', result: 'ok' }),
      stderr: '',
      code: 0,
      aborted: false,
    });

    const result = await executeClaudeOneShot('No session id');

    expect(result.sessionId).toBeNull();
    expect(result.response).toBe('ok');
  });

  it('throws structured ClaudeExecParseError when stdout is non-JSON', async () => {
    mockSpawnCli.mockResolvedValue({
      stdout: 'not-json-output',
      stderr: 'stderr text',
      code: 17,
      aborted: false,
    });

    await expect(executeClaudeOneShot('bad output')).rejects.toBeInstanceOf(ClaudeExecParseError);

    try {
      await executeClaudeOneShot('bad output');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ClaudeExecParseError);
      const parseError = error as ClaudeExecParseError;
      expect(parseError.failure).toEqual(expect.objectContaining({
        exitCode: 17,
        stdout: 'not-json-output',
        stderr: 'stderr text',
      }));
    }
  });
});
