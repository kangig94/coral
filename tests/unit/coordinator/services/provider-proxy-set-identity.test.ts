import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ProviderProxySetIdentityIndex,
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromCapsule,
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('complete provider proxy set identity', () => {
  it('derives all sixteen identity facts from a v2 capsule', () => {
    const identity = providerProxySetIdentityFromCapsule({
      version: 2,
      grantId: '11111111-1111-4111-8111-111111111111',
      secret: 'a'.repeat(64),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: '22222222-2222-4222-8222-222222222222',
      hostFingerprint: 'b'.repeat(64),
      guardianInstanceId: '33333333-3333-4333-8333-333333333333',
      guardianPid: 101,
      guardianIncarnation: testIncarnation(1_001),
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId: '44444444-4444-4444-8444-444444444444',
      proxyPid: 102,
      reaperInstanceId: '55555555-5555-4555-8555-555555555555',
      reaperPid: 103,
      reaperIncarnation: testIncarnation(1_003),
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'detached-process-group',
      proxyIncarnation: testIncarnation(1_002),
      proxyProcessGroupId: 102,
      proxyEndpoint: '/tmp/proxy.sock',
      orphanTimeoutMs: 30_000,
      teardownReserveMs: 14_000,
    });

    expect(Object.keys(identity)).toHaveLength(16);
    expect(identity).toMatchObject({
      guardianPid: 101,
      proxyPid: 102,
      reaperPid: 103,
      proxyProcessGroupId: 102,
      canonicalEndpoint: '/tmp/proxy.sock',
    });
  });

  it('derives every live identity field from one durable record and serializes it canonically', () => {
    const record = providerOperationRecord('executing');
    const identity = providerProxySetIdentityFromRecord(record);

    expect(identity).toEqual({
      buildSetId: record.operation.buildSetId,
      hostFingerprint: record.locator.hostFingerprint,
      guardianInstanceId: record.locator.guardian.instanceId,
      guardianPid: record.locator.guardian.pid,
      guardianIncarnation: record.locator.guardian.incarnation,
      guardianControlEndpoint: record.locator.guardian.controlEndpoint,
      proxyInstanceId: record.operation.proxyInstanceId,
      proxyPid: record.locator.proxy.pid,
      reaperInstanceId: record.locator.reaper.instanceId,
      reaperPid: record.locator.reaper.pid,
      reaperIncarnation: record.locator.reaper.incarnation,
      reaperControlEndpoint: record.locator.reaper.controlEndpoint,
      containmentKind: record.locator.containment.kind,
      proxyIncarnation: record.locator.proxy.incarnation,
      proxyProcessGroupId: record.locator.containment.processGroupId,
      canonicalEndpoint: record.locator.proxy.controlEndpoint,
    });
    expect(providerProxySetKey(identity)).toBe(providerProxySetKey({ ...identity }));
    expect(providerProxySetIdentitiesEqual(identity, { ...identity })).toBe(true);
  });

  it('keeps equal short ids on different hosts as two complete identities', () => {
    const first = providerOperationRecord('executing');
    const second = providerOperationRecord('executing', {
      operation: { ...first.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: { ...first.locator, hostFingerprint: 'b'.repeat(64) },
    });
    const index = new ProviderProxySetIdentityIndex();

    index.add(providerProxySetIdentityFromRecord(first));
    index.add(providerProxySetIdentityFromRecord(second));

    expect(index.size).toBe(2);
  });

  it('fail-stops when one three-field address aliases different guardian identity', () => {
    const first = providerOperationRecord('executing');
    const second = providerOperationRecord('executing', {
      operation: { ...first.operation, jobId: randomUUID(), operationId: randomUUID() },
      locator: {
        ...first.locator,
        guardian: { ...first.locator.guardian, instanceId: randomUUID() },
      },
    });
    const index = new ProviderProxySetIdentityIndex();

    index.add(providerProxySetIdentityFromRecord(first));
    expect(() => index.add(providerProxySetIdentityFromRecord(second))).toThrow(/provider_proxy_set_identity_alias/u);
    expect(index.size).toBe(1);
  });
});
