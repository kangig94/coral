import { describe, expect, it } from 'vitest';

import {
  decodeProviderOperationRuntimeMeta,
  encodeProviderOperationRuntimeMeta,
  ProviderOperationRuntimeMetaCodecError,
  providerOperationRuntimeMetaKey,
  providerOperationRuntimeMetaSchema,
  type ProviderOperationRuntimeMeta,
} from '#src/jobs/runtime-meta.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const OPERATION_ID = '00000000-0000-4000-8000-000000000002';
const HOST_FINGERPRINT = '0123456789abcdef'.repeat(4);

// The plan's exact field listing (`Ledger, activation, replay, and durable effects`, W2.3/W2.5) — this is the
// contract, not an implementation detail, so the test pins the field set independently of schema internals.
const EXPECTED_FIELDS = [
  'version',
  'jobId',
  'operationId',
  'buildSetId',
  'hostFingerprint',
  'guardianInstanceId',
  'guardianPid',
  'guardianProcessStartedAtSeconds',
  'guardianControlEndpoint',
  'proxyInstanceId',
  'proxyPid',
  'reaperInstanceId',
  'reaperPid',
  'reaperProcessStartedAtSeconds',
  'reaperControlEndpoint',
  'containmentKind',
  'proxyProcessStartedAtSeconds',
  'proxyProcessGroupId',
  'canonicalEndpoint',
  'reservationId',
  'activationNonce',
  'providerRootPid',
  'providerRootProcessStartedAtSeconds',
  'jointContainmentReceipt',
  'committedThroughProviderSeq',
].sort();

function validMeta(overrides: Partial<ProviderOperationRuntimeMeta> = {}): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: JOB_ID,
    operationId: OPERATION_ID,
    buildSetId: '00000000-0000-4000-8000-000000000003',
    hostFingerprint: HOST_FINGERPRINT,
    guardianInstanceId: '00000000-0000-4000-8000-000000000004',
    guardianPid: 101,
    guardianProcessStartedAtSeconds: 1_700_000_000,
    guardianControlEndpoint: '/tmp/coral-proxy/guardian.sock',
    proxyInstanceId: '00000000-0000-4000-8000-000000000005',
    proxyPid: 202,
    reaperInstanceId: '00000000-0000-4000-8000-000000000006',
    reaperPid: 303,
    reaperProcessStartedAtSeconds: 1_700_000_001,
    reaperControlEndpoint: '/tmp/coral-proxy/reaper.sock',
    containmentKind: 'process-group',
    proxyProcessStartedAtSeconds: 1_700_000_002,
    proxyProcessGroupId: 404,
    canonicalEndpoint: '/tmp/coral-proxy/proxy.sock',
    reservationId: '00000000-0000-4000-8000-000000000007',
    activationNonce: '00000000-0000-4000-8000-000000000008',
    providerRootPid: 505,
    providerRootProcessStartedAtSeconds: 1_700_000_003,
    jointContainmentReceipt: 'receipt-abc123',
    committedThroughProviderSeq: 0,
    ...overrides,
  };
}

describe('providerOperationRuntimeMetaSchema', () => {
  it('accepts exactly the fields the plan lists, no more and no fewer', () => {
    expect(Object.keys(providerOperationRuntimeMetaSchema.shape).sort()).toEqual(EXPECTED_FIELDS);
  });

  it('rejects an unknown field', () => {
    const withExtra = { ...validMeta(), unexpectedField: 'nope' } as ProviderOperationRuntimeMeta;
    expect(() => providerOperationRuntimeMetaSchema.parse(withExtra)).toThrow();
  });

  it('rejects a non-canonical-case UUID field', () => {
    const lettered = '0a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d';
    const uppercased = validMeta({ jobId: lettered.toUpperCase() });
    expect(() => providerOperationRuntimeMetaSchema.parse(uppercased)).toThrow();
  });

  it('rejects a non-absolute endpoint', () => {
    const relative = validMeta({ canonicalEndpoint: 'relative/proxy.sock' });
    expect(() => providerOperationRuntimeMetaSchema.parse(relative)).toThrow();
  });
});

describe('providerOperationRuntimeMetaKey', () => {
  it('formats the exact key format the coordinator writes', () => {
    expect(providerOperationRuntimeMetaKey(JOB_ID, OPERATION_ID)).toBe(
      `provider_operation.v1:${JOB_ID}:${OPERATION_ID}`,
    );
  });

  it('refuses to build a key from a non-canonical id', () => {
    expect(() => providerOperationRuntimeMetaKey('not-a-uuid', OPERATION_ID)).toThrow();
  });
});

describe('encodeProviderOperationRuntimeMeta / decodeProviderOperationRuntimeMeta', () => {
  it('round-trips a valid record through encode and decode', () => {
    const meta = validMeta();
    const encoded = encodeProviderOperationRuntimeMeta(meta);

    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(4096);
    expect(decodeProviderOperationRuntimeMeta(encoded)).toEqual(meta);
  });

  it('rejects encoding a record whose bytes exceed the 4096-byte cap', () => {
    const oversized = validMeta({ jointContainmentReceipt: 'x'.repeat(5000) });

    let thrown: unknown;
    try {
      encodeProviderOperationRuntimeMeta(oversized);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderOperationRuntimeMetaCodecError);
    expect((thrown as ProviderOperationRuntimeMetaCodecError).code).toBe('meta_too_large');
  });

  it('rejects decoding a raw value over the 4096-byte cap before parsing it as JSON', () => {
    const oversizedRaw = 'x'.repeat(5000);

    let thrown: unknown;
    try {
      decodeProviderOperationRuntimeMeta(oversizedRaw);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderOperationRuntimeMetaCodecError);
    expect((thrown as ProviderOperationRuntimeMetaCodecError).code).toBe('meta_too_large');
  });

  it('rejects decoding malformed JSON', () => {
    let thrown: unknown;
    try {
      decodeProviderOperationRuntimeMeta('{not json');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderOperationRuntimeMetaCodecError);
    expect((thrown as ProviderOperationRuntimeMetaCodecError).code).toBe('meta_invalid');
  });

  it('rejects decoding valid JSON that fails schema validation', () => {
    const encoded = JSON.stringify({ ...validMeta(), version: 2 });

    let thrown: unknown;
    try {
      decodeProviderOperationRuntimeMeta(encoded);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderOperationRuntimeMetaCodecError);
    expect((thrown as ProviderOperationRuntimeMetaCodecError).code).toBe('meta_invalid');
  });
});
