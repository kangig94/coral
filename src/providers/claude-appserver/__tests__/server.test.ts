import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { isRecord } from '../../../shared/mcp-utils.js';
import { buildClaudeChildArgs, createClaudeBrokerServer } from '../server.js';
import { createBrokerSession, type ClaudeBrokerChild, type ClaudeBrokerSession } from '../session.js';
import {
  CLAUDE_BROKER_BUSY_RPC_CODE,
  type ClaudeBrokerNotification,
  type SessionEnsureParams,
} from '../protocol.js';

const BOOTSTRAP: SessionEnsureParams = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:abc123',
  permissionMode: 'bypassPermissions',
  systemPrompt: 'Stay concise.',
};

class FakeClaudeChild implements ClaudeBrokerChild {
  readonly writes: unknown[] = [];

  private readonly stdoutHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void>();
  private readonly stderrHandlers = new Set<(chunk: string) => void>();

  constructor(private readonly autoAckControlRequests = true) {}

  writeLine(line: string): void {
    const parsed = JSON.parse(line) as {
      type?: string;
      request_id?: string;
      request?: { subtype?: string };
    };
    this.writes.push(parsed);

    if (this.autoAckControlRequests && parsed.type === 'control_request' && typeof parsed.request_id === 'string') {
      queueMicrotask(() => {
        this.emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: parsed.request_id,
            response:
              parsed.request?.subtype === 'initialize'
                ? {
                    commands: [],
                    output_style: 'normal',
                    available_output_styles: ['normal'],
                    models: [],
                    account: {},
                    pid: 1234,
                  }
                : {},
          },
        });
      });
    }
  }

  kill(_signal?: NodeJS.Signals): void {
    this.emitExit({ code: 0, signal: null });
  }

  onStdoutLine(handler: (line: string) => void): () => void {
    this.stdoutHandlers.add(handler);
    return () => {
      this.stdoutHandlers.delete(handler);
    };
  }

  onExit(handler: (event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  onStderrChunk(handler: (chunk: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => {
      this.stderrHandlers.delete(handler);
    };
  }

  emit(message: unknown): void {
    const line = JSON.stringify(message);
    for (const handler of this.stdoutHandlers) {
      handler(line);
    }
  }

  emitSystemInit(sessionId: string): void {
    this.emit({
      type: 'system',
      subtype: 'init',
      uuid: `system-${sessionId}`,
      session_id: sessionId,
      apiKeySource: 'user',
      claude_code_version: '1.0.0',
      cwd: '/workspace',
      tools: [],
      mcp_servers: [],
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      slash_commands: [],
      output_style: 'normal',
      skills: [],
      plugins: [],
    });
  }

  emitAssistantTool(sessionId: string, toolName: string, input: Record<string, unknown>): void {
    this.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'tool_use',
            id: `tool-${toolName}`,
            name: toolName,
            input,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: `assistant-${toolName}`,
      session_id: sessionId,
    });
  }

  emitPermissionRequest(requestId: string, toolName: string, input: Record<string, unknown>): void {
    this.emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input,
        tool_use_id: `toolu-${requestId}`,
      },
    });
  }

  emitHookProgress(sessionId: string, output: string): void {
    this.emit({
      type: 'system',
      subtype: 'hook_progress',
      uuid: `hook-${sessionId}`,
      session_id: sessionId,
      hook_id: 'hook-1',
      hook_name: 'formatter',
      hook_event: 'post_tool',
      stdout: '',
      stderr: '',
      output,
    });
  }

  emitResult(sessionId: string, result = 'done', costUsd = 0.1): void {
    this.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 25,
      duration_api_ms: 20,
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: costUsd,
      usage: { output_tokens: 4 },
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: costUsd,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      },
      permission_denials: [],
      uuid: `result-${sessionId}`,
      session_id: sessionId,
      result,
    });
  }

  emitStderr(chunk: string): void {
    for (const handler of this.stderrHandlers) {
      handler(chunk);
    }
  }

  emitExit(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
    for (const handler of this.exitHandlers) {
      handler(event);
    }
  }
}

