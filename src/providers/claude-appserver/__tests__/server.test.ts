import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRecord } from '../../../shared/mcp-utils.js';
import { buildClaudeChildArgs, createClaudeBrokerServer } from '../server.js';
import {
  buildClaudeChildEnv,
  createBrokerSession,
  hashClaudeChildEnv,
  type ClaudeBrokerChild,
  type ClaudeBrokerSession,
} from '../session.js';
import {
  CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
  CLAUDE_BROKER_BUSY_RPC_CODE,
  CLAUDE_BROKER_STATE_RPC_CODE,
  type ClaudeBrokerNotification,
  type SessionEnsureParams,
} from '../protocol.js';

const BOOTSTRAP: SessionEnsureParams = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:abc123',
  permissionMode: 'bypassPermissions',
  systemPrompt: 'Stay concise.',
};

const MODEL = 'claude-sonnet-4-6';

class FakeClaudeChild implements ClaudeBrokerChild {
  readonly writes: unknown[] = [];
  readonly kills: Array<NodeJS.Signals | undefined> = [];

  private readonly stdoutHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void>();
  private readonly stderrHandlers = new Set<(chunk: string) => void>();

  constructor(
    private readonly autoAckControlRequests = true,
    private readonly exitOnKill = true,
  ) {}

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
    this.kills.push(_signal);
    if (this.exitOnKill) {
      this.emitExit({ code: 0, signal: null });
    }
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

  emitControlSuccess(requestId: string, subtype?: string): void {
    this.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response:
          subtype === 'initialize'
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
      model: MODEL,
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
        model: MODEL,
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
        [MODEL]: {
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

  emitResultWithoutCost(sessionId: string, result = 'done'): void {
    this.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 25,
      duration_api_ms: 20,
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      usage: { output_tokens: 4 },
      modelUsage: {
        [MODEL]: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      },
      permission_denials: [],
      uuid: `result-missing-cost-${sessionId}`,
      session_id: sessionId,
      result,
    });
  }

  emitStderr(chunk: string): void {
    for (const handler of this.stderrHandlers) {
      handler(chunk);
    }
  }

