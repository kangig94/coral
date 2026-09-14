import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  discardCurrentStoreEpoch,
  epochPath,
  listStoreEpochs,
  resolveCurrentStoreEpoch,
  settleStoreEpoch,
  STORE_EPOCH_METADATA_FILE_NAME,
} from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('write-once store epochs', () => {
  it('leaves epoch zero untouched for a v0.10.9-shaped reader after a newer epoch exists', () => {
    const runtime = harness();
    const flatPath = epochPath(runtime.paths.coral.store.dbDir, 0);
    createCompatibleStore(flatPath, 'v0.10.9-data');

    const discarded = discardCurrentStoreEpoch(runtime, options());
    discarded.db.close();

    const oldReader = new DatabaseSync(flatPath, { readOnly: true });
    const row = oldReader.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };
    oldReader.close();
    expect(row.value).toBe('v0.10.9-data');
    expect(resolveCurrentStoreEpoch(runtime.storage, runtime.paths.coral.store.dbDir)).toBe(1);
  });

  it('adopts the winner when two publishers mint the same next epoch', () => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 0));
    let collisionInjected = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (collisionInjected || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-'))
        return;
      collisionInjected = true;
      publishAdversarialEpoch(destination, true);
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe(1);
    settled.db.close();
    expect(collisionInjected).toBe(true);
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
  });

  it('re-mints when another process sweeps its private mint', () => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 0));
    let swept = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (swept || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-')) return;
      swept = true;
      rmSync(source, { recursive: true, force: true });
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe(1);
    settled.db.close();
    expect(swept).toBe(true);
  });

  it.each([1, 2, 3, 5])('converges after %i adversarial publications to one non-garbage pair', (count) => {
    const runtime = harness();
    createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 0));
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
      [count + 1, 'current'],
      [count, 'preserved'],
    ]);
    expect(rows.filter((row) => row.role === 'garbage')).toEqual([]);
  });

  it.each(['empty-mint', 'opened-mint', 'described-mint', 'published-epoch'])(
    'boots after process death seeded at %s',
    (cut) => {
      const runtime = harness();
      createIncompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 0));
      const mint = join(runtime.paths.coral.store.dbDir, '.mint-dead-process');
      if (cut !== 'published-epoch') mkdirSync(mint, { recursive: true });
      if (cut === 'opened-mint' || cut === 'described-mint') createCompatibleStore(join(mint, 'store.db'), cut);
      if (cut === 'described-mint') writeFileSync(join(mint, STORE_EPOCH_METADATA_FILE_NAME), '{}');
      if (cut === 'published-epoch') publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'));

      const settled = settleStoreEpoch(runtime, options());

      settled.db.close();
      expect(readdirSync(runtime.paths.coral.store.dbDir).some((name) => name.startsWith('.mint-'))).toBe(false);
    },
  );

  it('boots when sweeping a garbage epoch fails', () => {
    const runtime = harness();
    createCompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 2), 'current');
    createCompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 1), 'preserved');
    createCompatibleStore(epochPath(runtime.paths.coral.store.dbDir, 0), 'garbage');
    const garbagePath = epochPath(runtime.paths.coral.store.dbDir, 0);
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

    expect(settled.epoch).toBe(2);
    settled.db.close();
    expect(existsSync(epochPath(runtime.paths.coral.store.dbDir, 0))).toBe(true);
  });
});
