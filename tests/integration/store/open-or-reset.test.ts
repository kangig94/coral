import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import {
  existsSync,
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
  STORE_EPOCH_METADATA_FILE_NAME,
} from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { releaseStoreReset } from '#src/store/operator-store-reset.js';
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

function publishLiveCoordinator(runtime: Runtime, pid: number): void {
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
        const external = `${path}-external`;
        mkdirSync(external);
        writeFileSync(join(external, 'sentinel'), 'external');
        symlinkSync(external, path);
      },
    ],
  ])('publishes over a disproven successor blocked by a %s', (_description, block) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createIncompatibleStore(epochPath(dbDir, '0'));
    const successor = join(dbDir, 'epoch-1');
    block(successor);

    const settled = settleStoreEpoch(runtime, options());

    expect(settled.epoch).toBe('1');
    settled.db.close();
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    if (_description === 'symlink') expect(existsSync(`${successor}-external/sentinel`)).toBe(true);
    console.log(`successor-blocker-cell kind=${_description} selected=epoch-1`);
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

  it.each(['EACCES', 'EIO'])(
    'does not delete the open current epoch when its sweep observation gets transient %s',
    (code) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      createCompatibleStore(epochPath(dbDir, '0'), 'flat');
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
      const metadataPath = join(dbDir, 'epoch-1', STORE_EPOCH_METADATA_FILE_NAME);
      let reads = 0;
      const storage = new Proxy(runtime.storage, {
        get(subject, property, receiver) {
          if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
          return (path: string, encoding: 'utf-8'): string => {
            if (path === metadataPath && (reads += 1) === 3) {
              throw Object.assign(new Error(`injected sweep ${code}`), { code });
            }
            return subject.readFileSync(path, encoding);
          };
        },
      });

      const settled = settleStoreEpoch(withStorage(runtime, storage), options());

      expect(settled.epoch).toBe('1');
      settled.db.close();
      expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
      console.log(`unobservable-metadata-cell phase=sweep code=${code} removed=false`);
    },
  );

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

  it('does not open a substitute swapped under an explicit proven database path', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const fixtureDirectory = join(dbDir, 'fixture');
    const displacedDirectory = join(dbDir, 'fixture-original');
    const substituteDirectory = join(dbDir, '..', 'fixture-substitute');
    const fixturePath = join(fixtureDirectory, 'store.db');
    const substitutePath = join(substituteDirectory, 'store.db');
    createCompatibleStore(fixturePath, 'original');
    createCompatibleStore(substitutePath, 'substitute');
    let swapped = false;
    let restored = false;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'lstatSync') {
          return (path: string, statOptions?: { bigint: true }) => {
            const result = statOptions === undefined ? subject.lstatSync(path) : subject.lstatSync(path, statOptions);
            if (path === fixturePath && statOptions?.bigint === true && !swapped) {
              swapped = true;
              renameSync(fixtureDirectory, displacedDirectory);
              symlinkSync(substituteDirectory, fixtureDirectory);
            }
            return result;
          };
        }
        if (property === 'fstatSync') {
          return (descriptor: number, statOptions: { bigint: true }) => {
            const result = subject.fstatSync(descriptor, statOptions);
            if (swapped && !restored) {
              restored = true;
              rmSync(fixtureDirectory);
              renameSync(displacedDirectory, fixtureDirectory);
            }
            return result;
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    expect(() => openWritableStoreDbNoReset(withStorage(runtime, storage), { path: fixturePath, storeFormat })).toThrow(
      'No Coral store exists yet',
    );

    const substitute = new DatabaseSync(substitutePath, { readOnly: true });
    const values = substitute.prepare('SELECT value FROM rollback_sentinel').all() as { value: string }[];
    substitute.close();
    expect(values.map(({ value }) => value)).toEqual(['substitute']);
    expect({ swapped, restored }).toEqual({ swapped: true, restored: true });
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

  it('closes a displaced compatible epoch and adopts the newly proven current epoch', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'displaced');
    let reads = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readdirSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): string[] => {
          reads += 1;
          if (path === dbDir && reads === 2) publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
          return subject.readdirSync(path);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    const row = settled.db.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };

    expect(settled.epoch).toBe('1');
    expect(row.value).toBe('concurrent-winner');
    settled.db.close();
  });

  it('binds a proven epoch to its object when its directory is swapped before open and restored', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const published = join(dbDir, 'epoch-1');
    const displaced = join(dbDir, 'epoch-1-displaced');
    const substitute = join(dbDir, '..', 'epoch-1-substitute');
    publishAdversarialEpoch(published, true);
    publishAdversarialEpoch(substitute, true);
    const provenDatabasePath = join(published, 'store.db');
    let swapped = false;
    let restored = false;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'lstatSync') {
          return (path: string, statOptions?: { bigint: true }) => {
            const result = statOptions === undefined ? subject.lstatSync(path) : subject.lstatSync(path, statOptions);
            if (path === provenDatabasePath && statOptions?.bigint === true && !swapped) {
              swapped = true;
              renameSync(published, displaced);
              symlinkSync(substitute, published);
            }
            return result;
          };
        }
        if (property === 'readdirSync') {
          return (path: string): string[] => {
            if (path === dbDir && swapped && !restored) {
              restored = true;
              rmSync(published);
              renameSync(displaced, published);
            }
            return subject.readdirSync(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    settled.db.exec("INSERT INTO rollback_sentinel (value) VALUES ('settled-write')");
    settled.db.close();

    const originalDb = new DatabaseSync(epochPath(dbDir, '1'), { readOnly: true });
    const originalValues = originalDb.prepare('SELECT value FROM rollback_sentinel ORDER BY rowid').all() as {
      value: string;
    }[];
    originalDb.close();
    const substituteDb = new DatabaseSync(epochPath(substitute, '0'), { readOnly: true });
    const substituteValues = substituteDb.prepare('SELECT value FROM rollback_sentinel ORDER BY rowid').all() as {
      value: string;
    }[];
    substituteDb.close();
    expect(originalValues.map(({ value }) => value)).toEqual(['concurrent-winner', 'settled-write']);
    expect(substituteValues.map(({ value }) => value)).toEqual(['concurrent-winner']);
    console.log('proof-binding-cell swapped=true restored=true substitute-write=false');
  });

  it('reports an anomaly when another process removes its private mint', () => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'));
    let swept = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (swept || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-')) return;
      swept = true;
      rmSync(source, { recursive: true, force: true });
    });

    expect(() => settleStoreEpoch(withStorage(runtime, storage), options())).toThrow(
      'Store epoch settlement made no progress beyond epoch 0.',
    );
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
    const rows = listStoreEpochs(runtime, storeFormat);

    expect(rows.filter((row) => row.role !== 'garbage').map((row) => [row.epoch, row.role])).toEqual([
      [String(count + 1), 'current'],
      [String(count), 'preserved'],
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

      expect(released.kind).toBe('release-unproven');
      expect(existsSync(flatPath)).toBe(true);
    });
  });

  it('re-reads current before a stale release can delete a concurrently published epoch', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishLiveCoordinator(runtime, 999_999_991);
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
    publishLiveCoordinator(runtime, 999_999_991);
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

      expect(released.kind).toBe('release-unproven');
      expect(existsSync(epochPath(dbDir, '2'))).toBe(true);
      console.log(`unobservable-metadata-cell phase=release code=${code} removed=false`);
    },
  );

  it('reports release as unproven when the deletion parent cannot be synced', async () => {
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

    expect(released.kind).toBe('release-unproven');
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
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

  it('does not release an old epoch whose database is held by a live foreign coordinator', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(epochPath(dbDir, '0'), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const oldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(oldPath, async (pid) => {
      publishLiveCoordinator(runtime, pid);
      const released = await releaseStoreReset({ target: 'gen2', runtime, epoch: '1' });

      expect(released.kind).toBe('release-unproven');
      expect(existsSync(oldPath)).toBe(true);
      console.log('live-descriptor-release-cell target=epoch-1/store.db current=3 descriptor=live removed=false');
    });
  });

  it('boots when sweeping a garbage epoch fails', () => {
    const runtime = harness();
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-2'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'), true);
    createCompatibleStore(epochPath(runtime.paths.coral.store.dbDir, '0'), 'garbage');
    const garbagePath = epochPath(runtime.paths.coral.store.dbDir, '0');
    const storage = new Proxy(runtime.storage, {
      get(target, property, receiver) {
        if (property !== 'unlinkSync') return Reflect.get(target, property, receiver) as unknown;
        return (path: string): void => {
          if (path === garbagePath) throw Object.assign(new Error('injected sweep failure'), { code: 'EIO' });
          target.unlinkSync(path);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('2');
    settled.db.close();
    expect(existsSync(epochPath(runtime.paths.coral.store.dbDir, '0'))).toBe(true);
  });

  it('syncs the epoch root after boot-sweep removals', () => {
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

    let lastRemoval = -1;
    let lastRootSync = -1;
    events.forEach((event, index) => {
      if (event.startsWith('remove:')) lastRemoval = index;
      if (event === `sync:${dbDir}`) lastRootSync = index;
    });
    expect(lastRemoval).toBeGreaterThanOrEqual(0);
    expect(lastRootSync).toBeGreaterThan(lastRemoval);
    console.log('boot-sweep-durability-cell removals=1 parent-sync=after');
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

      for (const [original, backup] of backups) renameSync(backup, original);
      backups.clear();
    }

    expect(listStoreEpochs(runtime, storeFormat).filter(({ role }) => role === 'garbage')).toEqual([]);
    console.log('boot-sweep-power-loss-cell repetitions=3 accumulated-garbage=0');
  });
});
