import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import type { Runtime } from '#src/runtime/ports.js';
import {
  STORE_EPOCH_METADATA_FILE_NAME,
  STORE_EPOCH_OPEN_RETRY_BUDGET_MS,
  STORE_EPOCH_OPEN_RETRY_INTERVAL_MS,
  epochDirectory,
  settleStoreEpoch,
} from '#src/store/epoch.js';
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
  vi.restoreAllMocks();
});

function withVirtualRetryClock(runtime: Runtime): { runtime: Runtime; sleptMs: () => number } {
  let now = 0;
  let slept = 0;
  vi.spyOn(Atomics, 'wait').mockImplementation(((_view, _index, _value, timeout) => {
    const duration = timeout ?? 0;
    now += duration;
    slept += duration;
    return 'timed-out';
  }) as typeof Atomics.wait);
  return {
    runtime: { ...runtime, time: { ...runtime.time, monotonicNow: () => BigInt(now) } },
    sleptMs: () => slept,
  };
}

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

it('retries a transient holder publication failure without replacing the current epoch', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-holder-publication-failure-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  const initial = settleStoreEpoch(runtime, { storeFormat, build: buildManifest });
  initial.db
    .prepare(
      `INSERT INTO projection_jobs (
         job_id, execution_owner, phase, diagnostics, session_id, provider,
         project_root, work_dir, backend_namespace, job_kind, created_at, last_seq
       ) VALUES (?, ?, 'running', '{"progressFaults":[]}', ?, 'codex', ?, ?, 'tests', 'provider', ?, 0)`,
    )
    .run(
      'job-survives-holder-retry',
      JSON.stringify({ kind: 'provider-session', id: 'session-survives-holder-retry' }),
      'session-survives-holder-retry',
      '/workspace',
      '/workspace',
      '2026-09-23T00:00:00.000Z',
    );
  initial.db.close();
  const clock = withVirtualRetryClock(runtime);
  let failedWrites = 0;
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'writeAtomicDurableSync') {
        return (...args: Parameters<Runtime['storage']['writeAtomicDurableSync']>): boolean => {
          const [path, content] = args;
          if (
            failedWrites < 2 &&
            basename(path).startsWith('.epoch-holder-') &&
            typeof content === 'string' &&
            content.includes('"epoch":"1"')
          ) {
            failedWrites += 1;
            return false;
          }
          return subject.writeAtomicDurableSync(...args);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build: buildManifest });

  expect(failedWrites).toBe(2);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expect(settled.store.epoch).toBe('1');
  expect(
    settled.db.prepare('SELECT phase FROM projection_jobs WHERE job_id = ?').get('job-survives-holder-retry'),
  ).toEqual({ phase: 'running' });
  settled.db.close();
});

it('records a placeholder cause when a holder failure cannot be inspected', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-holder-uninspectable-failure-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  const initial = settleStoreEpoch(runtime, { storeFormat, build: buildManifest });
  initial.db.close();
  const clock = withVirtualRetryClock(runtime);
  const hostileError = new Error('hidden');
  Object.defineProperty(hostileError, 'message', {
    configurable: true,
    get() {
      throw new Error('cause serialization exploded');
    },
  });
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'writeAtomicDurableSync') {
        return (...args: Parameters<Runtime['storage']['writeAtomicDurableSync']>): boolean => {
          const [path, content] = args;
          if (
            basename(path).startsWith('.epoch-holder-') &&
            typeof content === 'string' &&
            content.includes('"epoch":"1"')
          ) {
            throw hostileError;
          }
          return subject.writeAtomicDurableSync(...args);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build: buildManifest });
  const metadata = JSON.parse(
    readFileSync(join(epochDirectory(settled.store.storeRoot, '2'), STORE_EPOCH_METADATA_FILE_NAME), 'utf-8'),
  ) as { classification: unknown };

  expect(settled.store.epoch).toBe('2');
  expect(clock.sleptMs()).toBe(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  expect(metadata.classification).toEqual({
    kind: 'unavailable',
    stage: 'holder-registration',
    cause: {
      message: 'Store epoch failure cause is unavailable.',
      attempts: STORE_EPOCH_OPEN_RETRY_BUDGET_MS / STORE_EPOCH_OPEN_RETRY_INTERVAL_MS + 1,
    },
  });
  settled.db.close();
});
