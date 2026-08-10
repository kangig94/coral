import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperations,
  readProviderOperationsDue,
} from '#src/store/provider-operation-journal.js';
import {
  decodeProviderOperationRecord,
  encodeProviderOperationRecord,
  providerOperationJobRecoveryOwner,
  providerOperationRecordSchema,
  type ProviderOperationPhase,
  type ProviderOperationRecord,
} from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { providerOperationRecord } from './provider-operation-fixtures.js';

const SAGA_PREFIX = 'provider_operation_saga.v1:';
const RECORD_PREFIX = `${SAGA_PREFIX}record:`;
const DUE_PREFIX = `${SAGA_PREFIX}due:`;
const PHASES = [
  'prepare-pending',
  'guardian-activation-pending',
  'proxy-activation-pending',
  'executing',
  'prestart-cleanup-pending',
  'local-recovery-pending',
  'activation-resolution-pending',
  'settlement-pending',
] as const satisfies readonly ProviderOperationPhase[];

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function sagaRows(db: Database): readonly { key: string; value: string }[] {
  return db
    .prepare<
      [string, string],
      { key: string; value: string }
    >('SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key')
    .all(SAGA_PREFIX, `${SAGA_PREFIX}\uffff`);
}

describe('provider operation journal', () => {
  it('assigns the durable local handoff only to generic job recovery', () => {
    for (const phase of PHASES) {
      expect(providerOperationJobRecoveryOwner(providerOperationRecord(phase))).toBe(
        phase === 'local-recovery-pending' ? 'generic-job-recovery' : 'provider-operation-saga',
      );
    }
  });

  it('isolates a strict, bounded saga keyspace and composes with an open transaction', () => {
    const db = createDb();
    try {
      const objects = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name IN ('provider_operations', 'provider_operations_due')`,
        )
        .all();
      expect(objects).toEqual([]);

      for (const phase of PHASES) {
        const record = providerOperationRecord(phase);
        expect(decodeProviderOperationRecord(encodeProviderOperationRecord(record))).toEqual(record);
      }

      const pending = providerOperationRecord('prepare-pending');
      if (pending.phase !== 'prepare-pending') throw new Error('expected prepare-pending fixture');
      const oversized = providerOperationRecordSchema.parse({
        ...pending,
        prepareSource: {
          ...pending.prepareSource,
          childAuthorization: {
            ...pending.prepareSource.childAuthorization,
            principalWire: {
              subject: 'agent',
              binding: { kind: 'project', root: `/${'x'.repeat(65_000)}` },
              attenuatedCaps: ['liveness'],
            },
          },
        },
      });
      expect(() => encodeProviderOperationRecord(oversized)).toThrow(/exceeding the 65536-byte limit/);
      expect(() => decodeProviderOperationRecord(JSON.stringify(oversized))).toThrow(/exceeding the 65536-byte limit/);

      const localRecovery = providerOperationRecord('local-recovery-pending');
      if (localRecovery.phase !== 'local-recovery-pending') throw new Error('expected local recovery fixture');
      expect(
        decodeProviderOperationRecord(encodeProviderOperationRecord({ ...localRecovery, reason: 'x'.repeat(4096) })),
      ).toEqual({ ...localRecovery, reason: 'x'.repeat(4096) });
      expect(providerOperationRecordSchema.safeParse({ ...localRecovery, reason: 'x'.repeat(4097) }).success).toBe(
        false,
      );

      const invalid = {
        ...providerOperationRecord('prepare-pending'),
        reservation: '00000000-0000-4000-8000-000000000007',
      } as unknown as ProviderOperationRecord;
      expect(() => insertProviderOperation(db, invalid)).toThrow(/failed schema validation.*reservation/s);
      expect(sagaRows(db)).toEqual([]);

      const record = providerOperationRecord('prepare-pending');
      db.exec('BEGIN IMMEDIATE');
      insertProviderOperation(db, record);
      expect(sagaRows(db)).toHaveLength(2);
      db.exec('ROLLBACK');
      expect(readProviderOperation(db, record.operation)).toBeNull();

      const executing = providerOperationRecord('executing', { job: 2 });
      insertProviderOperation(db, record);
      insertProviderOperation(db, executing);
      expect(sagaRows(db).map(({ key }) => key)).toEqual([
        expect.stringMatching(/^provider_operation_saga\.v1:due:/u),
        expect.stringMatching(/^provider_operation_saga\.v1:due:/u),
        expect.stringMatching(/^provider_operation_saga\.v1:record:/u),
        expect.stringMatching(/^provider_operation_saga\.v1:record:/u),
      ]);
      expect(
        db
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'provider_operation.v1:%'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('accepts resolution directives only on the phase that will consume them', () => {
    const requestedAt = '2026-08-09T12:34:56.000Z';
    const prestart = providerOperationRecordSchema.parse({
      ...providerOperationRecord('prestart-cleanup-pending'),
      afterRelease: { kind: 'terminal-aborted', cause: 'user_abort', requestedAt },
    });
    const resolving = providerOperationRecordSchema.parse({
      ...providerOperationRecord('activation-resolution-pending'),
      onNeverStarted: { kind: 'local-authorized', reason: 'The exact attempt never started.' },
      activationIndeterminate: {
        kind: 'terminal-failed',
        code: 'activation_indeterminate',
        reason: 'The start boundary cannot be resolved.',
      },
    });
    const executing = providerOperationRecordSchema.parse({
      ...providerOperationRecord('executing'),
      controlIntent: { kind: 'stop', cause: 'signal_abort', requestedAt },
    });

    for (const record of [prestart, resolving, executing]) {
      expect(decodeProviderOperationRecord(encodeProviderOperationRecord(record))).toEqual(record);
    }
    expect(
      providerOperationRecordSchema.safeParse({
        ...providerOperationRecord('prestart-cleanup-pending'),
        controlIntent: { kind: 'run' },
      }).success,
    ).toBe(false);
    expect(
      providerOperationRecordSchema.safeParse({
        ...providerOperationRecord('executing'),
        controlIntent: { kind: 'stop', cause: 'signal_abort' },
      }).success,
    ).toBe(false);

    const cleanup = providerOperationRecord('prestart-cleanup-pending');
    if (cleanup.phase !== 'prestart-cleanup-pending') throw new Error('expected prestart cleanup fixture');
    const { afterRelease: _afterRelease, ...missingAfterRelease } = cleanup;
    expect(() => decodeProviderOperationRecord(JSON.stringify(missingAfterRelease))).toThrow(
      /failed schema validation.*afterRelease/s,
    );
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

  it('rolls back the canonical CAS when the due-index mutation count disagrees', () => {
    const db = createDb();
    try {
      const initial = providerOperationRecord('prepare-pending', { retryNotBeforeMs: 100 });
      insertProviderOperation(db, initial);
      expect(
        db.prepare<[string, string]>('DELETE FROM meta WHERE key >= ? AND key < ?').run(DUE_PREFIX, `${DUE_PREFIX};`)
          .changes,
      ).toBe(1);

      const next = { ...initial, revision: 1, retryNotBeforeMs: 200 };
      expect(() => compareAndSwapProviderOperation(db, initial, next)).toThrow(
        'Provider operation due-index delete changed 0 rows instead of one.',
      );
      expect(readProviderOperation(db, initial.operation)).toEqual(initial);
      expect(sagaRows(db).map(({ key }) => key)).toEqual([expect.stringMatching(/:record:/u)]);
    } finally {
      db.close();
    }
  });

  it('uses a bounded key range that cannot hide due work behind a LIMIT-ed record scan', () => {
    const db = createDb();
    try {
      const scheduled = Array.from({ length: 32 }, (_, index) =>
        providerOperationRecord('guardian-activation-pending', {
          job: index + 1,
          retryNotBeforeMs: 101,
        }),
      );
      const due = providerOperationRecord('prepare-pending', { job: 99, retryNotBeforeMs: 100 });
      const localRecoveryDue = providerOperationRecord('local-recovery-pending', {
        job: 97,
        retryNotBeforeMs: 100,
      });
      const executing = providerOperationRecord('executing', { job: 98, retryNotBeforeMs: 0 });
      for (const record of [...scheduled, due, localRecoveryDue, executing]) insertProviderOperation(db, record);

      const naivelyLimited = db
        .prepare<[string, string, number], Pick<{ value: string }, 'value'>>(
          `SELECT value FROM meta
           WHERE key >= ? AND key < ?
           ORDER BY key
           LIMIT ?`,
        )
        .all(RECORD_PREFIX, `${RECORD_PREFIX};`, 32)
        .map(({ value }) => decodeProviderOperationRecord(value))
        .filter((record) => record.phase !== 'executing' && record.retryNotBeforeMs <= 100);
      expect(naivelyLimited).toEqual([]);
      expect(readProviderOperationsDue(db, 100, 3)).toEqual([executing, localRecoveryDue, due]);

      const plan = db
        .prepare<[string, string, number], { detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT key, value FROM meta
           WHERE key >= ? AND key < ?
           ORDER BY key
           LIMIT ?`,
        )
        .all(DUE_PREFIX, `${DUE_PREFIX}${String(100).padStart(16, '0')};`, 1);
      expect(plan.map(({ detail }) => detail).join('\n')).toMatch(/SEARCH meta USING INDEX .*\(key>\? AND key<\?\)/u);
    } finally {
      db.close();
    }
  });

  it('enumerates every canonical journal row across keyset pages and phases', () => {
    const db = createDb();
    try {
      const records = Array.from({ length: 130 }, (_, index) =>
        providerOperationRecord(PHASES[index % PHASES.length] ?? 'prepare-pending', { job: index + 1 }),
      );
      for (const record of records) insertProviderOperation(db, record);

      expect(readProviderOperations(db)).toEqual(
        [...records].sort((left, right) => left.operation.jobId.localeCompare(right.operation.jobId)),
      );
    } finally {
      db.close();
    }
  });

  it('fails loudly when a canonical value is corrupt', () => {
    const db = createDb();
    try {
      const record = providerOperationRecord('prepare-pending');
      insertProviderOperation(db, record);
      db.prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key >= ? AND key < ?').run(
        '{}',
        RECORD_PREFIX,
        `${RECORD_PREFIX};`,
      );
      expect(() => readProviderOperation(db, record.operation)).toThrow(/record .* contains an invalid value/u);
    } finally {
      db.close();
    }
  });

  it('treats a stale due pointer as persisted corruption', () => {
    const db = createDb();
    try {
      const initial = providerOperationRecord('prepare-pending', { retryNotBeforeMs: 100 });
      insertProviderOperation(db, initial);
      const advanced = { ...initial, revision: 1 };
      db.prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key >= ? AND key < ?').run(
        encodeProviderOperationRecord(advanced),
        RECORD_PREFIX,
        `${RECORD_PREFIX};`,
      );

      expect(() => readProviderOperationsDue(db, 100, 1)).toThrow(/is stale or disagrees with its canonical record/u);
    } finally {
      db.close();
    }
  });
});
