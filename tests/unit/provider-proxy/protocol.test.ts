import { describe, expect, it } from 'vitest';

import {
  decodeProxyControlFrame,
  MAX_PROXY_CONTROL_FRAME_BYTES,
  ProxyControlProtocolError,
  proxyOperationActivateParamsSchema,
} from '#src/provider-proxy/protocol.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';

describe('provider proxy protocol vocabulary', () => {
  it('accepts a newline-delimited frame at the byte cap and rejects one byte over it', () => {
    const prefix = '{"jsonrpc":"2.0","id":"frame","method":"control.test","params":"';
    const suffix = '"}\n';
    const paddingBytes = MAX_PROXY_CONTROL_FRAME_BYTES - Buffer.byteLength(prefix + suffix, 'utf8');
    const atLimit = `${prefix}${'a'.repeat(paddingBytes)}${suffix}`;

    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_PROXY_CONTROL_FRAME_BYTES);
    expect(decodeProxyControlFrame(atLimit)).toMatchObject({ method: 'control.test' });

    const overLimit = `${prefix}${'a'.repeat(paddingBytes + 1)}${suffix}`;
    expect(() => decodeProxyControlFrame(overLimit)).toThrowError(ProxyControlProtocolError);
    try {
      decodeProxyControlFrame(overLimit);
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'frame_too_large' });
    }
  });
});

describe('proxy control-method request schemas, shared with their coordinator senders', () => {
  const operation = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };

  it('operation.activate.v1: refuses the exact extra field that made every activation fail', () => {
    const valid = {
      operation,
      reservation: UUID_A,
      jointContainmentReceipt: 'joint-1',
      jointActivationReceipt: 'joint-activation-1',
    };
    expect(proxyOperationActivateParamsSchema.safeParse(valid).success).toBe(true);

    // Sharing the strict schema keeps a sender from adding coordinator-only state to the wire contract.
    const extra = proxyOperationActivateParamsSchema.safeParse({ ...valid, committedThroughProviderSeq: 0 });
    expect(extra.success).toBe(false);
    if (!extra.success) {
      expect(extra.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
    }

    const { jointContainmentReceipt: _omitted, ...missingReceipt } = valid;
    const missing = proxyOperationActivateParamsSchema.safeParse(missingReceipt);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['jointContainmentReceipt'] })]),
      );
    }
  });
});
