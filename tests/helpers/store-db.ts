import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { StoragePort } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';
import type { StoreFormatDescription } from '#src/store/format-fingerprint.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';

type ReadonlyStoreRuntime = Readonly<{ storage: Pick<StoragePort, 'existsSync'> }>;

export function openTestStoreDatabase(options: {
  readonly path: string;
  readonly storage: StoragePort;
  readonly storeFormat: StoreFormatDescription;
  readonly flavor?: Runtime['flavor'];
  readonly busyTimeoutMs?: number;
  readonly readonly?: boolean;
}): Database {
  if (options.readonly === true) {
    return openStoreDatabase({ ...options, readonly: true });
  }
  return openStoreDatabase(options);
}

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
      : openTestStoreDatabase({ path, storage: runtime.storage as Runtime['storage'], storeFormat });
  assertTestDatabaseLocation(db);
  return db;
}

let kbTestStorage: StoragePort | undefined;

export function openKbTestStoreDb(path: string): Database {
  kbTestStorage ??= createRealRuntime('prod').storage;
  return openTestStoreDb({ storage: kbTestStorage }, path);
}