  emitUnknownControlRequest(requestId: string): void {
    this.emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'request_file_access',
        path: '/etc/passwd',
      },
    });
  }

  crash(exitCode: number | null = 1): void {
    this.emitExit({ code: exitCode, signal: null });
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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

function countControlRequests(child: FakeClaudeChild, subtype: string): number {
  return child.writes.filter((message) => {
    return (
      isRecord(message) &&
      message.type === 'control_request' &&
      isRecord(message.request) &&
      message.request.subtype === subtype
    );
  }).length;
}

async function ensureSession(
  session: ClaudeBrokerSession,
  params: Partial<SessionEnsureParams> = {},
) {
  return session.sessionEnsure({
    ...BOOTSTRAP,
    ...params,
  });
}

function probeParams(brokerSessionKey: string, conversationRef?: string) {
  return conversationRef ? { brokerSessionKey, conversationRef } : { brokerSessionKey };
}

function startParams(
  brokerSessionKey: string,
  params: Omit<Record<string, unknown>, 'brokerSessionKey'> & { brokerTurnId: string; prompt: string },
) {
  return {
    brokerSessionKey,
    ...params,
  };
}

function interruptParams(brokerSessionKey: string, brokerTurnId?: string) {
  return brokerTurnId ? { brokerSessionKey, brokerTurnId } : { brokerSessionKey };
}

function countControlResponses(child: FakeClaudeChild, requestId: string): number {
  return child.writes.filter((message) => {
    return (
      isRecord(message) &&
      message.type === 'control_response' &&
      isRecord(message.response) &&
      message.response.request_id === requestId
    );
  }).length;
}

function readAllowBehavior(child: FakeClaudeChild, requestId: string): string | undefined {
  const response = child.writes.find((message) => {
    return (
      isRecord(message) &&
      message.type === 'control_response' &&
      isRecord(message.response) &&
      message.response.request_id === requestId
    );
  });
  if (!isRecord(response) || !isRecord(response.response) || !isRecord(response.response.response)) {
    return undefined;
  }
  return typeof response.response.response.behavior === 'string' ? response.response.response.behavior : undefined;
}

function findControlRequestId(child: FakeClaudeChild, subtype: string): string | undefined {
  const request = child.writes.find((message) => {
    return (
      isRecord(message) &&
      message.type === 'control_request' &&
      typeof message.request_id === 'string' &&
      isRecord(message.request) &&
      message.request.subtype === subtype
    );
  });

  return isRecord(request) && typeof request.request_id === 'string' ? request.request_id : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

    const firstEnsure = await ensureSession(session);
    expect(firstEnsure.bootstrapSignature).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:abc123',
      permissionMode: 'bypassPermissions',
    });
    expect(firstEnsure.brokerSessionKey).toEqual(expect.any(String));
    expect(firstEnsure.initialized).toBe(true);
    expect(firstEnsure.sessionId).toBeNull();
    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(notifications[0]).toEqual({
      method: 'host/stats',
      params: {
        liveControllers: 1,
        activeTurns: 0,
      },
    });

    child.emitSystemInit('sess-1');
    await flush();

    const secondEnsure = await ensureSession(session, {
      brokerSessionKey: firstEnsure.brokerSessionKey,
      conversationRef: 'sess-1',
    });
    expect(secondEnsure.sessionId).toBe('sess-1');
    expect(secondEnsure.brokerSessionKey).toBe(firstEnsure.brokerSessionKey);
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
        brokerSessionKey: firstEnsure.brokerSessionKey,
        bootstrapSignature: firstEnsure.bootstrapSignature,
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      },
    });

    await expect(session.sessionProbe(probeParams(firstEnsure.brokerSessionKey, 'sess-1'))).resolves.toMatchObject({
      brokerSessionKey: firstEnsure.brokerSessionKey,
      status: 'available',
      conversationRef: 'sess-1',
    });
    await expect(session.sessionProbe(probeParams(firstEnsure.brokerSessionKey, 'sess-other'))).resolves.toMatchObject({
      brokerSessionKey: firstEnsure.brokerSessionKey,
      status: 'missing',
    });
  });

  it('rejects overlapping turns, routes interrupt idempotently, and completes from Claude result events', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-turn');
    await flush();

    await expect(
      session.turnStart(startParams(ensureResult.brokerSessionKey, {
        brokerTurnId: 'turn-1',
        prompt: 'hello',
        model: 'claude-sonnet-4-6',
        maxThinkingTokens: 256,
      })),
    ).resolves.toEqual({
      brokerSessionKey: ensureResult.brokerSessionKey,
      brokerTurnId: 'turn-1',
      sessionId: 'sess-turn',
      conversationRef: 'sess-turn',
    });

    await expect(
      session.turnStart(startParams(ensureResult.brokerSessionKey, {
        brokerTurnId: 'turn-2',
        prompt: 'overlap',
      })),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BUSY_RPC_CODE,
    });

    await expect(session.turnInterrupt(interruptParams(ensureResult.brokerSessionKey))).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: true,
    });
    await expect(session.turnInterrupt(interruptParams(ensureResult.brokerSessionKey, 'stale-turn'))).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: false,
    });

    child.emitResult('sess-turn', 'answer', 0.123);
    await flush();

    const controlRequests = child.writes.filter(
      (message) => isRecord(message) && message.type === 'control_request' && isRecord(message.request),
    );
    const subtypes = controlRequests.map((message) => String(((message as Record<string, unknown>).request as Record<string, unknown>).subtype));
    expect(subtypes).toContain('set_model');
    expect(subtypes).toContain('set_max_thinking_tokens');
    expect(subtypes.filter((subtype) => subtype === 'interrupt')).toHaveLength(1);

    await expect(session.turnInterrupt(interruptParams(ensureResult.brokerSessionKey, 'turn-1'))).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: false,
    });

    expect(notifications).toContainEqual({
      method: 'turn/completed',
      params: {
        brokerSessionKey: ensureResult.brokerSessionKey,
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

    expect(
      notifications.filter((notification) => notification.method === 'host/stats'),
    ).toEqual([
      {
        method: 'host/stats',
        params: {
          liveControllers: 1,
          activeTurns: 0,
        },
      },
      {
        method: 'host/stats',
        params: {
          liveControllers: 1,
          activeTurns: 1,
        },
      },
      {
        method: 'host/stats',
        params: {
          liveControllers: 1,
          activeTurns: 0,
        },
      },
      {
        method: 'host/stats',
        params: {
          liveControllers: 0,
          activeTurns: 0,
        },
      },
    ]);
    expect(child.kills).toContain('SIGTERM');

    await expect(session.sessionProbe(probeParams(ensureResult.brokerSessionKey, 'sess-turn'))).resolves.toEqual({
      brokerSessionKey: ensureResult.brokerSessionKey,
      status: 'missing',
      bootstrapSignature: null,
      sessionId: null,
      conversationRef: null,
      activeTurnId: null,
    });
  });

  it('auto-allows tool permission requests and emits assistant/system progress', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-progress');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-progress', prompt: 'work' }));

    child.emitPermissionRequest('req-1', 'Write', { file_path: '/workspace/out.txt' });
    child.emitAssistantTool('sess-progress', 'Read', { file_path: '/workspace/in.txt' });
    child.emitHookProgress('sess-progress', 'formatter: updated output');
    await flush();

    expect(countControlResponses(child, 'req-1')).toBe(1);
    expect(readAllowBehavior(child, 'req-1')).toBe('allow');

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

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-fail');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-fail', prompt: 'long run' }));

    child.emitStderr('fatal stderr chunk');
    child.emitExit({ code: 1, signal: null });

    await flush();
    const failed = notifications.find((notification) => notification.method === 'turn/failed');
    expect(failed).toEqual({
      method: 'turn/failed',
      params: {
        brokerSessionKey: ensureResult.brokerSessionKey,
        brokerTurnId: 'turn-fail',
        message: 'Claude child exited unexpectedly (exit 1).',
        sessionId: 'sess-fail',
        conversationRef: 'sess-fail',
        stderr: 'fatal stderr chunk',
      },
    });
    expect(notifications.map((notification) => notification.method)).toContain('host/stats');
    expect(notifications.at(-2)).toEqual({
      method: 'host/stats',
      params: {
        liveControllers: 0,
        activeTurns: 0,
      },
    });
    expect(notifications.at(-1)).toEqual({
      method: 'host/stats',
      params: {
        liveControllers: 0,
        activeTurns: 0,
      },
    });

    const closed = await Promise.race([
      session.closed,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    expect(closed).toBe('timeout');
  });
});

