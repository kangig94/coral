import { type Runtime } from '../../runtime/ports.js';
import { type FileLockLease, acquireSharedFileLockSync, attemptExclusiveFileLockSync } from '../../infra/fs-lock.js';
import { type SuccessionWriterEntitlement } from '../succession-writer-generation.js';
import { type Database } from '../db.js';
import { observeStorePath } from '../path-observation.js';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { type ResolvedStoreEpoch, type StoreEpochHolderListEntry } from './types.js';
import {
  storeEpochLockPath,
  observeStoreEpoch,
  storeEpochHolderPath,
  observeContainedRegularFile,
  epochDirectory,
  observeContainedDirectory,
  observeStoreEpochLock,
  resolveObservedStoreRoot,
  observeContainedRegularFileAsync,
  observeContainedDirectoryAsync,
  observeStoreEpochLockAsync,
} from './observation.js';
import {
  STORE_EPOCH_HOLDER_PUBLICATION_ATTEMPTS,
  EPOCH_HOLDER_PREFIX,
  MAX_STORE_EPOCH_HOLDER_BYTES,
} from './constants.js';
import { isRecord } from './metadata.js';
import { errorCode } from './classification.js';
import type { RetentionRunBudget } from '../retention-outcome.js';

export function parkableEpochReadLease(
  runtime: Pick<Runtime, 'storage'>,
  epoch: ResolvedStoreEpoch,
  lease: FileLockLease,
  writerEntitlement: SuccessionWriterEntitlement,
): FileLockLease {
  let held: FileLockLease | null = lease;
  let released = false;
  const releaseHeld = (): void => {
    const current = held;
    held = null;
    current?.();
  };
  const unregisterPark = writerEntitlement.onPark(releaseHeld);
  const unregisterUnpark = writerEntitlement.onUnpark(() => {
    if (released || held !== null) return;
    held = acquireStoreEpochReadLock(runtime, epoch);
    if (held === null) throw new Error(`Store epoch ${epoch.epoch} is no longer proven for writer reclaim.`);
  });
  return () => {
    released = true;
    unregisterPark();
    unregisterUnpark();
    releaseHeld();
  };
}

export function acquireStoreEpochReadLock(
  runtime: Pick<Runtime, 'storage'>,
  resolved: ResolvedStoreEpoch,
  busyTimeoutMs = 5_000,
): FileLockLease | null {
  const lease = acquireSharedFileLockSync(storeEpochLockPath(resolved.storeRoot, resolved.epoch), busyTimeoutMs);
  const observation = observeStoreEpoch(runtime.storage, resolved.storeRoot, `epoch-${resolved.epoch}`);
  if (observation?.proof.kind === 'proven') return lease;
  lease();
  return null;
}

export function holdStoreEpochLockUntilClose(db: Database, lease: FileLockLease | null): Database {
  if (lease === null) return db;
  const close = db.close.bind(db);
  let closed = false;
  Object.defineProperty(db, 'close', {
    configurable: true,
    value: () => {
      if (closed) return;
      closed = true;
      try {
        close();
      } finally {
        lease();
      }
    },
  });
  return db;
}

export function registerStoreEpochHolder(
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage'>,
  resolved: ResolvedStoreEpoch,
  db: Database,
  lease: FileLockLease,
): Database {
  let holderPath: string | undefined;
  try {
    for (let attempt = 0; attempt < STORE_EPOCH_HOLDER_PUBLICATION_ATTEMPTS; attempt += 1) {
      const candidate = storeEpochHolderPath(resolved.storeRoot, runtime.ids.uuid());
      if (
        runtime.storage.writeAtomicDurableSync(
          candidate,
          `${JSON.stringify({ epoch: resolved.epoch, pid: runtime.env.pid() })}\n`,
          {
            encoding: 'utf-8',
            mode: 0o600,
            stagePath: join(dirname(resolved.path), `.holder-stage-${runtime.env.pid()}-${runtime.ids.uuid()}`),
          },
        )
      ) {
        holderPath = candidate;
        break;
      }
      if (observeStorePath(runtime.storage, candidate) === 'present') break;
    }
    if (holderPath === undefined) {
      throw new Error(`Failed to publish store epoch ${resolved.epoch} holder.`);
    }
  } catch (error: unknown) {
    db.close();
    lease();
    throw error;
  }
  const close = db.close.bind(db);
  let closed = false;
  Object.defineProperty(db, 'close', {
    configurable: true,
    value: () => {
      if (closed) return;
      closed = true;
      try {
        close();
      } finally {
        try {
          runtime.storage.unlinkSync(holderPath);
          runtime.storage.syncDirectoryDurableSync(resolved.storeRoot);
        } catch {
          // A failed holder-file removal must not keep the store lease held.
        } finally {
          lease();
        }
      }
    },
  });
  return db;
}

