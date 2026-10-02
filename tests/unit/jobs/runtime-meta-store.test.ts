import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { encodeHistoricalDurableCliProcessRuntimeMeta } from '#tests/helpers/historical-durable-cli-runtime-meta.js';
import {
  readDurableCliProcessRuntimeMeta,
  readDurableCliProcessRuntimeEvidence,
} from '#src/jobs/runtime-meta-store.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('durable CLI process runtime meta store', () => {
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
});
