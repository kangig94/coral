import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { cleanupRetiredExpansion } from '#src/kb-daemon/expansion/retirement.js';
import { ExpansionStateStore } from '#src/kb-daemon/expansion/state.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';

const RETIRED_ID = 'retired-vector';

function seedRetiredExpansion(baseDir: string, flavor: BuildFlavor) {
  const runtime = createRealRuntime(flavor, { baseDir });
  const db = openSettledTestStoreDb(runtime);
  const state = new ExpansionStateStore(db);
  state.insert({ id: RETIRED_ID, version: '0.9.0', installed_at: '2026-01-01T00:00:00.000Z' });
  db.prepare(
    `INSERT INTO consumer_cursors
       (consumer_id, authority, cursor, registered_at, registration_kind)
     VALUES (?, 'journal', 0, '2026-01-01T00:00:00.000Z', 'expansion')`,
  ).run(RETIRED_ID);
  const kbRuntimeDir = kbRuntimePaths(flavor, { baseDir }).root;
  const directories = [
    runtime.paths.coral.engine.dataDir(RETIRED_ID),
    join(kbRuntimeDir, RETIRED_ID),
    join(kbRuntimeDir, `${RETIRED_ID}-staging`),
  ];
  const sentinels = directories.map((directory) => {
    mkdirSync(directory, { recursive: true });
    const sentinel = join(directory, 'sentinel');
    writeFileSync(sentinel, flavor);
    return sentinel;
  });
  return { runtime, db, state, kbRuntimeDir, sentinels };
}

describe('retired expansion cleanup across flavor stores', () => {
  it('removes selected-flavor residue and durable state while preserving the other flavor', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-retired-expansion-'));
    const selected = seedRetiredExpansion(baseDir, 'prod');
    const other = seedRetiredExpansion(baseDir, 'dev');
    try {
      await expect(
        cleanupRetiredExpansion(RETIRED_ID, {
          runtime: selected.runtime,
          kbRuntimeDir: selected.kbRuntimeDir,
          manifestCatalog: createExpansionManifestCatalog({ db: selected.db, staticManifests: [] }),
          consumerDriver: new ConsumerDriver({
            db: selected.db,
            now: () => new Date('2026-01-01T00:00:00.000Z'),
            time: selected.runtime.time,
          }),
          finalizeState: () => selected.state.delete(RETIRED_ID),
        }),
      ).resolves.toBe('removed');

      for (const sentinel of selected.sentinels) expect(existsSync(sentinel)).toBe(false);
      expect(selected.state.get(RETIRED_ID)).toBeUndefined();
      expect(
        selected.db.prepare('SELECT 1 FROM consumer_cursors WHERE consumer_id = ?').get(RETIRED_ID),
      ).toBeUndefined();
      for (const sentinel of other.sentinels) expect(readFileSync(sentinel, 'utf8')).toBe('dev');
      expect(other.state.get(RETIRED_ID)).toBeDefined();
      expect(other.db.prepare('SELECT 1 FROM consumer_cursors WHERE consumer_id = ?').get(RETIRED_ID)).toBeDefined();
    } finally {
      selected.db.close();
      other.db.close();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
