import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  discardCurrentStoreEpoch,
  epochDirectory,
  epochPath,
  listStoreEpochs,
  openWritableStoreDbNoReset,
  resolveCurrentStoreEpoch,
  settleStoreEpoch,
  storeMintLockPath,
  sweepStoreEpochs,
  sweepStoreEpochsPostReady,
  MAX_STORE_EPOCH_HOLDER_BYTES,
  MAX_STORE_EPOCH_METADATA_BYTES,
  STORE_EPOCH_METADATA_FILE_NAME,
} from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import {
  discardStoreReset,
  releaseStoreReset as releaseStoreResetWithSocketGuard,
} from '#src/store/operator-store-reset.js';
import { acquireDirectoryLockSync, acquireSharedFileLockSync } from '#src/infra/fs-lock.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

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
  return { storeFormat, build };
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
  if (compatible) createCompatibleStore(join(destination, 'store.db'), 'concurrent-winner');
  else createIncompatibleStore(join(destination, 'store.db'));
  writeFileSync(
    join(destination, STORE_EPOCH_METADATA_FILE_NAME),
    JSON.stringify({
      supersedes: 0,
      classification: { kind: 'unavailable', cause: 'adversary' },
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
  it('does not treat an epoch symlink to the store root as a published epoch', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = epochPath(dbDir, '0');
    createCompatibleStore(flatPath, 'flat-epoch-zero');
    symlinkSync('.', join(dbDir, 'epoch-1'));

    const settled = settleStoreEpoch(runtime, options());
    settled.db.exec("INSERT INTO rollback_sentinel (value) VALUES ('settled-write')");
    settled.db.close();

    const flat = new DatabaseSync(flatPath, { readOnly: true });
    const values = flat.prepare('SELECT value FROM rollback_sentinel ORDER BY rowid').all() as { value: string }[];
    flat.close();
    expect(settled.epoch).toBe('0');
    expect(values.map(({ value }) => value)).toEqual(['flat-epoch-zero', 'settled-write']);
    console.log('symlink-cell alias=epoch-1->. selected=epoch-0 flat-write=visible');
  });

  it('does not open or stamp a flat store symlink when no epoch is proven', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const external = join(dbDir, '..', 'external-flat.db');
    createCompatibleStore(external, 'external-flat');
    mkdirSync(dbDir, { recursive: true });
    symlinkSync(external, epochPath(dbDir, '0'));

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    const externalDb = new DatabaseSync(external, { readOnly: true });
    const values = externalDb.prepare('SELECT value FROM rollback_sentinel ORDER BY rowid').all() as {
      value: string;
    }[];
    externalDb.close();
    expect(settled.epoch).toBe('1');
    expect(values.map(({ value }) => value)).toEqual(['external-flat']);
    console.log('flat-symlink-cell proven=none external-write=false selected=epoch-1');
  });

  it('does not open or stamp a flat store symlink when a positive epoch is proven', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const external = join(dbDir, '..', 'external-flat.db');
    createCompatibleStore(external, 'external-flat');
    mkdirSync(dbDir, { recursive: true });
    symlinkSync(external, epochPath(dbDir, '0'));
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);

    const settled = settleStoreEpoch(runtime, options());
    settled.db.exec("INSERT INTO rollback_sentinel (value) VALUES ('settled-write')");
    settled.db.close();

    const externalDb = new DatabaseSync(external, { readOnly: true });
    const values = externalDb.prepare('SELECT value FROM rollback_sentinel ORDER BY rowid').all() as {
      value: string;
    }[];
    externalDb.close();
    expect(settled.epoch).toBe('1');
    expect(values.map(({ value }) => value)).toEqual(['external-flat']);
    console.log('flat-symlink-cell proven=epoch-1 external-write=false selected=epoch-1');
  });

  it('does not let a regular file named as an epoch authorize deletion of epoch zero', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = epochPath(dbDir, '0');
    createCompatibleStore(flatPath, 'flat-epoch-zero');
    writeFileSync(join(dbDir, 'epoch-1'), 'not a directory');

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    expect(settled.epoch).toBe('0');
    expect(existsSync(flatPath)).toBe(true);
    console.log('regular-file-cell entry=epoch-1 selected=epoch-0 flat-store=preserved');
  });

  it('recognizes the former numeric ceiling as an epoch with a successor', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat-epoch-zero');
    publishAdversarialEpoch(join(dbDir, `epoch-${Number.MAX_SAFE_INTEGER}`), true);

    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);

    expect(current).toBe(String(Number.MAX_SAFE_INTEGER));
    console.log(`max-safe-integer-cell entry=${Number.MAX_SAFE_INTEGER} selected=epoch-${current}`);
  });

  it.each([
    ['empty directory', (directory: string) => mkdirSync(directory)],
    [
      'directory without epoch.json',
      (directory: string) => createCompatibleStore(join(directory, 'store.db'), 'missing-metadata'),
    ],
    [
      'directory with malformed epoch.json',
      (directory: string) => {
        createCompatibleStore(join(directory, 'store.db'), 'malformed-metadata');
        writeFileSync(join(directory, STORE_EPOCH_METADATA_FILE_NAME), '{');
      },
    ],
  ])('does not select an %s', (_description, arrange) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat-epoch-zero');
    arrange(join(dbDir, 'epoch-2'));

    expect(resolveCurrentStoreEpoch(runtime.storage, dbDir)).toBe('0');
  });

  it('does not select an epoch symlink to an external directory', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const external = join(dbDir, '..', 'external-epoch');
    createCompatibleStore(epochPath(dbDir, '0'), 'flat-epoch-zero');
    publishAdversarialEpoch(external, true);
    symlinkSync(external, join(dbDir, 'epoch-2'));

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    expect(settled.epoch).toBe('0');
    expect(existsSync(join(external, 'store.db'))).toBe(true);
  });

  it('selects the highest proven epoch across numbering gaps including the former numeric ceiling', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat-epoch-zero');
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(dbDir, `epoch-${Number.MAX_SAFE_INTEGER - 1}`), true);
    publishAdversarialEpoch(join(dbDir, `epoch-${Number.MAX_SAFE_INTEGER}`), true);

    expect(resolveCurrentStoreEpoch(runtime.storage, dbDir)).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it.each([
    ['regular file', (path: string) => writeFileSync(path, 'blocker')],
    [
      'malformed non-empty directory',
      (path: string) => {
        mkdirSync(path);
        writeFileSync(join(path, 'junk'), 'blocker');
      },
    ],
    [
      'symlink',
      (path: string) => {
        const external = join(dirname(path), '..', `${basename(path)}-external`);
        mkdirSync(external);
        writeFileSync(join(external, 'sentinel'), 'external');
        symlinkSync(external, path);
      },
    ],
  ])('publishes after a successor blocked by a %s without deleting the blocker', (_description, block) => {
    const scenarios: Array<{
      retained: string[];
      current: string;
      blocker: string;
      successor: string;
      survivors: string[];
    }> = [
      { retained: [], current: '0', blocker: '1', successor: '2', survivors: ['0', '2'] },
      { retained: ['0'], current: '2', blocker: '3', successor: '4', survivors: ['0', '2', '4'] },
      { retained: ['0', '1'], current: '3', blocker: '4', successor: '5', survivors: ['0', '3', '5'] },
    ];
    for (const scenario of scenarios) {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      if (scenario.current === '0') {
        createIncompatibleStore(epochPath(dbDir, '0'));
      } else {
        createCompatibleStore(epochPath(dbDir, '0'), 'flat');
        if (scenario.retained.includes('1')) publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
        publishAdversarialEpoch(join(dbDir, `epoch-${scenario.current}`));
      }
      const blockerPath = join(dbDir, `epoch-${scenario.blocker}`);
      block(blockerPath);

      const settled = settleStoreEpoch(runtime, options());

      expect(settled.epoch).toBe(scenario.successor);
      settled.db.close();
      expect(existsSync(blockerPath)).toBe(true);
      const externalSentinel = join(dbDir, '..', `epoch-${scenario.blocker}-external`, 'sentinel');
      if (_description === 'symlink') expect(existsSync(externalSentinel)).toBe(true);
      publishLiveCoordinator(runtime, runtime.env.pid());
      expect(sweepStoreEpochs(runtime, dbDir, scenario.successor)).toBe('complete');
      expect(existsSync(blockerPath)).toBe(false);
      const survivors = ['0', '1', '2', '3', '4', '5'].filter((epoch) => existsSync(epochPath(dbDir, epoch)));
      expect(survivors).toEqual(scenario.survivors);
      if (_description === 'symlink') expect(existsSync(externalSentinel)).toBe(true);
      console.log(
        `successor-blocker-cell kind=${_description} retained-evidence=${scenario.retained.length + 1} selected=epoch-${scenario.successor} survivors=${survivors.join(',')}`,
      );
    }
  });

  it.each([String(Number.MAX_SAFE_INTEGER - 1), '9007199254740995', '123456789012345678901234567890'])(
    'supersedes incompatible epoch %s without a numeric ceiling',
    (epoch) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(join(dbDir, `epoch-${epoch}`));

      const settled = settleStoreEpoch(runtime, options());

      expect(String(settled.epoch)).toBe((BigInt(epoch) + 1n).toString());
      settled.db.close();
      expect(existsSync(join(dbDir, `epoch-${BigInt(epoch) + 1n}`, 'store.db'))).toBe(true);
      console.log(`unbounded-successor-cell current=${epoch} successor=${BigInt(epoch) + 1n}`);
    },
  );

  it.each(['EACCES', 'EIO'])(
    'lists missing, malformed, and %s-unreadable epoch metadata without losing the current row',
    (code) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      createCompatibleStore(epochPath(dbDir, '0'), 'flat-epoch-zero');
      createCompatibleStore(join(dbDir, 'epoch-2', 'store.db'), 'missing');
      createCompatibleStore(join(dbDir, 'epoch-3', 'store.db'), 'malformed');
      writeFileSync(join(dbDir, 'epoch-3', STORE_EPOCH_METADATA_FILE_NAME), '{');
      publishAdversarialEpoch(join(dbDir, 'epoch-4'), true);
      const unreadableMetadata = join(dbDir, 'epoch-4', STORE_EPOCH_METADATA_FILE_NAME);
      const storage = new Proxy(runtime.storage, {
        get(subject, property, receiver) {
          if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
          return (path: string, encoding: 'utf-8'): string => {
            if (path === unreadableMetadata) throw Object.assign(new Error('injected unreadable metadata'), { code });
            return subject.readFileSync(path, encoding);
          };
        },
      });

      const rows = listStoreEpochs(withStorage(runtime, storage), storeFormat);

      expect(rows.filter(({ role }) => role === 'current').map(({ epoch }) => epoch)).toEqual(['0']);
      expect(Object.fromEntries(rows.map(({ epoch, epochJson }) => [epoch, epochJson.kind]))).toEqual({
        0: 'legacy-epoch-0',
        2: 'missing',
        3: 'malformed',
        4: 'unreadable',
      });
      expect(rows.find(({ epoch }) => epoch === '4')?.role).toBe('unobservable');
    },
  );

  it('classifies oversized epoch metadata as malformed without reading or refusing it', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat-epoch-zero');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const metadataPath = join(dbDir, 'epoch-1', STORE_EPOCH_METADATA_FILE_NAME);
    writeFileSync(metadataPath, 'x'.repeat(MAX_STORE_EPOCH_METADATA_BYTES + 1));
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path === metadataPath) throw new Error('oversized metadata must not be read');
          return subject.readFileSync(path, encoding);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    settled.db.close();
    const oversized = listStoreEpochs(withStorage(runtime, storage), storeFormat).find(({ epoch }) => epoch === '1');

    expect(settled.epoch).toBe('0');
    expect(oversized?.epochJson.kind).toBe('malformed');
    console.log(`oversized-epoch-json-cell bytes=${MAX_STORE_EPOCH_METADATA_BYTES + 1} classification=malformed`);
  });

  it('surfaces a mode-0444 proven store as an open syscall refusal with errno', () => {
    const runtime = harness();
    const path = epochPath(runtime.paths.coral.store.dbDir, '0');
    createCompatibleStore(path, 'read-only');
    chmodSync(path, 0o444);

    expect(() => settleStoreEpoch(runtime, options())).toThrow(/open syscall.*errno EACCES/u);
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
  });

  it.each(['EACCES', 'EMFILE'])('surfaces persistent %s from open instead of retrying', (code) => {
    const runtime = harness();
    const path = epochPath(runtime.paths.coral.store.dbDir, '0');
    createCompatibleStore(path, code);
    let attempts = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'openSync') return Reflect.get(subject, property, receiver) as unknown;
        return (candidate: string, flags: string, mode?: number): number => {
          if (candidate === path) {
            attempts += 1;
            throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return subject.openSync(candidate, flags, mode);
        };
      },
    });

    expect(() => settleStoreEpoch(withStorage(runtime, storage), options())).toThrow(
      new RegExp(`open syscall.*errno ${code}`, 'u'),
    );
    expect(attempts).toBe(1);
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
  });

  it.each(['EACCES', 'EIO'])('does not delete an epoch whose metadata read returns %s', (code) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const metadataPath = join(dbDir, 'epoch-1', STORE_EPOCH_METADATA_FILE_NAME);
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path === metadataPath) throw Object.assign(new Error(`injected ${code}`), { code });
          return subject.readFileSync(path, encoding);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('0');
    settled.db.close();
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    console.log(`unobservable-metadata-cell phase=selection code=${code} removed=false`);
  });

  it('steps over an unobservable successor while replacing an incompatible current epoch', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createIncompatibleStore(epochPath(dbDir, '0'));
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const metadataPath = join(dbDir, 'epoch-1', STORE_EPOCH_METADATA_FILE_NAME);
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path === metadataPath) throw Object.assign(new Error('injected successor EIO'), { code: 'EIO' });
          return subject.readFileSync(path, encoding);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('2');
    settled.db.close();
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    console.log('unobservable-successor-cell blocked=epoch-1 selected=epoch-2 removed=false');
  });

  it('inventories every file recursively removed with a directory epoch', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const before = listStoreEpochs(runtime, storeFormat)[0]?.bytes;
    mkdirSync(join(dbDir, 'epoch-1', 'nested'));
    writeFileSync(join(dbDir, 'epoch-1', 'extra.bin'), '12345');
    writeFileSync(join(dbDir, 'epoch-1', 'nested', 'extra.bin'), '678');

    const after = listStoreEpochs(runtime, storeFormat)[0]?.bytes;

    expect(before).not.toBeNull();
    expect(after).toBe((before ?? 0) + 8);
  });

  it('opens an explicit nonstandard database path without applying epoch discovery', () => {
    const runtime = harness();
    const fixturePath = join(runtime.paths.coral.store.dbDir, 'fixture.db');
    createCompatibleStore(fixturePath, 'explicit-fixture');
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-3'), true);

    const db = openWritableStoreDbNoReset(runtime, { path: fixturePath, storeFormat });
    const row = db.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };
    db.close();

    expect(row.value).toBe('explicit-fixture');
  });

  it('leaves epoch zero untouched for a v0.10.9-shaped reader after a newer epoch exists', () => {
    const runtime = harness();
    const flatPath = epochPath(runtime.paths.coral.store.dbDir, '0');
    createCompatibleStore(flatPath, 'v0.10.9-data');

    const discarded = discardCurrentStoreEpoch(runtime, options());
    discarded.db.close();

    const oldReader = new DatabaseSync(flatPath, { readOnly: true });
    const row = oldReader.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };
    oldReader.close();
    expect(row.value).toBe('v0.10.9-data');
    expect(resolveCurrentStoreEpoch(runtime.storage, runtime.paths.coral.store.dbDir)).toBe('1');
    console.log('rollback-cell epoch0=untouched reader=booted value=v0.10.9-data current=1');
  });

  it('adopts the winner when two publishers mint the same next epoch', () => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'));
    let collisionInjected = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (collisionInjected || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-'))
        return;
      collisionInjected = true;
      publishAdversarialEpoch(destination, true);
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('1');
    settled.db.close();
    expect(collisionInjected).toBe(true);
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
    console.log('concurrent-publish-cell publishers=2 winner=epoch-1 loser=adopted-on-ENOTEMPTY current=1');
  });

  it('re-mints when a private mint disappears before publication', () => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'));
    let swept = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (swept || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-')) return;
      swept = true;
      rmSync(source, { recursive: true, force: true });
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('1');
    settled.db.close();
    expect(swept).toBe(true);
  });

  it.each([1, 2, 3, 5])('converges after %i adversarial publications to one non-garbage pair', (count) => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'));
    publishLiveCoordinator(runtime, runtime.env.pid());
    let injected = 0;
    const storage = interceptRename(runtime, (source, destination) => {
      if (injected >= count || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-'))
        return;
      injected += 1;
      publishAdversarialEpoch(destination);
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    settled.db.close();
    expect(sweepStoreEpochs(runtime, runtime.paths.coral.store.dbDir, settled.epoch)).toBe('complete');
    const rows = listStoreEpochs(runtime, storeFormat);

    expect(rows.filter((row) => row.role !== 'garbage').map((row) => [row.epoch, row.role])).toEqual([
      [String(count + 1), 'current'],
      [String(count), 'preserved'],
      ['0', 'preserved'],
    ]);
    expect(rows.filter((row) => row.role === 'garbage')).toEqual([]);
    console.log(`K-replacement-cell K=${count} non-garbage=${count + 1}:current,${count}:preserved garbage=0`);
  });

  it.each(['empty-mint', 'opened-mint', 'described-mint'])(
    'boots without deleting an unowned mint after process death seeded at %s',
    (cut) => {
      const runtime = harness();
      createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'));
      const mint = join(runtime.paths.coral.store.dbDir, '.mint-dead-process');
      mkdirSync(mint, { recursive: true });
      if (cut === 'opened-mint' || cut === 'described-mint') createCompatibleStore(join(mint, 'store.db'), cut);
      if (cut === 'described-mint') writeFileSync(join(mint, STORE_EPOCH_METADATA_FILE_NAME), '{}');

      const settled = settleStoreEpoch(runtime, options());

      settled.db.close();
      expect(existsSync(mint)).toBe(true);
    },
  );

  it('boots after process death following epoch publication', () => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'));
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'), true);

    const settled = settleStoreEpoch(runtime, options());

    expect(settled.epoch).toBe('1');
    settled.db.close();
  });

  it('does not sweep a mint whose database is held by a live foreign coordinator', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
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
      console.log(
        'live-descriptor-sweep-cell targets=.mint-live-publisher/store.db,epoch-1/store.db current=3 descriptors=live removed=false',
      );
    });
  });

  it('does not sweep an epoch held by a live process when coordinator discovery is missing', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const heldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(heldPath, async () => {
      const settled = settleStoreEpoch(runtime, options());
      settled.db.close();

      expect(existsSync(heldPath)).toBe(true);
      console.log('missing-discovery-cell holder=unregistered-live removed=false');
    });
  });

  it('does not sweep an epoch when a live coordinator discovery write returned false', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const heldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(heldPath, async (pid) => {
      const storage = new Proxy(runtime.storage, {
        get(subject, property, receiver) {
          if (property !== 'writeAtomicSync') return Reflect.get(subject, property, receiver) as unknown;
          return (): boolean => false;
        },
      });
      const interruptedRuntime = withStorage(runtime, storage);
      publishLiveCoordinator(interruptedRuntime, pid);
      const settled = settleStoreEpoch(interruptedRuntime, options());
      settled.db.close();

      expect(existsSync(heldPath)).toBe(true);
      console.log('missing-discovery-cell holder=coordinator-write-false removed=false');
    });
  });

  it('does not release epoch zero while a v0.10.9-shaped coordinator is live', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = epochPath(dbDir, '0');
    createCompatibleStore(flatPath, 'v0.10.9-live');
    publishAdversarialEpoch(join(dbDir, 'epoch-2'), true);

    await withLiveSqliteDescriptor(flatPath, async (pid) => {
      publishLiveCoordinator(runtime, pid);
      const released = await releaseStoreReset({ target: 'gen2', runtime, epoch: '0' });

      expect(released.kind).toBe('release-holder-live');
      expect(existsSync(flatPath)).toBe(true);
    });
  });

  it('takes the socket guard before release when discovery publication fails', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const held = openWritableStoreDbNoReset(runtime, { path: epochPath(dbDir, '1'), storeFormat });
    const failedStorage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'writeAtomicSync') return Reflect.get(subject, property, receiver) as unknown;
        return (): boolean => false;
      },
    });
    expect(
      writeDiscoveryRecord(
        {
          pid: runtime.env.pid(),
          port: 1,
          socketPath: join(runtime.paths.coral.coordinator.runDir, 'live.sock'),
          bundleHash: 'failed-publication',
          flavor: runtime.flavor,
          namespace: 'failed-publication',
          startedAt: Date.now(),
          token: 'failed-publication',
          bootToken: 'failed-publication',
          version: '0.10.9',
          storeEpoch: '1',
        },
        withStorage(runtime, failedStorage),
      ),
    ).toBe(false);
    let guardAttempts = 0;
    await expect(
      releaseStoreResetWithSocketGuard({
        target: 'gen2',
        runtime,
        epoch: '1',
        acquireSocketGuard: async () => {
          guardAttempts += 1;
          throw new Error('coordinator socket is held');
        },
      }),
    ).rejects.toThrow('coordinator socket is held');
    expect(guardAttempts).toBe(1);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);

    held.close();
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
      kind: 'released',
    });
    console.log('release-socket-guard-cell discovery-published=false guarded=true descriptor-preserved=true');
  });

  it('re-reads current before a stale release can delete a concurrently published epoch', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
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

  it('re-reads current after the deletion proof when the target becomes current', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const target = epochDirectory(dbDir, '2');
    mkdirSync(target);
    writeFileSync(join(target, 'junk'), 'not published');
    publishLiveCoordinator(runtime, runtime.env.pid());
    const discoveryPath = runtime.paths.coral.coordinator.infoFile;
    let published = false;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          const result = subject.readFileSync(path, encoding);
          if (path === discoveryPath && !published) {
            published = true;
            rmSync(target, { recursive: true, force: true });
            publishAdversarialEpoch(target, true);
          }
          return result;
        };
      },
    });

    const released = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '2' });

    expect(released.kind).toBe('current');
    expect(existsSync(epochPath(dbDir, '2'))).toBe(true);
    console.log('release-race-cell resolved=epoch-1 deletion-proof=epoch-2 removed=false');
  });

  it.each(['EACCES', 'EIO'])(
    'does not release the real current epoch after transient %s hid it from resolution',
    async (code) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      createCompatibleStore(epochPath(dbDir, '0'), 'flat');
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
      publishAdversarialEpoch(join(dbDir, 'epoch-2'), true);
      publishLiveCoordinator(runtime, 999_999_991);
      const metadataPath = join(dbDir, 'epoch-2', STORE_EPOCH_METADATA_FILE_NAME);
      let reads = 0;
      const storage = new Proxy(runtime.storage, {
        get(subject, property, receiver) {
          if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
          return (path: string, encoding: 'utf-8'): string => {
            if (path === metadataPath && (reads += 1) === 1) {
              throw Object.assign(new Error(`injected current-resolution ${code}`), { code });
            }
            return subject.readFileSync(path, encoding);
          };
        },
      });

      const released = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '2' });

      expect(released.kind).toBe('current');
      expect(existsSync(epochPath(dbDir, '2'))).toBe(true);
      console.log(`unobservable-metadata-cell phase=release code=${code} removed=false`);
    },
  );

  it('reports a durability-sync failure when the deletion parent cannot be synced', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishLiveCoordinator(runtime, runtime.env.pid());
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => (path === dbDir ? false : subject.syncDirectoryDurableSync(path));
      },
    });

    const released = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '1' });

    expect(released.kind).toBe('release-durability-sync-failed');
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);

    let retrySyncs = 0;
    const retryStorage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => {
          if (path === dbDir) retrySyncs += 1;
          return subject.syncDirectoryDurableSync(path);
        };
      },
    });
    const retried = await releaseStoreReset({
      target: 'gen2',
      runtime: withStorage(runtime, retryStorage),
      epoch: '1',
    });

    expect(retried.kind).toBe('absent');
    expect(retrySyncs).toBe(1);
  });

  it('keeps epoch zero observable until a partial release can be retried', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    writeFileSync(`${epochPath(dbDir, '0')}-wal`, 'wal');
    writeFileSync(`${epochPath(dbDir, '0')}-shm`, 'shm');
    writeFileSync(`${epochPath(dbDir, '0')}.format`, 'format');
    publishAdversarialEpoch(join(dbDir, 'epoch-2'), true);
    let failed = false;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'unlinkSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): void => {
          if (path === `${epochPath(dbDir, '0')}-shm` && !failed) {
            failed = true;
            throw Object.assign(new Error('injected sidecar deletion failure'), { code: 'EIO' });
          }
          subject.unlinkSync(path);
        };
      },
    });

    await expect(
      releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '0' }),
    ).resolves.toMatchObject({ kind: 'release-deletion-failed' });
    expect(existsSync(epochPath(dbDir, '0'))).toBe(true);
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '0' })).resolves.toMatchObject({
      kind: 'released',
    });
    expect(
      [
        epochPath(dbDir, '0'),
        `${epochPath(dbDir, '0')}-wal`,
        `${epochPath(dbDir, '0')}-shm`,
        `${epochPath(dbDir, '0')}.format`,
      ].some(existsSync),
    ).toBe(false);
  });

  it('removes a directory at the flat store path only through explicit release zero', async () => {
    const releaseRuntime = harness();
    const releaseDbDir = releaseRuntime.paths.coral.store.dbDir;
    mkdirSync(epochPath(releaseDbDir, '0'), { recursive: true });
    writeFileSync(join(epochPath(releaseDbDir, '0'), 'nested'), 'garbage');
    publishAdversarialEpoch(join(releaseDbDir, 'epoch-1'), true);

    await expect(releaseStoreReset({ target: 'gen2', runtime: releaseRuntime, epoch: '0' })).resolves.toMatchObject({
      kind: 'released',
    });
    expect(existsSync(epochPath(releaseDbDir, '0'))).toBe(false);

    const sweepRuntime = harness();
    const sweepDbDir = sweepRuntime.paths.coral.store.dbDir;
    mkdirSync(epochPath(sweepDbDir, '0'), { recursive: true });
    writeFileSync(join(epochPath(sweepDbDir, '0'), 'nested'), 'garbage');
    publishAdversarialEpoch(join(sweepDbDir, 'epoch-2'), true);
    publishLiveCoordinator(sweepRuntime, sweepRuntime.env.pid(), '2');

    expect(sweepStoreEpochs(sweepRuntime, sweepDbDir, '2')).toBe('complete');
    expect(existsSync(epochPath(sweepDbDir, '0'))).toBe(true);
  });

  it('surfaces a persistent successor lstat refusal once with its errno', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createIncompatibleStore(epochPath(dbDir, '0'));
    const successor = epochDirectory(dbDir, '1');
    let attempts = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'lstatSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, lstatOptions?: { bigint: true }) => {
          if (path === successor) {
            attempts += 1;
            throw Object.assign(new Error('injected successor refusal'), { code: 'EACCES' });
          }
          return lstatOptions === undefined ? subject.lstatSync(path) : subject.lstatSync(path, lstatOptions);
        };
      },
    });

    expect(() => settleStoreEpoch(withStorage(runtime, storage), options())).toThrow(
      /lstat syscall.*successor.*errno EACCES/u,
    );
    expect(attempts).toBe(1);
  });

  it.each([300, 3_000])('answers health and signals during a post-ready sweep over %i entries', async (entryCount) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    for (let index = 0; index < entryCount; index += 1) {
      const garbage = join(dbDir, `epoch-garbage-${index}`, 'nested', 'deeper');
      mkdirSync(garbage, { recursive: true });
      writeFileSync(join(garbage, 'payload'), 'garbage');
    }
    const token = 'sweep-health-token';
    const server = createServer((request, response) => {
      response.statusCode = request.headers.authorization === `Bearer ${token}` ? 200 : 401;
      response.end('healthy');
    });
    await new Promise<void>((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('health server did not bind TCP');
    let sweepSettled = false;
    const sweep = sweepStoreEpochsPostReady(runtime, dbDir, '3').finally(() => {
      sweepSettled = true;
    });
    const signalHandled = new Promise<boolean>((resolveSignal) => {
      process.once('SIGUSR2', () => resolveSignal(!sweepSettled));
      setImmediate(() => process.kill(process.pid, 'SIGUSR2'));
    });
    const startedAt = performance.now();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const healthLatencyMs = performance.now() - startedAt;
    const healthAnsweredDuringSweep = !sweepSettled;
    const signalHandledDuringSweep = await signalHandled;

    expect(health.status).toBe(200);
    expect(await health.text()).toBe('healthy');
    expect(healthAnsweredDuringSweep).toBe(true);
    expect(signalHandledDuringSweep).toBe(true);
    expect(healthLatencyMs).toBeLessThan(500);
    expect(await sweep).toBe('complete');
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    console.log(
      `event-loop-cell entries=${entryCount} health-status=${health.status} latency-ms=${healthLatencyMs.toFixed(1)} signal-handled-during-sweep=${signalHandledDuringSweep}`,
    );
  });

  it('bounds an oversized holder before parsing it', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const holderPath = join(dbDir, '.epoch-holder-oversized.json');
    writeFileSync(holderPath, 'x'.repeat(MAX_STORE_EPOCH_HOLDER_BYTES + 1));
    let holderReads = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFile') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string, encoding: 'utf-8'): Promise<string> => {
          if (path === holderPath) holderReads += 1;
          return subject.readFile(path, encoding);
        };
      },
    });

    expect(await sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3')).toBe('complete');
    expect(holderReads).toBe(0);
    expect(existsSync(holderPath)).toBe(false);
    console.log(`holder-bound-cell bytes=${MAX_STORE_EPOCH_HOLDER_BYTES + 1} parsed=false`);
  });

  it('reclaims K abandoned private mints during the post-ready sweep', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    for (let index = 0; index < 12; index += 1) {
      createCompatibleStore(join(dbDir, `.mint-process-death-${index}`, 'store.db'), `mint-${index}`);
    }

    expect(await sweepStoreEpochsPostReady(runtime, dbDir, '1')).toBe('complete');
    expect(readdirSync(dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
    console.log('mint-process-death-cell seeded=12 remaining=0');
  });

  it('does not sweep a live concurrent mint through the production post-ready path', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const id = 'live-publisher';
    const mint = join(dbDir, `.mint-${id}`);
    createCompatibleStore(join(mint, 'store.db'), 'live-mint');
    const held = acquireSharedFileLockSync(storeMintLockPath(dbDir, id));
    try {
      expect(await sweepStoreEpochsPostReady(runtime, dbDir, '3')).toBe('live-holder');
      expect(existsSync(join(mint, 'store.db'))).toBe(true);
      console.log('post-ready-live-mint-cell result=live-holder mint=present');
    } finally {
      held();
    }
  });

  it('does not sweep the coordinator epoch while its settled database is open', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const settled = settleStoreEpoch(runtime, options());
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);
    try {
      expect(await sweepStoreEpochsPostReady(runtime, dbDir, '5')).toBe('live-holder');
      expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
      console.log('post-ready-coordinator-descriptor-cell result=live-holder epoch-1=present');
    } finally {
      settled.db.close();
    }
  });

  it('protects a KB daemon holder published after the sweep directory snapshot', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);
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
    const sweep = sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '5');
    await snapshot;
    const kbDatabase = openWritableStoreDbNoReset(runtime, { path: epochPath(dbDir, '1'), storeFormat });
    releaseSnapshot();
    try {
      expect(await sweep).toBe('live-holder');
      expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
      console.log('post-ready-kb-descriptor-cell holder-after-snapshot=true epoch-1=present');
    } finally {
      kbDatabase.close();
    }
  });

  it('cancels a slow sweep before shutdown can expose its address to a successor', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'rollback');
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
    const sweep = sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3', {
      signal: controller.signal,
    });
    await snapshot;
    controller.abort();
    releaseSnapshot();

    expect(await sweep).toBe('cancelled');
    expect(existsSync(epochPath(dbDir, '0'))).toBe(true);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    const successor = settleStoreEpoch(runtime, options());
    expect(successor.epoch).toBe('4');
    successor.db.close();
    const rollback = new DatabaseSync(epochPath(dbDir, '0'), { readOnly: true });
    expect((rollback.prepare('SELECT value FROM rollback_sentinel').get() as { value: string }).value).toBe('rollback');
    rollback.close();
    console.log('shutdown-sweep-cell result=cancelled successor=epoch-4 rollback=bootable');
  });

  it('releases the socket guard when discard cannot acquire the adoption lock', async () => {
    const baseRuntime = harness();
    const { adoptionLock } = resolveGenerationBoundaryPaths(baseRuntime);
    mkdirSync(dirname(adoptionLock), { recursive: true });
    const held = acquireDirectoryLockSync(adoptionLock, {
      storage: baseRuntime.storage,
      time: baseRuntime.time,
    });
    let monotonicMs = 0n;
    const runtime = {
      ...baseRuntime,
      time: {
        ...baseRuntime.time,
        monotonicNow: () => {
          monotonicMs += 1_000n;
          return monotonicMs;
        },
        sleep: async () => undefined,
      },
    };
    let socketReleased = false;
    try {
      await expect(
        discardStoreReset({
          target: 'gen2',
          runtime,
          build,
          storeFormat,
          currentBundleDir: '/test/bundle',
          acquireSocketGuard: async () => ({
            release: async () => {
              socketReleased = true;
            },
          }),
        }),
      ).rejects.toMatchObject({ code: 'legacy_source_not_quiescent' });
      expect(socketReleased).toBe(true);
    } finally {
      held();
    }
  });

  it('reports a deletion failure separately from durability', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const target = epochDirectory(dbDir, '1');
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'rmSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): void => {
          if (path === target) throw Object.assign(new Error('injected deletion failure'), { code: 'EACCES' });
          subject.rmSync(path, rmOptions);
        };
      },
    });

    const released = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '1' });

    expect(released.kind).toBe('release-deletion-failed');
    expect(existsSync(target)).toBe(true);
  });

  it('durably syncs an epoch adopted after its publisher died following rename', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createIncompatibleStore(epochPath(dbDir, '0'));
    let rootSyncs = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => {
          if (path !== dbDir) return subject.syncDirectoryDurableSync(path);
          rootSyncs += 1;
          return rootSyncs > 1;
        };
      },
    });
    const interruptedRuntime = withStorage(runtime, storage);

    expect(() => settleStoreEpoch(interruptedRuntime, options())).toThrow('Failed to durably sync store epoch root');
    const adopted = settleStoreEpoch(interruptedRuntime, options());

    expect(adopted.epoch).toBe('1');
    adopted.db.close();
    expect(rootSyncs).toBeGreaterThanOrEqual(2);
  });

  it('refuses to release an old positive epoch held by a live coordinator', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const oldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(oldPath, async (pid) => {
      publishLiveCoordinator(runtime, pid, '1');
      const released = await releaseStoreReset({ target: 'gen2', runtime, epoch: '1' });

      expect(released.kind).toBe('release-holder-live');
      expect(existsSync(oldPath)).toBe(true);
      console.log('ordinary-live-release-cell target=epoch-1 current=3 released=false reason=open-epoch');
    });
  });

  it('does not sweep an epoch held by a live child when discovery names its dead parent', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const oldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(oldPath, async () => {
      publishLiveCoordinator(runtime, 999_999_991);
      expect(sweepStoreEpochs(runtime, dbDir, '3')).toBe('unobservable-metadata');
      expect(existsSync(oldPath)).toBe(true);
      console.log('dead-parent-live-child-cell parent=absent child=live removed=false');
    });
  });

  it('keeps the opened epoch usable when the post-publication sweep fails', async () => {
    const runtime = harness();
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-2'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'), true);
    createCompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'), 'garbage');
    const garbagePath = epochDirectory(runtime.paths.coral.store.dbDir, '1');
    const storage = new Proxy(runtime.storage, {
      get(target, property, receiver) {
        if (property !== 'rm') return Reflect.get(target, property, receiver) as unknown;
        return async (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): Promise<void> => {
          if (path === garbagePath) throw Object.assign(new Error('injected sweep failure'), { code: 'EIO' });
          await target.rm(path, rmOptions);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('3');
    publishLiveCoordinator(runtime, runtime.env.pid());
    await expect(
      sweepStoreEpochsPostReady(withStorage(runtime, storage), runtime.paths.coral.store.dbDir, settled.epoch),
    ).resolves.toBe('deletion-failed');
    settled.db.close();
    expect(existsSync(epochPath(runtime.paths.coral.store.dbDir, '0'))).toBe(true);
  });

  it('syncs the epoch root after post-publication sweep removals', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishLiveCoordinator(runtime, runtime.env.pid());
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'rmSync') {
          return (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): void => {
            events.push(`remove:${path}`);
            subject.rmSync(path, rmOptions);
          };
        }
        if (property === 'unlinkSync') {
          return (path: string): void => {
            events.push(`remove:${path}`);
            subject.unlinkSync(path);
          };
        }
        if (property === 'syncDirectoryDurableSync') {
          return (path: string): boolean => {
            events.push(`sync:${path}`);
            return subject.syncDirectoryDurableSync(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    settled.db.close();
    expect(sweepStoreEpochs(withStorage(runtime, storage), dbDir, settled.epoch)).toBe('complete');

    let lastRemoval = -1;
    let lastRootSync = -1;
    events.forEach((event, index) => {
      if (event.startsWith('remove:')) lastRemoval = index;
      if (event === `sync:${dbDir}`) lastRootSync = index;
    });
    expect(lastRemoval).toBeGreaterThanOrEqual(0);
    expect(lastRootSync).toBeGreaterThan(lastRemoval);
    console.log('post-publication-sweep-durability-cell removals=1 parent-sync=after');
  });

  it('prevents K crash-resurrected sweep removals from accumulating', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishLiveCoordinator(runtime, runtime.env.pid());
    const backups = new Map<string, string>();
    let backupSequence = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'rmSync') {
          return (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): void => {
            if (dirname(path) === dbDir && basename(path).startsWith('epoch-') && subject.existsSync(path)) {
              const backup = join(dbDir, `.crash-backup-${backupSequence++}`);
              subject.renameSync(path, backup);
              backups.set(path, backup);
              return;
            }
            subject.rmSync(path, rmOptions);
          };
        }
        if (property === 'syncDirectoryDurableSync') {
          return (path: string): boolean => {
            const synced = subject.syncDirectoryDurableSync(path);
            if (path === dbDir && synced) {
              for (const backup of backups.values()) subject.rmSync(backup, { recursive: true, force: true });
              backups.clear();
            }
            return synced;
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    for (const incompatible of ['1', '3', '5']) {
      publishAdversarialEpoch(join(dbDir, `epoch-${incompatible}`));
      const settled = settleStoreEpoch(withStorage(runtime, storage), options());
      settled.db.close();
      expect(sweepStoreEpochs(withStorage(runtime, storage), dbDir, settled.epoch)).toBe('complete');

      for (const [original, backup] of backups) renameSync(backup, original);
      backups.clear();
    }

    expect(listStoreEpochs(runtime, storeFormat).filter(({ role }) => role === 'garbage')).toEqual([]);
    console.log('post-publication-sweep-power-loss-cell repetitions=3 accumulated-garbage=0');
  });
});
