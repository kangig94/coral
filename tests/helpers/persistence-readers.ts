import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

import type { StoragePort } from '#src/infra/port-types.js';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import type { JobEvent, JobStatus } from '#src/jobs/records.js';
import { openStoreDatabase } from '#src/store/db.js';
import { storePaths } from '#src/infra/path/store.js';
import { loadJobProjectionDetail, readJobEvents } from '#src/jobs/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';

const nodeStoreReaderStorage: Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'readdirSync'> = {
  readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
  readdirSync: readdirSync as StoragePort['readdirSync'],
  existsSync: (filePath) => existsSync(filePath),
  mkdirSync: (dirPath, options) => mkdirSync(dirPath, options),
};

function withReadonlyStore<T>(read: (db: ReturnType<typeof openStoreDatabase>) => T, fallback: T): T {
  const dbPath = storePaths(resolveBuildFlavor(process.env)).dbFile;
  if (!existsSync(dbPath)) {
    return fallback;
  }

  const db = openStoreDatabase({
    path: dbPath,
    storage: nodeStoreReaderStorage as StoragePort,
    readonly: true,
  });

  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Reads and parses a persisted job status record.
 */
export function readStatusRecord(jobId: string): JobStatus | null {
  return withReadonlyStore((db) => loadJobProjectionDetail(db, jobId, createDefaultStoreReadContext()).status, null);
}

/**
 * Reads and parses all persisted progress records for a job.
 */
export function readProgressLog(jobId: string): JobEvent[] {
  return withReadonlyStore((db) => readJobEvents(db, jobId, createDefaultStoreReadContext()), []);
}
