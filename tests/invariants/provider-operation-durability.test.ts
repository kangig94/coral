import { describe, expect, it } from 'vitest';

import { decodeProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('provider operation durability', () => {
  it('rejects a pending prepare without its prepare source', () => {
    const candidate = { ...providerOperationRecord('prepare-pending') } as Record<string, unknown>;
    delete candidate.prepareSource;

    expect(() => decodeProviderOperationRecord(JSON.stringify(candidate))).toThrow(/prepareSource/u);
  });

  it('rejects an activation receipt bound to another job or locator', () => {
    const executing = providerOperationRecord('executing');
    if (executing.phase !== 'executing') throw new Error('expected executing fixture');
    const hostRef = executing.activationAck.hostRef;
    for (const mismatch of [
      { ...hostRef, fingerprint: 'd'.repeat(64) },
      { ...hostRef, leaseMode: 'job-exclusive', ownerJobId: '00000000-0000-4000-8000-000000000099' },
    ]) {
      const candidate = { ...executing, activationAck: { ...executing.activationAck, hostRef: mismatch } };
      expect(() => decodeProviderOperationRecord(JSON.stringify(candidate))).toThrow();
    }
  });
});
