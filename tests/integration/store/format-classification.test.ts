import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { classifyStoreFile } from '#src/store/db.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import type { StoreFormatDescription, StoreFormatFingerprint } from '#src/store/format-fingerprint.js';

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

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('store format classification', () => {
  it('leaves a fresh database byte-identical when a read-only opener refuses it', () => {
    const { root, dbPath } = tempPath('readonly-fresh.db');
    new DatabaseSync(dbPath).close();
    const before = sha256File(dbPath);
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    expect(() =>
      openTestStoreDatabase({ path: dbPath, storage, storeFormat: format('1.0.0'), readonly: true }),
    ).toThrow();
    expect(sha256File(dbPath)).toBe(before);
  });

  it('classifies an equal fingerprint with a lower SemVer as compatible', () => {
    const lower = tempPath('lower.db').dbPath;
    createStore(lower, { fingerprint: CURRENT_FINGERPRINT, productVersion: '0.9.16' });

    expect(classify(lower, format('0.10.0'))).toMatchObject({
      kind: 'compatible',
      storedProductVersion: '0.9.16',
    });
  });

  it('classifies an equal valid fingerprint with no version row as unsupported', () => {
    const { dbPath } = tempPath('missing-version.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT });

    expect(classify(dbPath, format('1.0.0'))).toEqual({
      kind: 'corrupt-or-unsupported',
      currentFingerprint: CURRENT_FINGERPRINT,
      currentProductVersion: '1.0.0',
      storedFingerprint: CURRENT_FINGERPRINT,
      storedProductVersion: null,
      storedProductVersionState: 'absent',
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

  it('classifies equal SemVer with a different fingerprint as corrupt-or-unsupported', () => {
    const { dbPath } = tempPath('equal-version-different-fingerprint.db');
    createStore(dbPath, { fingerprint: OTHER_FINGERPRINT, productVersion: '1.0.0' });

    expect(classify(dbPath, format('1.0.0'))).toMatchObject({ kind: 'corrupt-or-unsupported' });
  });

  it('stamps fingerprint and product version rows when initializing a fresh store', () => {
    const { root, dbPath } = tempPath('initialized.db');
    const current = format('1.2.3');
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    const db = openTestStoreDatabase({ path: dbPath, storage, storeFormat: current });
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

    expect(() => openTestStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0') })).toThrow();
    expect(readStoredProductVersion(dbPath)).toBe('1.2.0');
  });

  it('raises the product version when a newer build opens an older compatible store', () => {
    const { root, dbPath } = tempPath('older-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0' });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    openTestStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0') }).close();

    expect(readStoredProductVersion(dbPath)).toBe('1.1.0');
  });

  it('never raises the product version during a read-only open', () => {
    const { root, dbPath } = tempPath('readonly-high-water.db');
    createStore(dbPath, { fingerprint: CURRENT_FINGERPRINT, productVersion: '1.0.0' });
    const storage = createRealRuntime('prod', { baseDir: join(root, 'runtime') }).storage;

    openTestStoreDatabase({ path: dbPath, storage, storeFormat: format('1.1.0'), readonly: true }).close();

    expect(readStoredProductVersion(dbPath)).toBe('1.0.0');
  });
});
