import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  listStoreEpochResidues,
  listStoreEpochHolders,
  listStoreEpochs,
  openWritableStoreDbNoReset,
  resolveCurrentStoreEpoch,
  settleStoreEpoch,
  storeEpochLockPath,
  storeMintLockPath,
  sweepStoreEpochs,
  sweepStoreEpochsPostReady,
  MAX_STORE_EPOCH_HOLDER_BYTES,
  MAX_STORE_EPOCH_METADATA_BYTES,
  STORE_EPOCH_METADATA_FILE_NAME,
} from '#src/store/epoch.js';
import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import {
  discardStoreReset,
  releaseStoreReset as releaseStoreResetWithSocketGuard,
} from '#src/store/operator-store-reset.js';
import {
  acquireDirectoryLockSync,
  acquireSharedFileLockSync,
  createSharedFileLockSync,
  tryAcquireExclusiveFileLockSync,
} from '#src/infra/fs-lock.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { formatStoreResetRelease } from '#src/cli/format/store-reset.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from '#src/store/reset-incident.js';
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

function releaseStoreReset(
  options: Omit<Parameters<typeof releaseStoreResetWithSocketGuard>[0], 'acquireSocketGuard'>,
) {
  return releaseStoreResetWithSocketGuard({
    ...options,
    acquireSocketGuard: async () => ({ release: async () => undefined }),
  });
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

function flatStorePath(dbDir: string): string {
  return join(dbDir, 'store.db');
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
  writeFileSync(join(destination, '.lock'), '');
  if (compatible) createCompatibleStore(join(destination, 'store.db'), 'concurrent-winner');
  else createIncompatibleStore(join(destination, 'store.db'));
  writeFileSync(
    join(destination, STORE_EPOCH_METADATA_FILE_NAME),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable', cause: 'adversary' },
      build,
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

function createCrashedWalStore(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const crashed = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec(\"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE legacy_sentinel(value TEXT NOT NULL); INSERT INTO legacy_sentinel VALUES ('untouched');\"); process.kill(process.pid, 'SIGKILL');",
      path,
    ],
    { encoding: 'utf-8' },
  );
  expect(crashed.signal).toBe('SIGKILL');
  rmSync(`${path}-shm`, { force: true });
}

function fileTreeSnapshot(root: string): readonly Readonly<{ path: string; bytes: Buffer }>[] {
  const snapshot: Array<Readonly<{ path: string; bytes: Buffer }>> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else snapshot.push({ path: path.slice(root.length + 1), bytes: readFileSync(path) });
    }
  };
  visit(root);
  return snapshot;
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

async function withGeneratedHookReadStore<T>(runtime: Runtime, epoch: string, run: () => Promise<T>): Promise<T> {
  const dbDir = runtime.paths.coral.store.dbDir;
  const helperUrl = pathToFileURL(join(process.cwd(), 'clients/hooks/lib/store-epoch.mjs')).href;
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--input-type=module',
      '-e',
      "const { openLockedReadOnlyStoreDatabase } = await import(process.argv[1]); const handle = openLockedReadOnlyStoreDatabase(process.argv[2], process.argv[3]); handle.db.prepare('SELECT 1').get(); process.stdout.write('ready\\n'); process.on('SIGTERM', () => { handle.close(); process.exit(0); }); setInterval(() => {}, 1000);",
      helperUrl,
      dbDir,
      epochPath(dbDir, epoch),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolveReady, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.stdout.once('data', () => resolveReady());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Generated hook reader exited before ready (${code}): ${stderr}`)));
    });
    return await run();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    }
  }
}

function publishLiveCoordinator(runtime: Runtime, pid: number, storeEpoch?: string): void {
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
      ...(storeEpoch === undefined ? {} : { storeEpoch }),
    },
    runtime,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('write-once store epochs', () => {
  it.each(['post-ready sweep', 'release'] as const)(
    'holds the shared epoch lock for the read-only port through %s',
    async (operation) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
      publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
      publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);
      const db = openReadOnlyStoreDatabase(runtime, { path: epochPath(dbDir, '1'), storeFormat });
      try {
        const result =
          operation === 'post-ready sweep'
            ? await sweepStoreEpochsPostReady(runtime, dbDir, '5')
            : sweepStoreEpochs(runtime, dbDir, null, { releaseEpoch: '1' });
        expect(result).toBe('live-holder');
        expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
        expect(db.prepare<[], { value: string }>('SELECT value FROM rollback_sentinel').get()?.value).toBe(
          'concurrent-winner',
        );
        console.log(
          `read-only-opener-cell opener=read-port operation=${operation.replaceAll(' ', '-')} result=live-holder sqlite=usable`,
        );
      } finally {
        db.close();
      }
    },
  );

  it.each(['synchronous', 'post-ready'] as const)(
    'skips one contended garbage epoch during the %s sweep, removes garbage on both sides, and syncs',
    async (kind) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      for (const epoch of ['1', '2', '3', '4', '5']) publishAdversarialEpoch(join(dbDir, `epoch-${epoch}`), true);
      publishLiveCoordinator(runtime, runtime.env.pid(), '5');
      const held = acquireSharedFileLockSync(storeEpochLockPath(dbDir, '2'));
      let rootSyncs = 0;
      const storage = new Proxy(runtime.storage, {
        get(subject, property, receiver) {
          if (property === 'syncDirectoryDurableSync') {
            return (path: string): boolean => {
              if (path === dbDir) rootSyncs += 1;
              return subject.syncDirectoryDurableSync(path);
            };
          }
          if (property === 'syncDirectoryDurable') {
            return async (path: string): Promise<boolean> => {
              if (path === dbDir) rootSyncs += 1;
              return subject.syncDirectoryDurable(path);
            };
          }
          return Reflect.get(subject, property, receiver) as unknown;
        },
      });
      try {
        const result =
          kind === 'synchronous'
            ? sweepStoreEpochs(withStorage(runtime, storage), dbDir, '5')
            : await sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '5');
        expect(result).toBe('live-holder');
        expect(existsSync(epochPath(dbDir, '1'))).toBe(false);
        expect(existsSync(epochPath(dbDir, '2'))).toBe(true);
        expect(existsSync(epochPath(dbDir, '3'))).toBe(false);
        expect(rootSyncs).toBeGreaterThan(0);
        console.log(
          `contended-skip-cell sweep=${kind} before=removed contended=present after=removed parent-sync=${rootSyncs}`,
        );
      } finally {
        held();
      }
    },
  );

  it('distinguishes a pre-deletion durability failure from a removed release target', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    writeFileSync(join(dbDir, '.epoch-holder-stale.json'), `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => (path === dbDir ? false : subject.syncDirectoryDurableSync(path));
      },
    });

    const result = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '1' });

    expect(result.kind).toBe('release-pre-deletion-durability-sync-failed');
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    console.log('release-disposition-cell phase=pre-deletion target=present renderer-claim=not-removed');
  });

  it('distinguishes an absent second proof with a failed barrier from a removed release target', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-19'), true);
    publishLiveCoordinator(runtime, runtime.env.pid(), '19');
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => (path === dbDir ? false : subject.syncDirectoryDurableSync(path));
      },
    });

    const result = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '17' });

    expect(result.kind).toBe('release-absent-durability-sync-failed');
    expect(existsSync(epochDirectory(dbDir, '17'))).toBe(false);
    expect(formatStoreResetRelease(result)).toContain('was already absent');
    expect(formatStoreResetRelease(result)).not.toContain('was removed');
    console.log('release-disposition-cell phase=absent-second-proof target=absent renderer-claim=already-absent');
  });

  it('syncs after synchronous holder unlink mutates and then throws', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const holder = join(dbDir, '.epoch-holder-post-effect-sync.json');
    writeFileSync(holder, `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'unlinkSync') {
          return (path: string): void => {
            subject.unlinkSync(path);
            if (path === holder) {
              events.push('holder-removed');
              throw Object.assign(new Error('injected post-effect holder failure'), { code: 'EIO' });
            }
          };
        }
        if (property === 'syncDirectoryDurableSync') {
          return (path: string): boolean => {
            if (path === dbDir) events.push('parent-sync');
            return subject.syncDirectoryDurableSync(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    expect(sweepStoreEpochs(withStorage(runtime, storage), dbDir, '3')).toBe('deletion-failed');
    expect(events).toEqual(['holder-removed', 'parent-sync']);
    console.log('ambiguous-removal-cell site=sync-holder post-effect=EIO parent-sync=after');
  });

  it('syncs after post-ready holder unlink mutates and then throws', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const holder = join(dbDir, '.epoch-holder-post-effect-async.json');
    writeFileSync(holder, `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'unlink') {
          return async (path: string): Promise<void> => {
            await subject.unlink(path);
            if (path === holder) {
              events.push('holder-removed');
              throw Object.assign(new Error('injected post-effect holder failure'), { code: 'EIO' });
            }
          };
        }
        if (property === 'syncDirectoryDurable') {
          return async (path: string): Promise<boolean> => {
            if (path === dbDir) events.push('parent-sync');
            return subject.syncDirectoryDurable(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    await expect(sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3')).resolves.toBe('deletion-failed');
    expect(events).toEqual(['holder-removed', 'parent-sync']);
    console.log('ambiguous-removal-cell site=post-ready-holder post-effect=EIO parent-sync=after');
  });

  it('syncs after legacy-quarantine removal mutates and then throws', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const quarantine = join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'incident'), 'evidence');
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'rm') {
          return async (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): Promise<void> => {
            await subject.rm(path, rmOptions);
            if (path === quarantine) {
              events.push('quarantine-removed');
              throw Object.assign(new Error('injected post-effect quarantine failure'), { code: 'EIO' });
            }
          };
        }
        if (property === 'syncDirectoryDurable') {
          return async (path: string): Promise<boolean> => {
            if (path === dbDir) events.push('parent-sync');
            return subject.syncDirectoryDurable(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    await expect(sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3')).resolves.toBe('deletion-failed');
    expect(events).toEqual(['quarantine-removed', 'parent-sync']);
    console.log('ambiguous-removal-cell site=legacy-quarantine post-effect=EIO parent-sync=after');
  });

  it('syncs successful synchronous holder cleanup before reporting a later holder deletion failure', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-2'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const first = join(dbDir, '.epoch-holder-a.json');
    const second = join(dbDir, '.epoch-holder-b.json');
    writeFileSync(first, `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    writeFileSync(second, `${JSON.stringify({ epoch: '2', pid: 999_999_992 })}\n`);
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'unlinkSync') {
          return (path: string): void => {
            if (path === second) {
              events.push('remove-failed');
              throw Object.assign(new Error('injected holder deletion failure'), { code: 'EIO' });
            }
            subject.unlinkSync(path);
            if (path === first) events.push('remove-succeeded');
          };
        }
        if (property === 'syncDirectoryDurableSync') {
          return (path: string): boolean => {
            if (path === dbDir) events.push('parent-sync');
            return subject.syncDirectoryDurableSync(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    expect(sweepStoreEpochs(withStorage(runtime, storage), dbDir, '3')).toBe('deletion-failed');
    expect(events).toEqual(['remove-succeeded', 'remove-failed', 'parent-sync']);
    console.log('sweep-barrier-cell site=sync-holder-cleanup mutation=true exit=deletion-failed parent-sync=after');
  });

  it('syncs successful post-ready holder cleanup before reporting a later holder deletion failure', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const first = join(dbDir, '.epoch-holder-a.json');
    const second = join(dbDir, '.epoch-holder-b.json');
    writeFileSync(first, `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    writeFileSync(second, `${JSON.stringify({ epoch: '2', pid: 999_999_992 })}\n`);
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'unlink') {
          return async (path: string): Promise<void> => {
            if (path === second) {
              events.push('remove-failed');
              throw Object.assign(new Error('injected holder deletion failure'), { code: 'EIO' });
            }
            await subject.unlink(path);
            if (path === first) events.push('remove-succeeded');
          };
        }
        if (property === 'syncDirectoryDurable') {
          return async (path: string): Promise<boolean> => {
            if (path === dbDir) events.push('parent-sync');
            return subject.syncDirectoryDurable(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    await expect(sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3')).resolves.toBe('deletion-failed');
    expect(events).toEqual(['remove-succeeded', 'remove-failed', 'parent-sync']);
    console.log(
      'sweep-barrier-cell site=post-ready-holder-cleanup mutation=true exit=deletion-failed parent-sync=after',
    );
  });

  it('tells release operators that holder cleanup failed before the target was attempted', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const holder = join(dbDir, '.epoch-holder-stale.json');
    writeFileSync(holder, `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'unlinkSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): void => {
          if (path === holder) throw Object.assign(new Error('injected holder cleanup failure'), { code: 'EIO' });
          subject.unlinkSync(path);
        };
      },
    });

    const result = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '1' });

    expect(result.kind).toBe('release-holder-cleanup-failed');
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    expect(formatStoreResetRelease(result)).toContain('target deletion was not attempted');
    console.log('release-disposition-cell phase=holder-cleanup target=present renderer-claim=not-attempted');
  });

  it.each(['synchronous', 'post-ready'] as const)(
    'reclaims a large invalid epoch-0 directory in the %s sweep',
    async (kind) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
      const invalid = join(dbDir, 'epoch-0');
      mkdirSync(invalid);
      writeFileSync(join(invalid, 'payload'), 'x'.repeat(512 * 1024));
      publishLiveCoordinator(runtime, runtime.env.pid(), '1');

      const result =
        kind === 'synchronous'
          ? sweepStoreEpochs(runtime, dbDir, '1')
          : await sweepStoreEpochsPostReady(runtime, dbDir, '1');

      expect(result).toBe('complete');
      expect(existsSync(invalid)).toBe(false);
      console.log(`epoch-zero-directory-cell sweep=${kind} bytes=${512 * 1024} remaining=false`);
    },
  );

  it('removes each epoch lock with its store across K release cycles', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    for (let epoch = 1; epoch <= 9; epoch += 1) publishAdversarialEpoch(join(dbDir, `epoch-${epoch}`), true);

    for (let epoch = 1; epoch <= 8; epoch += 1) {
      await releaseStoreReset({ target: 'gen2', runtime, epoch: String(epoch) });
    }

    const entries = readdirSync(dbDir);
    expect(entries.filter((entry) => entry.startsWith('.epoch-lock-'))).toEqual([]);
    expect(entries).toEqual(['epoch-9']);
    console.log('contained-lock-lifecycle-cell cycles=8 raw-cardinality=1 root-lock-files=0');
  });

  it.each(['post-ready sweep', 'release'] as const)(
    'holds the generated hook shared lock through %s',
    async (operation) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
      publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
      publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);

      await withGeneratedHookReadStore(runtime, '1', async () => {
        const result =
          operation === 'post-ready sweep'
            ? await sweepStoreEpochsPostReady(runtime, dbDir, '5')
            : sweepStoreEpochs(runtime, dbDir, null, { releaseEpoch: '1' });
        expect(result).toBe('live-holder');
        expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
        console.log(
          `read-only-opener-cell opener=generated-hook operation=${operation.replaceAll(' ', '-')} result=live-holder`,
        );
      });
    },
  );

  it.each(['post-ready sweep', 'release'] as const)(
    'takes the list classification shared lock before opening SQLite for %s',
    (operation) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
      publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
      let observedLocked = false;
      const storage = new Proxy(runtime.storage, {
        get(subject, property, receiver) {
          if (property !== 'openSqliteDatabaseSync') return Reflect.get(subject, property, receiver) as unknown;
          return (path: string, options?: { readOnly?: boolean; busyTimeoutMs?: number }) => {
            if (path === epochPath(dbDir, '1')) {
              const exclusive = tryAcquireExclusiveFileLockSync(storeEpochLockPath(dbDir, '1'));
              observedLocked = exclusive === null;
              exclusive?.();
            }
            return subject.openSqliteDatabaseSync(path, options);
          };
        },
      });

      listStoreEpochs(withStorage(runtime, storage), storeFormat);

      expect(observedLocked).toBe(true);
      console.log(
        `read-only-opener-cell opener=list-classification operation=${operation.replaceAll(' ', '-')} lock-before-sqlite=true`,
      );
    },
  );
  it('does not treat an epoch symlink to the store root as a published epoch', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = flatStorePath(dbDir);
    createCompatibleStore(flatPath, 'flat-epoch-zero');
    symlinkSync('.', join(dbDir, 'epoch-1'));

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    const flat = new DatabaseSync(flatPath, { readOnly: true });
    const values = flat.prepare('SELECT value FROM rollback_sentinel ORDER BY rowid').all() as { value: string }[];
    flat.close();
    expect(settled.epoch).toBe('2');
    expect(values.map(({ value }) => value)).toEqual(['flat-epoch-zero']);
    console.log('symlink-cell alias=epoch-1->. selected=epoch-2 flat-write=untouched');
  });

  it('does not open or stamp a flat store symlink when no epoch is proven', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const external = join(dbDir, '..', 'external-flat.db');
    createCompatibleStore(external, 'external-flat');
    mkdirSync(dbDir, { recursive: true });
    symlinkSync(external, flatStorePath(dbDir));

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
    symlinkSync(external, flatStorePath(dbDir));
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

  it('does not let a regular file named as an epoch address the flat store', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = flatStorePath(dbDir);
    createCompatibleStore(flatPath, 'flat-epoch-zero');
    writeFileSync(join(dbDir, 'epoch-1'), 'not a directory');

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    expect(settled.epoch).toBe('2');
    expect(existsSync(flatPath)).toBe(true);
    console.log('regular-file-cell entry=epoch-1 selected=epoch-2 flat-store=untouched');
  });

  it('recognizes the former numeric ceiling as an epoch with a successor', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat-epoch-zero');
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
    createCompatibleStore(flatStorePath(dbDir), 'flat-epoch-zero');
    arrange(join(dbDir, 'epoch-2'));

    expect(resolveCurrentStoreEpoch(runtime.storage, dbDir)).toBeNull();
  });

  it('does not select an epoch symlink to an external directory', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const external = join(dbDir, '..', 'external-epoch');
    createCompatibleStore(flatStorePath(dbDir), 'flat-epoch-zero');
    publishAdversarialEpoch(external, true);
    symlinkSync(external, join(dbDir, 'epoch-2'));

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    expect(settled.epoch).toBe('1');
    expect(existsSync(join(external, 'store.db'))).toBe(true);
  });

  it('selects the highest proven epoch across numbering gaps including the former numeric ceiling', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat-epoch-zero');
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
        const external = join(dirname(path), '..', `${basename(path)}-external`);
        mkdirSync(external);
        writeFileSync(join(external, 'sentinel'), 'external');
        symlinkSync(external, path);
      },
    ],
  ])('publishes after a successor blocked by a %s without deleting the blocker', (_description, block) => {
    const scenarios: Array<{
      retained: string[];
      current: string | null;
      blocker: string;
      successor: string;
      survivors: string[];
    }> = [
      { retained: [], current: null, blocker: '1', successor: '2', survivors: ['2'] },
      { retained: [], current: '2', blocker: '3', successor: '4', survivors: ['2', '4'] },
      { retained: ['1'], current: '3', blocker: '4', successor: '5', survivors: ['3', '5'] },
    ];
    for (const scenario of scenarios) {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      createCompatibleStore(flatStorePath(dbDir), 'flat');
      if (scenario.current !== null) {
        for (const retained of scenario.retained) {
          publishAdversarialEpoch(join(dbDir, `epoch-${retained}`), true);
        }
        publishAdversarialEpoch(join(dbDir, `epoch-${scenario.current}`));
      }
      const blockerPath = join(dbDir, `epoch-${scenario.blocker}`);
      block(blockerPath);

      const settled = settleStoreEpoch(runtime, options());

      expect(settled.epoch).toBe(scenario.successor);
      settled.db.close();
      expect(existsSync(blockerPath)).toBe(true);
      const externalSentinel = join(dbDir, '..', `epoch-${scenario.blocker}-external`, 'sentinel');
      if (_description === 'symlink') expect(existsSync(externalSentinel)).toBe(true);
      publishLiveCoordinator(runtime, runtime.env.pid());
      expect(sweepStoreEpochs(runtime, dbDir, scenario.successor)).toBe('complete');
      expect(existsSync(blockerPath)).toBe(false);
      const survivors = ['1', '2', '3', '4', '5'].filter((epoch) => existsSync(epochPath(dbDir, epoch)));
      expect(survivors).toEqual(scenario.survivors);
      expect(existsSync(flatStorePath(dbDir))).toBe(true);
      if (_description === 'symlink') expect(existsSync(externalSentinel)).toBe(true);
      console.log(
        `successor-blocker-cell kind=${_description} retained-evidence=${scenario.retained.length + (scenario.current === null ? 0 : 1)} selected=epoch-${scenario.successor} survivors=${survivors.join(',')} flat=untouched`,
      );
    }
  });

  it('does not delete a pre-existing mint that blocks preparation publication', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const occupied = join(dbDir, '.mint-occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'sentinel'), 'pre-existing mint');
    const ids = ['occupied', 'fresh', 'holder'];
    const collisionRuntime: Runtime = {
      ...runtime,
      ids: { uuid: () => ids.shift() ?? 'fallback' },
    };

    const settled = settleStoreEpoch(collisionRuntime, options());
    settled.db.close();

    console.log(
      `mint-collision-cell selected=epoch-${settled.epoch} blocker-present=${existsSync(occupied)} blocker-byte-identical=${readFileSync(join(occupied, 'sentinel'), 'utf-8') === 'pre-existing mint'}`,
    );
    expect(settled.epoch).toBe('1');
    expect(readFileSync(join(occupied, 'sentinel'), 'utf-8')).toBe('pre-existing mint');
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
      publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
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

      expect(rows.filter(({ role }) => role === 'current').map(({ epoch }) => epoch)).toEqual(['1']);
      expect(Object.fromEntries(rows.map(({ epoch, epochJson }) => [epoch, epochJson.kind]))).toEqual({
        1: 'valid',
        2: 'missing',
        3: 'malformed',
        4: 'unreadable',
      });
      expect(rows.find(({ epoch }) => epoch === '4')?.role).toBe('unobservable');
    },
  );

  it('classifies oversized epoch metadata as malformed without reading or refusing it', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const metadataPath = join(dbDir, 'epoch-1', STORE_EPOCH_METADATA_FILE_NAME);
    writeFileSync(metadataPath, 'x'.repeat(MAX_STORE_EPOCH_METADATA_BYTES + 1));
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path === metadataPath) throw new Error('oversized metadata must not be read');
          return subject.readFileSync(path, encoding);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    settled.db.close();
    const oversized = listStoreEpochs(withStorage(runtime, storage), storeFormat).find(({ epoch }) => epoch === '1');

    expect(settled.epoch).toBe('2');
    expect(oversized?.epochJson.kind).toBe('malformed');
    console.log(`oversized-epoch-json-cell bytes=${MAX_STORE_EPOCH_METADATA_BYTES + 1} classification=malformed`);
  });

  it('replaces a mode-0444 store rather than refusing to boot', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const path = epochPath(dbDir, '1');
    chmodSync(path, 0o444);

    const settled = settleStoreEpoch(runtime, options());
    expect(settled.epoch).toBe('2');
    settled.db.close();
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
  });

  it.each(['EACCES', 'EMFILE'])('replaces an epoch whose open persistently returns %s', (code) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const path = epochPath(dbDir, '1');
    let attempts = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'openSync') return Reflect.get(subject, property, receiver) as unknown;
        return (candidate: string, flags: string, mode?: number): number => {
          if (candidate === path) {
            attempts += 1;
            throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return subject.openSync(candidate, flags, mode);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    expect(settled.epoch).toBe('2');
    settled.db.close();
    expect(attempts).toBe(1);
    expect(readdirSync(runtime.paths.coral.store.dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
  });

  it.each(['EACCES', 'EIO'])('does not delete an epoch whose metadata read returns %s', (code) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
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

    expect(settled.epoch).toBe('2');
    settled.db.close();
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    console.log(`unobservable-metadata-cell phase=selection code=${code} removed=false`);
  });

  it('steps over an unobservable successor while replacing an incompatible current epoch', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
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

  it('mints epoch one on first boot with only a compatible flat store present', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = flatStorePath(dbDir);
    createCompatibleStore(flatPath, 'v0.10.9-data');
    const before = readFileSync(flatPath);

    const settled = settleStoreEpoch(runtime, options());
    settled.db.close();

    expect(settled.epoch).toBe('1');
    expect(readFileSync(flatPath)).toEqual(before);
    const oldReader = new DatabaseSync(flatPath, { readOnly: true });
    const row = oldReader.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };
    oldReader.close();
    expect(row.value).toBe('v0.10.9-data');
    console.log('first-boot-cell flat=compatible selected=epoch-1 flat=untouched');
  });

  it('never touches the flat store while a v0.10.9-shaped reader holds it across publication and sweep', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const flatPath = flatStorePath(dbDir);
    createCompatibleStore(flatPath, 'v0.10.9-data');
    const forbiddenPaths = new Set(
      [flatPath, `${flatPath}-wal`, `${flatPath}-shm`, `${flatPath}.format`, storeEpochLockPath(dbDir, '0')].map(
        (path) => resolve(path),
      ),
    );
    const operations: string[] = [];
    const trackedMethods = new Set([
      'existsSync',
      'lstatSync',
      'statSync',
      'openSync',
      'openSqliteDatabaseSync',
      'renameSync',
      'unlinkSync',
      'rmSync',
      'lstat',
      'stat',
      'openSqliteDatabase',
      'rename',
      'unlink',
      'rm',
    ]);
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        const value = Reflect.get(subject, property, receiver) as unknown;
        if (typeof property !== 'string' || !trackedMethods.has(property) || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          for (const argument of args) {
            if (typeof argument === 'string' && forbiddenPaths.has(resolve(argument))) {
              operations.push(`${property}:${argument}`);
            }
          }
          return Reflect.apply(value, subject, args);
        };
      },
    });
    const trackedRuntime = withStorage(runtime, storage);

    await withLiveSqliteDescriptor(flatPath, async () => {
      for (let publication = 1; publication <= 3; publication += 1) {
        const settled =
          publication === 1
            ? settleStoreEpoch(trackedRuntime, options())
            : discardCurrentStoreEpoch(trackedRuntime, options());
        settled.db.close();
      }
      publishLiveCoordinator(trackedRuntime, trackedRuntime.env.pid(), '3');
      expect(sweepStoreEpochs(trackedRuntime, dbDir, '3')).toBe('complete');
    });

    expect(operations).toEqual([]);
    expect(existsSync(storeEpochLockPath(dbDir, '0'))).toBe(false);
    const oldReader = new DatabaseSync(flatPath, { readOnly: true });
    const row = oldReader.prepare('SELECT value FROM rollback_sentinel').get() as { value: string };
    oldReader.close();
    expect(row.value).toBe('v0.10.9-data');
    expect(resolveCurrentStoreEpoch(runtime.storage, dbDir)).toBe('3');
    console.log('rollback-cell flat=untouched operations=0 reader=held-through-publish-and-sweep current=3');
  });

  it('adopts the winner when two publishers mint the same next epoch', () => {
    const runtime = harness();
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

  it('re-mints when a private mint disappears before publication', () => {
    const runtime = harness();
    let swept = false;
    const storage = interceptRename(runtime, (source, destination) => {
      if (swept || !basename(source).startsWith('.mint-') || !basename(destination).startsWith('epoch-')) return;
      swept = true;
      rmSync(source, { recursive: true, force: true });
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('1');
    settled.db.close();
    expect(swept).toBe(true);
  });

  it.each([2, 3, 6])('keeps exactly two epoch directories plus the flat store after %i publications', (count) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'v0.10.9-data');
    publishLiveCoordinator(runtime, runtime.env.pid());
    let injected = 0;
    const storage = interceptRename(runtime, (source, destination) => {
      if (
        injected >= count - 1 ||
        !basename(source).startsWith('.mint-') ||
        !basename(destination).startsWith('epoch-')
      )
        return;
      injected += 1;
      publishAdversarialEpoch(destination);
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());
    settled.db.close();
    expect(sweepStoreEpochs(runtime, dbDir, settled.epoch)).toBe('complete');
    const rows = listStoreEpochs(runtime, storeFormat);
    expect(rows.map((row) => [row.epoch, row.role])).toEqual([
      [String(count), 'current'],
      [String(count - 1), 'preserved'],
    ]);
    expect(
      readdirSync(dbDir)
        .filter((entry) => entry === 'store.db' || /^epoch-[1-9]\d*$/u.test(entry))
        .sort(),
    ).toEqual([`epoch-${count - 1}`, `epoch-${count}`, 'store.db'].sort());
    console.log(`K-publication-cell K=${count} epoch-directories=2 survivors=${count - 1},${count} flat=untouched`);
  });

  it.each(['empty-mint', 'opened-mint', 'described-mint'])(
    'boots without deleting an unowned mint after process death seeded at %s',
    (cut) => {
      const runtime = harness();
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
    createIncompatibleStore(flatStorePath(runtime.paths.coral.store.dbDir));
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'), true);

    const settled = settleStoreEpoch(runtime, options());

    expect(settled.epoch).toBe('1');
    settled.db.close();
  });

  it('does not sweep a mint whose database is held by a live foreign coordinator', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
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

  it('takes the socket guard before release when discovery publication fails', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const held = openWritableStoreDbNoReset(runtime, { path: epochPath(dbDir, '1'), storeFormat });
    const failedStorage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'writeAtomicSync') return Reflect.get(subject, property, receiver) as unknown;
        return (): boolean => false;
      },
    });
    expect(
      writeDiscoveryRecord(
        {
          pid: runtime.env.pid(),
          port: 1,
          socketPath: join(runtime.paths.coral.coordinator.runDir, 'live.sock'),
          bundleHash: 'failed-publication',
          flavor: runtime.flavor,
          namespace: 'failed-publication',
          startedAt: Date.now(),
          token: 'failed-publication',
          bootToken: 'failed-publication',
          version: '0.10.9',
          storeEpoch: '1',
        },
        withStorage(runtime, failedStorage),
      ),
    ).toBe(false);
    let guardAttempts = 0;
    await expect(
      releaseStoreResetWithSocketGuard({
        target: 'gen2',
        runtime,
        epoch: '1',
        acquireSocketGuard: async () => {
          guardAttempts += 1;
          throw new Error('coordinator socket is held');
        },
      }),
    ).rejects.toThrow('coordinator socket is held');
    expect(guardAttempts).toBe(1);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);

    held.close();
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
      kind: 'released',
    });
    console.log('release-socket-guard-cell discovery-published=false guarded=true descriptor-preserved=true');
  });

  it('re-reads current before a stale release can delete a concurrently published epoch', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishLiveCoordinator(runtime, runtime.env.pid());
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
    createCompatibleStore(flatStorePath(dbDir), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const target = epochDirectory(dbDir, '2');
    mkdirSync(target);
    writeFileSync(join(target, 'junk'), 'not published');
    publishLiveCoordinator(runtime, runtime.env.pid());
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
      createCompatibleStore(flatStorePath(dbDir), 'flat');
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

      expect(released.kind).toBe('current');
      expect(existsSync(epochPath(dbDir, '2'))).toBe(true);
      console.log(`unobservable-metadata-cell phase=release code=${code} removed=false`);
    },
  );

  it('reports a durability-sync failure when the deletion parent cannot be synced', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
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

    expect(released.kind).toBe('release-durability-sync-failed');
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);

    let retrySyncs = 0;
    const retryStorage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => {
          if (path === dbDir) retrySyncs += 1;
          return subject.syncDirectoryDurableSync(path);
        };
      },
    });
    const retried = await releaseStoreReset({
      target: 'gen2',
      runtime: withStorage(runtime, retryStorage),
      epoch: '1',
    });

    expect(retried.kind).toBe('absent');
    expect(retrySyncs).toBe(1);
  });

  it('surfaces a persistent successor lstat refusal once with its errno', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createIncompatibleStore(flatStorePath(dbDir));
    const successor = epochDirectory(dbDir, '1');
    let attempts = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'lstatSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, lstatOptions?: { bigint: true }) => {
          if (path === successor) {
            attempts += 1;
            throw Object.assign(new Error('injected successor refusal'), { code: 'EACCES' });
          }
          return lstatOptions === undefined ? subject.lstatSync(path) : subject.lstatSync(path, lstatOptions);
        };
      },
    });

    expect(() => settleStoreEpoch(withStorage(runtime, storage), options())).toThrow(
      /lstat syscall.*successor.*errno EACCES/u,
    );
    expect(attempts).toBe(1);
  });

  it.each([300, 3_000])('answers health and signals during a post-ready sweep over %i entries', async (entryCount) => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    for (let index = 0; index < entryCount; index += 1) {
      const garbage = join(dbDir, `epoch-garbage-${index}`, 'nested', 'deeper');
      mkdirSync(garbage, { recursive: true });
      writeFileSync(join(garbage, 'payload'), 'garbage');
    }
    const token = 'sweep-health-token';
    const server = createServer((request, response) => {
      response.statusCode = request.headers.authorization === `Bearer ${token}` ? 200 : 401;
      response.end('healthy');
    });
    await new Promise<void>((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('health server did not bind TCP');
    let sweepSettled = false;
    const sweep = sweepStoreEpochsPostReady(runtime, dbDir, '3').finally(() => {
      sweepSettled = true;
    });
    const signalHandled = new Promise<boolean>((resolveSignal) => {
      process.once('SIGUSR2', () => resolveSignal(!sweepSettled));
      setImmediate(() => process.kill(process.pid, 'SIGUSR2'));
    });
    const startedAt = performance.now();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const healthLatencyMs = performance.now() - startedAt;
    const healthAnsweredDuringSweep = !sweepSettled;
    const signalHandledDuringSweep = await signalHandled;

    expect(health.status).toBe(200);
    expect(await health.text()).toBe('healthy');
    expect(healthAnsweredDuringSweep).toBe(true);
    expect(signalHandledDuringSweep).toBe(true);
    expect(healthLatencyMs).toBeLessThan(500);
    expect(await sweep).toBe('complete');
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    console.log(
      `event-loop-cell entries=${entryCount} health-status=${health.status} latency-ms=${healthLatencyMs.toFixed(1)} signal-handled-during-sweep=${signalHandledDuringSweep}`,
    );
  });

  it('bounds an oversized holder before parsing it', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const holderPath = join(dbDir, '.epoch-holder-oversized.json');
    writeFileSync(holderPath, 'x'.repeat(MAX_STORE_EPOCH_HOLDER_BYTES + 1));
    let holderReads = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFile') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string, encoding: 'utf-8'): Promise<string> => {
          if (path === holderPath) holderReads += 1;
          return subject.readFile(path, encoding);
        };
      },
    });

    expect(await sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3')).toBe('complete');
    expect(holderReads).toBe(0);
    expect(existsSync(holderPath)).toBe(false);
    console.log(`holder-bound-cell bytes=${MAX_STORE_EPOCH_HOLDER_BYTES + 1} parsed=false`);
  });

  it('reclaims K abandoned private mints during the post-ready sweep', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    for (let index = 0; index < 12; index += 1) {
      const id = `process-death-${index}`;
      createCompatibleStore(join(dbDir, `.mint-${id}`, 'store.db'), `mint-${index}`);
      createSharedFileLockSync(storeMintLockPath(dbDir, id))();
    }

    expect(await sweepStoreEpochsPostReady(runtime, dbDir, '1')).toBe('complete');
    expect(readdirSync(dbDir).filter((name) => name.startsWith('.mint-'))).toEqual([]);
    console.log('mint-process-death-cell seeded=12 remaining=0');
  });

  it('does not sweep a live concurrent mint through the production post-ready path', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const id = 'live-publisher';
    const mint = join(dbDir, `.mint-${id}`);
    const held = createSharedFileLockSync(storeMintLockPath(dbDir, id));
    createCompatibleStore(join(mint, 'store.db'), 'live-mint');
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readdir') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string): Promise<string[]> => {
          const entries = await subject.readdir(path);
          if (path !== dbDir) return entries;
          return entries.sort((left, right) => {
            const lock = basename(storeMintLockPath(dbDir, id));
            return left === lock ? -1 : right === lock ? 1 : 0;
          });
        };
      },
    });
    try {
      const result = await sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3');
      const present = existsSync(join(mint, 'store.db'));
      console.log(`post-ready-live-mint-cell lock-before-directory=true result=${result} mint-present=${present}`);
      expect(result).toBe('live-holder');
      expect(present).toBe(true);
    } finally {
      held();
    }
  });

  it('carries the mint lease inode through publication rename', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const id = 'rename-lease';
    const mint = join(dbDir, `.mint-${id}`);
    const epoch = epochDirectory(dbDir, '1');
    mkdirSync(mint, { recursive: true });
    const mintLock = storeMintLockPath(dbDir, id);
    const lease = createSharedFileLockSync(mintLock);
    const before = statSync(mintLock, { bigint: true });
    renameSync(mint, epoch);
    const publishedLock = storeEpochLockPath(dbDir, '1');
    const after = statSync(publishedLock, { bigint: true });
    const whileHeld = tryAcquireExclusiveFileLockSync(publishedLock);
    whileHeld?.();
    lease();
    const afterRelease = tryAcquireExclusiveFileLockSync(publishedLock);
    afterRelease?.();

    const sameInode = before.dev === after.dev && before.ino === after.ino;
    console.log(
      `lease-rename-cell before=${before.dev}:${before.ino} after=${after.dev}:${after.ino} same-inode=${sameInode} exclusive-while-held=${whileHeld === null ? 'blocked' : 'acquired'} exclusive-after-release=${afterRelease === null ? 'blocked' : 'acquired'}`,
    );
    expect(sameInode).toBe(true);
    expect(whileHeld).toBeNull();
    expect(afterRelease).not.toBeNull();
  });

  it('removes the public epoch address before recursive deletion can erase its lock', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);
    let closeOpened: (() => void) | undefined;
    let openedValue: string | undefined;
    let interpositionRan = false;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'rm') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> => {
          if (path === epochDirectory(dbDir, '1') || basename(path).startsWith('.reaping-')) {
            await subject.unlink(join(path, '.lock'));
            interpositionRan = true;
            try {
              const opened = openWritableStoreDbNoReset(runtime, { path: epochPath(dbDir, '1'), storeFormat });
              closeOpened = () => opened.close();
              openedValue = opened.prepare<[], { value: string }>('SELECT value FROM rollback_sentinel').get()?.value;
            } catch {
              openedValue = undefined;
            }
          }
          await subject.rm(path, options);
        };
      },
    });

    try {
      const result = await sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '5');
      const present = existsSync(epochPath(dbDir, '1'));
      console.log(
        `deletion-window-cell interposition-ran=${interpositionRan} opener=${openedValue === undefined ? 'refused' : 'opened'} live-query=${openedValue ?? 'none'} result=${result} epoch-1-present=${present}`,
      );
      expect(interpositionRan).toBe(true);
      expect(openedValue).toBeUndefined();
      expect(result).toBe('complete');
      expect(present).toBe(false);
    } finally {
      closeOpened?.();
    }
  });

  it.each(['store.db', '.lock'] as const)(
    'rejects an epoch whose required %s has another hard link during ordinary settlement',
    (artifact) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(epochDirectory(dbDir, '1'), true);
      const artifactPath = join(epochDirectory(dbDir, '1'), artifact);
      const aliasPath = join(dirname(dbDir), `protected-${artifact.replace('.', '')}`);
      linkSync(artifactPath, aliasPath);
      const before = readFileSync(aliasPath);

      const settled = settleStoreEpoch(runtime, options());
      settled.db.close();

      console.log(
        `settlement-hardlink-cell artifact=${artifact} selected-epoch=${settled.epoch} nlink=${statSync(aliasPath).nlink} byte-identical=${readFileSync(aliasPath).equals(before)}`,
      );
      expect(settled.epoch).toBe('2');
      expect(readFileSync(aliasPath)).toEqual(before);
    },
  );

  it.each(['store.db', '.lock'] as const)(
    'keeps the generated hook out of an epoch whose required %s has another hard link',
    async (artifact) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(epochDirectory(dbDir, '1'), true);
      const artifactPath = join(epochDirectory(dbDir, '1'), artifact);
      const aliasPath = join(dirname(dbDir), `hook-protected-${artifact.replace('.', '')}`);
      linkSync(artifactPath, aliasPath);
      const before = readFileSync(aliasPath);
      const helperUrl = `${pathToFileURL(join(process.cwd(), 'clients/hooks/lib/store-epoch.mjs')).href}?hardlink-proof=${artifact}-${Date.now()}`;
      const hook = (await import(helperUrl)) as {
        resolveCurrentStoreDbPath(path: string): string | null;
        openLockedReadOnlyStoreDatabase(dbDir: string, dbPath: string): { close(): void };
      };

      expect(hook.resolveCurrentStoreDbPath(dbDir)).toBeNull();
      expect(() => hook.openLockedReadOnlyStoreDatabase(dbDir, epochPath(dbDir, '1'))).toThrow();
      console.log(
        `generated-hook-hardlink-cell artifact=${artifact} resolved=none nlink=${statSync(aliasPath).nlink} byte-identical=${readFileSync(aliasPath).equals(before)}`,
      );
      expect(readFileSync(aliasPath)).toEqual(before);
    },
  );

  it.each(['.mint-invalid', '.preparing-invalid', '.reaping-invalid', 'epoch-1'] as const)(
    'reclaims %s when its regular lock is not a SQLite database',
    async (name) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(epochDirectory(dbDir, '3'), true);
      publishAdversarialEpoch(epochDirectory(dbDir, '5'), true);
      const target = join(dbDir, name);
      if (name === 'epoch-1') publishAdversarialEpoch(target, true);
      else mkdirSync(target);
      writeFileSync(join(target, '.lock'), 'not a SQLite database');

      const result = await sweepStoreEpochsPostReady(runtime, dbDir, '5');

      console.log(`malformed-lock-reclamation-cell namespace=${name} result=${result} remaining=${existsSync(target)}`);
      expect(result).toBe('complete');
      expect(existsSync(target)).toBe(false);
    },
  );

  it.each(['.mint-wrong-kind', '.preparing-wrong-kind', '.reaping-wrong-kind'] as const)(
    'lists and sweeps a wrong-kind %s residue consistently',
    async (name) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(epochDirectory(dbDir, '1'), true);
      const target = join(dbDir, name);
      writeFileSync(target, 'wrong-kind');

      const listed = listStoreEpochResidues(runtime);
      const result = await sweepStoreEpochsPostReady(runtime, dbDir, '1');

      console.log(
        `wrong-kind-residue-cell namespace=${name} listed=${listed[0]?.state ?? 'missing'} result=${result} remaining=${existsSync(target)}`,
      );
      expect(listed).toEqual([{ name, bytes: 'wrong-kind'.length, state: 'reclaimable' }]);
      expect(result).toBe('complete');
      expect(existsSync(target)).toBe(false);
    },
  );

  it('does not acquire an exclusive lock while listing holders and residues', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(epochDirectory(dbDir, '1'), true);
    writeFileSync(join(dbDir, '.epoch-holder-list.json'), JSON.stringify({ epoch: '1', pid: process.pid }));
    const residue = join(dbDir, '.mint-list');
    mkdirSync(residue);
    createSharedFileLockSync(join(residue, '.lock'))();
    const lockBefore = fileTreeSnapshot(dbDir);

    const holders = listStoreEpochHolders(runtime);
    const residues = listStoreEpochResidues(runtime);
    const lockAfter = fileTreeSnapshot(dbDir);

    console.log(
      `read-only-list-cell holders=${holders.map(({ state }) => state).join(',')} residues=${residues.map(({ state }) => state).join(',')} byte-identical=${JSON.stringify(lockAfter) === JSON.stringify(lockBefore)}`,
    );
    expect(lockAfter).toEqual(lockBefore);
    expect(holders).toEqual([{ id: 'list', epoch: '1', pid: process.pid, state: 'unobservable' }]);
    expect(residues).toEqual([{ name: '.mint-list', bytes: expect.any(Number), state: 'unobservable' }]);
  });

  it.each(['directory', 'legacy-symlink', 'external-symlink', 'socket'] as const)(
    'classifies a valid current epoch with a %s lock as unusable without touching legacy state',
    async (lockKind) => {
      const runtime = harness();
      const dbDir = runtime.paths.coral.store.dbDir;
      publishAdversarialEpoch(epochDirectory(dbDir, '1'), true);
      const lock = storeEpochLockPath(dbDir, '1');
      rmSync(lock, { force: true });

      const legacyRoot = join(dirname(dbDir), 'legacy-tree');
      const legacyStore = join(legacyRoot, 'store.db');
      createCrashedWalStore(legacyStore);
      const externalStore = join(dirname(dbDir), 'external-lock.db');
      writeFileSync(externalStore, 'external-lock-sentinel');
      let closeSocket: (() => Promise<void>) | undefined;
      if (lockKind === 'directory') mkdirSync(lock);
      if (lockKind === 'legacy-symlink') symlinkSync(legacyStore, lock);
      if (lockKind === 'external-symlink') symlinkSync(externalStore, lock);
      if (lockKind === 'socket') {
        const server = createServer();
        await new Promise<void>((resolveListen, reject) => {
          server.once('error', reject);
          server.listen(lock, resolveListen);
        });
        closeSocket = () =>
          new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          );
      }
      const legacyBefore = fileTreeSnapshot(legacyRoot);
      const externalBefore = readFileSync(externalStore);

      let settled: ReturnType<typeof settleStoreEpoch> | undefined;
      try {
        expect(listStoreEpochs(runtime, storeFormat).find(({ epoch }) => epoch === '1')?.classification.kind).toBe(
          'unavailable',
        );
        expect(() => openReadOnlyStoreDatabase(runtime, { path: epochPath(dbDir, '1'), storeFormat })).toThrow();
        settled = settleStoreEpoch(runtime, options());
        const legacyAfter = fileTreeSnapshot(legacyRoot);
        console.log(
          `malformed-lock-cell kind=${lockKind} boot=proceeded selected-epoch=${settled.epoch} legacy-byte-identical=${JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore)}`,
        );
        expect(settled.epoch).toBe('2');
        expect(legacyAfter).toEqual(legacyBefore);
        expect(readFileSync(externalStore)).toEqual(externalBefore);
      } finally {
        settled?.db.close();
        await closeSocket?.();
      }
    },
  );

  it('keeps the generated hook out of a legacy store named by a symlinked epoch lock', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(epochDirectory(dbDir, '1'), true);
    const legacyRoot = join(dirname(dbDir), 'hook-legacy-tree');
    const legacyStore = join(legacyRoot, 'store.db');
    createCrashedWalStore(legacyStore);
    rmSync(storeEpochLockPath(dbDir, '1'));
    symlinkSync(legacyStore, storeEpochLockPath(dbDir, '1'));
    const before = fileTreeSnapshot(legacyRoot);
    const helperUrl = `${pathToFileURL(join(process.cwd(), 'clients/hooks/lib/store-epoch.mjs')).href}?lock-proof=${Date.now()}`;
    const hook = (await import(helperUrl)) as {
      resolveCurrentStoreDbPath(path: string): string | null;
      openLockedReadOnlyStoreDatabase(dbDir: string, dbPath: string): unknown;
    };

    expect(hook.resolveCurrentStoreDbPath(dbDir)).toBeNull();
    expect(() => hook.openLockedReadOnlyStoreDatabase(dbDir, epochPath(dbDir, '1'))).toThrow();
    const after = fileTreeSnapshot(legacyRoot);
    console.log(
      `generated-hook-malformed-lock-cell resolved=none open=refused legacy-byte-identical=${JSON.stringify(after) === JSON.stringify(before)}`,
    );
    expect(after).toEqual(before);
  });

  it('lists and converges K lockless mints and K partial-cleanup residues', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const residueCount = 8;
    for (let index = 0; index < residueCount; index += 1) {
      mkdirSync(join(dbDir, `.mint-lockless-${index}`));
      createCompatibleStore(join(dbDir, `.mint-partial-cleanup-${index}`, 'store.db'), `partial-${index}`);
    }

    const listed = listStoreEpochResidues(runtime);
    expect(listed).toHaveLength(residueCount * 2);
    expect(new Set(listed.map(({ state }) => state))).toEqual(new Set(['reclaimable']));

    const result = await sweepStoreEpochsPostReady(runtime, dbDir, '1');
    const remaining = listStoreEpochResidues(runtime);
    console.log(
      `mint-residue-cell lockless=${residueCount} partial-cleanup=${residueCount} listed-state=${listed[0]?.state} result=${result} remaining=${remaining.length}`,
    );
    expect(result).toBe('complete');
    expect(remaining).toEqual([]);
  });

  it('does not sweep the coordinator epoch while its settled database is open', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    const settled = settleStoreEpoch(runtime, options());
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);
    try {
      expect(await sweepStoreEpochsPostReady(runtime, dbDir, '5')).toBe('live-holder');
      expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
      console.log('post-ready-coordinator-descriptor-cell result=live-holder epoch-1=present');
    } finally {
      settled.db.close();
    }
  });

  it('protects a KB daemon holder published after the sweep directory snapshot', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-5'), true);
    let releaseSnapshot!: () => void;
    let snapshotTaken!: () => void;
    const snapshot = new Promise<void>((resolveSnapshot) => {
      snapshotTaken = resolveSnapshot;
    });
    const resume = new Promise<void>((resolveResume) => {
      releaseSnapshot = resolveResume;
    });
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readdir') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string): Promise<string[]> => {
          const entries = await subject.readdir(path);
          if (path === dbDir) {
            snapshotTaken();
            await resume;
          }
          return entries;
        };
      },
    });
    const sweep = sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '5');
    await snapshot;
    const kbDatabase = openWritableStoreDbNoReset(runtime, { path: epochPath(dbDir, '1'), storeFormat });
    releaseSnapshot();
    try {
      expect(await sweep).toBe('live-holder');
      expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
      console.log('post-ready-kb-descriptor-cell holder-after-snapshot=true epoch-1=present');
    } finally {
      kbDatabase.close();
    }
  });

  it('cancels a slow sweep before shutdown can expose its address to a successor', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'rollback');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'));
    let releaseSnapshot!: () => void;
    let snapshotTaken!: () => void;
    const snapshot = new Promise<void>((resolveSnapshot) => {
      snapshotTaken = resolveSnapshot;
    });
    const resume = new Promise<void>((resolveResume) => {
      releaseSnapshot = resolveResume;
    });
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readdir') return Reflect.get(subject, property, receiver) as unknown;
        return async (path: string): Promise<string[]> => {
          const entries = await subject.readdir(path);
          if (path === dbDir) {
            snapshotTaken();
            await resume;
          }
          return entries;
        };
      },
    });
    const controller = new AbortController();
    const sweep = sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3', {
      signal: controller.signal,
    });
    await snapshot;
    controller.abort();
    releaseSnapshot();

    expect(await sweep).toBe('cancelled');
    expect(existsSync(flatStorePath(dbDir))).toBe(true);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
    const successor = settleStoreEpoch(runtime, options());
    expect(successor.epoch).toBe('4');
    successor.db.close();
    const rollback = new DatabaseSync(flatStorePath(dbDir), { readOnly: true });
    expect((rollback.prepare('SELECT value FROM rollback_sentinel').get() as { value: string }).value).toBe('rollback');
    rollback.close();
    console.log('shutdown-sweep-cell result=cancelled successor=epoch-4 rollback=bootable');
  });

  it('syncs an epoch removal before returning cancellation after the sweep yield', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publishAdversarialEpoch(join(dbDir, `epoch-${epoch}`), true);
    const controller = new AbortController();
    const events: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property === 'rm') {
          return async (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): Promise<void> => {
            await subject.rm(path, rmOptions);
            if (basename(path).startsWith('.reaping-')) {
              events.push('epoch-removed');
              controller.abort();
            }
          };
        }
        if (property === 'syncDirectoryDurable') {
          return async (path: string): Promise<boolean> => {
            if (path === dbDir) events.push('parent-sync');
            return subject.syncDirectoryDurable(path);
          };
        }
        return Reflect.get(subject, property, receiver) as unknown;
      },
    });

    await expect(
      sweepStoreEpochsPostReady(withStorage(runtime, storage), dbDir, '3', { signal: controller.signal }),
    ).resolves.toBe('cancelled');
    expect(events).toEqual(['epoch-removed', 'parent-sync']);
    console.log('sweep-barrier-cell site=post-ready-cancellation mutation=true exit=cancelled parent-sync=after');
  });

  it('releases the socket guard when discard cannot acquire the adoption lock', async () => {
    const baseRuntime = harness();
    const { adoptionLock } = resolveGenerationBoundaryPaths(baseRuntime);
    mkdirSync(dirname(adoptionLock), { recursive: true });
    const held = acquireDirectoryLockSync(adoptionLock, {
      storage: baseRuntime.storage,
      time: baseRuntime.time,
    });
    let monotonicMs = 0n;
    const runtime = {
      ...baseRuntime,
      time: {
        ...baseRuntime.time,
        monotonicNow: () => {
          monotonicMs += 1_000n;
          return monotonicMs;
        },
        sleep: async () => undefined,
      },
    };
    let socketReleased = false;
    try {
      await expect(
        discardStoreReset({
          target: 'gen2',
          runtime,
          build,
          storeFormat,
          currentBundleDir: '/test/bundle',
          acquireSocketGuard: async () => ({
            release: async () => {
              socketReleased = true;
            },
          }),
        }),
      ).rejects.toMatchObject({ code: 'legacy_source_not_quiescent' });
      expect(socketReleased).toBe(true);
    } finally {
      held();
    }
  });

  it('reports a deletion failure separately from durability', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const target = epochDirectory(dbDir, '1');
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'rmSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): void => {
          if (basename(path).startsWith('.reaping-')) {
            throw Object.assign(new Error('injected deletion failure'), { code: 'EACCES' });
          }
          subject.rmSync(path, rmOptions);
        };
      },
    });

    const released = await releaseStoreReset({ target: 'gen2', runtime: withStorage(runtime, storage), epoch: '1' });

    expect(released.kind).toBe('release-deletion-failed');
    expect(existsSync(target)).toBe(false);
    expect(listStoreEpochResidues(runtime).map(({ state }) => state)).toEqual(['unobservable']);
  });

  it('durably syncs an epoch adopted after its publisher died following rename', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createIncompatibleStore(flatStorePath(dbDir));
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

  it('refuses to release an old positive epoch held by a live coordinator', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    createCompatibleStore(flatStorePath(dbDir), 'flat');
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const oldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(oldPath, async (pid) => {
      publishLiveCoordinator(runtime, pid, '1');
      const released = await releaseStoreReset({ target: 'gen2', runtime, epoch: '1' });

      expect(released.kind).toBe('release-holder-live');
      expect(existsSync(oldPath)).toBe(true);
      console.log('ordinary-live-release-cell target=epoch-1 current=3 released=false reason=open-epoch');
    });
  });

  it('does not sweep an epoch held by a live child when discovery names its dead parent', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishAdversarialEpoch(join(dbDir, 'epoch-1'), true);
    publishAdversarialEpoch(join(dbDir, 'epoch-3'), true);
    const oldPath = epochPath(dbDir, '1');

    await withLiveSqliteDescriptor(oldPath, async () => {
      publishLiveCoordinator(runtime, 999_999_991);
      expect(sweepStoreEpochs(runtime, dbDir, '3')).toBe('unobservable-metadata');
      expect(existsSync(oldPath)).toBe(true);
      console.log('dead-parent-live-child-cell parent=absent child=live removed=false');
    });
  });

  it('keeps the opened epoch usable when the post-publication sweep fails', async () => {
    const runtime = harness();
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-3'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-2'), true);
    publishAdversarialEpoch(join(runtime.paths.coral.store.dbDir, 'epoch-1'), true);
    createCompatibleStore(flatStorePath(runtime.paths.coral.store.dbDir), 'garbage');
    const storage = new Proxy(runtime.storage, {
      get(target, property, receiver) {
        if (property !== 'rm') return Reflect.get(target, property, receiver) as unknown;
        return async (path: string, rmOptions?: { recursive?: boolean; force?: boolean }): Promise<void> => {
          if (basename(path).startsWith('.reaping-')) {
            throw Object.assign(new Error('injected sweep failure'), { code: 'EIO' });
          }
          await target.rm(path, rmOptions);
        };
      },
    });

    const settled = settleStoreEpoch(withStorage(runtime, storage), options());

    expect(settled.epoch).toBe('3');
    publishLiveCoordinator(runtime, runtime.env.pid());
    await expect(
      sweepStoreEpochsPostReady(withStorage(runtime, storage), runtime.paths.coral.store.dbDir, settled.epoch),
    ).resolves.toBe('deletion-failed');
    settled.db.close();
    expect(existsSync(flatStorePath(runtime.paths.coral.store.dbDir))).toBe(true);
  });

  it('syncs the epoch root after post-publication sweep removals', () => {
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
    expect(sweepStoreEpochs(withStorage(runtime, storage), dbDir, settled.epoch)).toBe('complete');

    let lastRemoval = -1;
    let lastRootSync = -1;
    events.forEach((event, index) => {
      if (event.startsWith('remove:')) lastRemoval = index;
      if (event === `sync:${dbDir}`) lastRootSync = index;
    });
    expect(lastRemoval).toBeGreaterThanOrEqual(0);
    expect(lastRootSync).toBeGreaterThan(lastRemoval);
    console.log('post-publication-sweep-durability-cell removals=1 parent-sync=after');
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
      expect(sweepStoreEpochs(withStorage(runtime, storage), dbDir, settled.epoch)).toBe('complete');

      for (const [original, backup] of backups) renameSync(backup, original);
      backups.clear();
    }

    expect(listStoreEpochs(runtime, storeFormat).filter(({ role }) => role === 'garbage')).toEqual([]);
    console.log('post-publication-sweep-power-loss-cell repetitions=3 accumulated-garbage=0');
  });
});
