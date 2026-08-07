import { describe, expect, it } from 'vitest';

import {
  coordinatorIdentitySchema,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  guardianIdentitySchema,
  MAX_PROXY_CONTROL_FRAME_BYTES,
  operationIdentitySchema,
  PROVIDER_EVENT_METHOD,
  providerEventBodySchema,
  providerEventRequestSchema,
  providerEventResultSchema,
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  proxyIdentitySchema,
  reaperIdentitySchema,
} from '#src/provider-proxy/protocol.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const HOST_FINGERPRINT = 'a'.repeat(64);

const coordinatorIdentity = {
  instanceId: UUID_A,
  pid: 99,
  processStartedAtSeconds: 199,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
};

const guardianIdentity = {
  guardianInstanceId: UUID_B,
  pid: 101,
  processStartedAtSeconds: 201,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
  hostFingerprint: HOST_FINGERPRINT,
  canonicalControlEndpoint: '/tmp/guardian.sock',
};

const reaperIdentity = {
  reaperInstanceId: UUID_C,
  pid: 102,
  processStartedAtSeconds: 202,
  guardianInstanceId: UUID_B,
  generation: 'gen2' as const,
  flavor: 'prod' as const,
  buildSetId: UUID_D,
  hostFingerprint: HOST_FINGERPRINT,
  canonicalControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'posix-process-group',
};

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

const operationIdentity = {
  jobId: UUID_A,
  operationId: UUID_B,
  proxyInstanceId: UUID_C,
  buildSetId: UUID_D,
};

