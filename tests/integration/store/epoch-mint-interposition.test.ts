import { basename, dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, expect, it, vi } from 'vitest';

const interposition = vi.hoisted(() => ({ dbDir: null as string | null, lockOpenObserved: false, swept: false }));

vi.mock('#src/infra/fs-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/infra/fs-lock.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sqlite = await import('node:sqlite');
  return {
    ...actual,
    createSharedFileLockSync: (databasePath: string) => {
      const directory = path.dirname(databasePath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      interposition.lockOpenObserved = true;
      const name = path.basename(directory);
      if (
        interposition.dbDir !== null &&
        path.dirname(directory) === interposition.dbDir &&
        (name.startsWith('.mint-') || name.startsWith('.preparing-') || name.startsWith('.reaping-'))
      ) {
        interposition.swept = true;
        fs.rmSync(directory, { recursive: true, force: true });
      }
      const db = new sqlite.DatabaseSync(databasePath, { timeout: 5_000 });
      try {
        db.exec('PRAGMA busy_timeout = 5000; BEGIN; SELECT count(*) FROM sqlite_schema');
      } catch (error: unknown) {
        db.close();
        throw error;
      }
      return () => {
        try {
          db.exec('ROLLBACK');
        } finally {
          db.close();
        }
      };
    },
  };
});

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { settleStoreEpoch } from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

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

afterEach(() => {
  interposition.dbDir = null;
  interposition.lockOpenObserved = false;
  interposition.swept = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('does not expose a sweepable preparation directory before constructing its SQLite lock', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-mint-interposition-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  interposition.dbDir = runtime.paths.coral.store.dbDir;
  let epoch: string | null = null;
  let failure: unknown = null;

  try {
    const settled = settleStoreEpoch(runtime, { storeFormat, build });
    epoch = settled.epoch;
    settled.db.close();
  } catch (error: unknown) {
    failure = error;
  }

  console.log(
    `mint-construction-window-cell lock-open-observed=${interposition.lockOpenObserved} sweepable-before-lock=${interposition.swept} result=${failure === null ? `epoch-${epoch}` : basename(String(failure))}`,
  );
  expect(interposition.lockOpenObserved).toBe(true);
  expect(interposition.swept).toBe(false);
  expect(failure).toBeNull();
  expect(epoch).toBe('1');
});
