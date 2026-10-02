import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { readOrCreateEpochKey, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function createDurableTestRuntime(): ReturnType<typeof createRealRuntime> {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-durable-runtime-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  openSettledTestStoreDb(runtime).close();
  readOrCreateEpochKey(runtime, resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1'));
  return runtime;
}