type StoreEpochHolderObservation = StoreEpochHolderListEntry &
  Readonly<{ entry: string; path: string; removable: boolean; proof: FileLockLease | null }>;

function observeStoreEpochHolder(runtime: Runtime, dbDir: string, entry: string): StoreEpochHolderObservation | null {
  const path = join(dbDir, entry);
  const id = entry.slice(EPOCH_HOLDER_PREFIX.length, -'.json'.length);
  const unobservable = (removable: boolean): StoreEpochHolderObservation => ({
    id,
    entry,
    path,
    epoch: null,
    pid: null,
    state: 'unobservable',
    removable,
    proof: null,
  });
  try {
    const proof = observeContainedRegularFile(runtime.storage, dbDir, path, { kind: 'proven' });
    if (proof.kind !== 'proven') return unobservable(false);
    if (runtime.storage.statSync(path).size > MAX_STORE_EPOCH_HOLDER_BYTES) return unobservable(false);
    const value: unknown = JSON.parse(runtime.storage.readFileSync(path, 'utf-8'));
    if (
      !isRecord(value) ||
      typeof value.epoch !== 'string' ||
      !/^[1-9]\d*$/.test(value.epoch) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0
    ) {
      return unobservable(false);
    }
    const pid = Number(value.pid);
    const directory = epochDirectory(dbDir, value.epoch);
    const rootProof = observeContainedDirectory(runtime.storage, dbDir, directory);
    const lockProof = observeStoreEpochLock(runtime.storage, dbDir, value.epoch, rootProof);

    if (lockProof.kind !== 'proven')
      return { id, entry, path, epoch: value.epoch, pid, state: 'unobservable', removable: false, proof: null };
    return {
      id,
      entry,
      path,
      epoch: value.epoch,
      pid,
      state: 'unobservable',
      removable: false,
      proof: null,
    };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return unobservable(false);
  }
}

function inspectStoreEpochHolder(runtime: Runtime, dbDir: string, entry: string): StoreEpochHolderObservation | null {
  const holder = observeStoreEpochHolder(runtime, dbDir, entry);
  if (holder === null || holder.pid === null) return holder;
  const owner = runtime.process.observeLiveness(holder.pid);
  const attempt =
    owner === 'absent' && holder.epoch !== null
      ? attemptExclusiveFileLockSync(storeEpochLockPath(dbDir, holder.epoch))
      : null;
  return {
    ...holder,
    state: owner === 'absent' ? 'stale' : owner === 'alive' ? 'live' : 'unobservable',
    removable: owner === 'absent',
    proof: attempt?.kind === 'acquired' ? attempt.lease : null,
  };
}

export function observeStoreEpochHolders(
  runtime: Runtime,
  dbDir: string,
  inspectLiveness = false,
):
  | Readonly<{ kind: 'observed'; holders: readonly StoreEpochHolderObservation[] }>
  | Readonly<{ kind: 'unobservable' }> {
  let entries: readonly string[];
  try {
    entries = runtime.storage.readdirSync(dbDir);
  } catch {
    return { kind: 'unobservable' };
  }
  const holders: StoreEpochHolderObservation[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(EPOCH_HOLDER_PREFIX) || !entry.endsWith('.json')) continue;
    const holder = inspectLiveness
      ? inspectStoreEpochHolder(runtime, dbDir, entry)
      : observeStoreEpochHolder(runtime, dbDir, entry);
    if (holder !== null) holders.push(holder);
  }
  return { kind: 'observed', holders };
}

export function listStoreEpochHolders(runtime: Runtime): readonly StoreEpochHolderListEntry[] {
  let root: ReturnType<typeof resolveObservedStoreRoot>;
  try {
    root = resolveObservedStoreRoot(runtime.storage, runtime.paths.coral.store.dbDir);
  } catch {
    return [{ id: 'unobservable', epoch: null, pid: null, state: 'unobservable' }];
  }
  if (root.kind === 'absent') return [];
  const dbDir = root.path;
  const observed = observeStoreEpochHolders(runtime, dbDir);
  if (observed.kind === 'unobservable') {
    return [{ id: 'unobservable', epoch: null, pid: null, state: 'unobservable' }];
  }
  return observed.holders.map(({ id, epoch, pid, state, proof }) => {
    proof?.();
    return { id, epoch, pid, state };
  });
}

