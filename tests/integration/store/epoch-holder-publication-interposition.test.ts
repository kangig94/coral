import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';

import type * as NodeFs from 'node:fs';

const publicationRace = vi.hoisted(() => ({
  armed: false,
  baseDir: null as string | null,
  fixturePath: null as string | null,
  lostHolderPath: null as string | null,
  sweepResult: null as string | null,
  sweepStatus: null as number | null,
  sweepStderr: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const { spawnSync } = await import('node:child_process');
  return {
    ...actual,
    renameSync: (source: string, destination: string): void => {
      if (
        publicationRace.armed &&
        publicationRace.baseDir !== null &&
        publicationRace.fixturePath !== null &&
        basename(destination).startsWith('.epoch-holder-') &&
        destination.endsWith('.json') &&
        source.startsWith(destination)
      ) {
        publicationRace.armed = false;
        publicationRace.lostHolderPath = destination;
        const sweep = spawnSync(process.execPath, [publicationRace.fixturePath, publicationRace.baseDir, '1'], {
          cwd: process.cwd(),
          encoding: 'utf-8',
        });
        publicationRace.sweepStatus = sweep.status;
        publicationRace.sweepResult = sweep.stdout.trim();
        publicationRace.sweepStderr = sweep.stderr;
      }
      actual.renameSync(source, destination);
    },
  };
});

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { settleStoreEpoch } from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const buildManifest: StrictBundleManifest = {
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
  publicationRace.armed = false;
  publicationRace.baseDir = null;
  publicationRace.fixturePath = null;
  publicationRace.lostHolderPath = null;
  publicationRace.sweepResult = null;
  publicationRace.sweepStatus = null;
  publicationRace.sweepStderr = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('settles when a sweep unlinks the first holder publication', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-holder-publication-sweep-'));
  roots.push(baseDir);
  const fixturePath = join(baseDir, 'store-epoch-post-ready-sweep.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../../fixtures/store-epoch-post-ready-sweep.ts', import.meta.url))],
    outfile: fixturePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    loader: { '.sql': 'text' },
    define: { __VERSION__: JSON.stringify(storeFormat.productVersion) },
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const runtime = createRealRuntime('prod', { baseDir });
  publicationRace.baseDir = baseDir;
  publicationRace.fixturePath = fixturePath;
  publicationRace.armed = true;

  const settled = settleStoreEpoch(runtime, { storeFormat, build: buildManifest });

  expect(publicationRace.sweepStatus, publicationRace.sweepStderr).toBe(0);
  expect(publicationRace.sweepResult).toBe('complete');
  expect(publicationRace.lostHolderPath).not.toBeNull();
  expect(existsSync(publicationRace.lostHolderPath as string)).toBe(false);
  const holders = readdirSync(settled.store.storeRoot).filter(
    (entry) => entry.startsWith('.epoch-holder-') && entry.endsWith('.json'),
  );
  expect(holders).toHaveLength(1);
  expect(join(settled.store.storeRoot, holders[0])).not.toBe(publicationRace.lostHolderPath);
  expect(settled.store.epoch).toBe('1');
  settled.db.close();
});