describe('provider proxy protocol vocabulary', () => {
  it('publishes the normative frame and timeout constants', () => {
    expect(MAX_PROXY_CONTROL_FRAME_BYTES).toBe(17 * 1024 * 1024);
    expect(PROXY_CONTROL_RPC_TIMEOUT_MS).toBe(5_000);
    expect(PROXY_EVENT_COMMIT_TIMEOUT_MS).toBe(30_000);
    expect(PROXY_STATUS_RPC_TIMEOUT_MS).toBe(500);
  });

  it('validates every identity field set strictly', () => {
    expect(coordinatorIdentitySchema.parse(coordinatorIdentity)).toEqual(coordinatorIdentity);
    expect(guardianIdentitySchema.parse(guardianIdentity)).toEqual(guardianIdentity);
    expect(reaperIdentitySchema.parse(reaperIdentity)).toEqual(reaperIdentity);
    expect(proxyIdentitySchema.parse(proxyIdentity)).toEqual(proxyIdentity);
    expect(operationIdentitySchema.parse(operationIdentity)).toEqual(operationIdentity);
  });

  it('rejects unknown identity fields', () => {
    expect(coordinatorIdentitySchema.safeParse({ ...coordinatorIdentity, unexpected: true }).success).toBe(false);
    expect(guardianIdentitySchema.safeParse({ ...guardianIdentity, unexpected: true }).success).toBe(false);
    expect(reaperIdentitySchema.safeParse({ ...reaperIdentity, unexpected: true }).success).toBe(false);
    expect(proxyIdentitySchema.safeParse({ ...proxyIdentity, unexpected: true }).success).toBe(false);
    expect(operationIdentitySchema.safeParse({ ...operationIdentity, unexpected: true }).success).toBe(false);
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
      coordinatorIdentitySchema.safeParse({
        ...coordinatorIdentity,
        instanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(coordinatorIdentitySchema.safeParse({ ...coordinatorIdentity, generation: 'gen3' }).success).toBe(false);
    expect(coordinatorIdentitySchema.safeParse({ ...coordinatorIdentity, flavor: 'staging' }).success).toBe(false);

    expect(
      guardianIdentitySchema.safeParse({
        ...guardianIdentity,
        guardianInstanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(guardianIdentitySchema.safeParse({ ...guardianIdentity, hostFingerprint: 'a'.repeat(63) }).success).toBe(
      false,
    );
    expect(guardianIdentitySchema.safeParse({ ...guardianIdentity, flavor: 'staging' }).success).toBe(false);

    expect(
      reaperIdentitySchema.safeParse({
        ...reaperIdentity,
        reaperInstanceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(reaperIdentitySchema.safeParse({ ...reaperIdentity, containmentKind: '' }).success).toBe(false);
    expect(reaperIdentitySchema.safeParse({ ...reaperIdentity, generation: 'gen3' }).success).toBe(false);

    expect(
      operationIdentitySchema.safeParse({
        ...operationIdentity,
        jobId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).success,
    ).toBe(false);
    expect(
      operationIdentitySchema.safeParse({ ...operationIdentity, operationId: 'not-a-canonical-uuid' }).success,
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

describe('provider.event.v1 vocabulary', () => {
  const operation = { jobId: UUID_A, operationId: UUID_B, proxyInstanceId: UUID_C, buildSetId: UUID_D };

  it('publishes the one method name used in both directions of the reverse channel', () => {
    expect(PROVIDER_EVENT_METHOD).toBe('provider.event.v1');
  });

  it('accepts every ProviderEventBody variant, including the progress kind contract.ts has no schema for', () => {
    expect(providerEventBodySchema.safeParse({ kind: 'progress', message: 'tick' }).success).toBe(true);
    expect(
      providerEventBodySchema.safeParse({
        kind: 'continuity',
        conversationRef: 'ref-1',
        resumable: true,
        providerContinuity: null,
      }).success,
    ).toBe(true);
    expect(
      providerEventBodySchema.safeParse({
        kind: 'artifact_handle',
        handle: 'handle-1',
        identity: { kind: 'file', path: '/tmp/artifact' },
      }).success,
    ).toBe(true);
    expect(providerEventBodySchema.safeParse({ kind: 'suspended', reason: 'interrupt_unconfirmed' }).success).toBe(
      true,
    );
    expect(providerEventBodySchema.safeParse({ kind: 'terminal' }).success).toBe(false); // missing required fields
    expect(providerEventBodySchema.safeParse({ kind: 'unknown-kind' }).success).toBe(false);
  });

  it('validates the request strictly: canonical operation identity, a positive seq, and a covered event', () => {
    const valid = { operation, providerSeq: 1, event: { kind: 'progress', message: 'tick' } };
    expect(providerEventRequestSchema.safeParse(valid).success).toBe(true);

    expect(providerEventRequestSchema.safeParse({ ...valid, providerSeq: 0 }).success).toBe(false);
    expect(providerEventRequestSchema.safeParse({ ...valid, providerSeq: -1 }).success).toBe(false);
    expect(providerEventRequestSchema.safeParse({ ...valid, providerSeq: 1.5 }).success).toBe(false);
    expect(providerEventRequestSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    expect(
      providerEventRequestSchema.safeParse({ ...valid, event: { kind: 'progress', message: 'tick', extra: 1 } })
        .success,
    ).toBe(false);
  });

  it('validates both result variants and rejects a kind outside the closed set', () => {
    expect(providerEventResultSchema.safeParse({ kind: 'ack', committedThroughProviderSeq: 0 }).success).toBe(true);
    expect(
      providerEventResultSchema.safeParse({ kind: 'replay', replayFromProviderSeq: 1, reason: 'gap' }).success,
    ).toBe(true);

    expect(providerEventResultSchema.safeParse({ kind: 'ack', committedThroughProviderSeq: -1 }).success).toBe(false);
    expect(
      providerEventResultSchema.safeParse({ kind: 'replay', replayFromProviderSeq: 0, reason: 'gap' }).success,
    ).toBe(false);
    expect(providerEventResultSchema.safeParse({ kind: 'replay', replayFromProviderSeq: 1, reason: '' }).success).toBe(
      false,
    );
    expect(providerEventResultSchema.safeParse({ kind: 'nack', committedThroughProviderSeq: 0 }).success).toBe(false);
  });
});
