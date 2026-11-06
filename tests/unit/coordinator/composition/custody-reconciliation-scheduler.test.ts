import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createCustodyReconciliationScheduler } from '#src/coordinator/composition/custody-reconciliation-scheduler.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { insertProviderOperation, providerOperationRecordKeyPrefix } from '#src/store/provider-operation-journal.js';
import { custodyLedgerDir, readCustodyLedger, recordCustodyIntent } from '#src/store/custody-ledger.js';
import { createCustodyRetentionFixture } from '#tests/helpers/custody-retention.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { providerOperationRecord } from '../../store/provider-operation-fixtures.js';

it.each([false, true])(
  'reports the last damaged hold repaired before disarming (publication initially present: %s)',
  async (present) => {
    vi.useFakeTimers();
    const f = createCustodyRetentionFixture(createRetentionFixture());
    f.setNow(500);
    const log = vi.fn();
    const record = providerOperationRecord('prepare-pending');
    const intent = recordCustodyIntent(f.runtime, f.runDir, {
      effect: 'provider-operation-publication',
      epoch: 'epoch-1',
      owner: 'provider-operation',
      operationId: record.operation.operationId,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    const entry = join(custodyLedgerDir(f.runDir), intent.id);
    f.runtime.storage.writeFileSync(join(entry, 'binding.v1.json'), '{');
    const storeServicesRef = createStoreServicesRef();
    storeServicesRef.set({ storeDb: f.db, progressStore: f.store, consumerDriver: null });
    const scheduler = createCustodyReconciliationScheduler({
      runtime: f.runtime,
      bootId: 'repair-test',
      world: { storeServicesRef, log },
      selectedStoreEpochPath: () => 'epoch-1',
    });
    try {
      if (present) insertProviderOperation(f.db, record);
      scheduler.arm();
      if (!present) {
        expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'holding' }]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('state=held'));
        log.mockClear();
        insertProviderOperation(f.db, record);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
      const evidence = log.mock.calls.map(([line]) => line).find((line) => line.startsWith('custody-damage '));
      expect(evidence).toBeDefined();
      expect(JSON.parse(evidence!.slice('custody-damage '.length))).toMatchObject({
        counts: { reported: 1, cleared: 1 },
        entries: [
          {
            entry,
            observed: { disposition: 'holding', reason: 'identity binding is incomplete or mismatched' },
            final: { disposition: 'bound' },
            cleared: true,
          },
        ],
      });
      if (!present) expect(log).toHaveBeenCalledWith(expect.stringContaining('state=cleared'));
      expect(log.mock.calls.some(([line]) => line.includes('state=held'))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      const count = log.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      scheduler.arm();
      expect(log).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      f.close();
    }
  },
);

it('keeps a persistent damaged binding with an unreadable publication silent across completed retries', async () => {
  vi.useFakeTimers();
  const f = createCustodyRetentionFixture(createRetentionFixture());
  f.setNow(10_000);
  const record = providerOperationRecord('prepare-pending');
  insertProviderOperation(f.db, record);
  f.db
    .prepare<[string, string]>('UPDATE meta SET value = ? WHERE key LIKE ?')
    .run('{', `${providerOperationRecordKeyPrefix(record.operation.jobId)}%`);
  const intent = recordCustodyIntent(f.runtime, f.runDir, {
    effect: 'provider-operation-publication',
    epoch: 'epoch-1',
    owner: 'provider-operation',
    operationId: record.operation.operationId,
    capsule: null,
    nowMs: 100,
    bindWithinMs: 1_000,
  });
  f.runtime.storage.writeFileSync(join(custodyLedgerDir(f.runDir), intent.id, 'binding.v1.json'), '{');
  let completed = 0;
  const runtime = {
    ...f.runtime,
    time: {
      ...f.runtime.time,
      setTimeout: (callback: () => void, milliseconds: number) =>
        f.runtime.time.setTimeout(() => {
          callback();
          if (milliseconds === 1_000) completed++;
        }, milliseconds),
    },
  };
  const log = vi.fn();
  const storeServicesRef = createStoreServicesRef();
  storeServicesRef.set({ storeDb: f.db, progressStore: f.store, consumerDriver: null });
  const scheduler = createCustodyReconciliationScheduler({
    runtime,
    bootId: 'persistent-damage-test',
    world: { storeServicesRef, log },
    selectedStoreEpochPath: () => 'epoch-1',
  });
  try {
    scheduler.arm();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('state=held'));
    expect(log.mock.calls[0][0]).toContain('unreadable rows');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(completed).toBe(3);
    expect(log).toHaveBeenCalledOnce();
    expect(readCustodyLedger(runtime, f.runDir)).toMatchObject([{ kind: 'holding' }]);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    f.close();
  }
});

it('keeps an entry held when a pass cannot open the store and clears only after successful repair', async () => {
  vi.useFakeTimers();
  const f = createCustodyRetentionFixture(createRetentionFixture());
  f.setNow(500);
  const record = providerOperationRecord('prepare-pending');
  const intent = recordCustodyIntent(f.runtime, f.runDir, {
    effect: 'provider-operation-publication',
    epoch: 'epoch-1',
    owner: 'provider-operation',
    operationId: record.operation.operationId,
    capsule: null,
    nowMs: 100,
    bindWithinMs: 1_000,
  });
  const entry = join(custodyLedgerDir(f.runDir), intent.id);
  f.runtime.storage.writeFileSync(join(entry, 'binding.v1.json'), '{');
  const log = vi.fn();
  const storeServicesRef = createStoreServicesRef();
  storeServicesRef.set({ storeDb: f.db, progressStore: f.store, consumerDriver: null });
  const scheduler = createCustodyReconciliationScheduler({
    runtime: f.runtime,
    bootId: 'interrupted-observation-test',
    world: { storeServicesRef, log },
    selectedStoreEpochPath: () => 'epoch-1',
  });
  const getDb = vi.spyOn(f.store, 'getDb');
  try {
    scheduler.arm();
    expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'holding' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('state=held'));
    getDb.mockClear();
    const failure = new Error('store unavailable');
    getDb.mockImplementation(() => {
      throw failure;
    });
    log.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getDb).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    const interrupted = JSON.parse(log.mock.calls[0][0].split(' detail=')[1]);
    expect(interrupted.counts).toEqual({ added: 1, changed: 0, cleared: 0 });
    expect(interrupted.changes).toMatchObject([
      { kind: 'added', identity: f.runDir, reason: [expect.stringContaining('store unavailable')] },
    ]);
    log.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getDb).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
    getDb.mockRestore();
    insertProviderOperation(f.db, record);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readCustodyLedger(f.runtime, f.runDir)).toMatchObject([{ kind: 'bound' }]);
    const clearedLine = log.mock.calls.map(([line]) => line).find((line) => line.includes('state=cleared'));
    expect(clearedLine).toBeDefined();
    const cleared = JSON.parse(clearedLine!.split(' detail=')[1]);
    expect(cleared.counts).toEqual({ added: 0, changed: 0, cleared: 2 });
    expect(cleared.changes.map((change: { identity: string }) => change.identity).sort()).toEqual(
      [entry, f.runDir].sort(),
    );
    expect(vi.getTimerCount()).toBe(0);
    log.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log).not.toHaveBeenCalled();
  } finally {
    getDb.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
    f.close();
  }
});