function parseLines(output: string): Array<Record<string, unknown>> {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function collectNotifications(session: ClaudeBrokerSession): ClaudeBrokerNotification[] {
  const notifications: ClaudeBrokerNotification[] = [];
  session.subscribeNotifications((notification) => {
    notifications.push(notification);
  });
  return notifications;
}

describe('buildClaudeChildArgs', () => {
  it('builds the persistent Claude child argv for fresh and resumed sessions', () => {
    expect(buildClaudeChildArgs(BOOTSTRAP)).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--append-system-prompt',
      'Stay concise.',
      '--dangerously-skip-permissions',
    ]);

    expect(
      buildClaudeChildArgs({
        ...BOOTSTRAP,
        conversationRef: 'sess-resume',
      }),
    ).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--resume',
      'sess-resume',
      '--append-system-prompt',
      'Stay concise.',
      '--dangerously-skip-permissions',
    ]);
  });
});

describe('Claude broker session', () => {
  it('bootstraps once, emits session updates, and probes continuity', async () => {
    const child = new FakeClaudeChild();
    const spawnChild = vi.fn(async () => child);
    const session = createBrokerSession({ spawnChild });
    const notifications = collectNotifications(session);

    const firstEnsure = await session.sessionEnsure(BOOTSTRAP);
    expect(firstEnsure.bootstrapSignature).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:abc123',
      permissionMode: 'bypassPermissions',
    });
    expect(firstEnsure.initialized).toBe(true);
    expect(firstEnsure.sessionId).toBeNull();
    expect(spawnChild).toHaveBeenCalledTimes(1);

    child.emitSystemInit('sess-1');
    await flush();

    const secondEnsure = await session.sessionEnsure(BOOTSTRAP);
    expect(secondEnsure.sessionId).toBe('sess-1');
    expect(spawnChild).toHaveBeenCalledTimes(1);

    const initializeRequests = child.writes.filter(
      (message) =>
        isRecord(message) &&
        message.type === 'control_request' &&
        isRecord(message.request) &&
        message.request.subtype === 'initialize',
    );
    expect(initializeRequests).toHaveLength(1);

    expect(notifications).toContainEqual({
      method: 'session/updated',
      params: {
        bootstrapSignature: firstEnsure.bootstrapSignature,
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      },
    });

    await expect(session.sessionProbe({ conversationRef: 'sess-1' })).resolves.toMatchObject({
      status: 'available',
      conversationRef: 'sess-1',
    });
    await expect(session.sessionProbe({ conversationRef: 'sess-other' })).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('rejects overlapping turns, routes interrupt idempotently, and completes from Claude result events', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-turn');
    await flush();

    await expect(
      session.turnStart({
        brokerTurnId: 'turn-1',
        prompt: 'hello',
        model: 'claude-sonnet-4-6',
        maxThinkingTokens: 256,
      }),
    ).resolves.toEqual({
      brokerTurnId: 'turn-1',
      sessionId: 'sess-turn',
      conversationRef: 'sess-turn',
    });

    await expect(
      session.turnStart({
        brokerTurnId: 'turn-2',
        prompt: 'overlap',
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BUSY_RPC_CODE,
    });

    await expect(session.turnInterrupt({})).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: true,
    });
    await expect(session.turnInterrupt({ brokerTurnId: 'stale-turn' })).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: false,
    });

    child.emitResult('sess-turn', 'answer', 0.123);
    await flush();

    const controlRequests = child.writes.filter(
      (message) => isRecord(message) && message.type === 'control_request' && isRecord(message.request),
    );
    const subtypes = controlRequests.map((message) => String((message.request as Record<string, unknown>).subtype));
    expect(subtypes).toContain('set_model');
    expect(subtypes).toContain('set_max_thinking_tokens');
    expect(subtypes.filter((subtype) => subtype === 'interrupt')).toHaveLength(1);

    await expect(session.turnInterrupt({ brokerTurnId: 'turn-1' })).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: false,
    });

    expect(notifications).toContainEqual({
      method: 'turn/completed',
      params: {
        brokerTurnId: 'turn-1',
        sessionId: 'sess-turn',
        conversationRef: 'sess-turn',
        result: 'answer',
        model: 'claude-sonnet-4-6',
        durationMs: 25,
        numTurns: 1,
        costUsd: 0.123,
        usage: { output_tokens: 4 },
        isError: false,
        subtype: 'success',
        errors: undefined,
      },
    });
  });

  it('auto-allows tool permission requests and emits assistant/system progress', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-progress');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-progress', prompt: 'work' });

    child.emitPermissionRequest('req-1', 'Write', { file_path: '/workspace/out.txt' });
    child.emitAssistantTool('sess-progress', 'Read', { file_path: '/workspace/in.txt' });
    child.emitHookProgress('sess-progress', 'formatter: updated output');
    await flush();

    const controlResponses = child.writes.filter(
      (message) =>
        isRecord(message) &&
        message.type === 'control_response' &&
        isRecord(message.response) &&
        message.response.request_id === 'req-1',
    );
    expect(controlResponses).toHaveLength(1);
    expect((controlResponses[0].response as Record<string, unknown>).response).toEqual({ behavior: 'allow' });

    const progressMessages = notifications
      .filter((notification): notification is Extract<ClaudeBrokerNotification, { method: 'turn/progress' }> => notification.method === 'turn/progress')
      .map((notification) => notification.params.message);
    expect(progressMessages.some((message) => message.includes('Write'))).toBe(true);
    expect(progressMessages.some((message) => message.includes('Read'))).toBe(true);
    expect(progressMessages.some((message) => message.includes('formatter'))).toBe(true);
  });

  it('turns child exit into turn failure and resolves the closed signal with an error', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-fail');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-fail', prompt: 'long run' });

    child.emitStderr('fatal stderr chunk');
    child.emitExit({ code: 1, signal: null });

    const closed = await session.closed;
    expect(closed).toBeInstanceOf(Error);

    await flush();
    const failed = notifications.find((notification) => notification.method === 'turn/failed');
    expect(failed).toEqual({
      method: 'turn/failed',
      params: {
        brokerTurnId: 'turn-fail',
        message: 'Claude child exited unexpectedly (exit 1).',
        sessionId: 'sess-fail',
        conversationRef: 'sess-fail',
        stderr: 'fatal stderr chunk',
      },
    });
  });
});

