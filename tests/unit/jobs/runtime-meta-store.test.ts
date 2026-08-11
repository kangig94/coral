import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  deleteDurableCliProcessRuntimeMeta,
  readDurableCliProcessRuntimeMeta,
  writeDurableCliProcessRuntimeMeta,
} from '#src/jobs/runtime-meta-store.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';

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
