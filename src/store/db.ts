import type BetterSqlite3 from 'better-sqlite3';

export function openStoreDatabase(_path: string): BetterSqlite3.Database {
  throw new Error('openStoreDatabase: Phase 1 wiring not yet implemented');
}

export type Database = BetterSqlite3.Database;
