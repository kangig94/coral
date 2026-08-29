import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

import type { StoragePort } from '#src/infra/port-types.js';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import type { JobEvent, JobStatus } from '#src/jobs/records.js';
import type { Database } from '#src/store/db.js';
import { storePaths } from '#src/infra/path/store.js';
import { loadJobProjectionDetail, readJobEvents } from '#src/jobs/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';

const nodeStoreReaderStorage: Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'readdirSync'> = {
  readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
  readdirSync: readdirSync as StoragePort['readdirSync'],
  existsSync: (filePath) => existsSync(filePath),
  mkdirSync: (dirPath, options) => mkdirSync(dirPath, options),
};

function withReadonlyStore<T>(read: (db: Database) => T, fallback: T): T {
  const dbPath = storePaths(resolveBuildFlavor(process.env)).dbFile;
  if (!existsSync(dbPath)) {
    return fallback;
  }

  const db = openTestStoreDb({ storage: nodeStoreReaderStorage }, dbPath, { readonly: true });

  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function readStatusRecord(jobId: string): JobStatus | null {
  return withReadonlyStore((db) => loadJobProjectionDetail(db, jobId, createDefaultStoreReadContext()).status, null);
}

export function readProgressLog(jobId: string): JobEvent[] {
  return withReadonlyStore((db) => readJobEvents(db, jobId, createDefaultStoreReadContext()), []);
}
