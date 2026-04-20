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

export function readMetaValue(target: SqliteTarget, key: string): string | null {
  const row = prepareCached<[string], { value: string } | undefined>(
    target,
    `SELECT value FROM meta WHERE key = ?`,
  ).get(key);
  return row?.value ?? null;
}

export function writeMetaValue(target: SqliteTarget, key: string, value: string): void {
  prepareCached<[string, string]>(
    target,
    `INSERT INTO meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteMetaValue(target: SqliteTarget, key: string): void {
  prepareCached<[string]>(target, `DELETE FROM meta WHERE key = ?`).run(key);
}

export function listMetaByPrefix(target: SqliteTarget, prefix: string): Array<{ key: string; value: string }> {
  return prepareCached<[string], { key: string; value: string }>(
    target,
    `SELECT key, value
       FROM meta
      WHERE key LIKE ? ESCAPE '\\'
      ORDER BY key ASC`,
  ).all(`${escapeLike(prefix)}%`);
}

export function replaceMetaPrefix(target: SqliteTarget, prefix: string, values: Readonly<Record<string, string>>): void {
  prepareCached<[string]>(target, `DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'`).run(`${escapeLike(prefix)}%`);
  for (const [key, value] of Object.entries(values)) {
    writeMetaValue(target, key, value);
  }
}

function escapeLike(input: string): string {
  return input.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
