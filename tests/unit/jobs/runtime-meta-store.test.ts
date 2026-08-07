import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  deleteDurableCliProcessRuntimeMeta,
  deleteProviderOperationRuntimeMeta,
  hasProviderOperationRuntimeMetaForJob,
  readDurableCliProcessRuntimeMeta,
  readProviderOperationRuntimeMeta,
  writeDurableCliProcessRuntimeMeta,
  writeProviderOperationRuntimeMeta,
} from '#src/jobs/runtime-meta-store.js';
import { providerOperationRuntimeMetaKey, type ProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const OPERATION_ID = '00000000-0000-4000-8000-000000000002';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('durable CLI process runtime meta store', () => {
  it('reports no recorded identity for a job that never wrote one', () => {
    const db = createDb();
    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toBeNull();
  });

  it('round-trips a written record through the real meta table', () => {
    const db = createDb();
    const meta = { version: 1 as const, jobId: JOB_ID, pid: 4242, processStartedAtSeconds: 1_000 };

    writeDurableCliProcessRuntimeMeta(db, meta);

    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toEqual(meta);
  });

  it('replaces an earlier record for the same job on a second write', () => {
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, { version: 1, jobId: JOB_ID, pid: 111, processStartedAtSeconds: 1 });

    writeDurableCliProcessRuntimeMeta(db, { version: 1, jobId: JOB_ID, pid: 222, processStartedAtSeconds: 2 });

    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toEqual({
      version: 1,
      jobId: JOB_ID,
      pid: 222,
      processStartedAtSeconds: 2,
    });
  });

  it('deletes the recorded row, and deleting an already-absent row is a no-op rather than an error', () => {
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, { version: 1, jobId: JOB_ID, pid: 4242, processStartedAtSeconds: 1_000 });

    deleteDurableCliProcessRuntimeMeta(db, JOB_ID);
    expect(readDurableCliProcessRuntimeMeta(db, JOB_ID)).toBeNull();

    // The retention prune that owns this call can legitimately run twice for the same job.
    expect(() => deleteDurableCliProcessRuntimeMeta(db, JOB_ID)).not.toThrow();
  });
});

describe('provider operation runtime meta store (read-only)', () => {
  it('reports no recorded identity for an operation nothing has written', () => {
    const db = createDb();
    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).toBeNull();
  });

  it('treats a corrupt row as no usable record rather than throwing', () => {
    const db = createDb();
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      providerOperationRuntimeMetaKey(JOB_ID, OPERATION_ID),
      '{not json',
    );

    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).toBeNull();
  });
});

function providerOperationRuntimeMeta(
  overrides: Partial<ProviderOperationRuntimeMeta> = {},
): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: JOB_ID,
    operationId: OPERATION_ID,
    buildSetId: '00000000-0000-4000-8000-000000000003',
    hostFingerprint: 'a'.repeat(64),
    guardianInstanceId: '00000000-0000-4000-8000-000000000004',
    guardianPid: 100,
    guardianProcessStartedAtSeconds: 1,
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: '00000000-0000-4000-8000-000000000005',
    proxyPid: 200,
    reaperInstanceId: '00000000-0000-4000-8000-000000000006',
    reaperPid: 300,
    reaperProcessStartedAtSeconds: 2,
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-group',
    proxyProcessStartedAtSeconds: 3,
    proxyProcessGroupId: 200,
    canonicalEndpoint: '/tmp/proxy.sock',
    reservationId: '00000000-0000-4000-8000-000000000007',
    activationNonce: '00000000-0000-4000-8000-000000000008',
    providerRootPid: 400,
    providerRootProcessStartedAtSeconds: 4,
    jointContainmentReceipt: 'receipt-1',
    committedThroughProviderSeq: 0,
    ...overrides,
  };
}

describe('provider operation runtime meta store (write and delete)', () => {
  it('round-trips a written locator through the real meta table', () => {
    const db = createDb();
    const meta = providerOperationRuntimeMeta();

    writeProviderOperationRuntimeMeta(db, meta);

    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).toEqual(meta);
  });

  it('replaces an earlier locator for the same operation on a second write, matching the durable-CLI writer', () => {
    const db = createDb();
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta({ committedThroughProviderSeq: 0 }));

    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta({ committedThroughProviderSeq: 7 }));

    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)?.committedThroughProviderSeq).toBe(7);
  });

  it('deletes the exact matching locator, and deleting an already-absent one is a no-op rather than an error', () => {
    const db = createDb();
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta());

    deleteProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID);
    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).toBeNull();

    // Compensation must be safe to run against a locator a racing durable-effect commit already released.
    expect(() => deleteProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).not.toThrow();
  });

  it('never deletes a different operation sharing the same job', () => {
    const db = createDb();
    const otherOperationId = '00000000-0000-4000-8000-00000000000f';
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta());
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta({ operationId: otherOperationId }));

    deleteProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID);

    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).toBeNull();
    expect(readProviderOperationRuntimeMeta(db, JOB_ID, otherOperationId)).not.toBeNull();
  });

  it('composes into a transaction its caller already opened, rather than starting its own', () => {
    const db = createDb();
    const otherOperationId = '00000000-0000-4000-8000-00000000000f';

    // If either write opened its own transaction, this whole block would throw on the second `BEGIN
    // IMMEDIATE` — SQLite refuses a nested `BEGIN`. Reaching `COMMIT` proves both writes ran inside the one
    // transaction this test opened, exactly the property `applyProviderEventAtSeq`'s real port depends on to
    // advance the watermark atomically with whichever effect it applies.
    db.exec('BEGIN IMMEDIATE');
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta());
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta({ operationId: otherOperationId }));
    db.exec('ROLLBACK');

    // A rolled-back outer transaction discards both writes, confirming neither was ever independently
    // committed.
    expect(readProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID)).toBeNull();
    expect(readProviderOperationRuntimeMeta(db, JOB_ID, otherOperationId)).toBeNull();
  });
});

describe('hasProviderOperationRuntimeMetaForJob', () => {
  it('is false for a job with no provider_operation.v1 row at all', () => {
    const db = createDb();
    expect(hasProviderOperationRuntimeMetaForJob(db, JOB_ID)).toBe(false);
  });

  it('is true once any operation for the job has committed meta, regardless of operation id', () => {
    const db = createDb();
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta());

    expect(hasProviderOperationRuntimeMetaForJob(db, JOB_ID)).toBe(true);
  });

  it('is false again once the one committed row for the job is deleted', () => {
    const db = createDb();
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta());
    deleteProviderOperationRuntimeMeta(db, JOB_ID, OPERATION_ID);

    expect(hasProviderOperationRuntimeMetaForJob(db, JOB_ID)).toBe(false);
  });

  it('never answers true for an unrelated job sharing no prefix', () => {
    const db = createDb();
    const otherJobId = '00000000-0000-4000-8000-0000000000aa';
    writeProviderOperationRuntimeMeta(db, providerOperationRuntimeMeta());

    expect(hasProviderOperationRuntimeMetaForJob(db, otherJobId)).toBe(false);
  });
});
