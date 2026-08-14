import { currentCoralStoreFormat } from '#src/store-format.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { describe, expect, it } from 'vitest';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('provider proxy durable claim mirror', () => {
  it('builds the complete startup snapshot before reconciliation and excludes only local recovery', () => {
    const claimed = providerOperationRecord('prepare-pending');
    const local = providerOperationRecord('local-recovery-pending', { job: 2 });
    const mirror = new ProviderProxySetClaimMirror();

    mirror.initialize([claimed, local]);

    expect(mirror.size).toBe(1);
    expect(mirror.claimFor(claimed.operation)?.setIdentity.guardianInstanceId).toBe(
      claimed.locator.guardian.instanceId,
    );
    expect(mirror.claimFor(local.operation)).toBeNull();
  });

  it('publishes a durable executing claim synchronously before any attach can complete', () => {
    const db = createDb();
    try {
      const mirror = new ProviderProxySetClaimMirror();
      mirror.initialize([]);
      const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => mirror.applyMutation(mutation));
      const executing = providerOperationRecord('executing');

      insertProviderOperation(db, executing);

      expect(mirror.claimFor(executing.operation)?.setIdentity).toMatchObject({
        proxyInstanceId: executing.operation.proxyInstanceId,
        guardianInstanceId: executing.locator.guardian.instanceId,
      });
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

  it('does not publish a claim when a durable insert fails', () => {
    const db = createDb();
    try {
      const durable = providerOperationRecord('prepare-pending');
      insertProviderOperation(db, durable);
      const mirror = new ProviderProxySetClaimMirror();
      mirror.initialize([]);
      const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => mirror.applyMutation(mutation));
      const rejected = providerOperationRecord('prepare-pending', {
        operation: durable.operation,
        locator: { ...durable.locator, hostFingerprint: 'b'.repeat(64) },
      });

      expect(() => insertProviderOperation(db, rejected)).toThrow();

      expect(readProviderOperation(db, durable.operation)?.locator.hostFingerprint).toBe(
        durable.locator.hostFingerprint,
      );
      expect(mirror.size).toBe(0);
      unsubscribe();
    } finally {
      db.close();
    }
  });
});
