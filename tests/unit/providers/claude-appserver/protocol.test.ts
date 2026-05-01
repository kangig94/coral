import { describe, expect, it } from 'vitest';

import {
  ClaudeBrokerRpcError,
  buildJsonRpcFailureFromError,
  buildJsonRpcSuccess,
  parseJsonRpcInboundLine,
  requireSessionEnsureParams,
  requireSessionProbeParams,
  requireTurnInterruptParams,
  requireTurnStartParams,
  stripBrokerSessionKey,
  toBootstrapSignature,
  withBrokerSessionKey,
} from '#src/providers/claude-appserver/protocol.js';

describe('claude-appserver protocol helpers', () => {
  it('parses inbound JSON-RPC requests and notifications', () => {
    expect(
      parseJsonRpcInboundLine(
        JSON.stringify({
          id: 'req-1',
          method: 'session/probe',
          params: {
            brokerSessionKey: 'broker-1',
          },
        }),
      ),
    ).toEqual({
      id: 'req-1',
      method: 'session/probe',
      params: {
        brokerSessionKey: 'broker-1',
      },
    });

    expect(
      parseJsonRpcInboundLine(
        JSON.stringify({
          method: 'host/stats',
          params: {
            liveControllers: 1,
            activeTurns: 0,
          },
        }),
      ),
    ).toEqual({
      method: 'host/stats',
      params: {
        liveControllers: 1,
        activeTurns: 0,
      },
    });
  });

  it('builds broker responses and preserves typed RPC errors', () => {
    expect(buildJsonRpcSuccess('req-1', { ok: true })).toEqual({
      id: 'req-1',
      result: { ok: true },
    });

    expect(
      buildJsonRpcFailureFromError('req-1', new ClaudeBrokerRpcError(-32602, 'Invalid params.', { field: 'cwd' })),
    ).toEqual({
      id: 'req-1',
      error: {
        code: -32602,
        message: 'Invalid params.',
        data: { field: 'cwd' },
      },
    });
  });

  it('validates broker params and re-attaches the broker session key', () => {
    const ensure = requireSessionEnsureParams({
      cwd: '/workspace',
      systemPromptHash: 'sha256:abc123',
      permissionMode: 'bypassPermissions',
      brokerSessionKey: 'broker-1',
      conversationRef: 'conversation-1',
      controllerEnv: {
        FOO: 'bar',
      },
      systemPrompt: 'Stay concise.',
    });

    expect(ensure).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:abc123',
      permissionMode: 'bypassPermissions',
      brokerSessionKey: 'broker-1',
      conversationRef: 'conversation-1',
      controllerEnv: {
        FOO: 'bar',
      },
      systemPrompt: 'Stay concise.',
    });
    expect(stripBrokerSessionKey(ensure)).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:abc123',
      permissionMode: 'bypassPermissions',
      conversationRef: 'conversation-1',
      controllerEnv: {
        FOO: 'bar',
      },
      systemPrompt: 'Stay concise.',
    });
    expect(toBootstrapSignature(stripBrokerSessionKey(ensure))).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:abc123',
      permissionMode: 'bypassPermissions',
    });

    expect(
      requireSessionProbeParams({
        brokerSessionKey: 'broker-1',
        conversationRef: 'conversation-1',
      }),
    ).toEqual({
      brokerSessionKey: 'broker-1',
      conversationRef: 'conversation-1',
    });

    expect(
      requireTurnStartParams({
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
        prompt: 'Hello Claude',
        model: 'claude-sonnet-4-6',
        maxThinkingTokens: null,
      }),
    ).toEqual({
      brokerSessionKey: 'broker-1',
      brokerTurnId: 'turn-1',
      prompt: 'Hello Claude',
      model: 'claude-sonnet-4-6',
      maxThinkingTokens: null,
    });

    expect(
      requireTurnInterruptParams({
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
      }),
    ).toEqual({
      brokerSessionKey: 'broker-1',
      brokerTurnId: 'turn-1',
    });

    expect(
      withBrokerSessionKey('broker-1', {
        method: 'turn/completed',
        params: {
          brokerTurnId: 'turn-1',
          sessionId: 'session-1',
          conversationRef: 'conversation-1',
          result: 'done',
          model: 'claude-sonnet-4-6',
          durationMs: 25,
          numTurns: 1,
          costUsd: 0.1,
          usage: { output_tokens: 4 },
          isError: false,
          subtype: 'success',
        },
      }),
    ).toEqual({
      method: 'turn/completed',
      params: {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
        sessionId: 'session-1',
        conversationRef: 'conversation-1',
        result: 'done',
        model: 'claude-sonnet-4-6',
        durationMs: 25,
        numTurns: 1,
        costUsd: 0.1,
        usage: { output_tokens: 4 },
        isError: false,
        subtype: 'success',
      },
    });
  });

  it('throws structured RPC errors for invalid wire input', () => {
    expectRpcError(() => parseJsonRpcInboundLine('{'), -32700, /Invalid JSON:/);
    expectRpcError(
      () =>
        parseJsonRpcInboundLine(
          JSON.stringify({
            id: 'req-1',
          }),
        ),
      -32600,
      'Invalid JSON-RPC request.',
    );
    expectRpcError(
      () =>
        requireSessionEnsureParams({
          cwd: '/workspace',
          permissionMode: 'bypassPermissions',
        }),
      -32602,
      'Invalid params for session/ensure.',
    );
  });
});

function expectRpcError(run: () => unknown, code: number, message: string | RegExp): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ClaudeBrokerRpcError);
  expect((thrown as ClaudeBrokerRpcError).code).toBe(code);
  if (typeof message === 'string') {
    expect((thrown as ClaudeBrokerRpcError).message).toBe(message);
    return;
  }
  expect((thrown as ClaudeBrokerRpcError).message).toMatch(message);
}
