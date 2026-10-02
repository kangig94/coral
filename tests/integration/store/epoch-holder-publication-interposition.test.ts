import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { settleStoreEpoch } from '#src/store/epoch/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint } from '../../helpers/store-db.js';

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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function withVirtualRetryClock(runtime: Runtime): Runtime {
  let now = 0;
  vi.spyOn(Atomics, 'wait').mockImplementation(((_view, _index, _value, timeout) => {
    const duration = timeout ?? 0;
    now += duration;
    return 'timed-out';
  }) as typeof Atomics.wait);
  return { ...runtime, time: { ...runtime.time, monotonicNow: () => BigInt(now) } };
}

it('settles when the first holder publication disappears', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-holder-publication-sweep-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  let lostHolderPath: string | null = null;
  const storage = {
    ...runtime.storage,
    writeAtomicDurableSync: (...args: Parameters<Runtime['storage']['writeAtomicDurableSync']>): boolean => {
      const published = runtime.storage.writeAtomicDurableSync(...args);
      const [path] = args;
      if (published && lostHolderPath === null && basename(path).startsWith('.epoch-holder-')) {
        lostHolderPath = path;
        runtime.storage.unlinkSync(path);
        return false;
      }
      return published;
    },
  };
  const settled = settleStoreEpoch(
    { ...runtime, storage },
    {
      storeFormat,
      build: buildManifest,
      authorizeMint: authorizeFixtureStoreMint,
    },
  );
  try {
    expect(lostHolderPath).not.toBeNull();
    expect(existsSync(lostHolderPath!)).toBe(false);
    const holders = readdirSync(settled.store.storeRoot).filter(
      (entry) => entry.startsWith('.epoch-holder-') && entry.endsWith('.json'),
    );
    expect(holders).toHaveLength(1);
    expect(join(settled.store.storeRoot, holders[0])).not.toBe(lostHolderPath);
    expect(settled.store.epoch).toBe('1');
  } finally {
    settled.db.close();
  }
});

it('retries a transient holder publication failure without replacing the current epoch', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-holder-publication-failure-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  const initial = settleStoreEpoch(runtime, {
    storeFormat,
    build: buildManifest,
    authorizeMint: authorizeFixtureStoreMint,
  });
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

  const settled = settleStoreEpoch(
    { ...clock, storage },
    { storeFormat, build: buildManifest, authorizeMint: authorizeFixtureStoreMint },
  );

  expect(settled.store.epoch).toBe('1');
  expect(
    settled.db.prepare('SELECT phase FROM projection_jobs WHERE job_id = ?').get('job-survives-holder-retry'),
  ).toEqual({ phase: 'running' });
  settled.db.close();
});
