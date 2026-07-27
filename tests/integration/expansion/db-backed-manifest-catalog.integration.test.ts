import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openWritableStoreDbNoReset } from '#src/store/db.js';
import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';
import dummyInstalledDbManifest from '#tests/fixtures/dummy-installed-engine/manifest.js';

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('DB-backed expansion manifest catalog', () => {
  it('persists installed manifests through a schema-backed store reopen', () => {
    const home = tempRoot('coral-db-backed-manifest-home-');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const runtime = createRealRuntime('prod');
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    const dbPath = join(tempRoot('coral-db-backed-manifest-store-'), 'store.db');
    const storeFormat = currentCoralStoreFormat();
    const db = openWritableStoreDbNoReset(runtime, { path: dbPath, storeFormat });
    createExpansionManifestCatalog({ db }).upsertInstalledEntry(dummyInstalledDbManifest);
    db.close();

    const readDb = openReadOnlyStoreDatabase(runtime, { path: dbPath, storeFormat });
    try {
      const entries = createExpansionManifestCatalog({ readDb }).listEntries();
      const installed = entries.find((entry) => entry.manifest.id === 'dummy-installed-db-engine');

      expect(installed).toEqual({
        source: 'installed',
        manifest: expect.objectContaining({
          id: 'dummy-installed-db-engine',
          tier: 'installed',
          specifier: '#tests/fixtures/dummy-installed-engine/expansion.js',
          description: 'DB-backed installed manifest fixture.',
        }),
      });
    } finally {
      readDb.close();
    }
  });

  it.each([
    {
      label: 'row id and decoded manifest id drift',
      rowId: 'row-id',
      manifest: { ...dummyInstalledDbManifest, id: 'manifest-id' },
    },
    {
      label: 'persisted bundled-tier entry',
      rowId: 'legacy-bundled',
      manifest: { ...dummyInstalledDbManifest, id: 'legacy-bundled', tier: 'bundled' },
    },
  ])('fails closed for $label', ({ rowId, manifest }) => {
    const home = tempRoot('coral-db-backed-manifest-invalid-home-');
    const runtime = createRealRuntime('prod', { baseDir: home });
    const dbPath = join(tempRoot('coral-db-backed-manifest-invalid-store-'), 'store.db');
    const storeFormat = currentCoralStoreFormat();
    const db = openWritableStoreDbNoReset(runtime, { path: dbPath, storeFormat });
    db.prepare('INSERT INTO expansion_manifest_catalog (id, manifest_json, updated_at) VALUES (?, ?, ?)').run(
      rowId,
      JSON.stringify(manifest),
      '2026-01-01T00:00:00.000Z',
    );
    db.close();

    const readDb = openReadOnlyStoreDatabase(runtime, { path: dbPath, storeFormat });
    try {
      expect(() => createExpansionManifestCatalog({ readDb })).toThrow(
        `Invalid expansion manifest catalog row '${rowId}'`,
      );
    } finally {
      readDb.close();
    }
  });
});
