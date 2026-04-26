import type BetterSqlite3 from 'better-sqlite3';

export type SqliteTarget = BetterSqlite3.Database | { db: BetterSqlite3.Database };

const statementCache = new WeakMap<BetterSqlite3.Database, Map<string, BetterSqlite3.Statement>>();

export function resolveSqliteDb(target: SqliteTarget): BetterSqlite3.Database {
  return 'db' in target ? target.db : target;
}

export function prepareCached<TParams extends unknown[] = unknown[], TResult = unknown>(
  target: SqliteTarget,
  sql: string,
): BetterSqlite3.Statement<TParams, TResult> {
  const db = resolveSqliteDb(target);
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }

  const cached = cache.get(sql);
  if (cached) {
    return cached as BetterSqlite3.Statement<TParams, TResult>;
  }

  const statement = db.prepare(sql);
  cache.set(sql, statement);
  return statement as BetterSqlite3.Statement<TParams, TResult>;
}

export function writeMetaValue(target: SqliteTarget, key: string, value: string): void {
  prepareCached<[string, string]>(
    target,
    `INSERT INTO meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
