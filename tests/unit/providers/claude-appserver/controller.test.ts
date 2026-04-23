import { afterEach, describe, expect, it } from 'vitest';

import { SingleSessionController, type ClaudeBrokerChild } from '#src/providers/claude-appserver/controller.js';
import type { SessionEnsureParams } from '#src/providers/claude-appserver/protocol.js';

const BOOTSTRAP: Omit<SessionEnsureParams, 'brokerSessionKey'> = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:abc123',
  permissionMode: 'bypassPermissions',
  systemPrompt: 'Stay concise.',
};

const MODEL = 'claude-sonnet-4-6';

class TestClaudeChild implements ClaudeBrokerChild {
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  readonly writes: unknown[] = [];

  private readonly stdoutHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void>();

  writeLine(line: string): void {
    const message = JSON.parse(line) as {
      type?: string;
      request_id?: string;
      request?: { subtype?: string };
    };
    this.writes.push(message);

    if (message.type === 'control_request' && typeof message.request_id === 'string') {
      queueMicrotask(() => {
        this.emit({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response:
              message.request?.subtype === 'initialize'
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

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal);
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

  emitResult(sessionId: string, result = 'done'): void {
    this.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 25,
      duration_api_ms: 20,
      is_error: false,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.1,
      usage: { output_tokens: 4 },
      modelUsage: {
        [MODEL]: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.1,
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

  private emitExit(event: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
    for (const handler of this.exitHandlers) {
      handler(event);
    }
  }
}

describe('SingleSessionController', () => {
  const controllers = new Set<SingleSessionController>();

  afterEach(async () => {
    await Promise.all([...controllers].map(async (controller) => controller.shutdown().catch(() => {})));
    controllers.clear();
  });

  it('bootstraps, handles a turn, and shuts down cleanly', async () => {
    const child = new TestClaudeChild();
    const controller = new SingleSessionController({
      spawnChild: async () => child,
    });
    controllers.add(controller);

    const notifications: unknown[] = [];
    const unsubscribe = controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    const ensure = await controller.sessionEnsure(BOOTSTRAP);
    expect(ensure).toEqual({
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:abc123',
        permissionMode: 'bypassPermissions',
      },
      sessionId: null,
      conversationRef: null,
      activeTurnId: null,
      initialized: true,
    });
    expect(controller.hasLiveController()).toBe(true);

    child.emitSystemInit('session-1');
    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          method: 'session/updated',
          params: {
            bootstrapSignature: ensure.bootstrapSignature,
            sessionId: 'session-1',
            conversationRef: 'session-1',
          },
        },
      ]),
    );

    const start = await controller.turnStart({
      brokerTurnId: 'turn-1',
      prompt: 'Hello Claude',
      model: MODEL,
    });
    expect(start).toEqual({
      brokerTurnId: 'turn-1',
      sessionId: 'session-1',
      conversationRef: 'session-1',
    });
    expect(controller.hasActiveTurn()).toBe(true);
    expect(child.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'control_request',
          request: expect.objectContaining({ subtype: 'initialize' }),
        }),
        expect.objectContaining({
          type: 'control_request',
          request: expect.objectContaining({ subtype: 'set_model', model: MODEL }),
        }),
        expect.objectContaining({
          type: 'user',
          session_id: 'session-1',
          message: {
            role: 'user',
            content: 'Hello Claude',
          },
        }),
      ]),
    );

    child.emitResult('session-1', 'done');
    await Promise.resolve();
    expect(controller.hasActiveTurn()).toBe(false);
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'turn/completed',
          params: expect.objectContaining({
            brokerTurnId: 'turn-1',
            sessionId: 'session-1',
            conversationRef: 'session-1',
            result: 'done',
            model: MODEL,
          }),
        }),
      ]),
    );

    await controller.shutdown();
    controllers.delete(controller);
    unsubscribe();

    expect(controller.hasLiveController()).toBe(false);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('reports missing, available, and unavailable probe states', async () => {
    const controller = new SingleSessionController({
      spawnChild: async () => new TestClaudeChild(),
    });
    controllers.add(controller);

    await expect(controller.sessionProbe()).resolves.toEqual({
      status: 'missing',
      bootstrapSignature: null,
      sessionId: null,
      conversationRef: null,
      activeTurnId: null,
    });

    await controller.sessionEnsure(BOOTSTRAP);
    await expect(controller.sessionProbe()).resolves.toMatchObject({
      status: 'available',
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:abc123',
        permissionMode: 'bypassPermissions',
      },
    });

    await controller.shutdown();
    controllers.delete(controller);

    await expect(controller.sessionProbe()).resolves.toMatchObject({
      status: 'unavailable',
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:abc123',
        permissionMode: 'bypassPermissions',
      },
    });
  });
});
