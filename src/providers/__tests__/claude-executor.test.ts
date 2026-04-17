import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeExecOptions } from '../claude/claude-executor.js';
import { executeClaudeOneShot, executeClaudeResume, ClaudeExecParseError } from '../claude/claude-executor.js';

const baseArgs = ['-p', '--verbose', '--output-format', 'stream-json'];

let mockRunCli: ReturnType<typeof vi.fn>;

function withRunner(overrides: Partial<ClaudeExecOptions> = {}): ClaudeExecOptions {
  return {
    environment: {},
    runCli: mockRunCli as ClaudeExecOptions['runCli'],
    ...overrides,
  };
}

function mockCliResult(
  stdout: string,
  overrides: Partial<{ stderr: string; code: number; aborted: boolean }> = {},
): void {
  mockRunCli.mockResolvedValue({
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
    mockRunCli = vi.fn();
  });

  it('sends one-shot prompt via the injected runner with stream-json output args', async () => {
    mockCliResult(
      stream(
        '{"type":"assistant","message":{"model":"claude-3-5-sonnet","content":[{"type":"text","text":"hello"}]}}',
        '{"type":"result","result":"hello","session_id":"sess-1","total_cost_usd":0.02}',
      ),
    );

    const result = await executeClaudeOneShot(
      'Say hello',
      withRunner({
        model: 'claude-3-5-sonnet',
        systemPrompt: 'You are precise',
        workingDirectory: '/tmp/work',
        sessionId: 'bootstrap-id',
      }),
    );

    expect(mockRunCli).toHaveBeenCalledWith({
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
      extraEnv: {},
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

    const result = await executeClaudeResume(
      'sess-1',
      'Continue',
      withRunner({
        model: 'claude-sonnet',
        systemPrompt: 'Resume mode',
        workingDirectory: '/tmp/project',
      }),
    );

    expect(mockRunCli).toHaveBeenCalledWith({
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
      extraEnv: {},
      onEvent: undefined,
    });

    expect(result.response).toBe('done');
    expect(result.sessionId).toBe('sess-2');
  });

  it('appends --effort when effort is set', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-effort"}');

    await executeClaudeOneShot('Use effort', withRunner({ effort: 'high' }));

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [...baseArgs, '--effort', 'high'],
      }),
    );
  });

  it('passes max effort to --effort max', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-effort-map"}');

    await executeClaudeOneShot('Use max effort', withRunner({ effort: 'max' }));

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [...baseArgs, '--effort', 'max'],
      }),
    );
  });

  it('includes --dangerously-skip-permissions for one-shot when bypassPermissions is true', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-5"}');

    await executeClaudeOneShot('Bypass one-shot', withRunner({ bypassPermissions: true }));

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [...baseArgs, '--dangerously-skip-permissions'],
      }),
    );
  });

  it('includes --dangerously-skip-permissions for resume when bypassPermissions is true', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-6"}');

    await executeClaudeResume('sess-6', 'Bypass resume', withRunner({ bypassPermissions: true }));

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [...baseArgs, '--resume', 'sess-6', '--dangerously-skip-permissions'],
      }),
    );
  });

  it('parses assistant text blocks when result event has no response text', async () => {
    mockCliResult(
      stream(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"line one\\nline two"}]}}',
        '{"type":"result","session_id":"sess-3","total_cost_usd":0.01}',
      ),
    );

    const result = await executeClaudeOneShot('Emit lines', withRunner());

    expect(result.response).toBe('line one\nline two');
    expect(result.sessionId).toBe('sess-3');
  });

  it('returns null sessionId when stream output omits session_id', async () => {
    mockCliResult('{"type":"result","result":"ok"}');

    const result = await executeClaudeOneShot('No session id', withRunner());

    expect(result.sessionId).toBeNull();
    expect(result.response).toBe('ok');
  });

  it('passes onEvent callback to the runner port', async () => {
    mockCliResult('{"type":"result","result":"ok","session_id":"sess-on-event"}');

    const onEvent = vi.fn();
    await executeClaudeOneShot('stream events', withRunner({ onEvent }));

    expect(mockRunCli).toHaveBeenCalledWith(expect.objectContaining({ onEvent }));
  });

  it('throws structured ClaudeExecParseError when stdout is fully unparseable', async () => {
    mockCliResult('not-json-output', { stderr: 'stderr text', code: 17 });

    const error = await executeClaudeOneShot('bad output', withRunner()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeExecParseError);
    if (!(error instanceof ClaudeExecParseError)) return;
    expect(error.failure).toEqual(
      expect.objectContaining({
        exitCode: 17,
        stdout: 'not-json-output',
        stderr: 'stderr text',
        parseError: 'Fully unparseable stream-json output',
      }),
    );
  });

  it('throws structured ClaudeExecParseError when stdout is empty', async () => {
    mockCliResult('', { stderr: 'stderr text', code: 0 });

    const error = await executeClaudeOneShot('empty output', withRunner()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeExecParseError);
    if (!(error instanceof ClaudeExecParseError)) return;
    expect(error.failure).toEqual(
      expect.objectContaining({
        exitCode: 0,
        stdout: '',
        stderr: 'stderr text',
        parseError: 'Fully unparseable stream-json output',
      }),
    );
  });
});
