import { DatabaseSync } from 'node:sqlite';
import type { Database } from '#src/store/db.js';

/**
 * Open a raw SQLite handle for tests. No schemas, no pragmas — callers that
 * need them apply the matching helpers explicitly. Equivalent to the legacy
 * `new BetterSqlite3(':memory:')` test idiom under `node:sqlite`. Normalizes
 * the legacy `readonly` option name to node:sqlite's `readOnly`.
 */
export function newRawDatabase(
  path: string = ':memory:',
  options?: { readonly?: boolean },
): Database {
  if (options?.readonly === true) {
    return new DatabaseSync(path, { readOnly: true }) as unknown as Database;
  }
  return new DatabaseSync(path) as unknown as Database;
}

/**
 * Read a PRAGMA value with the legacy `simple: true` semantics: returns the
 * single value column without caring about its actual column name. node:sqlite
 * names the column after the pragma's first output (e.g. `busy_timeout` →
 * `timeout`), so projecting the first value is the only stable extraction.
 */
export function pragmaSimple<T = unknown>(db: Database, name: string): T {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return (row ? Object.values(row)[0] : undefined) as T;
}

/**
 * Equivalent of better-sqlite3's `db.totalChanges` — node:sqlite exposes this
 * only via the `total_changes()` SQL scalar function.
 */
export function totalChanges(db: Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}
