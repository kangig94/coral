import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '../../../src/store/db.js';

import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';

export function createKbTestDb(storePath: string): Database {
  const runtime = createRealRuntime('prod');
  return openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePath,
    storage: runtime.storage,
  });
}
