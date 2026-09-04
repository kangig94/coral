import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { encodeHistoricalDurableCliProcessRuntimeMeta } from '#tests/helpers/historical-durable-cli-runtime-meta.js';
import {
  deleteDurableCliProcessRuntimeMeta,
  listDurableCliContainmentStatuses,
  readDurableCliContainmentStatus,
  readDurableCliProcessRuntimeMeta,
  readDurableCliProcessRuntimeEvidence,
  writeDurableCliContainmentStatus,
  writeDurableCliProcessRuntimeMeta,
} from '#src/jobs/runtime-meta-store.js';
import { decodeDurableCliProcessRuntimeMetaV1 } from '#src/jobs/runtime-meta.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function runtimeMeta(pid: number, timestamp: number) {
  return {
    jobId: JOB_ID,
    pid,
    incarnation: testIncarnation(timestamp),
    processGroupId: pid,
    childRoot: { pid: pid + 1, incarnation: testIncarnation(timestamp + 1) },
  };
}

describe('durable CLI process runtime meta store', () => {
  it('reports no recorded identity for a job that never wrote one', () => {
    const db = createDb();
    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toBeNull();
  });

  it('round-trips a written record through the real meta table', () => {
    const db = createDb();
    const meta = runtimeMeta(4242, 1_000);

    writeDurableCliProcessRuntimeMeta(db, meta);

    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toEqual(meta);
  });

  it('does not select a predecessor generation stored under the v1 key', () => {
    const db = createDb();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `durable_cli_process.v1:${JOB_ID}`,
      encodeHistoricalDurableCliProcessRuntimeMeta({
        version: 1,
        jobId: JOB_ID,
        pid: 4242,
        incarnation: testIncarnation(1_000),
      }),
    );

    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toBeNull();
    expect(readDurableCliProcessRuntimeEvidence(db, JOB_ID, 4242)).toEqual({
      kind: 'predecessor',
      record: { version: 1, jobId: JOB_ID, pid: 4242, incarnation: testIncarnation(1_000) },
    });
  });

  it('accepts the predecessor encoder numeric boundary', () => {
    const raw = encodeHistoricalDurableCliProcessRuntimeMeta({
      version: 1,
      jobId: JOB_ID,
      pid: 0,
      incarnation: testIncarnation(1_000),
    });

    expect(decodeDurableCliProcessRuntimeMetaV1(raw)).toEqual({
      version: 1,
      jobId: JOB_ID,
      pid: 0,
      incarnation: testIncarnation(1_000),
    });
  });

  it('distinguishes missing and corrupt generations without treating either as absence', () => {
    const db = createDb();

    expect(readDurableCliProcessRuntimeEvidence(db, JOB_ID, 4242)).toEqual({
      kind: 'unavailable',
      reason: 'missing',
    });

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`durable_cli_process.v2:${JOB_ID}`, '{not-json');
    expect(readDurableCliProcessRuntimeEvidence(db, JOB_ID, 4242)).toEqual({
      kind: 'unavailable',
      reason: 'corrupt-current',
    });
  });

  it('retains operator abandonment until terminal cleanup', () => {
    const db = createDb();
    const evidence = { kind: 'current' as const, record: runtimeMeta(4242, 1_000) };
    writeDurableCliProcessRuntimeMeta(db, evidence.record);
    writeDurableCliContainmentStatus(db, {
      jobId: JOB_ID,
      evidence,
      disposition: { kind: 'operator-abandoned', processAbsenceProven: false },
    });

    expect(readDurableCliContainmentStatus(db, JOB_ID)).toEqual({
      kind: 'valid',
      status: {
        jobId: JOB_ID,
        evidence,
        disposition: { kind: 'operator-abandoned', processAbsenceProven: false },
      },
    });

    deleteDurableCliProcessRuntimeMeta(db, JOB_ID);
    expect(readDurableCliContainmentStatus(db, JOB_ID)).toEqual({ kind: 'missing' });
  });

  it('reports malformed containment status bytes without dropping the listed row', () => {
    const db = createDb();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `durable_cli_containment_status.v1:${JOB_ID}`,
      '{not-json',
    );

    expect(readDurableCliContainmentStatus(db, JOB_ID)).toEqual({ kind: 'corrupt', jobId: JOB_ID });
    expect(listDurableCliContainmentStatuses(db)).toEqual([{ kind: 'corrupt', jobId: JOB_ID }]);
  });

  it('replaces an earlier record for the same job on a second write', () => {
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, runtimeMeta(111, 1));

    writeDurableCliProcessRuntimeMeta(db, runtimeMeta(222, 2));

    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toEqual(runtimeMeta(222, 2));
  });

  it('deletes the recorded row, and deleting an already-absent row is a no-op rather than an error', () => {
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, runtimeMeta(4242, 1_000));
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `durable_cli_process.v1:${JOB_ID}`,
      encodeHistoricalDurableCliProcessRuntimeMeta({
        version: 1,
        jobId: JOB_ID,
        pid: 4242,
        incarnation: testIncarnation(1_000),
      }),
    );

    deleteDurableCliProcessRuntimeMeta(db, JOB_ID);
    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toBeNull();
    expect(readDurableCliProcessRuntimeEvidence(db, JOB_ID, 4242)).toEqual({
      kind: 'unavailable',
      reason: 'missing',
    });

    // The retention prune that owns this call can legitimately run twice for the same job.
    expect(() => deleteDurableCliProcessRuntimeMeta(db, JOB_ID)).not.toThrow();
  });
});
