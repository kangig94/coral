import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { StoragePort, TimePort } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';
import { acquireDirectoryLockSync, createDirectoryLockParent } from '#src/infra/fs-lock.js';
import type { StoreFormatDescription } from '#src/store/format-fingerprint.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

type ReadonlyStoreRuntime = Readonly<{ storage: Pick<StoragePort, 'existsSync'> }>;

const TEST_TIME: Pick<TimePort, 'now' | 'monotonicNow' | 'sleep' | 'setInterval' | 'clearInterval'> = {
  now: Date.now,
  monotonicNow: () => process.hrtime.bigint() / 1_000_000n,
  sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

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
  const parent = dirname(options.path);
  createDirectoryLockParent(options.storage, parent);
  const lease = acquireDirectoryLockSync(join(parent, `.test-store-open-${randomUUID()}.lock`), {
    storage: options.storage,
    time: TEST_TIME,
  });
  try {
    return openStoreDatabase({ ...options, held: lease.actuator });
  } finally {
    lease();
  }
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
