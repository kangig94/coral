import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

import { afterEach, expect, it, vi } from 'vitest';

import type * as DbMod from '#src/store/db.js';
import type * as FsLockMod from '#src/infra/fs-lock.js';
// @ts-expect-error -- JavaScript hook reader intentionally has no TypeScript declaration.
import { resolveCurrentStoreDbPath } from '../../../clients/hooks/lib/store-epoch.mjs';

const interposition = vi.hoisted(() => ({
  aggregateRetryElapsedMs: null as number | null,
  dbDir: null as string | null,
  failReadLockAttempts: 0,
  incompatibleOpen: false,
  lockOpenObserved: false,
  nullReadLockAttempts: 0,
  publishEpochTwoOnSweep: false,
  readLockBusyTimeouts: [] as Array<number | undefined>,
  rejectZeroEpochTwoReadLock: false,
  releaseFailure: false,
  sweepConstruction: false,
  swept: false,
  writableOpenFailures: 0,
  writableOpenAttempts: 0,
  writableOpenBusyTimeouts: [] as Array<number | undefined>,
  writableOpenErrcode: 5,
  epochTwoReadLockBusyTimeouts: [] as Array<number | undefined>,
}));

vi.mock('#src/infra/fs-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FsLockMod>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sqlite = await import('node:sqlite');
  return {
    ...actual,
    acquireSharedFileLockSync: (path: string, busyTimeoutMs?: number) => {
      if (path.endsWith('/epoch-1/.lock')) interposition.readLockBusyTimeouts.push(busyTimeoutMs);
      if (path.endsWith('/epoch-2/.lock')) {
        interposition.epochTwoReadLockBusyTimeouts.push(busyTimeoutMs);
        if (interposition.rejectZeroEpochTwoReadLock && busyTimeoutMs === 0) {
          throw Object.assign(new Error('injected zero-timeout read lock contention'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 5,
          });
        }
      }
      if (interposition.aggregateRetryElapsedMs !== null && path.endsWith('/epoch-1/.lock')) {
        interposition.aggregateRetryElapsedMs += Math.min(1_500, busyTimeoutMs ?? 0);
      }
      if (interposition.failReadLockAttempts > 0 && path.endsWith('/epoch-1/.lock')) {
        interposition.failReadLockAttempts -= 1;
        throw Object.assign(new Error('injected read lock failure'), { code: 'EIO' });
      }
      const release = actual.acquireSharedFileLockSync(path, busyTimeoutMs);
      if (interposition.nullReadLockAttempts > 0 && path.endsWith('/epoch-1/.lock')) {
        interposition.nullReadLockAttempts -= 1;
        release();
        return null;
      }
      if (!interposition.releaseFailure || !path.endsWith('/epoch-1/.lock')) return release;
      let injected = false;
      return () => {
        release();
        if (injected) return;
        injected = true;
        interposition.releaseFailure = false;
        throw new Error('injected lease release failure');
      };
    },
    createSharedFileLockSync: (databasePath: string) => {
      const directory = path.dirname(databasePath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      interposition.lockOpenObserved = true;
      const name = path.basename(directory);
      const publishEpochTwoOnSweep = interposition.publishEpochTwoOnSweep;
      if (
        publishEpochTwoOnSweep &&
        interposition.dbDir !== null &&
        path.dirname(directory) === interposition.dbDir &&
        name.startsWith('.coral-store-epoch-construction-')
      ) {
        interposition.publishEpochTwoOnSweep = false;
        fs.cpSync(path.join(interposition.dbDir, 'epoch-1'), path.join(interposition.dbDir, 'epoch-2'), {
          recursive: true,
        });
      }
      if (
        interposition.dbDir !== null &&
        path.dirname(directory) === interposition.dbDir &&
        (((interposition.sweepConstruction || publishEpochTwoOnSweep) &&
          name.startsWith('.coral-store-epoch-construction-')) ||
          name.startsWith('.mint-') ||
          name.startsWith('.preparing-') ||
          name.startsWith('.reaping-'))
      ) {
        interposition.sweepConstruction = false;
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

vi.mock('#src/store/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DbMod>();
  return {
    ...actual,
    openWritableStoreDatabase: (options: Parameters<typeof actual.openWritableStoreDatabase>[0]) => {
      const remainingDeadlineMs =
        options.busyTimeoutDeadline === undefined
          ? undefined
          : Math.max(0, Number(options.busyTimeoutDeadline.expiresAt - options.busyTimeoutDeadline.monotonicNow()));
      const busyTimeoutMs =
        remainingDeadlineMs === undefined
          ? options.busyTimeoutMs
          : Math.min(options.busyTimeoutMs ?? remainingDeadlineMs, remainingDeadlineMs);
      if (options.path.endsWith('/epoch-1/store.db')) {
        interposition.writableOpenAttempts += 1;
        interposition.writableOpenBusyTimeouts.push(busyTimeoutMs);
      }
      if (interposition.aggregateRetryElapsedMs !== null && options.path.endsWith('/epoch-1/store.db')) {
        interposition.aggregateRetryElapsedMs += Math.min(1_500, busyTimeoutMs ?? 0);
      }
      if (interposition.writableOpenFailures > 0 && options.path.endsWith('/epoch-1/store.db')) {
        interposition.writableOpenFailures -= 1;
        throw Object.assign(new Error('injected SQLite busy failure'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: interposition.writableOpenErrcode,
        });
      }
      const decision = actual.openWritableStoreDatabase(options);
      if (!interposition.incompatibleOpen || !options.path.endsWith('/epoch-1/store.db')) return decision;
      if (decision.kind === 'opened') decision.db.close();
      return {
        kind: 'incompatible' as const,
        classification: {
          kind: 'newer-incompatible' as const,
          currentFingerprint: options.storeFormat.fingerprint,
          currentProductVersion: options.storeFormat.productVersion,
          storedFingerprint: options.storeFormat.fingerprint,
          storedProductVersion: '99.0.0',
        },
      };
    },
  };
});

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { backendLog } from '#src/infra/backend-log.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  MAX_STORE_EPOCH_METADATA_BYTES,
  STORE_EPOCH_OPEN_RETRY_BUDGET_MS,
  STORE_EPOCH_OPEN_RETRY_INTERVAL_MS,
  STORE_EPOCH_METADATA_FILE_NAME,
  discardCurrentStoreEpoch,
  epochDirectory,
  parseStoreEpochMetadata,
  settleStoreEpoch,
} from '#src/store/epoch.js';
import { STORE_FORMAT_FINGERPRINT_META_KEY } from '#src/store/format-fingerprint.js';
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
  interposition.aggregateRetryElapsedMs = null;
  interposition.dbDir = null;
  interposition.failReadLockAttempts = 0;
  interposition.incompatibleOpen = false;
  interposition.lockOpenObserved = false;
  interposition.nullReadLockAttempts = 0;
  interposition.publishEpochTwoOnSweep = false;
  interposition.readLockBusyTimeouts = [];
  interposition.rejectZeroEpochTwoReadLock = false;
  interposition.releaseFailure = false;
  interposition.sweepConstruction = false;
  interposition.swept = false;
  interposition.writableOpenFailures = 0;
  interposition.writableOpenAttempts = 0;
  interposition.writableOpenBusyTimeouts = [];
  interposition.writableOpenErrcode = 5;
  interposition.epochTwoReadLockBusyTimeouts = [];
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(prefix = 'coral-epoch-open-cause-'): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function publishInitialEpoch(runtime: Runtime): void {
  const settled = settleStoreEpoch(runtime, { storeFormat, build });
  expect(settled.store.epoch).toBe('1');
  settled.db
    .prepare(
      `INSERT INTO projection_jobs (
         job_id, execution_owner, phase, diagnostics, session_id, provider,
         project_root, work_dir, backend_namespace, job_kind, created_at, last_seq
       ) VALUES (?, ?, 'running', '{"progressFaults":[]}', ?, 'codex', ?, ?, 'tests', 'provider', ?, 0)`,
    )
    .run(
      'job-survives-retry',
      JSON.stringify({ kind: 'provider-session', id: 'session-survives-retry' }),
      'session-survives-retry',
      '/workspace',
      '/workspace',
      '2026-09-23T00:00:00.000Z',
    );
  settled.db.close();
}

function expectInitialEpochAndJob(settled: ReturnType<typeof settleStoreEpoch>): void {
  expect(settled.store.epoch).toBe('1');
  expect(
    settled.db
      .prepare<[string], { phase: string }>('SELECT phase FROM projection_jobs WHERE job_id = ?')
      .get('job-survives-retry'),
  ).toEqual({ phase: 'running' });
}

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
    runtime: {
      ...runtime,
      time: {
        ...runtime.time,
        monotonicNow: () => BigInt(now),
      },
    },
    sleptMs: () => slept,
  };
}

function retryAttemptTimeouts(): number[] {
  return Array.from(
    { length: STORE_EPOCH_OPEN_RETRY_BUDGET_MS / STORE_EPOCH_OPEN_RETRY_INTERVAL_MS },
    (_, attempt) => STORE_EPOCH_OPEN_RETRY_BUDGET_MS - attempt * STORE_EPOCH_OPEN_RETRY_INTERVAL_MS,
  );
}

function currentEpochAttemptTimeouts(): number[] {
  return [...retryAttemptTimeouts(), STORE_EPOCH_OPEN_RETRY_BUDGET_MS];
}

function classification(runtime: Runtime, epoch: string): unknown {
  const metadata = JSON.parse(
    readFileSync(join(epochDirectory(runtime.paths.coral.store.dbDir, epoch), STORE_EPOCH_METADATA_FILE_NAME), 'utf-8'),
  ) as { classification: unknown };
  return metadata.classification;
}

it('does not expose a sweepable preparation directory before constructing its SQLite lock', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-mint-interposition-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  interposition.dbDir = runtime.paths.coral.store.dbDir;
  let epoch: string | null = null;
  let failure: unknown = null;

  try {
    const settled = settleStoreEpoch(runtime, { storeFormat, build });
    epoch = settled.store.epoch;
    settled.db.close();
  } catch (error: unknown) {
    failure = error;
  }

  expect(interposition.lockOpenObserved).toBe(true);
  expect(interposition.swept).toBe(false);
  expect(failure).toBeNull();
  expect(epoch).toBe('1');
  expect(classification(runtime, '1')).toEqual({ kind: 'absent' });
});

