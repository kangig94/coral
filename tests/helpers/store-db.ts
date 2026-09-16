import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { StoragePort } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';
import { settleStoreEpoch } from '#src/store/epoch.js';
import type { StoreFormatDescription } from '#src/store/format-fingerprint.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';

type ReadonlyStoreRuntime = Readonly<{ storage: Pick<StoragePort, 'lstatSync'> }>;

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

export function openSettledTestStoreDb(runtime: Runtime): Database {
  const storeFormat = currentCoralStoreFormat();
  return settleStoreEpoch(runtime, {
    storeFormat,
    build: {
      version: storeFormat.productVersion,
      buildSetId: '123e4567-e89b-42d3-a456-426614174000',
      bundleHash: '0123456789abcdef',
      cliBundleHash: '0123456789abcdef',
      claudeAppserverBundleHash: '0123456789abcdef',
      durableWrapperBundleHash: '0123456789abcdef',
      flavor: runtime.flavor,
      storeFormatFingerprint: storeFormat.fingerprint,
    },
  }).db;
}

let kbTestStorage: StoragePort | undefined;

export function openKbTestStoreDb(path: string): Database {
  kbTestStorage ??= createRealRuntime('prod').storage;
  return openTestStoreDb({ storage: kbTestStorage }, path);
}
