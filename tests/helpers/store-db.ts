import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';

export function openTestStoreDb(runtime: Pick<Runtime, 'storage'>, path: string): Database {
  const db = openStoreDatabase({
    path,
    storage: runtime.storage,
    storeFormat: currentCoralStoreFormat(),
  });
  assertTestDatabaseLocation(db);
  return db;
}

export function openKbTestStoreDb(path: string): Database {
  return openTestStoreDb({ storage: createRealRuntime('prod').storage }, path);
}