it('settles after a sweep removes the construction directory before the lock opens', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-mint-construction-sweep-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  interposition.dbDir = runtime.paths.coral.store.dbDir;
  interposition.sweepConstruction = true;

  const settled = settleStoreEpoch(runtime, { storeFormat, build });

  expect(interposition.lockOpenObserved).toBe(true);
  expect(interposition.swept).toBe(true);
  expect(settled.store.epoch).toBe('1');
  settled.db.close();
});

it('retries transient read-lock failures without stranding the current epoch', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.failReadLockAttempts = 2;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(interposition.failReadLockAttempts).toBe(0);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expectInitialEpochAndJob(settled);
  settled.db.close();
});

it('gives the deciding lock attempt a full timeout after the retry window expires', () => {
  const runtime = harness('coral-read-lock-budget-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.failReadLockAttempts = Number.MAX_SAFE_INTEGER;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(clock.sleptMs()).toBe(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  expect(interposition.readLockBusyTimeouts).toEqual(currentEpochAttemptTimeouts());
  expect(interposition.readLockBusyTimeouts.every((timeout) => timeout !== undefined && timeout > 0)).toBe(true);
  settled.db.close();
});

it('keeps sequential lock and store SQLite waits inside the total retry budget', () => {
  const runtime = harness('coral-aggregate-retry-budget-');
  publishInitialEpoch(runtime);
  interposition.aggregateRetryElapsedMs = 0;
  const timedRuntime = {
    ...runtime,
    time: {
      ...runtime.time,
      monotonicNow: () => BigInt(interposition.aggregateRetryElapsedMs ?? 0),
    },
  };

  const settled = settleStoreEpoch(timedRuntime, { storeFormat, build });

  expect(settled.store.epoch).toBe('1');
  expect(interposition.aggregateRetryElapsedMs).toBeLessThanOrEqual(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  settled.db.close();
});

it('retries a current epoch that fails re-proof before opening', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.nullReadLockAttempts = 2;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(interposition.nullReadLockAttempts).toBe(0);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expectInitialEpochAndJob(settled);
  settled.db.close();
});

it('retries transient errno failures from the openable probe', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  const epochOnePath = join(epochDirectory(runtime.paths.coral.store.dbDir, '1'), 'store.db');
  let failuresRemaining = 2;
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'openSync') {
        return (path: string, flags: string): number => {
          if (failuresRemaining > 0 && path === epochOnePath && flags === 'r+') {
            failuresRemaining -= 1;
            throw Object.assign(new Error('injected permission denial'), { errno: 'EACCES' });
          }
          return subject.openSync(path, flags);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(failuresRemaining).toBe(0);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expectInitialEpochAndJob(settled);
  settled.db.close();
});

it('retries transient non-decisive writable-open failures', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.writableOpenFailures = 2;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(interposition.writableOpenAttempts).toBe(3);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expectInitialEpochAndJob(settled);
  settled.db.close();
});

