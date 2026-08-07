import { describe, expect, it } from 'vitest';

import {
  coordinatorIdentitySchema,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  guardianIdentitySchema,
  MAX_PROXY_CONTROL_FRAME_BYTES,
  operationIdentitySchema,
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  proxyHandoffOperationSchema,
  proxyIdentitySchema,
  reaperIdentitySchema,
} from '#src/provider-proxy/protocol.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const HOST_FINGERPRINT = 'a'.repeat(64);

const proxyIdentity = {
  proxyInstanceId: UUID_A,
  pid: 100,
  processStartedAtSeconds: 200,
  processGroupId: 100,
  guardianInstanceId: UUID_B,
  reaperInstanceId: UUID_C,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
  hostFingerprint: HOST_FINGERPRINT,
  canonicalEndpoint: '/tmp/provider.sock',
};

describe('provider proxy protocol vocabulary', () => {
  it('publishes the normative frame and timeout constants', () => {
    expect(MAX_PROXY_CONTROL_FRAME_BYTES).toBe(17 * 1024 * 1024);
    expect(PROXY_CONTROL_RPC_TIMEOUT_MS).toBe(5_000);
    expect(PROXY_EVENT_COMMIT_TIMEOUT_MS).toBe(30_000);
    expect(PROXY_STATUS_RPC_TIMEOUT_MS).toBe(500);
  });

  it('validates every identity field set strictly', () => {
    expect(
      coordinatorIdentitySchema.parse({
        instanceId: UUID_A,
        pid: 99,
        processStartedAtSeconds: 199,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: UUID_D,
      }),
    ).toBeDefined();
    expect(
      guardianIdentitySchema.parse({
        guardianInstanceId: UUID_B,
        pid: 101,
        processStartedAtSeconds: 201,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: UUID_D,
        hostFingerprint: HOST_FINGERPRINT,
        canonicalControlEndpoint: '/tmp/guardian.sock',
      }),
    ).toBeDefined();
    expect(
      reaperIdentitySchema.parse({
        reaperInstanceId: UUID_C,
        pid: 102,
        processStartedAtSeconds: 202,
        guardianInstanceId: UUID_B,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: UUID_D,
        hostFingerprint: HOST_FINGERPRINT,
        canonicalControlEndpoint: '/tmp/reaper.sock',
        containmentKind: 'posix-process-group',
      }),
    ).toBeDefined();
    expect(proxyIdentitySchema.parse(proxyIdentity)).toEqual(proxyIdentity);
    expect(
      operationIdentitySchema.parse({
        jobId: UUID_A,
        operationId: UUID_B,
        proxyInstanceId: UUID_C,
        buildSetId: UUID_D,
      }),
    ).toBeDefined();
    expect(
      proxyHandoffOperationSchema.parse({
        operation: {
          jobId: UUID_A,
          operationId: UUID_B,
          proxyInstanceId: UUID_C,
          buildSetId: UUID_D,
        },
        carrierState: 'executing',
        committedThroughProviderSeq: 0,
      }),
    ).toBeDefined();
  });

  it('rejects unknown identity fields', () => {
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, unexpected: true }).success).toBe(false);
  });

  it('rejects non-canonical scalars and open-ended enum values', () => {
    expect(
      proxyIdentitySchema.safeParse({
        ...proxyIdentity,
        proxyInstanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, hostFingerprint: 'a'.repeat(63) }).success).toBe(false);
    expect(
      proxyIdentitySchema.safeParse({ ...proxyIdentity, processGroupId: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, generation: 'gen3' }).success).toBe(false);
    expect(
      proxyHandoffOperationSchema.safeParse({
        operation: {
          jobId: UUID_A,
          operationId: UUID_B,
          proxyInstanceId: UUID_C,
          buildSetId: UUID_D,
        },
        carrierState: 'unknown',
        committedThroughProviderSeq: 0,
      }).success,
    ).toBe(false);
  });

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

  it('rejects unknown JSON-RPC envelope fields and emits one canonical newline', () => {
    const invalid = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'frame',
      method: 'control.test',
      unexpected: true,
    })}\n`;

    expect(() => decodeProxyControlFrame(invalid)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(encodeProxyControlFrame({ jsonrpc: '2.0', id: 'frame', method: 'control.test' })).toMatch(/[^\n]\n$/);
  });
});
