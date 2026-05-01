import type { Database } from '../../src/store/db.js';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Runtime } from '#src/runtime/ports.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreSchemasDir } from '#src/store/schema-loader.js';

export function openTestStoreDb(
  runtime: Pick<Runtime, 'storage' | 'paths'>,
  path = runtime.paths.coral.store.dbFile,
): Database {
  if (path !== ':memory:') {
    runtime.storage.mkdirSync(dirname(path), { recursive: true });
  }
  const resolvedPath = path === ':memory:' || existsSync(dirname(path)) ? path : ':memory:';

  return openStoreDatabase({
    path: resolvedPath,
    storage: runtime.storage,
    schemasDir: ensureStoreSchemasDir(runtime.storage),
  });
}