it('treats a lease-release failure after a non-decisive open failure as retryable', () => {
  const runtime = harness('coral-non-decisive-release-failure-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.writableOpenFailures = 1;
  interposition.releaseFailure = true;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(clock.sleptMs()).toBeGreaterThan(0);
  expectInitialEpochAndJob(settled);
  settled.db.close();
});

it('mints after persistent non-decisive failures exhaust the retry budget', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.writableOpenFailures = Number.MAX_SAFE_INTEGER;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(clock.sleptMs()).toBe(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  expect(interposition.writableOpenAttempts).toBe(currentEpochAttemptTimeouts().length);
  expect(interposition.readLockBusyTimeouts).toEqual(currentEpochAttemptTimeouts());
  expect(interposition.writableOpenBusyTimeouts).toEqual(currentEpochAttemptTimeouts());
  expect(classification(runtime, '2')).toEqual({
    kind: 'unavailable',
    stage: 'writable-open',
    cause: {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
      message: 'injected SQLite busy failure',
      attempts: currentEpochAttemptTimeouts().length,
    },
  });
  settled.db.close();
});

it('records the first non-decisive open failure after the retry window is exhausted', () => {
  const runtime = harness('coral-first-open-failure-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  const epochOnePath = join(epochDirectory(runtime.paths.coral.store.dbDir, '1'), 'store.db');
  let firstProbe = true;
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property !== 'openSync') return Reflect.get(subject, property, receiver) as unknown;
      return (path: string, flags: string): number => {
        if (firstProbe && path === epochOnePath && flags === 'r+') {
          firstProbe = false;
          throw Object.assign(new Error('injected first permission denial'), { code: 'EACCES' });
        }
        return subject.openSync(path, flags);
      };
    },
  });
  interposition.writableOpenFailures = Number.MAX_SAFE_INTEGER;

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(classification(runtime, '2')).toMatchObject({
    kind: 'unavailable',
    stage: 'openable-probe',
    cause: { code: 'EACCES', message: expect.stringContaining('injected first permission denial') },
  });
  settled.db.close();
});

