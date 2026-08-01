import { createServer, type Server } from 'node:net';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { discardStoreReset, resolveStoreResetTargetPaths } from '#src/cli/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { bindSocket } from '#src/transport/ipc/server.js';

const STORE_FORMAT = currentCoralStoreFormat();
const BUILD: StrictBundleManifest = {
  version: STORE_FORMAT.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  flavor: 'prod',
  storeFormatFingerprint: STORE_FORMAT.fingerprint,
};
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'coral-store-reset-operator-'));
  roots.push(value);
  return value;
}

function createMismatchStore(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'store_format_fingerprint',
      `sha256:${'0'.repeat(64)}`,
    );
  } finally {
    db.close();
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('store-reset operator socket exclusion', () => {
  it('refuses legacy deterministically without touching an incumbent socket inode', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const paths = resolveStoreResetTargetPaths(runtime, 'legacy');
    createMismatchStore(paths.storeDbPath);
    const before = readFileSync(paths.storeDbPath);
    const incumbent = createServer();
    await expect(bindSocket(incumbent, paths.socketPath)).resolves.toEqual({ kind: 'bound' });
    const socketInode = lstatSync(paths.socketPath, { bigint: true }).ino;

    try {
      await expect(discardStoreReset({ target: 'legacy', runtime })).rejects.toMatchObject({
        code: 'legacy_foreign_generation',
        context: {
          operation: 'discard',
          legacyPath: runtime.paths.coral.generation.legacyDataRoot,
          version: null,
          flavor: 'prod',
          baseDir,
        },
      });
      expect(readFileSync(paths.storeDbPath)).toEqual(before);
      expect(lstatSync(paths.socketPath, { bigint: true }).ino).toBe(socketInode);
      expect(existsSync(paths.quarantineRoot)).toBe(false);
    } finally {
      await closeServer(incumbent);
    }
  });

  it('refuses an incumbent gen2 coordinator without changing the targeted store', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const paths = resolveStoreResetTargetPaths(runtime, 'gen2');
    createMismatchStore(paths.storeDbPath);
    const before = readFileSync(paths.storeDbPath);
    const incumbent = createServer();
    await expect(bindSocket(incumbent, paths.socketPath)).resolves.toEqual({ kind: 'bound' });

    try {
      await expect(
        discardStoreReset({ target: 'gen2', runtime, build: BUILD, storeFormat: STORE_FORMAT }),
      ).rejects.toMatchObject({
        code: 'coordinator_socket_in_use',
        remediation: expect.stringContaining('coral-cli backend shutdown'),
        context: { flavor: 'prod', operation: 'gen2 store reset', socketPath: paths.socketPath },
      });
      expect(readFileSync(paths.storeDbPath)).toEqual(before);
      expect(existsSync(paths.quarantineRoot)).toBe(false);
    } finally {
      await closeServer(incumbent);
    }
  });
});
