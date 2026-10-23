import { currentCoralStoreFormat } from '#src/store-format.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { describe, expect, it } from 'vitest';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('provider proxy durable claim mirror', () => {
  it('releases retirement protection only on committed settlement exhaustion and retains receipt delivery across restart', () => {
    const db = createDb();
    try {
      const pending = providerOperationRecord('settlement-pending');
      insertProviderOperation(db, pending);
      const mirror = new ProviderProxySetClaimMirror();
      mirror.initialize([pending]);
      const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => mirror.applyMutation(mutation));
      expect(mirror.claimFor(pending.operation)).toMatchObject({ retirementProtection: 'live' });
      const identity = mirror.claimFor(pending.operation)!.setIdentity;
      expect(mirror.claimsFor(identity)).toHaveLength(1);
      const eligible = providerOperationRecordSchema.parse({
        ...pending,
        revision: pending.revision + 1,
        settlementFailure: { elapsedMs: 120_000, observedAtMs: 120_100, containmentRequested: true },
      });
      expect(
        compareAndSwapProviderOperation(db, { ...pending, revision: 99 }, { ...eligible, revision: 100 }).kind,
      ).toBe('conflict');
      expect(mirror.claimFor(pending.operation)).toMatchObject({ retirementProtection: 'live' });
      expect(mirror.claimsFor(identity)).toHaveLength(1);
      expect(compareAndSwapProviderOperation(db, pending, eligible).kind).toBe('updated');
      expect(mirror.size).toBe(1);
      expect(mirror.claimFor(pending.operation)).toMatchObject({
        retirementProtection: 'released-after-settlement-exhaustion',
      });
      expect(mirror.claimsFor(identity)).toEqual([]);
      expect(mirror.operationsFor(identity)).toEqual([pending.operation]);
      const restarted = new ProviderProxySetClaimMirror();
      restarted.initialize([eligible]);
      expect(restarted.claimFor(pending.operation)).toEqual(mirror.claimFor(pending.operation));
      expect(restarted.claimsFor(identity)).toEqual([]);
      expect(restarted.operationsFor(identity)).toEqual([pending.operation]);
      expect(deleteProviderOperation(db, eligible).kind).toBe('deleted');
      expect(mirror.size).toBe(0);
      expect(mirror.operationsFor(identity)).toEqual([]);
      unsubscribe();
    } finally {
      db.close();
    }
  });

  it('changes claims only after successful insert, CAS, and delete results', () => {
    const db = createDb();
    try {
      const mirror = new ProviderProxySetClaimMirror();
      mirror.initialize([]);
      const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => mirror.applyMutation(mutation));
      const pending = providerOperationRecord('prepare-pending');
      insertProviderOperation(db, pending);
      expect(mirror.size).toBe(1);

      const local = providerOperationRecord('local-recovery-pending', {
        operation: pending.operation,
        locator: pending.locator,
        revision: pending.revision + 1,
      });
      const stale = providerOperationRecord('prepare-pending', {
        operation: pending.operation,
        locator: pending.locator,
        revision: 1,
      });
      const staleNext = providerOperationRecord('local-recovery-pending', {
        operation: pending.operation,
        locator: pending.locator,
        revision: 2,
      });
      expect(compareAndSwapProviderOperation(db, stale, staleNext).kind).toBe('conflict');
      expect(mirror.size).toBe(1);
      expect(compareAndSwapProviderOperation(db, pending, local).kind).toBe('updated');
      expect(mirror.size).toBe(0);

      expect(deleteProviderOperation(db, pending).kind).toBe('conflict');
      expect(mirror.size).toBe(0);
      unsubscribe();
    } finally {
      db.close();
    }
  });
});
