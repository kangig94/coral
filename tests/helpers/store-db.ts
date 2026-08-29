import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { StoragePort } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';

type ReadonlyStoreRuntime = Readonly<{ storage: Pick<StoragePort, 'existsSync'> }>;

export function openTestStoreDb(
  runtime: Pick<Runtime, 'storage'>,
  path: string,
  options?: Readonly<{ readonly?: false }>,
): Database;
export function openTestStoreDb(
  runtime: ReadonlyStoreRuntime,
  path: string,
  options: Readonly<{ readonly: true }>,
): Database;
export function openTestStoreDb(
  runtime: ReadonlyStoreRuntime,
  path: string,
  options?: Readonly<{ readonly?: boolean }>,
): Database {
  const storeFormat = currentCoralStoreFormat();
  const db =
    options?.readonly === true
      ? openStoreDatabase({ path, storage: runtime.storage, storeFormat, readonly: true })
      : openStoreDatabase({ path, storage: runtime.storage as Runtime['storage'], storeFormat });
  assertTestDatabaseLocation(db);
  return db;
}

const KB_TEST_STORAGE = createRealRuntime('prod').storage;

export function openKbTestStoreDb(path: string): Database {
  return openTestStoreDb({ storage: KB_TEST_STORAGE }, path);
}