describe('broker: duplicate turn/start rejection', () => {
  it('rejects a second turn/start while the first turn is pending acknowledgement', async () => {
    const child = new FakeClaudeChild();
    let releaseFirstStart!: () => void;
    let markFirstInFlight!: () => void;
    const firstInFlight = new Promise<void>((resolve) => {
      markFirstInFlight = resolve;
    });
    const session = createBrokerSession({
      spawnChild: async () => child,
      onTurnStarted: async () => {
        markFirstInFlight();
        await new Promise<void>((resolve) => {
          releaseFirstStart = resolve;
        });
      },
    });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-pending');
    await flush();

    const first = session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-1', prompt: 'hello' }));
    await firstInFlight;
    const second = session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-2', prompt: 'world' }));

    await expect(second).rejects.toMatchObject({
      code: CLAUDE_BROKER_BUSY_RPC_CODE,
      message: expect.stringMatching(/busy/i),
    });

    releaseFirstStart();
    await expect(first).resolves.toMatchObject({ brokerTurnId: 'turn-1' });
    child.emitResult('sess-pending', 'done');
    await flush();
  });

  it('accepts a new turn/start after the previous turn completes', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-seq');
    await flush();

    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-1', prompt: 'first' }));
    child.emitResult('sess-seq', 'first done');
    await flush();

    await expect(
      session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-2', prompt: 'second' })),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_STATE_RPC_CODE,
    });

    await expect(
      ensureSession(session, {
        brokerSessionKey: ensureResult.brokerSessionKey,
        conversationRef: 'sess-seq',
      }),
    ).resolves.toMatchObject({
      brokerSessionKey: ensureResult.brokerSessionKey,
      conversationRef: 'sess-seq',
      initialized: true,
    });

    await expect(
      session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-2', prompt: 'second' })),
    ).resolves.toMatchObject({
      brokerSessionKey: ensureResult.brokerSessionKey,
      brokerTurnId: 'turn-2',
      sessionId: null,
      conversationRef: 'sess-seq',
    });

    child.emitResult('sess-seq', 'second done');
    await flush();
  });
});

