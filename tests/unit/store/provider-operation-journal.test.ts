import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  ProviderOperationMutationAdmission,
} from '#src/store/provider-operation-journal.js';
import {
  encodeProviderOperationRecord,
  PROVIDER_OPERATION_RECORD_VERSION,
} from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { providerOperationRecord } from './provider-operation-fixtures.js';

const SAGA_PREFIX = `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:`;
const RECORD_PREFIX = `${SAGA_PREFIX}record:`;

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('provider operation journal', () => {
  it('closes only one set and joins mutations admitted before its fence', async () => {
    const admission = new ProviderOperationMutationAdmission();
    const target = providerOperationRecord('prepare-pending');
    const unrelated = providerOperationRecord('prepare-pending', {
      operation: {
        ...target.operation,
        proxyInstanceId: '00000000-0000-4000-8000-000000000030',
        buildSetId: '00000000-0000-4000-8000-000000000040',
      },
      locator: {
        ...target.locator,
        proxy: {
          ...target.locator.proxy,
          instanceId: '00000000-0000-4000-8000-000000000030',
        },
      },
    });
    let settleTarget!: () => void;
    const targetMaySettle = new Promise<void>((resolve) => {
      settleTarget = resolve;
    });
    const mutation = admission.run('provider-operation:prepare', () => targetMaySettle, target.operation);
    await Promise.resolve();

    const fence = admission.closeSet(target.operation);
    expect(fence).toMatchObject({
      kind: 'holding',
      pendingMutations: ['provider-operation:prepare'],
      exit: 'admitted-provider-operation-mutation-settlement',
    });
    expect(() => admission.runSync('late-target', () => undefined, target.operation)).toThrow(
      'Provider operation mutation admission is closed for this proxy set.',
    );
    expect(admission.runSync('unrelated-set', () => 'admitted', unrelated.operation)).toBe('admitted');
    if (fence.kind !== 'holding') throw new Error('active exact-set mutation was not retained by the fence');

    let drained = false;
    void fence.retryAfter.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    settleTarget();
    await mutation;
    await fence.retryAfter;
    expect(fence.isHeld()).toBe(true);
    expect(() => admission.runSync('still-fenced', () => undefined, target.operation)).toThrow(
      'Provider operation mutation admission is closed for this proxy set.',
    );

    const successorFence = admission.closeSet(target.operation);
    fence.release();
    expect(fence.isHeld()).toBe(false);
    expect(successorFence.isHeld()).toBe(true);
    expect(() => admission.runSync('successor-fenced', () => undefined, target.operation)).toThrow(
      'Provider operation mutation admission is closed for this proxy set.',
    );
    successorFence.release();
    expect(admission.runSync('released-target', () => 'admitted', target.operation)).toBe('admitted');
  });

  it('uses exact-value compare-and-swap and makes stale revisions lose without changing the winner', () => {
    const db = createDb();
    try {
      const initial = providerOperationRecord('prepare-pending');
      insertProviderOperation(db, initial);
      const winner = { ...initial, revision: 1, retryCount: 1 };
      expect(compareAndSwapProviderOperation(db, initial, winner)).toEqual({ kind: 'updated', record: winner });

      const stale = { ...initial, revision: 1, retryCount: 99 };
      expect(compareAndSwapProviderOperation(db, initial, stale)).toEqual({
        kind: 'conflict',
        current: winner,
      });
      expect(readProviderOperation(db, initial.operation)).toEqual(winner);
      expect(deleteProviderOperation(db, initial)).toEqual({ kind: 'conflict', current: winner });
      expect(deleteProviderOperation(db, winner)).toEqual({ kind: 'deleted' });
      expect(readProviderOperation(db, initial.operation)).toBeNull();

      const sameRevisionExpected = providerOperationRecord('prepare-pending', { job: 2 });
      const sameRevisionCurrent = { ...sameRevisionExpected, retryCount: 1 };
      insertProviderOperation(db, sameRevisionExpected);
      db.prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key >= ? AND key < ?').run(
        encodeProviderOperationRecord(sameRevisionCurrent),
        RECORD_PREFIX,
        `${RECORD_PREFIX};`,
      );
      const proposed = { ...sameRevisionExpected, revision: 1 };
      expect(compareAndSwapProviderOperation(db, sameRevisionExpected, proposed)).toEqual({
        kind: 'conflict',
        current: sameRevisionCurrent,
      });
    } finally {
      db.close();
    }
  });
});
