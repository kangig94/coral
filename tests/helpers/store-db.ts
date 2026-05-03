import type { Runtime } from '#src/runtime/ports.js';
import { openWritableStoreDbNoReset, type Database } from '#src/store/db.js';

export function openTestStoreDb(
  runtime: Pick<Runtime, 'storage' | 'paths'>,
  path = runtime.paths.coral.store.dbFile,
): Database {
  return openWritableStoreDbNoReset(runtime, { path });
}
