import type BetterSqlite3 from 'better-sqlite3';
import type { KbRuntime } from '../contract.js';
import type { ReadonlyDatabase } from '../../store/read-port.js';

export type SqliteTarget =
  | BetterSqlite3.Database
  | ReadonlyDatabase
  | KbRuntime
  | { db: BetterSqlite3.Database | ReadonlyDatabase };

const statementCache = new WeakMap<BetterSqlite3.Database | ReadonlyDatabase, Map<string, BetterSqlite3.Statement>>();

export function resolveSqliteDb(target: SqliteTarget): BetterSqlite3.Database | ReadonlyDatabase {
  if ('prepare' in target) {
    return target;
  }
  return (target as { db: BetterSqlite3.Database | ReadonlyDatabase }).db;
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

  const statement = db.prepare(sql) as BetterSqlite3.Statement<TParams, TResult>;
  cache.set(sql, statement);
  return statement;
}