async function observeStoreEpochHolderAsync(
  runtime: Runtime,
  dbDir: string,
  entry: string,
): Promise<StoreEpochHolderObservation | null> {
  const path = join(dbDir, entry);
  const id = entry.slice(EPOCH_HOLDER_PREFIX.length, -'.json'.length);
  const unobservable = (removable: boolean): StoreEpochHolderObservation => ({
    id,
    entry,
    path,
    epoch: null,
    pid: null,
    state: 'unobservable',
    removable,
    proof: null,
  });
  try {
    const proof = await observeContainedRegularFileAsync(runtime.storage, dbDir, path, { kind: 'proven' });
    if (proof.kind !== 'proven') return unobservable(false);
    const kind = await runtime.storage.lstat(path);
    if (kind.size > MAX_STORE_EPOCH_HOLDER_BYTES) return unobservable(false);
    const value: unknown = JSON.parse(await runtime.storage.readFile(path, 'utf-8'));
    if (
      !isRecord(value) ||
      typeof value.epoch !== 'string' ||
      !/^[1-9]\d*$/u.test(value.epoch) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0
    ) {
      return unobservable(false);
    }
    const pid = Number(value.pid);
    const directory = epochDirectory(dbDir, value.epoch);
    const rootProof = await observeContainedDirectoryAsync(runtime.storage, dbDir, directory);
    const lockProof = await observeStoreEpochLockAsync(runtime.storage, dbDir, value.epoch, rootProof);
    if (lockProof.kind !== 'proven')
      return { id, entry, path, epoch: value.epoch, pid, state: 'unobservable', removable: false, proof: null };
    return {
      id,
      entry,
      path,
      epoch: value.epoch,
      pid,
      state: 'unobservable',
      removable: false,
      proof: null,
    };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return unobservable(false);
  }
}

export async function inspectStoreEpochHolderAsync(
  runtime: Runtime,
  dbDir: string,
  entry: string,
): Promise<StoreEpochHolderObservation | null> {
  const holder = await observeStoreEpochHolderAsync(runtime, dbDir, entry);
  if (holder === null || holder.pid === null) return holder;
  const owner = runtime.process.observeLiveness(holder.pid);
  const attempt =
    owner === 'absent' && holder.epoch !== null
      ? attemptExclusiveFileLockSync(storeEpochLockPath(dbDir, holder.epoch))
      : null;
  return {
    ...holder,
    state: owner === 'absent' ? 'stale' : owner === 'alive' ? 'live' : 'unobservable',
    removable: owner === 'absent',
    proof: attempt?.kind === 'acquired' ? attempt.lease : null,
  };
}

export async function pruneStoreEpochHolders(
  runtime: Runtime,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
  afterName = '',
  checkpoint: (nextName: string) => void = () => {},
): Promise<string> {
  const root = runtime.paths.coral.store.dbDir;
  if (!budget.canContinue()) return afterName;
  const entries = (await runtime.storage.readdir(root)).sort();
  let cursor = afterName;
  for (const entry of entries) {
    if (entry <= afterName) continue;
    if (!budget.canContinue()) return cursor;
    if (entry.startsWith(EPOCH_HOLDER_PREFIX)) {
      const subject = join(root, entry);
      try {
        const identity = runtime.storage.lstatSync(subject, { bigint: true });
        const holder =
          entry.endsWith('.json') || entry.endsWith('.json.tmp')
            ? await inspectStoreEpochHolderAsync(runtime, root, entry)
            : null;
        if (holder?.state !== 'stale' || !holder.removable) {
          budget.record({
            kind: 'kept',
            subject,
            reason: 'holder-alive-or-unknown',
            pending: holder?.state !== 'live',
          });
        } else {
          try {
            if (!budget.canContinue()) return cursor;
            mutate(() => {
              try {
                const current = runtime.storage.lstatSync(subject, { bigint: true });
                if (
                  !current.isFile() ||
                  current.dev !== identity.dev ||
                  current.ino !== identity.ino ||
                  current.mtimeNs !== identity.mtimeNs
                )
                  throw new Error('holder-entry-identity-changed');
                runtime.storage.unlinkSync(subject);
              } catch (error: unknown) {
                if (errorCode(error) !== 'ENOENT') throw error;
              }
              if (!runtime.storage.syncDirectoryDurableSync(root)) throw new Error('holder-directory-sync-failed');
            });
            budget.record({ kind: 'deleted', subject, count: 1 });
          } finally {
            holder.proof?.();
          }
        }
      } catch (error: unknown) {
        budget.record({ kind: 'failed', subject, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    cursor = entry;
    checkpoint(cursor);
    await setImmediate();
  }
  checkpoint('');
  return '';
}