describe('broker: turn/interrupt timing contracts', () => {
  it('interrupt without an active turn is idempotent', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    await expect(session.turnInterrupt(interruptParams(ensureResult.brokerSessionKey))).resolves.toEqual({
      brokerTurnId: null,
      interrupted: false,
    });
  });

  it('interrupt before turn/start acknowledgement with no brokerTurnId still targets the in-flight turn', async () => {
    const child = new FakeClaudeChild();
    let releaseTurnStart!: () => void;
    let markTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const session = createBrokerSession({
      spawnChild: async () => child,
      onTurnStarted: async () => {
        markTurnStarted();
        await new Promise<void>((resolve) => {
          releaseTurnStart = resolve;
        });
      },
    });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-preack');
    await flush();

    const turnStart = session.turnStart(
      startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-1', prompt: 'long task' }),
    );
    await turnStarted;

    await expect(session.turnInterrupt(interruptParams(ensureResult.brokerSessionKey))).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: true,
    });
    expect(countControlRequests(child, 'interrupt')).toBe(1);

    releaseTurnStart();
    await expect(turnStart).resolves.toMatchObject({ brokerTurnId: 'turn-1' });
    child.emitResult('sess-preack', 'interrupted');
    await flush();
  });
});

describe('broker: session/ensure during active turn is a read, not a respawn', () => {
  it('returns current bootstrap state without restarting the child', async () => {
    const child = new FakeClaudeChild();
    const spawnChild = vi.fn(async () => child);
    const session = createBrokerSession({ spawnChild });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-concurrent');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-1', prompt: 'busy' }));

    await expect(
      ensureSession(session, {
        brokerSessionKey: ensureResult.brokerSessionKey,
        conversationRef: 'sess-concurrent',
      }),
    ).resolves.toMatchObject({
      brokerSessionKey: ensureResult.brokerSessionKey,
      sessionId: 'sess-concurrent',
      conversationRef: 'sess-concurrent',
      activeTurnId: 'turn-1',
      initialized: true,
    });
    expect(spawnChild).toHaveBeenCalledTimes(1);

    child.emitResult('sess-concurrent', 'done');
    await flush();
  });

  it('returns a mismatch error when the bootstrap signature drifts during an active turn', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-drift');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-1', prompt: 'running' }));

    await expect(
      ensureSession(session, {
        brokerSessionKey: ensureResult.brokerSessionKey,
        conversationRef: 'sess-drift',
        cwd: '/different/path',
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      message: expect.stringMatching(/mismatch/i),
    });

    child.emitResult('sess-drift', 'done');
    await flush();
  });
});

describe('broker: initialize sent exactly once per child lifecycle', () => {
  it('sends initialize again only after a child respawn', async () => {
    const child1 = new FakeClaudeChild();
    const child2 = new FakeClaudeChild();
    let activeChild = child1;
    const spawnChild = vi.fn(async () => activeChild);
    const session = createBrokerSession({ spawnChild });

    const firstEnsure = await ensureSession(session);
    child1.emitSystemInit('sess-first');
    await flush();

    activeChild = child2;
    child1.crash(1);
    await flush();

    const secondEnsure = ensureSession(session, {
      brokerSessionKey: firstEnsure.brokerSessionKey,
      conversationRef: 'sess-first',
    });
    await vi.waitFor(() => {
      expect(countControlRequests(child2, 'initialize')).toBe(1);
    });
    child2.emitSystemInit('sess-first');

    await expect(secondEnsure).resolves.toMatchObject({
      brokerSessionKey: firstEnsure.brokerSessionKey,
      conversationRef: 'sess-first',
      initialized: true,
    });
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(countControlRequests(child2, 'initialize')).toBe(1);

    await flush();
    await expect(
      ensureSession(session, {
        brokerSessionKey: firstEnsure.brokerSessionKey,
        conversationRef: 'sess-first',
      }),
    ).resolves.toMatchObject({
      brokerSessionKey: firstEnsure.brokerSessionKey,
      sessionId: 'sess-first',
      conversationRef: 'sess-first',
    });
  });
});

describe('broker: child crash during active turn produces terminal failure, not a hung wait', () => {
  it('keeps the broker transport open when one controller exits unexpectedly mid-turn', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-crash');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-crash', prompt: 'long op' }));

    child.crash(1);

    const closed = await Promise.race([
      session.closed,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(closed).toBe('timeout');
  });
});