it('resets retry state after a swept mint reveals a different current epoch', () => {
  const runtime = harness('coral-mint-retry-reset-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.dbDir = runtime.paths.coral.store.dbDir;
  interposition.publishEpochTwoOnSweep = true;
  interposition.rejectZeroEpochTwoReadLock = true;
  interposition.writableOpenFailures = Number.MAX_SAFE_INTEGER;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(interposition.epochTwoReadLockBusyTimeouts).toHaveLength(1);
  expect(interposition.epochTwoReadLockBusyTimeouts[0]).toBeGreaterThan(0);
  settled.db.close();
});

it('replaces a decisively incompatible current epoch without retrying', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.incompatibleOpen = true;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(interposition.writableOpenAttempts).toBe(1);
  expect(clock.sleptMs()).toBe(0);
  expect(classification(runtime, '2')).toMatchObject({ kind: 'newer-incompatible' });
  settled.db.close();
});

it.each([
  ['SQLITE_CORRUPT', 11],
  ['SQLITE_NOTADB', 26],
] as const)('replaces a current epoch on decisive %s without retrying', (_name, errcode) => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.writableOpenFailures = 1;
  interposition.writableOpenErrcode = errcode;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(interposition.writableOpenAttempts).toBe(1);
  expect(clock.sleptMs()).toBe(0);
  expect(classification(runtime, '2')).toMatchObject({
    kind: 'unavailable',
    stage: 'writable-open',
    cause: { errcode, attempts: 1 },
  });
  settled.db.close();
});

