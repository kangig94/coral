import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

import type { StoragePort } from '#src/runtime/ports.js';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import { isNoEntryError } from '#src/infra/fs-errors.js';
import type { JobProgress, JobStatus } from '#src/jobs/records.js';
import { sessionEntrySchema, type SessionEntry } from '#src/sessions/entry.js';
import { openStoreDatabase } from '#src/store/db.js';
import { storePaths } from '#src/infra/path/store.js';
import { loadJobProjectionDetail, readJobProgress } from '#src/jobs/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';

const nodeDiscussReaderStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'existsSync'> = {
  readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
  readdirSync: (dirPath, options) => readdirSync(dirPath, options),
  existsSync: (filePath) => existsSync(filePath),
};

const nodeStoreReaderStorage: Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'readdirSync'> = {
  ...nodeDiscussReaderStorage,
  mkdirSync: (dirPath, options) => mkdirSync(dirPath, options),
};

type SessionEntryStorage = Pick<StoragePort, 'readFileSync'>;

export function isValidSessionEntry(value: unknown): value is SessionEntry {
  return sessionEntrySchema.safeParse(value).success;
}

export function readSessionEntry(
  sessionPath: string,
  storage: SessionEntryStorage = nodeDiscussReaderStorage,
): SessionEntry | null {
  try {
    const parsed = JSON.parse(storage.readFileSync(sessionPath, 'utf-8')) as unknown;
    return isValidSessionEntry(parsed) ? parsed : null;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

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
export function readProgressLog(jobId: string): JobProgress[] {
  return withReadonlyStore((db) => readJobProgress(db, jobId, createDefaultStoreReadContext()), []);
}