describe('broker: child exits before first session_id emission', () => {
  it('session/ensure rejects when the child exits during bootstrap before session_id', async () => {
    const child = new FakeClaudeChild(false);
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensure = ensureSession(session);
    await vi.waitFor(() => {
      expect(countControlRequests(child, 'initialize')).toBe(1);
    });
    child.crash(1);

    await expect(ensure).rejects.toThrow();
  });

  it('kills the child when initialize fails before bootstrap is established', async () => {
    const child = new FakeClaudeChild(false);
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensure = ensureSession(session);
    await vi.waitFor(() => {
      expect(countControlRequests(child, 'initialize')).toBe(1);
    });

    child.emit({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: findControlRequestId(child, 'initialize'),
        error: 'initialize failed',
      },
    });

    await expect(ensure).rejects.toMatchObject({
      code: CLAUDE_BROKER_STATE_RPC_CODE,
      message: 'initialize failed',
    });
    expect(child.kills).toContain('SIGTERM');
  });

  it('does not permanently lock the broker after a bootstrap failure', async () => {
    const child1 = new FakeClaudeChild(false);
    const child2 = new FakeClaudeChild();
    let activeChild = child1;
    const session = createBrokerSession({
      spawnChild: async () => activeChild,
    });

    const firstEnsure = ensureSession(session);
    await vi.waitFor(() => {
      expect(countControlRequests(child1, 'initialize')).toBe(1);
    });
    child1.crash(1);
    await expect(firstEnsure).rejects.toThrow();

    activeChild = child2;
    const secondEnsure = ensureSession(session);
    await expect(secondEnsure).resolves.toMatchObject({
      initialized: true,
    });

    child2.emitSystemInit('sess-recovered');
    await flush();

    await expect(
      ensureSession(session, {
        brokerSessionKey: (await secondEnsure).brokerSessionKey,
        conversationRef: 'sess-recovered',
      }),
    ).resolves.toMatchObject({
      sessionId: 'sess-recovered',
      conversationRef: 'sess-recovered',
      initialized: true,
    });
  });
});

describe('broker: permission auto-allow for can_use_tool', () => {
  it('does not auto-allow an unknown control_request subtype', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-unknown-ctrl');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-1', prompt: 'work' }));

    child.emitUnknownControlRequest('req-unknown-1');
    await flush();

    expect(countControlResponses(child, 'req-unknown-1')).toBe(0);

    child.emitResult('sess-unknown-ctrl', 'done');
    await flush();
  });
});

describe('broker: session/ensure bootstrap signature mismatch', () => {
  it('rejects session/ensure when cwd drifts against an already-live child', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-live');
    await flush();

    await expect(
      ensureSession(session, {
        brokerSessionKey: ensureResult.brokerSessionKey,
        conversationRef: 'sess-live',
        cwd: '/completely/different',
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      message: expect.stringMatching(/mismatch/i),
    });
  });

  it('rejects session/ensure when systemPromptHash drifts against a live child', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-hash-live');
    await flush();

    await expect(
      ensureSession(session, {
        brokerSessionKey: ensureResult.brokerSessionKey,
        conversationRef: 'sess-hash-live',
        systemPromptHash: 'sha256:differenthash',
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      message: expect.stringMatching(/mismatch/i),
    });
  });

  it('does not respawn the child when mismatch is detected', async () => {
    const child = new FakeClaudeChild();
    const spawnChild = vi.fn(async () => child);
    const session = createBrokerSession({ spawnChild });

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-no-respawn');
    await flush();

    await expect(
      ensureSession(session, {
        brokerSessionKey: ensureResult.brokerSessionKey,
        conversationRef: 'sess-no-respawn',
        cwd: '/drift',
      }),
    ).rejects.toThrow();
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });
});

describe('broker: turn/completed notification carries cost metadata', () => {
  it('ignores malformed result events without crashing the broker', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    const ensureResult = await ensureSession(session);
    child.emitSystemInit('sess-nocost');
    await flush();
    await session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-nocost', prompt: 'work' }));

    child.emitResultWithoutCost('sess-nocost', 'ok');
    await flush();

    expect(notifications.find((notification) => notification.method === 'turn/completed')).toBeUndefined();
    await expect(
      session.turnStart(startParams(ensureResult.brokerSessionKey, { brokerTurnId: 'turn-overlap', prompt: 'still busy' })),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BUSY_RPC_CODE,
    });

    child.emitResult('sess-nocost', 'done');
    await flush();
  });
});