it('opens the current epoch when a real SQLite classification lock clears within the budget', async () => {
  const runtime = harness('coral-classification-busy-');
  publishInitialEpoch(runtime);
  const databasePath = join(epochDirectory(runtime.paths.coral.store.dbDir, '1'), 'store.db');
  const holder = new Worker(
    `
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData);
      db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
      parentPort.postMessage('ready');
      setTimeout(() => {
        db.exec('ROLLBACK');
        db.close();
        parentPort.postMessage('released');
      }, 300);
    `,
    { eval: true, workerData: databasePath },
  );
  await once(holder, 'message');

  try {
    const settled = settleStoreEpoch(runtime, { storeFormat, build, startupBusyTimeoutMs: 1_000 });

    expectInitialEpochAndJob(settled);
    settled.db.close();
    expect((await once(holder, 'message'))[0]).toBe('released');
  } finally {
    await holder.terminate();
  }
});

it('re-observes an unobservable current candidate and opens it once proven', () => {
  const runtime = harness();
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  const currentDirectory = epochDirectory(runtime.paths.coral.store.dbDir, '1');
  let observationFailures = 1;
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'lstatSync') {
        return (...args: Parameters<Runtime['storage']['lstatSync']>) => {
          if (observationFailures > 0 && args[0] === currentDirectory) {
            observationFailures -= 1;
            throw Object.assign(new Error('injected candidate observation failure'), { code: 'EACCES' });
          }
          return subject.lstatSync(...args);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(observationFailures).toBe(0);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expectInitialEpochAndJob(settled);
  settled.db.close();
});

it('does not fall back to an older proven epoch while the newest epoch is transiently unobservable', () => {
  const runtime = harness('coral-unobservable-latest-');
  const first = settleStoreEpoch(runtime, { storeFormat, build });
  first.db.close();
  const second = discardCurrentStoreEpoch(runtime, { storeFormat, build });
  second.db.exec('CREATE TABLE latest_epoch_jobs (id TEXT PRIMARY KEY)');
  second.db.prepare('INSERT INTO latest_epoch_jobs (id) VALUES (?)').run('latest-epoch-job');
  second.db.close();
  const clock = withVirtualRetryClock(runtime);
  const newestDirectory = epochDirectory(runtime.paths.coral.store.dbDir, '2');
  let observationFailures = 1;
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'lstatSync') {
        return (...args: Parameters<Runtime['storage']['lstatSync']>) => {
          if (observationFailures > 0 && args[0] === newestDirectory) {
            observationFailures -= 1;
            throw Object.assign(new Error('injected transient observation failure'), { code: 'EACCES' });
          }
          return subject.lstatSync(...args);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(observationFailures).toBe(0);
  expect(clock.sleptMs()).toBeGreaterThan(0);
  expect(settled.store.epoch).toBe('2');
  expect(settled.db.prepare('SELECT id FROM latest_epoch_jobs').get()).toEqual({ id: 'latest-epoch-job' });
  settled.db.close();
});

it('falls back to an older proven epoch only after an unobservable newer epoch exhausts the budget', () => {
  const runtime = harness('coral-persistently-unobservable-latest-');
  const first = settleStoreEpoch(runtime, { storeFormat, build });
  first.db.close();
  const second = discardCurrentStoreEpoch(runtime, { storeFormat, build });
  second.db.close();
  const clock = withVirtualRetryClock(runtime);
  const newestDirectory = epochDirectory(runtime.paths.coral.store.dbDir, '2');
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'lstatSync') {
        return (...args: Parameters<Runtime['storage']['lstatSync']>) => {
          if (args[0] === newestDirectory) {
            throw Object.assign(new Error('injected persistent observation failure'), { code: 'EACCES' });
          }
          return subject.lstatSync(...args);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(clock.sleptMs()).toBe(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  expect(settled.store.epoch).toBe('1');
  settled.db.close();
});

it('adopts a proven current epoch under contention after a newer candidate stays unobservable', () => {
  const runtime = harness('coral-contended-current-with-unobservable-latest-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  const newestDirectory = epochDirectory(runtime.paths.coral.store.dbDir, '2');
  mkdirSync(newestDirectory);
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property !== 'lstatSync') return Reflect.get(subject, property, receiver) as unknown;
      return (...args: Parameters<Runtime['storage']['lstatSync']>) => {
        if (args[0] === newestDirectory) {
          throw Object.assign(new Error('injected persistent observation failure'), { code: 'EACCES' });
        }
        return subject.lstatSync(...args);
      };
    },
  });
  interposition.writableOpenFailures = 1;

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build, startupBusyTimeoutMs: 750 });

  expectInitialEpochAndJob(settled);
  expect(interposition.readLockBusyTimeouts.every((timeout) => timeout !== undefined && timeout >= 750)).toBe(true);
  expect(interposition.writableOpenBusyTimeouts.every((timeout) => timeout !== undefined && timeout >= 750)).toBe(true);
  settled.db.close();
});

