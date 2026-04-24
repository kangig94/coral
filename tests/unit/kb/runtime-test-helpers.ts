import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreMigrationsDir } from '#src/store/migrations.js';

export function createKbTestDb(runtimeDir?: string): BetterSqlite3.Database {
  const runtime = createRealRuntime();
  return openStoreDatabase({
    path: runtimeDir === undefined ? ':memory:' : join(runtimeDir, 'store.db'),
    storage: runtime.storage,
    migrationsDir: ensureStoreMigrationsDir(runtime.storage),
  });
}
