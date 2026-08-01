import { createServer, type Server } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireStoreAdoptionSocketGuard } from '#src/cli/store-adopt.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { adoptLegacyStore } from '#src/store/legacy-store-adoption.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { bindSocket } from '#src/transport/ipc/server.js';

const roots: string[] = [];

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy store adoption socket guard', () => {
  it('refuses a live current-generation coordinator before locking, stamping, or renaming the legacy source', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-legacy-adoption-socket-'));
    roots.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const storeFormat = currentCoralStoreFormat();
    const paths = resolveGenerationBoundaryPaths(runtime);
    const sourceDb = join(paths.legacyFlavorRoot, 'store', 'store.db');
    openStoreDatabase({ path: sourceDb, storage: runtime.storage, storeFormat }).close();
    const db = new DatabaseSync(sourceDb);
    try {
      db.prepare("DELETE FROM meta WHERE key = 'store_product_version'").run();
    } finally {
      db.close();
    }

    const incumbent = createServer();
    await expect(bindSocket(incumbent, runtime.paths.coral.coordinator.socketPath)).resolves.toEqual({ kind: 'bound' });
    try {
      let refusal: unknown;
      try {
        await adoptLegacyStore({ runtime, storeFormat, acquireSocketGuard: acquireStoreAdoptionSocketGuard });
      } catch (error: unknown) {
        refusal = error;
      }

      expect(serializeCoralSetupError(refusal)).toMatchObject({
        code: 'coordinator_socket_in_use',
        remediation: expect.stringContaining('coral-cli backend shutdown'),
        context: { operation: 'legacy store adoption' },
      });
      expect(existsSync(paths.legacyFlavorRoot)).toBe(true);
      expect(existsSync(paths.generatedFlavorRoot)).toBe(false);
      const unchanged = new DatabaseSync(sourceDb, { readOnly: true });
      try {
        expect(
          unchanged.prepare("SELECT value FROM meta WHERE key = 'adopted_from_legacy_at' LIMIT 1").get(),
        ).toBeUndefined();
      } finally {
        unchanged.close();
      }
    } finally {
      await closeServer(incumbent);
    }
  });
});
