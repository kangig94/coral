import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRecord } from '../../../shared/mcp-utils.js';
import { buildClaudeChildArgs, createClaudeBrokerServer } from '../server.js';
import { createBrokerSession, type ClaudeBrokerChild, type ClaudeBrokerSession } from '../session.js';
import {
  CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
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

const MODEL = 'claude-sonnet-4-6';

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
    const subtypes = controlRequests.map((message) => String(((message as Record<string, unknown>).request as Record<string, unknown>).subtype));
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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-pending');
    await flush();

    const first = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
    await firstInFlight;
    const second = session.turnStart({ brokerTurnId: 'turn-2', prompt: 'world' });

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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-seq');
    await flush();

    await session.turnStart({ brokerTurnId: 'turn-1', prompt: 'first' });
    child.emitResult('sess-seq', 'first done');
    await flush();

    await expect(session.turnStart({ brokerTurnId: 'turn-2', prompt: 'second' })).resolves.toMatchObject({
      brokerTurnId: 'turn-2',
      sessionId: 'sess-seq',
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

    await session.sessionEnsure(BOOTSTRAP);
    await expect(session.turnInterrupt({})).resolves.toEqual({
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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-preack');
    await flush();

    const turnStart = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'long task' });
    await turnStarted;

    await expect(session.turnInterrupt({})).resolves.toEqual({
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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-concurrent');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-1', prompt: 'busy' });

    await expect(session.sessionEnsure(BOOTSTRAP)).resolves.toMatchObject({
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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-drift');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-1', prompt: 'running' });

    await expect(session.sessionEnsure({ ...BOOTSTRAP, cwd: '/different/path' })).rejects.toMatchObject({
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

    await session.sessionEnsure(BOOTSTRAP);
    child1.emitSystemInit('sess-first');
    await flush();

    activeChild = child2;
    child1.crash(1);
    await flush();

    const secondEnsure = session.sessionEnsure({ ...BOOTSTRAP, conversationRef: 'sess-first' });
    child2.emitSystemInit('sess-first');

    await expect(secondEnsure).resolves.toMatchObject({
      sessionId: 'sess-first',
      conversationRef: 'sess-first',
      initialized: true,
    });
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(countControlRequests(child2, 'initialize')).toBe(1);
  });
});

describe('broker: child crash during active turn produces terminal failure, not a hung wait', () => {
  it('resolves the closed signal quickly when the child exits unexpectedly mid-turn', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-crash');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-crash', prompt: 'long op' });

    child.crash(1);

    const closed = await Promise.race([
      session.closed,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(closed).not.toBe('timeout');
    expect(closed).toBeInstanceOf(Error);
  });
});

describe('broker: child exits before first session_id emission', () => {
  it('session/ensure rejects when the child exits during bootstrap before session_id', async () => {
    const child = new FakeClaudeChild(false);
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensure = session.sessionEnsure(BOOTSTRAP);
    await vi.waitFor(() => {
      expect(countControlRequests(child, 'initialize')).toBe(1);
    });
    child.crash(1);

    await expect(ensure).rejects.toThrow();
  });

  it('does not permanently lock the broker after a bootstrap failure', async () => {
    const child1 = new FakeClaudeChild(false);
    const child2 = new FakeClaudeChild();
    let activeChild = child1;
    const session = createBrokerSession({
      spawnChild: async () => activeChild,
    });

    const firstEnsure = session.sessionEnsure(BOOTSTRAP);
    await vi.waitFor(() => {
      expect(countControlRequests(child1, 'initialize')).toBe(1);
    });
    child1.crash(1);
    await expect(firstEnsure).rejects.toThrow();

    activeChild = child2;
    const secondEnsure = session.sessionEnsure(BOOTSTRAP);
    await expect(secondEnsure).resolves.toMatchObject({
      initialized: true,
    });

    child2.emitSystemInit('sess-recovered');
    await flush();

    await expect(session.sessionEnsure(BOOTSTRAP)).resolves.toMatchObject({
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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-unknown-ctrl');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-1', prompt: 'work' });

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

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-live');
    await flush();

    await expect(session.sessionEnsure({ ...BOOTSTRAP, cwd: '/completely/different' })).rejects.toMatchObject({
      code: CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      message: expect.stringMatching(/mismatch/i),
    });
  });

  it('rejects session/ensure when systemPromptHash drifts against a live child', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-hash-live');
    await flush();

    await expect(
      session.sessionEnsure({ ...BOOTSTRAP, systemPromptHash: 'sha256:differenthash' }),
    ).rejects.toMatchObject({
      code: CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      message: expect.stringMatching(/mismatch/i),
    });
  });

  it('does not respawn the child when mismatch is detected', async () => {
    const child = new FakeClaudeChild();
    const spawnChild = vi.fn(async () => child);
    const session = createBrokerSession({ spawnChild });

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-no-respawn');
    await flush();

    await expect(session.sessionEnsure({ ...BOOTSTRAP, cwd: '/drift' })).rejects.toThrow();
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });
});

describe('broker: turn/completed notification carries cost metadata', () => {
  it('ignores malformed result events without crashing the broker', async () => {
    const child = new FakeClaudeChild();
    const session = createBrokerSession({ spawnChild: async () => child });
    const notifications = collectNotifications(session);

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSystemInit('sess-nocost');
    await flush();
    await session.turnStart({ brokerTurnId: 'turn-nocost', prompt: 'work' });

    child.emitResultWithoutCost('sess-nocost', 'ok');
    await flush();

    expect(notifications.find((notification) => notification.method === 'turn/completed')).toBeUndefined();
    await expect(session.turnStart({ brokerTurnId: 'turn-overlap', prompt: 'still busy' })).rejects.toMatchObject({
      code: CLAUDE_BROKER_BUSY_RPC_CODE,
    });

    child.emitResult('sess-nocost', 'done');
    await flush();
  });
});

describe('broker: transport-close signal', () => {
  it('exposes a closed promise that resolves on child crash', async () => {
    const child = new FakeClaudeChild(false);
    const session = createBrokerSession({ spawnChild: async () => child });

    const ensure = session.sessionEnsure(BOOTSTRAP);
    await vi.waitFor(() => {
      expect(countControlRequests(child, 'initialize')).toBe(1);
    });
    child.crash(1);
    await expect(ensure).rejects.toThrow();

    const closed = await Promise.race([
      session.closed,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(closed).not.toBe('timeout');
    expect(closed).toBeInstanceOf(Error);
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
        status: 'available' as const,
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
    notificationHandler!({
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