describe('broker: transport-close signal', () => {
  it('leaves the broker transport open when a single controller crashes', async () => {
    const child = new FakeClaudeChild(false);
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensure = ensureSession(session);
    await vi.waitFor(() => {
      expect(countControlRequests(child, 'initialize')).toBe(1);
    });
    child.crash(1);
    await expect(ensure).rejects.toThrow();

    const closed = await Promise.race([
      session.closed,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(closed).toBe('timeout');
  });
});

describe('broker: pooled controller routing', () => {
  it('allocates distinct brokerSessionKey values for fresh sessions with the same bootstrap', async () => {
    const firstChild = new FakeClaudeChild();
    const secondChild = new FakeClaudeChild();
    const spawnChild = vi
      .fn<() => Promise<FakeClaudeChild>>()
      .mockResolvedValueOnce(firstChild)
      .mockResolvedValueOnce(secondChild);
    const session = createBrokerSession({ spawnChild });

    const firstEnsure = await ensureSession(session);
    const secondEnsure = await ensureSession(session);

    expect(firstEnsure.brokerSessionKey).not.toBe(secondEnsure.brokerSessionKey);
    expect(spawnChild).toHaveBeenCalledTimes(2);

    firstChild.emitSystemInit('sess-a');
    secondChild.emitSystemInit('sess-b');
    await flush();

    await expect(
      session.turnStart(startParams(firstEnsure.brokerSessionKey, { brokerTurnId: 'turn-a', prompt: 'alpha' })),
    ).resolves.toMatchObject({
      brokerSessionKey: firstEnsure.brokerSessionKey,
      brokerTurnId: 'turn-a',
    });
    await expect(
      session.turnStart(startParams(secondEnsure.brokerSessionKey, { brokerTurnId: 'turn-b', prompt: 'beta' })),
    ).resolves.toMatchObject({
      brokerSessionKey: secondEnsure.brokerSessionKey,
      brokerTurnId: 'turn-b',
    });
  });

  it('holds first-contact notifications until session/ensure returns the generated brokerSessionKey', async () => {
    const child = new FakeClaudeChild(false);
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    const ensurePromise = ensureSession(session);
    await vi.waitFor(() => {
      expect(countControlRequests(child, 'initialize')).toBe(1);
    });

    child.emitSystemInit('sess-held');
    expect(notifications).toEqual([]);

    const initializeRequestId = findControlRequestId(child, 'initialize');
    expect(initializeRequestId).toBeDefined();
    child.emitControlSuccess(initializeRequestId!, 'initialize');

    const ensureResult = await ensurePromise;
    expect(notifications).toEqual([
      {
        method: 'host/stats',
        params: {
          liveControllers: 1,
          activeTurns: 0,
        },
      },
    ]);

    await flush();
    expect(notifications).toContainEqual({
      method: 'session/updated',
      params: {
        brokerSessionKey: ensureResult.brokerSessionKey,
        bootstrapSignature: ensureResult.bootstrapSignature,
        sessionId: 'sess-held',
        conversationRef: 'sess-held',
      },
    });
  });

  it('evicts only the crashed controller and keeps other sessions available', async () => {
    const firstChild = new FakeClaudeChild();
    const secondChild = new FakeClaudeChild();
    const spawnChild = vi
      .fn<() => Promise<FakeClaudeChild>>()
      .mockResolvedValueOnce(firstChild)
      .mockResolvedValueOnce(secondChild);
    const session = createBrokerSession({ spawnChild });
    const notifications = collectNotifications(session);

    const firstEnsure = await ensureSession(session);
    const secondEnsure = await ensureSession(session);
    firstChild.emitSystemInit('sess-a');
    secondChild.emitSystemInit('sess-b');
    await flush();

    await session.turnStart(startParams(firstEnsure.brokerSessionKey, { brokerTurnId: 'turn-a', prompt: 'alpha' }));
    await session.turnStart(startParams(secondEnsure.brokerSessionKey, { brokerTurnId: 'turn-b', prompt: 'beta' }));

    firstChild.crash(1);
    await flush();

    await expect(session.sessionProbe(probeParams(firstEnsure.brokerSessionKey, 'sess-a'))).resolves.toMatchObject({
      brokerSessionKey: firstEnsure.brokerSessionKey,
      status: 'missing',
    });
    await expect(session.sessionProbe(probeParams(secondEnsure.brokerSessionKey, 'sess-b'))).resolves.toMatchObject({
      brokerSessionKey: secondEnsure.brokerSessionKey,
      status: 'available',
    });

    secondChild.emitResult('sess-b', 'still alive');
    await flush();

    expect(notifications).toContainEqual({
      method: 'turn/failed',
      params: {
        brokerSessionKey: firstEnsure.brokerSessionKey,
        brokerTurnId: 'turn-a',
        message: 'Claude child exited unexpectedly (exit 1).',
        sessionId: 'sess-a',
        conversationRef: 'sess-a',
      },
    });
    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          brokerSessionKey: secondEnsure.brokerSessionKey,
          brokerTurnId: 'turn-b',
        }),
      }),
    );
  });
});