it('records every persistently unproven epoch candidate and the observation attempts', () => {
  const runtime = harness();
  const clock = withVirtualRetryClock(runtime);
  const dbDir = runtime.paths.coral.store.dbDir;
  mkdirSync(epochDirectory(dbDir, '1'), { recursive: true });
  mkdirSync(epochDirectory(dbDir, '2'));
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'lstatSync') {
        return (...args: Parameters<Runtime['storage']['lstatSync']>) => {
          if (args.length > 1 && args[0] === epochDirectory(dbDir, '2')) {
            throw Object.assign(new Error('injected candidate observation failure'), { code: 'EACCES' });
          }
          return subject.lstatSync(...args);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(settled.store.epoch).toBe('3');
  expect(clock.sleptMs()).toBe(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  expect(classification(runtime, '3')).toEqual({
    kind: 'absent',
    attempts: retryAttemptTimeouts().length,
    candidateCount: 2,
    candidates: [
      { epoch: '1', proof: { kind: 'disproven', cause: 'epoch metadata is missing' } },
      { epoch: '2', proof: { kind: 'unobservable', cause: 'injected candidate observation failure' } },
    ],
  });
  settled.db.close();
});

it('bounds unproven candidate metadata and adopts the successor on restart', () => {
  const runtime = harness('coral-candidate-bound-');
  const dbDir = runtime.paths.coral.store.dbDir;
  mkdirSync(dbDir, { recursive: true });
  for (let epoch = 1; epoch <= 1_600; epoch += 1) {
    mkdirSync(epochDirectory(dbDir, String(epoch)));
  }
  vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

  const first = settleStoreEpoch(runtime, { storeFormat, build });
  const metadataPath = join(epochDirectory(dbDir, first.store.epoch), STORE_EPOCH_METADATA_FILE_NAME);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as unknown;

  expect(first.store.epoch).toBe('1601');
  expect(statSync(metadataPath).size).toBeLessThanOrEqual(MAX_STORE_EPOCH_METADATA_BYTES);
  expect(parseStoreEpochMetadata(metadata)).not.toBeNull();
  expect(metadata).toMatchObject({
    classification: {
      kind: 'absent',
      candidateCount: 1_600,
      candidates: expect.any(Array),
    },
  });
  expect((metadata as { classification: { candidates: unknown[] } }).classification.candidates).toHaveLength(16);
  first.db.close();

  const second = settleStoreEpoch(runtime, { storeFormat, build });

  expect(second.store.epoch).toBe('1601');
  second.db.close();
});

it('bounds an oversized incompatible classification and adopts the successor on restart', () => {
  const runtime = harness('coral-incompatible-classification-bound-');
  const first = settleStoreEpoch(runtime, { storeFormat, build });
  first.db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('x'.repeat(MAX_STORE_EPOCH_METADATA_BYTES), STORE_FORMAT_FINGERPRINT_META_KEY);
  first.db.close();

  const replacement = settleStoreEpoch(runtime, { storeFormat, build });
  const dbDir = runtime.paths.coral.store.dbDir;
  const successor = epochDirectory(dbDir, '2');
  const metadataPath = join(successor, STORE_EPOCH_METADATA_FILE_NAME);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as {
    classification: { kind: string; storedFingerprint?: string };
  };

  expect(replacement.store.epoch).toBe('2');
  expect(statSync(metadataPath).size).toBeLessThanOrEqual(MAX_STORE_EPOCH_METADATA_BYTES);
  expect(metadata.classification).toMatchObject({
    kind: 'corrupt-or-unsupported',
    storedFingerprint: expect.stringMatching(/\.\.\.$/u),
  });
  expect(parseStoreEpochMetadata(metadata)).not.toBeNull();
  expect(resolveCurrentStoreDbPath(dbDir)).toBe(join(successor, 'store.db'));
  replacement.db.close();

  const restarted = settleStoreEpoch(runtime, { storeFormat, build });

  expect(restarted.store.epoch).toBe('2');
  restarted.db.close();
});

it('preserves replacement when releasing an incompatible epoch fails', () => {
  const runtime = harness('coral-release-order-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  interposition.incompatibleOpen = true;
  interposition.releaseFailure = true;

  const settled = settleStoreEpoch(clock.runtime, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(clock.sleptMs()).toBe(0);
  expect(classification(runtime, '2')).toMatchObject({
    kind: 'newer-incompatible',
    releaseFailure: { message: 'injected lease release failure' },
  });
  settled.db.close();
});

it('settles after replacement logging fails', () => {
  const runtime = harness('coral-logging-failure-');
  publishInitialEpoch(runtime);
  const clock = withVirtualRetryClock(runtime);
  const epochOneDatabase = join(epochDirectory(runtime.paths.coral.store.dbDir, '1'), 'store.db');
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'openSync') {
        return (path: string, flags: string): number => {
          if (path === epochOneDatabase && flags === 'r+') {
            throw Object.assign(new Error('injected permission denial'), { code: 'EACCES' });
          }
          return subject.openSync(path, flags);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });
  vi.spyOn(backendLog, 'warn').mockImplementation(() => {
    throw new Error('injected logging failure');
  });

  const settled = settleStoreEpoch({ ...clock.runtime, storage }, { storeFormat, build });

  expect(settled.store.epoch).toBe('2');
  expect(clock.sleptMs()).toBe(STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
  expect(classification(runtime, '2')).toMatchObject({
    kind: 'unavailable',
    stage: 'openable-probe',
  });
  settled.db.close();
});
