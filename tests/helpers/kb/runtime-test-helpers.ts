import { currentCoralStoreFormat } from '#src/store-format.js';
import { join } from 'node:path';
import type { Database } from '../../../src/store/db.js';

import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';

export function createKbTestDb(runtimeDir?: string): Database {
  const runtime = createRealRuntime('prod');
  return openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: runtimeDir === undefined ? ':memory:' : join(runtimeDir, 'store.db'),
    storage: runtime.storage,
  });
}
