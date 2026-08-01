import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openStoreDatabase } from '#src/store/db.js';

const CURRENT_FINGERPRINT = currentCoralStoreFormat().fingerprint;
const tempRoots: string[] = [];

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

function fixture(): { readonly root: string; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-format-interleaving-'));
  tempRoots.push(root);
  return { root, dbPath: join(root, 'store.db') };
}

function createStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value);
      CREATE TABLE sentinel (id INTEGER PRIMARY KEY);
      INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', '${CURRENT_FINGERPRINT}');
      INSERT INTO meta (key, value) VALUES ('store_product_version', '1.0.0');
    `);
    db.exec('PRAGMA journal_mode = WAL');
  } finally {
    db.close();
  }
}

function workerResult(worker: Worker): Promise<{ readonly observed: string }> {
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`High-water stamp worker exited with code ${code}.`));
    });
  });
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

describe('store format product-version interleaving', () => {
  it('serializes two real connections so an interleaved newer stamp remains the maximum', async () => {
    const { root, dbPath } = fixture();
    createStore(dbPath);
    const runtime = createRealRuntime('prod', { baseDir: join(root, 'runtime') });
    const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const newerWorker = new Worker(NEWER_STAMP_WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath, state },
    });
    const newerResult = workerResult(newerWorker);

    try {
      expect(Atomics.wait(state, 0, 0, 5_000)).not.toBe('timed-out');
      expect(Atomics.load(state, 0)).toBe(1);

      openStoreDatabase({
        path: dbPath,
        storage: runtime.storage,
        storeFormat: { ...currentCoralStoreFormat(), productVersion: '1.1.0' },
      }).close();

      expect(Atomics.load(state, 0)).toBe(2);
      expect(await newerResult).toEqual({ observed: '1.0.0' });
      expect(readStoredProductVersion(dbPath)).toBe('1.2.0');
    } finally {
      await newerWorker.terminate();
    }
  });
});