describe('broker: per-controller env', () => {
  it('builds child env from the stripped broker env plus the controller overlay', () => {
    const originalCoral = process.env.CORAL_TEST_STRIP_ME;
    const originalBase = process.env.TEST_BASE_ENV;

    process.env.CORAL_TEST_STRIP_ME = 'remove-me';
    process.env.TEST_BASE_ENV = 'keep-me';

    try {
      const childEnv = buildClaudeChildEnv({
        TEST_CONTROLLER_ONLY: 'present',
        CORAL_SESSION_VALUE: 'allowed',
      });

      expect(childEnv.TEST_BASE_ENV).toBe('keep-me');
      expect(childEnv.CORAL_TEST_STRIP_ME).toBeUndefined();
      expect(childEnv.TEST_CONTROLLER_ONLY).toBe('present');
      expect(childEnv.CORAL_SESSION_VALUE).toBe('allowed');
      expect(childEnv.CORAL_CHILD).toBe('1');
      expect(hashClaudeChildEnv(childEnv)).toMatch(/^sha256:/);
    } finally {
      if (originalCoral === undefined) {
        delete process.env.CORAL_TEST_STRIP_ME;
      } else {
        process.env.CORAL_TEST_STRIP_ME = originalCoral;
      }
      if (originalBase === undefined) {
        delete process.env.TEST_BASE_ENV;
      } else {
        process.env.TEST_BASE_ENV = originalBase;
      }
    }
  });

  it('passes controller env per spawn and rejects env drift only for the same brokerSessionKey', async () => {
    const firstChild = new FakeClaudeChild();
    const secondChild = new FakeClaudeChild();
    const spawnChild = vi
      .fn<() => Promise<FakeClaudeChild>>()
      .mockResolvedValueOnce(firstChild)
      .mockResolvedValueOnce(secondChild);
    const session = createBrokerSession({ spawnChild });

    const firstEnsure = await ensureSession(session, {
      controllerEnv: {
        TEST_SESSION_ALPHA: 'alpha',
      },
    });
    const secondEnsure = await ensureSession(session, {
      controllerEnv: {
        TEST_SESSION_BETA: 'beta',
      },
    });
    const spawnCalls = spawnChild.mock.calls as unknown as Array<Array<unknown>>;
    const firstSpawnOptions = spawnCalls[0]?.[0] as { env?: Record<string, string> } | undefined;
    const secondSpawnOptions = spawnCalls[1]?.[0] as { env?: Record<string, string> } | undefined;

    expect(firstSpawnOptions).toMatchObject({
      env: expect.objectContaining({
        TEST_SESSION_ALPHA: 'alpha',
        CORAL_CHILD: '1',
      }),
    });
    expect(secondSpawnOptions).toMatchObject({
      env: expect.objectContaining({
        TEST_SESSION_BETA: 'beta',
        CORAL_CHILD: '1',
      }),
    });
    expect(secondSpawnOptions?.env).not.toHaveProperty('TEST_SESSION_ALPHA');

    await expect(
      ensureSession(session, {
        brokerSessionKey: firstEnsure.brokerSessionKey,
        controllerEnv: {
          TEST_SESSION_ALPHA: 'changed',
        },
      }),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      message: expect.stringMatching(/mismatch/i),
    });

    await expect(
      ensureSession(session, {
        brokerSessionKey: secondEnsure.brokerSessionKey,
        controllerEnv: {
          TEST_SESSION_BETA: 'beta',
        },
      }),
    ).resolves.toMatchObject({
      brokerSessionKey: secondEnsure.brokerSessionKey,
      initialized: true,
    });
  });

  it('waits for controller exit before resolving broker shutdown', async () => {
    const child = new FakeClaudeChild(true, false);
    const session = createBrokerSession({ spawnChild: async () => child });

    await ensureSession(session);

    let settled = false;
    const shutdown = session.shutdown().then(() => {
      settled = true;
    });

    await flush();
    expect(settled).toBe(false);

    child.emitExit({ code: 0, signal: 'SIGTERM' });
    await shutdown;
    expect(settled).toBe(true);
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

    const brokerShutdown = createDeferred();
    let notificationHandler: ((notification: ClaudeBrokerNotification) => void) | null = null;
    const session: ClaudeBrokerSession = {
      closed: Promise.resolve(),
      sessionEnsure: vi.fn(async () => ({
        brokerSessionKey: 'broker-session-1',
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:abc123',
          permissionMode: 'bypassPermissions' as const,
        },
        sessionId: null,
        conversationRef: null,
        activeTurnId: null,
        initialized: true,
      })),
      sessionProbe: vi.fn(async () => ({
        brokerSessionKey: 'broker-session-1',
        status: 'available' as const,
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:abc123',
          permissionMode: 'bypassPermissions' as const,
        },
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
        activeTurnId: null,
      })),
      turnStart: vi.fn(async () => ({
        brokerSessionKey: 'broker-session-1',
        brokerTurnId: 'turn-1',
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      })),
      turnInterrupt: vi.fn(async () => ({
        brokerTurnId: 'turn-1',
        interrupted: true,
      })),
      shutdown: vi.fn(async () => {
        await brokerShutdown.promise;
      }),
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
        brokerSessionKey: 'broker-session-1',
        initialized: true,
      },
    });

    outputText = '';
    notificationHandler!({
      method: 'turn/progress',
      params: {
        brokerSessionKey: 'broker-session-1',
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
        brokerSessionKey: 'broker-session-1',
        brokerTurnId: 'turn-1',
        message: 'Read(src/app.ts)',
        sessionId: 'sess-1',
        conversationRef: 'sess-1',
      },
    });

    outputText = '';
    input.write(`${JSON.stringify({ id: 2, method: 'broker/shutdown', params: {} })}\n`);
    await flush();
    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(outputText).toBe('');
    expect(exit).not.toHaveBeenCalled();

    brokerShutdown.resolve();
    await flush();
    expect(parseLines(outputText)[0]).toEqual({
      id: 2,
      result: { ok: true },
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('rejects new non-shutdown RPCs after broker/shutdown starts', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();

    let outputText = '';
    output.on('data', (chunk) => {
      outputText += chunk.toString();
    });

    const brokerShutdown = createDeferred();
    const session: ClaudeBrokerSession = {
      closed: Promise.resolve(),
      sessionEnsure: vi.fn(async () => ({
        brokerSessionKey: 'broker-session-1',
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:abc123',
          permissionMode: 'bypassPermissions' as const,
        },
        sessionId: null,
        conversationRef: null,
        activeTurnId: null,
        initialized: true,
      })),
      sessionProbe: vi.fn(async () => ({
        brokerSessionKey: 'broker-session-1',
        status: 'available' as const,
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:abc123',
          permissionMode: 'bypassPermissions' as const,
        },
        sessionId: null,
        conversationRef: null,
        activeTurnId: null,
      })),
      turnStart: vi.fn(async () => ({
        brokerSessionKey: 'broker-session-1',
        brokerTurnId: 'turn-1',
        sessionId: null,
        conversationRef: null,
      })),
      turnInterrupt: vi.fn(async () => ({
        brokerTurnId: null,
        interrupted: false,
      })),
      shutdown: vi.fn(async () => {
        await brokerShutdown.promise;
      }),
      subscribeNotifications() {
        return () => {};
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

    input.write(`${JSON.stringify({ id: 1, method: 'broker/shutdown', params: {} })}\n`);
    await flush();
    expect(session.shutdown).toHaveBeenCalledTimes(1);

    input.write(`${JSON.stringify({ id: 2, method: 'session/ensure', params: BOOTSTRAP })}\n`);
    await flush();

    expect(parseLines(outputText)).toContainEqual({
      id: 2,
      error: {
        code: -32001,
        message: 'Claude broker is shutting down.',
      },
    });
    expect(session.sessionEnsure).not.toHaveBeenCalled();

    brokerShutdown.resolve();
    await flush();

    expect(parseLines(outputText)).toContainEqual({
      id: 1,
      result: { ok: true },
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
