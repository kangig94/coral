import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';

import { validateProductVersion } from '#src/infra/product-version.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { classifyStoreFile, openStoreDatabase } from '#src/store/db.js';
import type { StoreFormatDescription, StoreFormatFingerprint } from '#src/store/format-fingerprint.js';
import { totalChanges } from '#tests/helpers/test-db.js';

const CURRENT_FINGERPRINT = currentCoralStoreFormat().fingerprint;
const OTHER_FINGERPRINT: StoreFormatFingerprint = `sha256:${'0'.repeat(64)}`;

type MetadataValue = string | number | Buffer | null;
type StoredMetadata = {
  readonly fingerprint?: MetadataValue;
  readonly productVersion?: MetadataValue;
};

const tempRoots: string[] = [];

function tempPath(name: string): { readonly root: string; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-format-classification-'));
  tempRoots.push(root);
  return { root, dbPath: join(root, name) };
}

function format(
  productVersion: string,
  fingerprint: StoreFormatFingerprint = CURRENT_FINGERPRINT,
): StoreFormatDescription {
  return { ...currentCoralStoreFormat(), fingerprint, productVersion };
}

function createStore(dbPath: string, metadata: StoredMetadata): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value);
      CREATE TABLE sentinel (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel (id) VALUES (1);
    `);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    if ('fingerprint' in metadata) insert.run('store_format_fingerprint', metadata.fingerprint ?? null);
    if ('productVersion' in metadata) insert.run('store_product_version', metadata.productVersion ?? null);
  } finally {
    db.close();
  }
}

function classify(dbPath: string, current: StoreFormatDescription) {
  const storage = createRealRuntime('prod', { baseDir: join(dbPath, '..', 'runtime') }).storage;
  return classifyStoreFile(dbPath, storage, current);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readStoredProductVersion(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'store_product_version'").get()?.value;
  } finally {
    db.close();
  }
}

const NEWER_STAMP_WORKER_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const state = workerData.state;
const db = new DatabaseSync(workerData.dbPath);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  const observed = db.prepare("SELECT value FROM meta WHERE key = 'store_product_version'").get().value;
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  Atomics.wait(state, 0, 1, 250);

  try {
    db.prepare("UPDATE meta SET value = '1.2.0' WHERE key = 'store_product_version'").run();
    db.exec('COMMIT');
    Atomics.store(state, 0, 2);
    Atomics.notify(state, 0);
    parentPort.postMessage({ observed });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
} finally {
  db.close();
}
`;

function workerResult(worker: Worker): Promise<{ readonly observed: string }> {
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`High-water stamp worker exited with code ${code}.`));
    });
  });
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('store format classification', () => {
  it('supplies a validated product version with the current store format', () => {
    const current = currentCoralStoreFormat();

    expect(validateProductVersion(current.productVersion)).toBe(current.productVersion);
  });

  it('classifies an absent database without creating it', () => {
    const { dbPath } = tempPath('absent.db');

    expect(classify(dbPath, format('1.0.0'))).toEqual({ kind: 'absent' });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('classifies a database with no user tables as fresh', () => {
    const { dbPath } = tempPath('fresh.db');
    new DatabaseSync(dbPath).close();

    expect(classify(dbPath, format('1.0.0'))).toEqual({ kind: 'fresh' });
  });

  it('leaves a fresh database byte-identical when a read-only opener refuses it', () => {
    const { root, dbPath } = tempPath('readonly-fresh.db');
    new DatabaseSync(dbPath).close();
    const before = sha256File(dbPath);
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    expect(() => openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.0.0'), readonly: true })).toThrow();
    expect(sha256File(dbPath)).toBe(before);
  });

  it('classifies an equal fingerprint with a lower or equal SemVer as compatible', () => {
    const lower = tempPath('lower.db').dbPath;
    const equal = tempPath('equal.db').dbPath;
    createStore(lower, { fingerprint: CURRENT_FINGERPRINT, productVersion: '0.9.16' });
    createStore(equal, { fingerprint: CURRENT_FINGERPRINT, productVersion: '0.10.0' });

    expect(classify(lower, format('0.10.0'))).toMatchObject({
      kind: 'compatible',
      storedProductVersion: '0.9.16',
    });
    expect(classify(equal, format('0.10.0'))).toMatchObject({
      kind: 'compatible',
      storedProductVersion: '0.10.0',
    });
  });

  it('classifies an equal valid fingerprint with no version row as legacy-adoptable', () => {
    const { dbPath } = tempPath('legacy-adoptable.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT });

    expect(classify(dbPath, format('1.0.0'))).toEqual({
      kind: 'legacy-adoptable',
      currentFingerprint: CURRENT_FINGERPRINT,
      currentProductVersion: '1.0.0',
      storedFingerprint: CURRENT_FINGERPRINT,
    });
  });

  it('uses SemVer precedence for older and prerelease stores', () => {
    const older = tempPath('older.db').dbPath;
    const prerelease = tempPath('prerelease.db').dbPath;
    createStore(older, { fingerprint: OTHER_FINGERPRINT, productVersion: '0.9.16' });
    createStore(prerelease, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0-rc.1' });

    expect(classify(older, format('0.10.0'))).toMatchObject({
      kind: 'older-incompatible',
      storedProductVersion: '0.9.16',
    });
    expect(classify(prerelease, format('1.0.0'))).toMatchObject({
      kind: 'compatible',
      storedProductVersion: '1.0.0-rc.1',
    });
  });

  it('classifies a newer SemVer as newer-incompatible regardless of fingerprint equality', () => {
    const equalFingerprint = tempPath('newer-equal.db').dbPath;
    const differentFingerprint = tempPath('newer-different.db').dbPath;
    createStore(equalFingerprint, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.1.0' });
    createStore(differentFingerprint, { fingerprint: OTHER_FINGERPRINT, productVersion: '1.1.0' });

    expect(classify(equalFingerprint, format('1.0.0'))).toMatchObject({ kind: 'newer-incompatible' });
    expect(classify(differentFingerprint, format('1.0.0'))).toMatchObject({ kind: 'newer-incompatible' });
  });

  it('treats build metadata as equal SemVer precedence', () => {
    const { dbPath } = tempPath('build-metadata.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.2.3+stored' });

    expect(classify(dbPath, format('1.2.3+current'))).toMatchObject({
      kind: 'compatible',
      storedProductVersion: '1.2.3+stored',
    });
  });

  it('classifies equal SemVer with a different fingerprint as corrupt-or-unsupported', () => {
    const { dbPath } = tempPath('equal-version-different-fingerprint.db');
    createStore(dbPath, { fingerprint: OTHER_FINGERPRINT, productVersion: '1.0.0' });

    expect(classify(dbPath, format('1.0.0'))).toMatchObject({ kind: 'corrupt-or-unsupported' });
  });

  it.each([
    ['missing fingerprint', { productVersion: '1.0.0' }],
    ['malformed fingerprint', { fingerprint: 'sha256:not-a-digest', productVersion: '1.0.0' }],
    ['unsupported fingerprint value', { fingerprint: Buffer.from('digest'), productVersion: '1.0.0' }],
    ['missing version with a non-current fingerprint', { fingerprint: OTHER_FINGERPRINT }],
    ['malformed version', { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0' }],
    ['unsupported version value', { fingerprint: CURRENT_FINGERPRINT, productVersion: Buffer.from('1.0.0') }],
  ] satisfies ReadonlyArray<readonly [string, StoredMetadata]>)(
    'classifies %s as corrupt-or-unsupported',
    (_, metadata) => {
      const { dbPath } = tempPath('corrupt-or-unsupported.db');
      createStore(dbPath, metadata);

      expect(classify(dbPath, format('1.0.0'))).toMatchObject({ kind: 'corrupt-or-unsupported' });
    },
  );

  it('rejects a product version that is not valid SemVer', () => {
    const { dbPath } = tempPath('invalid-version.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '2026.08.01' });

    expect(validateProductVersion('2026.08.01')).toBeNull();
    expect(classify(dbPath, format('1.0.0'))).toMatchObject({ kind: 'corrupt-or-unsupported' });
  });

  it.each([
    ['older-incompatible', { fingerprint: OTHER_FINGERPRINT, productVersion: '0.9.16' }, '0.10.0'],
    ['newer-incompatible', { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.1.0' }, '1.0.0'],
    ['equal version with different fingerprint', { fingerprint: OTHER_FINGERPRINT, productVersion: '1.0.0' }, '1.0.0'],
    ['missing fingerprint', { productVersion: '1.0.0' }, '1.0.0'],
    ['malformed fingerprint', { fingerprint: 'invalid', productVersion: '1.0.0' }, '1.0.0'],
    ['unsupported fingerprint', { fingerprint: Buffer.from('invalid'), productVersion: '1.0.0' }, '1.0.0'],
    ['missing version', { fingerprint: OTHER_FINGERPRINT }, '1.0.0'],
    ['malformed version', { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0' }, '1.0.0'],
    ['unsupported version', { fingerprint: CURRENT_FINGERPRINT, productVersion: Buffer.from('1.0.0') }, '1.0.0'],
  ] satisfies ReadonlyArray<readonly [string, StoredMetadata, string]>)(
    'leaves store.db byte-identical when refusing %s',
    (_, metadata, currentVersion) => {
      const { root, dbPath } = tempPath('refusal.db');
      createStore(dbPath, metadata);
      const before = sha256File(dbPath);
      const current = format(currentVersion);
      const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

      expect(() => openStoreDatabase({ path: dbPath, storage, storeFormat: current })).toThrow();
      expect(sha256File(dbPath)).toBe(before);
      expect(() => openStoreDatabase({ path: dbPath, storage, storeFormat: current, readonly: true })).toThrow();
      expect(sha256File(dbPath)).toBe(before);
    },
  );

  it('stamps fingerprint and product version rows when initializing a fresh store', () => {
    const { root, dbPath } = tempPath('initialized.db');
    const current = format('1.2.3');
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    const db = openStoreDatabase({ path: dbPath, storage, storeFormat: current });
    db.close();

    const stored = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = stored
        .prepare('SELECT key, value FROM meta WHERE key IN (?, ?) ORDER BY key')
        .all('store_format_fingerprint', 'store_product_version');
      expect(rows).toEqual([
        { key: 'store_format_fingerprint', value: CURRENT_FINGERPRINT },
        { key: 'store_product_version', value: '1.2.3' },
      ]);
    } finally {
      stored.close();
    }
    expect(classify(dbPath, current)).toMatchObject({ kind: 'compatible' });
  });

  it('does not lower the product version when an older build opens a newer store', () => {
    const { root, dbPath } = tempPath('newer-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.2.0' });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    expect(() => openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0') })).toThrow();
    expect(readStoredProductVersion(dbPath)).toBe('1.2.0');
  });

  it('raises the product version when a newer build opens an older compatible store', () => {
    const { root, dbPath } = tempPath('older-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0' });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0') }).close();

    expect(readStoredProductVersion(dbPath)).toBe('1.1.0');
  });

  it('retains the stored string and performs no write at equal SemVer precedence', () => {
    const { root, dbPath } = tempPath('equal-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0+stored' });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    const db = openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.0.0+current') });
    try {
      expect(totalChanges(db)).toBe(0);
    } finally {
      db.close();
    }
    expect(readStoredProductVersion(dbPath)).toBe('1.0.0+stored');
  });

  it('does not stamp an absent product version during an ordinary open', () => {
    const { root, dbPath } = tempPath('legacy-adoptable-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0') }).close();

    expect(readStoredProductVersion(dbPath)).toBeUndefined();
  });

  it('serializes two real connections so an interleaved newer stamp remains the maximum', async () => {
    const { root, dbPath } = tempPath('interleaved-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0' });
    const walSetup = new DatabaseSync(dbPath);
    walSetup.exec('PRAGMA journal_mode = WAL');
    walSetup.close();
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;
    const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const newerWorker = new Worker(NEWER_STAMP_WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, state },
    });
    const newerResult = workerResult(newerWorker);

    try {
      expect(Atomics.wait(state, 0, 0, 5_000)).not.toBe('timed-out');
      expect(Atomics.load(state, 0)).toBe(1);

      openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0') }).close();

      expect(Atomics.load(state, 0)).toBe(2);
      expect(await newerResult).toEqual({ observed: '1.0.0' });
      expect(readStoredProductVersion(dbPath)).toBe('1.2.0');
    } finally {
      await newerWorker.terminate();
    }
  });

  it('never raises the product version during a read-only open', () => {
    const { root, dbPath } = tempPath('readonly-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0' });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    openStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0'), readonly: true }).close();

    expect(readStoredProductVersion(dbPath)).toBe('1.0.0');
  });
});
