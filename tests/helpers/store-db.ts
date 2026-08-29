import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase, type Database } from '#src/store/db.js';

export function openTestStoreDb(runtime: Pick<Runtime, 'storage' | 'paths'>, path: string): Database {
  return openStoreDatabase({
    path,
    storage: runtime.storage,
    storeFormat: currentCoralStoreFormat(),
  });
}
