import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireStoreResetSocketGuard } from '#src/cli/store-reset-socket.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import { createForeignTargetValidator } from '#src/infra/handoff-target.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  encodeActiveStoreSelection,
  readActiveStoreSelection,
  readActiveStoreTransition,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
} from '#src/store/active-store-selection.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { discardStoreReset, resolveStoreResetTargetPaths } from '#src/store/operator-store-reset.js';
import { parseStoreResetIncidentManifest, STORE_RESET_MANIFEST_FILE_NAME } from '#src/store/reset-incident.js';
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
const backendBundle = 'operator routing backend';
const cliBundle = 'operator routing cli';
const claudeAppserverBundle = 'operator routing claude appserver';

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

function routedManifest(version: string, buildSetId: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
    cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
    claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
    flavor: 'prod',
    storeFormatFingerprint: STORE_FORMAT.fingerprint,
  };
}

function selection(manifest: StrictBundleManifest, bundleDir: string): ActiveStoreSelection {
  return {
    version: 1,
    manifest,
    bundleDir,
    activeStoreFingerprint: manifest.storeFormatFingerprint,
  };
}

function createBundle(parent: string, manifest: StrictBundleManifest): string {
  const bundleDir = join(parent, `bundle-${manifest.version}`);
  mkdirSync(bundleDir, { mode: 0o700 });
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle);
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle);
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle);
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest));
  return bundleDir;
}

function publishSelection(runtime: ReturnType<typeof createRealRuntime>, value: ActiveStoreSelection): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.coordinationRoot, 0o700);
  expect(
    runtime.storage.writeAtomicDurableSync(paths.selectionFile, encodeActiveStoreSelection(value), { mode: 0o600 }),
  ).toBe(true);
}

function createVersionedStore(path: string, productVersion: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run('store_format_fingerprint', STORE_FORMAT.fingerprint);
    insert.run('store_product_version', productVersion);
  } finally {
    db.close();
  }
}

function tableExists(path: string, table: string): boolean {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  } finally {
    db.close();
  }
}

function newestIncidentManifest(runtime: ReturnType<typeof createRealRuntime>) {
  const quarantineRoot = resolveStoreResetTargetPaths(runtime, 'gen2').quarantineRoot;
  const incident = readdirSync(quarantineRoot)
    .filter((entry) => entry !== '.staging')
    .sort()
    .at(-1);
  if (incident === undefined) throw new Error('Expected a store-reset incident.');
  return parseStoreResetIncidentManifest(readFileSync(join(quarantineRoot, incident, STORE_RESET_MANIFEST_FILE_NAME)));
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
        discardStoreReset({
          target: 'gen2',
          runtime,
          build: BUILD,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: acquireStoreResetSocketGuard,
          validateSelectedTarget: () => {
            throw new Error('no selected target is expected in this case');
          },
        }),
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

  it('returns a valid newer selection handoff before taking the maintenance lock', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const paths = resolveStoreResetTargetPaths(runtime, 'gen2');
    const currentBundleDir = root();
    const selectedManifest = routedManifest('99.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selected = selection(selectedManifest, createBundle(baseDir, selectedManifest));
    publishSelection(runtime, selected);
    createMismatchStore(paths.storeDbPath);
    const before = readFileSync(paths.storeDbPath);
    const boundary = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(boundary.coordinationRoot, { recursive: true, mode: 0o700 });
    const releaseMaintenance = acquireDirectoryLockSync(boundary.maintenanceLock, 1_000);

    try {
      const result = await discardStoreReset({
        target: 'gen2',
        runtime,
        build: BUILD,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: acquireStoreResetSocketGuard,
        maintenanceTimeoutMs: 1,
        currentBundleDir,
        validateSelectedTarget: createForeignTargetValidator(),
      });

      expect('kind' in result && result.kind).toBe('handoff');
      expect(readFileSync(paths.storeDbPath)).toEqual(before);
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: selected });
      expect(existsSync(paths.quarantineRoot)).toBe(false);
    } finally {
      releaseMaintenance();
    }
  });

  it('recovers an invalid newer selection under operator authority and publishes a V3 incident', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const paths = resolveStoreResetTargetPaths(runtime, 'gen2');
    const currentBundleDir = root();
    const selectedManifest = routedManifest('99.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selectedBundleDir = createBundle(baseDir, selectedManifest);
    unlinkSync(join(selectedBundleDir, 'coral-cli.cjs'));
    publishSelection(runtime, selection(selectedManifest, selectedBundleDir));
    createVersionedStore(paths.storeDbPath, '99.0.0');

    const result = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: acquireStoreResetSocketGuard,
      currentBundleDir,
      validateSelectedTarget: createForeignTargetValidator(),
    });

    // Both arms now carry `kind`, so narrow on its value rather than on the property's presence.
    expect(result.kind).toBe('discarded');
    if (result.kind !== 'discarded') return;
    expect(result.incident).toMatchObject({ schemaVersion: 3, resetPolicyCause: 'newer-incompatible-invalid-target' });
    expect(result.resumed).toBe(false);
    expect(tableExists(paths.storeDbPath, 'sentinel_before_reset')).toBe(false);
    expect(readActiveStoreSelection(runtime)).toEqual({
      kind: 'valid',
      selection: selection(BUILD, currentBundleDir),
    });
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(newestIncidentManifest(runtime)).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
      resetPolicyEvidence: { validationFailure: { code: 'adjacent-bundle-mismatch' } },
    });
  });
});
