import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ProviderProxySetIdentityIndex,
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
} from '#src/coordinator/services/provider-proxy-set-identity.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('complete provider proxy set identity', () => {
  it('derives every live identity field from one durable record and serializes it canonically', () => {
    const record = providerOperationRecord('executing');
    const identity = providerProxySetIdentityFromRecord(record);

    expect(identity).toEqual({
      buildSetId: record.operation.buildSetId,
      hostFingerprint: record.locator.hostFingerprint,
      guardianInstanceId: record.locator.guardian.instanceId,
      guardianPid: record.locator.guardian.pid,
      guardianProcessStartedAtSeconds: record.locator.guardian.processStartedAtSeconds,
      guardianControlEndpoint: record.locator.guardian.controlEndpoint,
      proxyInstanceId: record.operation.proxyInstanceId,
      proxyPid: record.locator.proxy.pid,
      reaperInstanceId: record.locator.reaper.instanceId,
      reaperPid: record.locator.reaper.pid,
      reaperProcessStartedAtSeconds: record.locator.reaper.processStartedAtSeconds,
      reaperControlEndpoint: record.locator.reaper.controlEndpoint,
      containmentKind: record.locator.containment.kind,
      proxyProcessStartedAtSeconds: record.locator.proxy.processStartedAtSeconds,
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
