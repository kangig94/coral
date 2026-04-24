import type BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';

import { createRealRuntime } from '../runtime/real.js';
import { openStoreDatabase } from '../store/db.js';
import { ensureStoreMigrationsDir } from '../store/migrations.js';

export function createStandaloneKbDb(runtimeDir: string): BetterSqlite3.Database {
  const runtime = createRealRuntime();
  return openStoreDatabase({
    path: join(runtimeDir, 'store.db'),
    storage: runtime.storage,
    migrationsDir: ensureStoreMigrationsDir(runtime.storage),
  });
}
