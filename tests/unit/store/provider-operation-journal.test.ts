import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  completeExecutingProviderOperationAttachment,
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  finishProviderOperationDueSelection,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationDueSelections,
  providerOperationJobIdFromRecordKey,
  readProviderOperations,
  readSupersededProviderOperations,
  retireSupersededProviderOperation,
  readProviderOperationsDue,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import {
  decodeProviderOperationRecord,
  encodeProviderOperationRecord,
  providerOperationJobRecoveryOwner,
  providerOperationRecordSchema,
  type ProviderOperationPhase,
  type ProviderOperationRecord,
  PROVIDER_OPERATION_RECORD_VERSION,
} from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { providerOperationRecord } from './provider-operation-fixtures.js';

const SAGA_PREFIX = `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:`;
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

function dueKey(record: ProviderOperationRecord): string {
  const fixed = (value: number): string => String(value).padStart(String(Number.MAX_SAFE_INTEGER).length, '0');
  return (
    `${DUE_PREFIX}${fixed(record.retryNotBeforeMs)}:` +
    `${record.operation.jobId}:${record.operation.operationId}:${record.operation.proxyInstanceId}:` +
    `${record.operation.buildSetId}:${fixed(record.revision)}`
  );
}

function recordKey(record: ProviderOperationRecord): string {
  return (
    `${RECORD_PREFIX}${record.operation.jobId}:${record.operation.operationId}:` +
    `${record.operation.proxyInstanceId}:${record.operation.buildSetId}`
  );
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
              binding: { kind: 'project', root: process.cwd() },
              attenuatedCaps: Array.from({ length: 5_900 }, () => 'liveness'),
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
        expect.stringMatching(new RegExp(`^${DUE_PREFIX}`, 'u')),
        expect.stringMatching(new RegExp(`^${RECORD_PREFIX}`, 'u')),
        expect.stringMatching(new RegExp(`^${RECORD_PREFIX}`, 'u')),
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

  it('does not let healthy executing rows occupy a bounded due page', () => {
    const db = createDb();
    try {
      const healthy = providerOperationRecord('executing', { job: 1, retryNotBeforeMs: 0 });
      const pending = providerOperationRecord('prepare-pending', { job: 2, retryNotBeforeMs: 100 });
      insertProviderOperation(db, healthy);
      insertProviderOperation(db, pending);

      expect(readProviderOperationsDue(db, 100, 1)).toEqual([pending]);
      expect(readProviderOperationsDue(db, 100, 1)).toEqual([pending]);

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

  it('completes executing attachment against the fresh watermark while preserving it', () => {
    const db = createDb();
    try {
      const initial = {
        ...providerOperationRecord('executing', { retryNotBeforeMs: 100, retryCount: 1 }),
        lastError: { observedAtMs: 90, code: 'attach_failed', message: 'retry attachment' },
      } as Extract<ProviderOperationRecord, { phase: 'executing' }>;
      insertProviderOperation(db, initial);
      const watermarkAdvanced = { ...initial, revision: 1, committedThroughProviderSeq: 4 };
      expect(compareAndSwapProviderOperation(db, initial, watermarkAdvanced).kind).toBe('updated');

      expect(
        completeExecutingProviderOperationAttachment(
          db,
          initial.operation,
          {
            retryCount: initial.retryCount,
            retryNotBeforeMs: initial.retryNotBeforeMs,
            lastError: initial.lastError,
          },
          120,
        ),
      ).toEqual({
        kind: 'completed',
        record: {
          ...watermarkAdvanced,
          revision: 2,
          retryCount: 0,
          retryNotBeforeMs: 120,
          lastError: null,
        },
      });
      expect(readProviderOperationsDue(db, 120, 1)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not clear a superseding executing retry generation', () => {
    const db = createDb();
    try {
      const initial = {
        ...providerOperationRecord('executing', { retryNotBeforeMs: 100, retryCount: 1 }),
        lastError: { observedAtMs: 90, code: 'first_failure', message: 'first failure' },
      } as Extract<ProviderOperationRecord, { phase: 'executing' }>;
      insertProviderOperation(db, initial);
      const superseding = {
        ...initial,
        revision: 1,
        retryCount: 2,
        retryNotBeforeMs: 200,
        lastError: { observedAtMs: 110, code: 'second_failure', message: 'second failure' },
      };
      expect(compareAndSwapProviderOperation(db, initial, superseding).kind).toBe('updated');

      expect(
        completeExecutingProviderOperationAttachment(
          db,
          initial.operation,
          {
            retryCount: initial.retryCount,
            retryNotBeforeMs: initial.retryNotBeforeMs,
            lastError: initial.lastError,
          },
          120,
        ),
      ).toEqual({ kind: 'retry-superseded', current: superseding });
      expect(readProviderOperationsDue(db, 200, 1)).toEqual([superseding]);
    } finally {
      db.close();
    }
  });

  it('atomically yields a selected due row and keeps the strict reader consistent', () => {
    const db = createDb();
    try {
      const initial = providerOperationRecord('prepare-pending', { retryNotBeforeMs: 100 });
      insertProviderOperation(db, initial);
      const selection = readProviderOperationDueSelections(db, 100, 1)[0];
      if (selection === undefined) throw new Error('expected one due selection');
      const mutations: ProviderOperationRecord[] = [];
      const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => {
        if (mutation.kind === 'upserted') mutations.push(mutation.record);
      });

      const result = finishProviderOperationDueSelection(db, selection, 100, 125);
      if (result.kind !== 'yielded') throw new Error('expected the selected due row to yield');
      const canonical = readProviderOperation(db, initial.operation);
      expect.soft(canonical).toEqual(result.record);

      const replacements = readProviderOperationDueSelections(db, 126, 1);
      expect(replacements).toHaveLength(1);
      expect(replacements[0]?.record).toEqual(canonical);
      expect(replacements[0]).toMatchObject({
        rawKey: dueKey(result.record),
        rawValue: recordKey(result.record),
      });
      expect(result.record).toEqual({ ...initial, revision: 1, retryNotBeforeMs: 125 });
      expect(mutations).toEqual([result.record]);
      unsubscribe();
    } finally {
      db.close();
    }
  });

  it('finishes absent, already-advanced, and healthy legacy due selections', () => {
    const db = createDb();
    try {
      const removed = providerOperationRecord('prepare-pending', { job: 1, retryNotBeforeMs: 100 });
      insertProviderOperation(db, removed);
      const removedSelection = readProviderOperationDueSelections(db, 100, 1)[0];
      if (removedSelection === undefined) throw new Error('expected a removable due selection');
      expect(deleteProviderOperation(db, removed)).toEqual({ kind: 'deleted' });
      expect(finishProviderOperationDueSelection(db, removedSelection, 100, 125)).toEqual({ kind: 'removed' });

      const advancing = providerOperationRecord('prepare-pending', { job: 2, retryNotBeforeMs: 100 });
      insertProviderOperation(db, advancing);
      const advancingSelection = readProviderOperationDueSelections(db, 100, 1)[0];
      if (advancingSelection === undefined) throw new Error('expected an advancing due selection');
      const advanced = { ...advancing, revision: 1, retryNotBeforeMs: 200 };
      expect(compareAndSwapProviderOperation(db, advancing, advanced)).toEqual({ kind: 'updated', record: advanced });
      expect(finishProviderOperationDueSelection(db, advancingSelection, 100, 125)).toEqual({
        kind: 'already-advanced',
      });
      expect(readProviderOperationDueSelections(db, 200, 1)[0]?.record).toEqual(advanced);

      const healthy = providerOperationRecord('executing', { job: 3, retryNotBeforeMs: 100 });
      insertProviderOperation(db, healthy);
      db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        dueKey(healthy),
        recordKey(healthy),
      );
      const healthySelection = readProviderOperationDueSelections(db, 100, 1)[0];
      if (healthySelection === undefined) throw new Error('expected a healthy legacy due selection');
      expect(finishProviderOperationDueSelection(db, healthySelection, 100, 125)).toEqual({ kind: 'removed' });
      expect(readProviderOperation(db, healthy.operation)).toEqual(healthy);
      expect(readProviderOperationDueSelections(db, 100, 1)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('removes both the selected legacy key and a distinct current legacy key before membership returns', () => {
    const db = createDb();
    try {
      const initial = providerOperationRecord('prepare-pending', { retryNotBeforeMs: 100 });
      insertProviderOperation(db, initial);
      const selection = readProviderOperationDueSelections(db, 100, 1)[0];
      if (selection === undefined) throw new Error('expected a legacy due selection');
      const current = providerOperationRecordSchema.parse({
        ...providerOperationRecord('executing', { retryNotBeforeMs: 100 }),
        operation: initial.operation,
        revision: 1,
      });
      db.prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key = ? AND value = ?').run(
        encodeProviderOperationRecord(current),
        recordKey(initial),
        encodeProviderOperationRecord(initial),
      );
      db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        dueKey(current),
        recordKey(current),
      );

      expect(finishProviderOperationDueSelection(db, selection, 100, 125)).toEqual({ kind: 'removed' });
      expect(readProviderOperation(db, initial.operation)).toEqual(current);
      expect(sagaRows(db)).toEqual([{ key: recordKey(current), value: encodeProviderOperationRecord(current) }]);
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

      expect(readProviderOperations(db).records).toEqual(
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

  // A row at this build's own address whose bytes it cannot read — a truncated or partially written value, or
  // a shape a later generation forgot to move. Every scan caller sits on the coordinator's boot path, so a
  // throw is not "one stalled operation", it is no daemon at all. The row is reported and left in place.
  //
  // The value used here is a v0.10.8 payload because that is a shape known to fail this schema; the address is
  // this build's, which is what makes it a corruption case rather than the upgrade case below.
  it('reports a row this build cannot read instead of refusing the whole scan', () => {
    const db = createDb();
    try {
      const readable = providerOperationRecord('executing');
      insertProviderOperation(db, readable);

      // A genuine v0.10.8 row, at its own canonical key and carrying the due entry a real one carries. The key
      // must be well-formed: a malformed key is rejected for its shape before the value is ever judged, which
      // makes the test pass whatever the value says.
      const legacy = providerOperationRecord('prepare-pending', { job: 2 });
      const shipped = JSON.parse(encodeProviderOperationRecord(legacy)) as {
        locator: Record<string, Record<string, unknown>>;
        providerRoot?: Record<string, unknown>;
      };
      for (const part of ['proxy', 'guardian', 'reaper', 'containment']) {
        const process = shipped.locator[part];
        if (process === undefined) continue;
        delete process.incarnation;
        process.processStartedAtSeconds = 1_700_000_000;
      }
      if (shipped.providerRoot !== undefined) {
        delete shipped.providerRoot.incarnation;
        shipped.providerRoot.processStartedAtSeconds = 1_700_000_000;
      }
      const legacyKey = recordKey(legacy);
      const insert = db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)');
      insert.run(legacyKey, JSON.stringify(shipped));
      insert.run(dueKey(legacy), legacyKey);

      const scan = readProviderOperations(db);

      expect(scan.records).toEqual([readable]);
      expect(scan.unreadableKeys).toEqual([legacyKey]);
      expect(
        sagaRows(db).some((row) => row.key === legacyKey),
        'the row is skipped, never removed',
      ).toBe(true);

      // The job the row names, without decoding it. Startup ownership needs exactly this to keep that job away
      // from generic recovery, which would strict-read the same row and abort the boot it just survived.
      expect(providerOperationJobIdFromRecordKey(legacyKey)).toBe(legacy.operation.jobId);

      // And the due index must not reintroduce the fatality. Every non-executing row has a due entry, so this
      // is the shape a real orphaned operation has, and the reconciler treats a throw here as fatal.
      expect(() => readProviderOperationsDue(db, Number.MAX_SAFE_INTEGER, 10)).not.toThrow();
      expect(readProviderOperationsDue(db, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);

      // And it must not stand in front of work this build *can* do. Due keys sort by retry time, so an older
      // build's rows are the oldest there are and land at the head of every scan. Filtering one page after
      // reading it returns nothing while readable work sits immediately behind — on every poll, forever,
      // because the reconciler reads an empty selection as "nothing due".
      const readableDue = providerOperationRecord('prepare-pending', { job: 3 });
      insertProviderOperation(db, readableDue);
      expect(
        readProviderOperationsDue(db, Number.MAX_SAFE_INTEGER, 1),
        'a single unusable row at the head must not hide the whole queue behind it',
      ).toEqual([readableDue]);
    } finally {
      db.close();
    }
  });
  // The upgrade case, at the address a real predecessor row actually occupies. v0.10.8 wrote its rows under
  // `provider_operation_saga.v1:`, and this build's decoder cannot read them — but the key still names the job,
  // and that is the whole requirement: an operation left in flight across the upgrade must keep its job away
  // from generic recovery, which would strict-read the same row and abort the boot it just survived.
  it('fences a superseded generation by key without ever reading its bytes', () => {
    const db = createDb();
    try {
      const readable = providerOperationRecord('executing');
      insertProviderOperation(db, readable);

      const stranded = providerOperationRecord('prepare-pending', { job: 2 });
      const supersededKey =
        `provider_operation_saga.v1:record:${stranded.operation.jobId}:${stranded.operation.operationId}:` +
        `${stranded.operation.proxyInstanceId}:${stranded.operation.buildSetId}`;
      db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        supersededKey,
        'not json, and never parsed',
      );

      const scan = readProviderOperations(db);

      expect(scan.records).toEqual([readable]);
      expect(scan.unreadableKeys).toEqual([supersededKey]);
      expect(providerOperationJobIdFromRecordKey(supersededKey)).toBe(stranded.operation.jobId);
      expect(
        db.prepare<[string], { key: string }>('SELECT key FROM meta WHERE key = ?').all(supersededKey),
        'a generation this build cannot read is not a generation it may delete',
      ).toEqual([{ key: supersededKey }]);
    } finally {
      db.close();
    }
  });

  // The other half of the fence: a fenced job that nothing can ever settle is a job that stays live in `jobs`
  // and unending under `wait` forever. A pid is readable out of a row whose meaning this build cannot read, so
  // absence is provable without interpreting anything — and once the row is gone the job reaches ordinary
  // recovery and is interrupted like any other.
  it('reads the pids out of a superseded row without trusting anything else it says', () => {
    const db = createDb();
    try {
      const stranded = providerOperationRecord('prepare-pending', { job: 2 });
      const supersededKey =
        `provider_operation_saga.v1:record:${stranded.operation.jobId}:${stranded.operation.operationId}:` +
        `${stranded.operation.proxyInstanceId}:${stranded.operation.buildSetId}`;
      // A genuine v0.10.8 payload: the process identity is seconds, which is exactly what this build cannot
      // read. The pids sit beside them and are readable regardless.
      const shipped = JSON.parse(encodeProviderOperationRecord(stranded)) as {
        locator: Record<string, Record<string, unknown>>;
      };
      for (const [part, pid] of [
        ['proxy', 9_001],
        ['guardian', 9_002],
        ['reaper', 9_003],
        ['containment', 9_001],
      ] as const) {
        const process = shipped.locator[part];
        if (process === undefined) continue;
        delete process.incarnation;
        process.processStartedAtSeconds = 1_700_000_000;
        process.pid = pid;
      }
      const insert = db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)');
      insert.run(supersededKey, JSON.stringify(shipped));
      insert.run('provider_operation_saga.v1:record:not-a-canonical-key', '{}');
      insert.run(`${supersededKey.replace(':record:', ':due:')}-unwalkable`, 'not json at all');

      const rows = readSupersededProviderOperations(db);

      expect(rows).toEqual([{ key: supersededKey, jobId: stranded.operation.jobId, pids: [9_001, 9_002, 9_003] }]);

      retireSupersededProviderOperation(db, supersededKey);

      expect(
        db.prepare<[string], { key: string }>('SELECT key FROM meta WHERE key = ?').all(supersededKey),
        'retiring the row is what unfences its job',
      ).toEqual([]);

      // The malformed key survives, reported and harmless. It is still a row this build cannot read, so the
      // scan names it — but it fences nothing, because a key that is not the canonical shape names no job.
      expect(readProviderOperations(db).unreadableKeys).toEqual([
        'provider_operation_saga.v1:record:not-a-canonical-key',
      ]);
      expect(providerOperationJobIdFromRecordKey('provider_operation_saga.v1:record:not-a-canonical-key')).toBeNull();
      expect(
        providerOperationJobIdFromRecordKey(`provider_operation_saga.v1:record:${stranded.operation.jobId}:garbage`),
        'a real job id behind a malformed tail must not fence that job',
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it('reports pids as unknown rather than absent when the row cannot be walked', () => {
    const db = createDb();
    try {
      const stranded = providerOperationRecord('prepare-pending', { job: 2 });
      const supersededKey =
        `provider_operation_saga.v1:record:${stranded.operation.jobId}:${stranded.operation.operationId}:` +
        `${stranded.operation.proxyInstanceId}:${stranded.operation.buildSetId}`;
      db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(supersededKey, 'not json');

      // `null`, never `[]`. An empty pid list would read as "nothing alive, retire it" — settling a job whose
      // processes were never observed at all.
      expect(readSupersededProviderOperations(db)).toEqual([
        { key: supersededKey, jobId: stranded.operation.jobId, pids: null },
      ]);
    } finally {
      db.close();
    }
  });

  // The rollback direction, and the reason the generation lives in the key rather than only in the payload.
  // v0.10.8 selects saga rows by literal key prefix and then parses them strictly, with no tolerance on its
  // startup claim scan — a `version` field inside the payload is a warning it never reaches. The literal
  // prefixes below are its source text, frozen; the keys they are tested against are built by this build's own
  // writer. If the two ever meet, that daemon does not boot.
  it('writes rows the shipped v0.10.8 selector cannot see', () => {
    const db = createDb();
    try {
      insertProviderOperation(db, providerOperationRecord('prepare-pending'));
      insertProviderOperation(db, providerOperationRecord('executing', { job: 2 }));
      expect(sagaRows(db).length, 'the rows exist to be missed').toBeGreaterThan(0);

      const shippedSelect = db.prepare<[string, string], { key: string }>(
        'SELECT key FROM meta WHERE key > ? AND key < ? ORDER BY key',
      );
      for (const shippedPrefix of ['provider_operation_saga.v1:record:', 'provider_operation_saga.v1:due:']) {
        expect(shippedSelect.all(shippedPrefix, `${shippedPrefix}\uffff`), shippedPrefix).toEqual([]);
      }
    } finally {
      db.close();
    }
  });
});