describe('Claude broker JSON-RPC server', () => {
  it('frames JSON-RPC requests and notifications on stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();

    let outputText = '';
    output.on('data', (chunk) => {
      outputText += chunk.toString();
    });

    let notificationHandler: ((notification: ClaudeBrokerNotification) => void) | null = null;
    const session: ClaudeBrokerSession = {
      closed: Promise.resolve(),
      sessionEnsure: vi.fn(async () => ({
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:abc123',
          permissionMode: 'bypassPermissions',
        },
        sessionId: null,
        conversationRef: null,
        activeTurnId: null,
        initialized: true,
      })),
      sessionProbe: vi.fn(async () => ({
        status: 'available',
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:abc123',
          permissionMode: 'bypassPermissions',
        },
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
        activeTurnId: null,
      })),
      turnStart: vi.fn(async () => ({
        brokerTurnId: 'turn-1',
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      })),
      turnInterrupt: vi.fn(async () => ({
        brokerTurnId: 'turn-1',
        interrupted: true,
      })),
      shutdown: vi.fn(async () => {}),
      subscribeNotifications(handler) {
        notificationHandler = handler;
        return () => {
          notificationHandler = null;
        };
      },
    };

    const exit = vi.fn();
    createClaudeBrokerServer({
      input,
      output,
      errorOutput,
      session,
      exit,
    }).start();

    input.write('not json\n');
    await flush();
    expect(parseLines(outputText)[0]).toMatchObject({
      id: null,
      error: { code: -32700 },
    });

    outputText = '';
    input.write(`${JSON.stringify({ id: 1, method: 'session/ensure', params: BOOTSTRAP })}\n`);
    await flush();
    expect(parseLines(outputText)[0]).toMatchObject({
      id: 1,
      result: {
        initialized: true,
      },
    });

    outputText = '';
    notificationHandler?.({
      method: 'turn/progress',
      params: {
        brokerTurnId: 'turn-1',
        message: 'Read(src/app.ts)',
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      },
    });
    await flush();
    expect(parseLines(outputText)[0]).toEqual({
      method: 'turn/progress',
      params: {
        brokerTurnId: 'turn-1',
        message: 'Read(src/app.ts)',
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      },
    });

    input.write(`${JSON.stringify({ id: 2, method: 'broker/shutdown', params: {} })}\n`);
    await flush();
    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
