import { describe, expect, it } from 'vitest';

import {
  CLAUDE_BROKER_MAX_JSONL_LINE_BYTES,
  ClaudeBrokerRpcError,
  JsonRpcLineTooLargeError,
  parseJsonRpcInboundLine,
  requireSessionEnsureParams,
  requireTurnSendParams,
} from '#src/providers/claude/appserver/protocol.js';

describe('claude appserver protocol helpers', () => {
  const send = {
    brokerSessionKey: 'broker-1',
    brokerTurnId: 'turn-1',
    text: 'Change direction',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
  };

  it('validates the turn/send address, text and UUID before dispatch', () => {
    expect(requireTurnSendParams(send)).toEqual(send);
    for (const invalid of [
      { ...send, brokerSessionKey: '' },
      { ...send, brokerTurnId: '' },
      { ...send, text: '' },
      { ...send, clientMessageId: 'not-a-uuid' },
      { ...send, extra: true },
    ]) {
      expectRpcError(() => requireTurnSendParams(invalid), -32602, 'Invalid params for turn/send.');
    }
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

  it('rejects oversized inbound JSON-RPC lines with a typed error', () => {
    const line = 'x'.repeat(CLAUDE_BROKER_MAX_JSONL_LINE_BYTES + 1);
    const thrown = captureRpcError(() => parseJsonRpcInboundLine(line));

    expect(thrown).toBeInstanceOf(JsonRpcLineTooLargeError);
    expect(thrown.code).toBe(-32700);
    expect(thrown.data).toEqual({
      code: 'json_rpc_line_too_large',
      maxLineBytes: CLAUDE_BROKER_MAX_JSONL_LINE_BYTES,
      observedBytes: CLAUDE_BROKER_MAX_JSONL_LINE_BYTES + 1,
    });
  });
});

function expectRpcError(run: () => unknown, code: number, message: string | RegExp): void {
  const thrown = captureRpcError(run);

  expect(thrown.code).toBe(code);
  if (typeof message === 'string') {
    expect(thrown.message).toBe(message);
    return;
  }
  expect(thrown.message).toMatch(message);
}

function captureRpcError(run: () => unknown): ClaudeBrokerRpcError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ClaudeBrokerRpcError);
  return thrown as ClaudeBrokerRpcError;
}
