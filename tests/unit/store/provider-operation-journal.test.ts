import { decodeProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationDueSelections,
  ProviderOperationMutationAdmission,
  ProviderOperationMutationSetClosedError,
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

  it('makes a competing admitted closer retry without excluding its unfinished writes', async () => {
    const admission = new ProviderOperationMutationAdmission();
    const set = providerOperationRecord('executing').operation;
    let closeFirst!: () => void;
    let closeSecond!: () => void;
    let finishSecond!: () => void;
    const firstMayClose = new Promise<void>((resolve) => {
      closeFirst = resolve;
    });
    const secondMayClose = new Promise<void>((resolve) => {
      closeSecond = resolve;
    });
    const secondMayFinish = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    let proofRan = false;
    let wrote = false;
    let refusal: unknown;
    const first = admission.run(
      'first-closer',
      async () => {
        await firstMayClose;
        const fence = admission.closeSet(set);
        try {
          expect(fence).toMatchObject({ kind: 'holding', pendingMutations: ['second-closer'] });
          if (fence.kind === 'holding') await fence.retryAfter;
          expect(wrote).toBe(true);
          proofRan = true;
        } finally {
          fence.release();
        }
      },
      set,
    );
    const second = admission.run(
      'second-closer',
      async () => {
        await secondMayClose;
        try {
          admission.closeSet(set);
        } catch (error: unknown) {
          refusal = error;
        }
        await secondMayFinish;
        admission.runSync(
          'last-admitted-write',
          () => {
            wrote = true;
          },
          set,
        );
      },
      set,
    );
    closeFirst();
    await Promise.resolve();
    closeSecond();
    await Promise.resolve();
    expect(refusal).toBeInstanceOf(ProviderOperationMutationSetClosedError);
    expect(proofRan).toBe(false);
    expect(wrote).toBe(false);
    finishSecond();
    await Promise.all([first, second]);
    expect(proofRan).toBe(true);
    expect(admission.pendingMutations()).toEqual([]);
  });

  it('refuses a transferred fence wait from a mutation the fence must drain', async () => {
    const admission = new ProviderOperationMutationAdmission();
    const set = providerOperationRecord('executing').operation;
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const mutation = admission.run(
      'admitted-before-external-closer',
      async () => {
        await wait;
        if (fence.kind !== 'holding') throw new Error('expected held fence');
        const heldFence = fence;
        expect(() => heldFence.retryAfter).toThrow(ProviderOperationMutationSetClosedError);
      },
      set,
    );
    const fence = admission.closeSet(set);
    resume();
    await mutation;
    if (fence.kind === 'holding') await fence.retryAfter;
    fence.release();
    expect(admission.pendingMutations()).toEqual([]);
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
    const mismatch = { ...hostRef, fingerprint: 'd'.repeat(64) };
    {
      const candidate = { ...executing, activationAck: { ...executing.activationAck, hostRef: mismatch } };
      expect(() => decodeProviderOperationRecord(JSON.stringify(candidate))).toThrow();
    }
  });
});

it('excludes startup-owned sets before decoding while reaching later selectable due rows', () => {
  const db = createDb();
  try {
    const excluded = providerOperationRecord('settlement-pending');
    for (let job = 1; job <= 256; job++)
      insertProviderOperation(db, providerOperationRecord('settlement-pending', { job }));
    const selected = providerOperationRecord('settlement-pending', {
      job: 300,
      operation: {
        ...excluded.operation,
        jobId: '00000000-0000-4000-8000-000000000300',
        buildSetId: '00000000-0000-4000-8000-000000000099',
      },
    });
    insertProviderOperation(db, selected);
    const prepare = db.prepare.bind(db);
    let canonicalReads = 0;
    db.prepare = ((sql: string) => {
      if (sql === 'SELECT value FROM meta WHERE key = ?') canonicalReads++;
      return prepare(sql);
    }) as typeof db.prepare;
    const canSelect = (record: typeof excluded) => record.operation.buildSetId !== excluded.operation.buildSetId;
    const due = readProviderOperationDueSelections(db, 0, 32, canSelect, [excluded.operation]);
    expect(due.map((selection) => selection.record)).toEqual([selected]);
    expect(canonicalReads).toBeLessThanOrEqual(64);
    canonicalReads = 0;
    expect(readProviderOperationDueSelections(db, 0, 32, canSelect).map((selection) => selection.record)).toEqual([
      selected,
    ]);
    expect(canonicalReads).toBeGreaterThan(256);
    canonicalReads = 0;
    expect(readProviderOperationDueSelections(db, 0, 32)).toHaveLength(32);
    expect(canonicalReads).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
