import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ProviderProxySetIdentityIndex,
  providerProxySetIdentityFromRecord,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('complete provider proxy set identity', () => {
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
