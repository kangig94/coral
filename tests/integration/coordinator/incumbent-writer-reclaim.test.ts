import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reclaimIncumbentWriter } from '#src/coordinator/succession/commit.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openWritableStoreDatabase } from '#src/store/db.js';
import { joinSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-incumbent-reclaim-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const store = { storeRoot: join(root, 'epochs'), epoch: '1' };
  const writer = joinSuccessionWriterGeneration(runtime, store);
  const opened = openWritableStoreDatabase({
    path: join(root, 'store.db'),
    storage: runtime.storage,
    storeFormat: currentCoralStoreFormat(),
    writerEntitlement: writer,
  });
  if (opened.kind !== 'opened') throw new Error('Expected an open test store.');
  return { runtime, writer, db: opened.db };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('incumbent writer reclaim', () => {
  it('resumes the existing store and journal admission after an abort before advance', async () => {
    const { runtime, writer, db } = fixture();
    db.exec('CREATE TABLE incumbent_reclaim (value TEXT NOT NULL)');
    writer.park();
    const fallback: string[] = [];

    const result = await reclaimIncumbentWriter({
      runtime,
      writer,
      storeDb: db,
      incumbentInstanceId: 'incumbent',
      deadlineMs: 1_000,
      reclaimKbDaemonWriter: async () => undefined,
      startSameBuildSuccession: (reason) => fallback.push(reason),
    });

    if (result.kind !== 'reclaimed') throw new Error(`Unexpected reclaim result: ${result.reason}`);
    expect(result.providerOperationAdmission.accepting).toBe(true);
    result.providerOperationAdmission.runSync('after-reclaim', () =>
      db.prepare('INSERT INTO incumbent_reclaim (value) VALUES (?)').run('journal'),
    );
    expect(fallback).toEqual([]);
    db.prepare('INSERT INTO incumbent_reclaim (value) VALUES (?)').run('served');
    expect(db.prepare<[], { total: number }>('SELECT count(*) AS total FROM incumbent_reclaim').get()?.total).toBe(2);
    db.close();
  });

  it('selects same-build succession when dependent writer reclaim exceeds its bound', async () => {
    const { runtime, writer, db } = fixture();
    writer.park();
    const fallback: string[] = [];

    const result = await reclaimIncumbentWriter({
      runtime,
      writer,
      storeDb: db,
      incumbentInstanceId: 'incumbent',
      deadlineMs: 1,
      reclaimKbDaemonWriter: async () => new Promise<void>(() => undefined),
      startSameBuildSuccession: (reason) => fallback.push(reason),
    });

    expect(result.kind).toBe('same-build-succession');
    expect(fallback).toHaveLength(1);
    expect(() => db.exec('CREATE TABLE should_not_write (value TEXT)')).toThrow(/parked|closed/u);
    db.close();
  });
});
