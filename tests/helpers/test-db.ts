import { DatabaseSync } from 'node:sqlite';
import type { Database } from '#src/store/db.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';

/**
 * Open a raw SQLite handle for tests. No schemas, no pragmas — callers that
 * need them apply the matching helpers explicitly.
 */
export function newRawDatabase(path: string, options?: { readonly?: boolean }): Database {
  const db = (options?.readonly === true
    ? new DatabaseSync(path, { readOnly: true })
    : new DatabaseSync(path)) as unknown as Database;
  assertTestDatabaseLocation(db);
  return db;
}

/**
 * node:sqlite names the column after the pragma's first output (e.g.
 * `busy_timeout` → `timeout`), so projecting the first value is the only
 * stable extraction.
 */
export function pragmaSimple<T = unknown>(db: Database, name: string): T {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return (row ? Object.values(row)[0] : undefined) as T;
}

/**
 * node:sqlite exposes this only via the `total_changes()` SQL scalar function.
 */
export function totalChanges(db: Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}
