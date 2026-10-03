import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  epochDirectory,
  epochPath,
  openWritableStoreDbNoReset,
  resolvedStoreEpoch,
  settleStoreEpoch,
  storeEpochLockPath,
  storeMintLockPath,
  sweepStoreEpochsPostReady,
  STORE_EPOCH_METADATA_FILE_NAME,
} from '#src/store/epoch/index.js';
import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { releaseStoreReset as releaseStoreResetWithSocketGuard } from '#src/store/operator-store-reset.js';
import { createSharedFileLockSync, tryAcquireExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { authorizeFixtureStoreMint, openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build: StrictBundleManifest = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
  flavor: 'prod',
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness(): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-store-epoch-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function releaseStoreReset(
  options: Omit<Parameters<typeof releaseStoreResetWithSocketGuard>[0], 'acquireSocketGuard'>,
) {
  return releaseStoreResetWithSocketGuard({
    ...options,
    acquireSocketGuard: async () => ({ release: async () => undefined }),
  });
}

function createIncompatibleStore(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE prior_epoch_sentinel (value TEXT NOT NULL);
      INSERT INTO prior_epoch_sentinel (value) VALUES ('preserved');
      INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', 'sha256:${'0'.repeat(64)}');
      INSERT INTO meta (key, value) VALUES ('store_product_version', '0.0.1');
    `);
  } finally {
    db.close();
  }
}

function createCompatibleStore(path: string, sentinel: string): void {
  openTestStoreDatabase({ path, storage: createRealRuntime('prod').storage, storeFormat }).close();
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE rollback_sentinel (value TEXT NOT NULL)');
    db.prepare('INSERT INTO rollback_sentinel (value) VALUES (?)').run(sentinel);
  } finally {
    db.close();
  }
}

function options() {
  return { storeFormat, build, authorizeMint: authorizeFixtureStoreMint };
}

function flatStorePath(dbDir: string): string {
  return join(dbDir, 'store.db');
}

function withStorage(runtime: Runtime, storage: StoragePort): Runtime {
  return { ...runtime, storage };
}

function interceptRename(runtime: Runtime, beforeRename: (source: string, destination: string) => void): StoragePort {
  return new Proxy(runtime.storage, {
    get(target, property, receiver) {
      if (property !== 'renameSync') return Reflect.get(target, property, receiver) as unknown;
      return (source: string, destination: string): void => {
        beforeRename(source, destination);
        target.renameSync(source, destination);
      };
    },
  });
}

function publishAdversarialEpoch(destination: string, compatible = false): void {
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, '.lock'), '');
  if (compatible) createCompatibleStore(join(destination, 'store.db'), 'concurrent-winner');
  else createIncompatibleStore(join(destination, 'store.db'));
  writeFileSync(
    join(destination, STORE_EPOCH_METADATA_FILE_NAME),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable' },
      build,
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

async function withLiveSqliteDescriptor<T>(
  paths: string | readonly string[],
  run: (pid: number) => Promise<T>,
): Promise<T> {
  const descriptorPaths = typeof paths === 'string' ? [paths] : paths;
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      "const { DatabaseSync } = require('node:sqlite'); const dbs = process.argv.slice(1).map((path) => new DatabaseSync(path)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ...descriptorPaths,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolveReady, reject) => {
      child.stdout.once('data', () => resolveReady());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`SQLite descriptor child exited before ready (${code}).`)));
    });
    if (child.pid === undefined) throw new Error('SQLite descriptor child has no pid.');
    return await run(child.pid);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    }
  }
}

function publishLiveCoordinator(runtime: Runtime, pid: number, storeEpoch?: string): void {
  writeDiscoveryRecord(
    {
      pid,
      port: 1,
      socketPath: join(runtime.paths.coral.coordinator.runDir, 'live.sock'),
      bundleHash: 'live-descriptor-test',
      flavor: runtime.flavor,
      namespace: 'live-descriptor-test',
      startedAt: Date.now(),
      token: 'live-descriptor-test',
      bootToken: 'live-descriptor-test',
      version: '0.10.9',
      ...(storeEpoch === undefined ? {} : { storeEpoch }),
    },
    runtime,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('write-once store epochs', () => {
  it('carries one resolved root through proof, lease, open, and holder publication', () => {
    const runtime = harness();
    const configuredDbDir = runtime.paths.coral.store.dbDir;
    const oldRoot = join(dirname(configuredDbDir), 'old-store-root');
    const newRoot = join(dirname(configuredDbDir), 'new-store-root');
    publishAdversarialEpoch(epochDirectory(oldRoot, '1'), true);
    publishAdversarialEpoch(epochDirectory(newRoot, '1'), true);
    mkdirSync(dirname(configuredDbDir), { recursive: true });
    symlinkSync(oldRoot, configuredDbDir, 'dir');
    const oldLock = storeEpochLockPath(oldRoot, '1');
    let retargeted = false;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'realpathSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): string => {
          const resolved = subject.realpathSync(path);
          if (!retargeted && path === oldLock) {
            retargeted = true;
            rmSync(configuredDbDir);
            symlinkSync(newRoot, configuredDbDir, 'dir');
          }
          return resolved;
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    const oldHolder = readdirSync(oldRoot).find((entry) => entry.startsWith('.epoch-holder-'));
    const newHolder = readdirSync(newRoot).find((entry) => entry.startsWith('.epoch-holder-'));
    const oldLease = tryAcquireExclusiveFileLockSync(oldLock);
    const newLease = tryAcquireExclusiveFileLockSync(storeEpochLockPath(newRoot, '1'));
    try {
      expect(retargeted).toBe(true);
      expect(settled.store.path).toBe(epochPath(oldRoot, '1'));
      expect(settled.db.prepare('SELECT value FROM rollback_sentinel').get()).toEqual({
        value: 'concurrent-winner',
      });
      expect(oldHolder).toBeDefined();
      expect(newHolder).toBeUndefined();
      expect(oldLease).toBeNull();
      expect(newLease).not.toBeNull();
    } finally {
      newLease?.();
      oldLease?.();
      settled.db.close();
    }
  });

  it('keeps every store opener out of an epoch with malformed metadata', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const malformedPath = epochPath(dbDir, '1');
    createCompatibleStore(malformedPath, 'malformed-metadata');
    writeFileSync(join(dirname(malformedPath), '.lock'), '');
    writeFileSync(join(dirname(malformedPath), STORE_EPOCH_METADATA_FILE_NAME), '{');
    const helperUrl = `${pathToFileURL(join(process.cwd(), 'clients/hooks/lib/store-epoch.mjs')).href}?metadata-proof=${Date.now()}`;
    const hook = (await import(helperUrl)) as {
      resolveCurrentStoreDbPath(path: string): string | null;
      openLockedReadOnlyStoreDatabase(dbPath: string): unknown;
    };

    expect(() => openWritableStoreDbNoReset(runtime, { path: malformedPath, storeFormat })).toThrow();
    expect(() => openReadOnlyStoreDatabase(runtime, { path: malformedPath, storeFormat })).toThrow();
    expect(hook.resolveCurrentStoreDbPath(dbDir)).toBeNull();
    expect(() => hook.openLockedReadOnlyStoreDatabase(malformedPath)).toThrow();
    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();
    expect(settled.store.epoch).toBe('2');
  });

  it('mints epoch one on first boot with only a compatible flat store present', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = flatStorePath(dbDir);
    createCompatibleStore(flatPath, 'v0.10.9-data');
    const before = readFileSync(flatPath);

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    expect(settled.store.epoch).toBe('1');
    expect(readFileSync(flatPath)).toEqual(before);
    const oldReader = new DatabaseSync(flatPath, { readOnly: true });
    const row = oldReader.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };
    oldReader.close();
    expect(row.value).toBe('v0.10.9-data');
  });

  it('adopts the winner when two publishers mint the same next epoch', () => {
    const runtime = harness();
    let collisionInjected = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (collisionInjected || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-'))
        return;
      collisionInjected = true;
      publishAdversarialEpoch(destination, true);
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.store.epoch).toBe('1');
    settled.db.close();
    expect(collisionInjected).toBe(true);
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
  });

  it('does not sweep a mint whose database is held by a live foreign coordinator', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const mintPath = join(dbDir, '.mint-live-publisher', 'store.db');
    createCompatibleStore(mintPath, 'live-mint');
    const oldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor([mintPath, oldPath], async (pid) => {
      publishLiveCoordinator(runtime, pid);
      const settled = settleStoreEpoch(runtime, options());
      settled.db.close();

      expect(existsSync(mintPath)).toBe(true);
      expect(existsSync(oldPath)).toBe(true);
    });
  });

  it('re-reads current before a stale release can delete a concurrently published epoch', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishLiveCoordinator(runtime, runtime.env.pid());
    let published = false;
    const target = epochDirectory(dbDir, '2');
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readdirSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): string[] => {
          if (path === dbDir && !published) {
            published = true;
            publishAdversarialEpoch(target, true);
          }
          return subject.readdirSync(path);
        };
      },
    });

    const released = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '2' });

    expect(released.kind).toBe('current');
    expect(existsSync(epochPath(dbDir, '2'))).toBe(true);
  });

  it('cancels a slow sweep before shutdown can expose its address to a successor', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'rollback');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'));
    let releaseSnapshot!: () => void;
    let snapshotTaken!: () => void;
    const snapshot = new Promise<void>((resolveSnapshot) => {
      snapshotTaken = resolveSnapshot;
    });
    const resume = new Promise<void>((resolveResume) => {
      releaseSnapshot = resolveResume;
    });
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readdir') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string): Promise<string[]> => {
          const entries = await subject.readdir(path);
          if (path === dbDir) {
            snapshotTaken();
            await resume;
          }
          return entries;
        };
      },
    });
    const controller = new AbortController();
    const sweep = sweepStoreEpochsPostReady(withStorage(runtime, storage), resolvedStoreEpoch(dbDir, '3'), {
      signal: controller.signal,
    });
    await snapshot;
    controller.abort();
    releaseSnapshot();

    expect(await sweep).toBe('cancelled');
    expect(existsSync(flatStorePath(dbDir))).toBe(true);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    const successor = settleStoreEpoch(runtime, options());
    expect(successor.store.epoch).toBe('4');
    successor.db.close();
    const rollback = new DatabaseSync(flatStorePath(dbDir), { readOnly: true });
    expect((rollback.prepare('SELECT value FROM rollback_sentinel').get() as { value: string }).value).toBe('rollback');
    rollback.close();
  });

  it('keeps the opened epoch usable when the post-publication sweep fails', async () => {
    const runtime = harness();
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-2'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'), true);
    createCompatibleStore(flatStorePath(runtime.paths.coral.store.dbDir), 'garbage');
    const storage = new Proxy(runtime.storage, {
      get(target, property, receiver) {
        if (property !== 'rmdirSync') return Reflect.get(target, property, receiver) as unknown;
        return (path: string): void => {
          if (basename(path).startsWith('.reaping-')) {
            throw Object.assign(new Error('injected sweep failure'), { code: 'EIO' });
          }
          target.rmdirSync(path);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.store.epoch).toBe('3');
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(join(dbDir, '.mint-failed', 'store.db'), 'abandoned');
    createSharedFileLockSync(storeMintLockPath(dbDir, 'failed'))();
    publishLiveCoordinator(runtime, runtime.env.pid());
    await expect(sweepStoreEpochsPostReady(withStorage(runtime, storage), settled.store)).resolves.toBe(
      'deletion-failed',
    );
    settled.db.close();
    expect(existsSync(flatStorePath(runtime.paths.coral.store.dbDir))).toBe(true);
  });
});
