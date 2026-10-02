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
import { describe, expect, it } from 'vitest';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('provider proxy durable claim mirror', () => {
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
