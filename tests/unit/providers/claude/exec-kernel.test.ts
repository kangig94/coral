import { describe, expect, it, vi } from 'vitest';

import type { ProviderEventBody, ProviderRequest, ProviderRuntime } from '#src/providers/contract.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { claudeExecKernel, isClaudeExecParseError } from '#src/providers/claude/exec-kernel.js';
import { buildPreparedClaudeRequest } from '#src/providers/claude/request-prep.js';

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'fork',
    sessionId: 'job-claude-exec-kernel',
    name: 'claude',
    conversationRef: 'parent-session',
    prompt: 'Run the task',
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeRuntime(
  runCliImpl?: ProviderRuntime['runCli'],
): ProviderRuntime & {
  acquireServer: ReturnType<typeof vi.fn>;
  runCli: ReturnType<typeof vi.fn>;
  continuityBridge: {
    checkpoint: ReturnType<typeof vi.fn>;
    transportClosed: ReturnType<typeof vi.fn>;
  };
} {
  const runCli = vi.fn(
    runCliImpl ??
      (async () => ({
        stdout: '',
        stderr: '',
        code: 0,
        aborted: false,
      })),
  );
  const acquireServer = vi.fn();
  const checkpoint = vi.fn();
  const transportClosed = vi.fn();

  return {
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> | null),
    },
    runCli,
    acquireServer,
    continuityBridge: {
      checkpoint,
      transportClosed,
    },
  };
}

function getTerminal(events: ProviderEventBody[]) {
  const terminal = events.find((event) => event.kind === 'terminal');
  if (!terminal || terminal.kind !== 'terminal') {
    throw new Error('Terminal event missing.');
  }

  return terminal;
}

describe('claude exec-kernel', () => {
  it('runs fork requests with the expected Claude CLI args and checkpoints the forked session', async () => {
    const request = makeRequest({
      prompt: 'Say hello',
      cwd: '/tmp/work',
      conversationRef: 'parent-session-1',
      model: 'claude-3-5-sonnet',
      systemPrompt: 'You are precise',
      effort: 'high',
      bypassPermissions: true,
    });
    const prepared = buildPreparedClaudeRequest(request);
    const runtime = makeRuntime(async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: 'hello',
        session_id: 'fork-session-1',
        model: 'claude-3-5-sonnet',
        total_cost_usd: 0.02,
      }),
      stderr: '',
      code: 0,
      aborted: false,
    }));

    const events = await collectProviderEvents(claudeExecKernel(request, runtime));

    expect(runtime.runCli).toHaveBeenCalledWith({
      command: 'claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--resume',
        'parent-session-1',
        '--fork-session',
        '--dangerously-skip-permissions',
        '--append-system-prompt',
        prepared.systemPrompt!,
        '--model',
        prepared.model!,
        '--effort',
        prepared.effort,
      ],
      prompt: prepared.prompt,
      cwd: '/tmp/work',
      extraEnv: {},
      onEvent: expect.any(Function),
    });

    expect(runtime.continuityBridge.checkpoint).toHaveBeenCalledWith({
      conversationRef: 'fork-session-1',
      resumable: true,
      providerContinuity: expect.objectContaining({
        conversationRef: 'fork-session-1',
      }),
    });
    expect(getTerminal(events).terminal).toMatchObject({
      content: 'hello',
      model: 'claude-3-5-sonnet',
      outcome: { kind: 'completed' },
      usage: { costUsd: 0.02 },
    });
  });

  it('emits progress from Claude stream events and falls back to assistant text when the result event omits text', async () => {
    const runtime = makeRuntime(async (cliRequest) => {
      cliRequest.onEvent?.('not-json');
      cliRequest.onEvent?.(
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4',
            content: [{ type: 'text', text: 'Working...' }],
          },
        }),
      );

      return {
        stdout: [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"line one\\nline two"}]}}',
          '{"type":"result","session_id":"fork-session-2","total_cost_usd":0.01}',
        ].join('\n'),
        stderr: '',
        code: 0,
        aborted: false,
      };
    });

    const events = await collectProviderEvents(claudeExecKernel(makeRequest(), runtime));

    expect(events.filter((event) => event.kind === 'progress')).toEqual([
      { kind: 'progress', message: 'Generating response...' },
    ]);
    expect(getTerminal(events).terminal).toMatchObject({
      content: 'line one\nline two',
      outcome: { kind: 'completed' },
      usage: { costUsd: 0.01 },
    });
  });

  it.each([
    ['not-json-output', 17],
    ['', 0],
  ])('classifies fully unparseable fork output as a Claude parse error for stdout=%j', async (stdout, code) => {
    const runtime = makeRuntime(async () => ({
      stdout,
      stderr: 'stderr text',
      code,
      aborted: false,
    }));

    const error = await collectProviderEvents(claudeExecKernel(makeRequest(), runtime)).catch((caught: unknown) => caught);

    expect(isClaudeExecParseError(error)).toEqual({
      exitCode: code,
      stdout,
      stderr: 'stderr text',
      parseError: 'Fully unparseable stream-json output',
    });
  });
});
