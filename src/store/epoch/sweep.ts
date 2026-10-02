import { type StoragePort } from '../../infra/port-types.js';
import { join } from 'node:path';
import { type Runtime } from '../../runtime/ports.js';
import { attemptExclusiveFileLockSync } from '../../infra/fs-lock.js';
import { probeCoordinator } from '../../infra/backend-discovery.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from '../reset-incident.js';
import { auditSweepFailure } from './sweep-audit.js';
import { errorCode } from './classification.js';
import { REAPING_DIRECTORY_PREFIX } from './constants.js';
import { type StoreEpoch, type StoreEpochSweepResult } from './types.js';
import {
  epochDirectory,
  observeContainedDirectory,
  observeStoreEpochLock,
  storeEpochLockPath,
  proveReleaseTarget,
  compareEpoch,
} from './observation.js';
import { readEpochMetadata } from './metadata.js';
import { observeStoreEpochHolders } from './holder.js';

function treeStaysOnDevice(storage: StoragePort, path: string, device: bigint): boolean {
  const entry = storage.lstatSync(path, { bigint: true });
  if (entry.dev !== device) return false;
  return (
    !entry.isDirectory() ||
    storage.readdirSync(path).every((child) => treeStaysOnDevice(storage, join(path, child), device))
  );
}

export async function treeStaysOnDeviceAsync(storage: StoragePort, path: string, device: bigint): Promise<boolean> {
  const entry = storage.lstatSync(path, { bigint: true });
  if (entry.dev !== device) return false;
  if (!entry.isDirectory()) return true;
  for (const child of await storage.readdir(path)) {
    if (!(await treeStaysOnDeviceAsync(storage, join(path, child), device))) return false;
  }
  return true;
}

function removeDuringSweep(storage: StoragePort, dbDir: string, path: string): boolean {
  try {
    const observed = storage.lstatSync(path);
    const device = storage.lstatSync(dbDir, { bigint: true }).dev;
    if (!treeStaysOnDevice(storage, path, device)) {
      auditSweepFailure(path, new Error('Recursive removal crossed the store device boundary.'));
      return false;
    }
    if (observed.isDirectory() && !observed.isSymbolicLink()) {
      storage.rmSync(path, { recursive: true, force: true });
    } else {
      storage.unlinkSync(path);
    }
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return true;
    auditSweepFailure(path, error);
    return false;
  }
}

export type LockedRemoval = 'removed' | 'locked' | 'target-failed' | 'lock-release-failed';

export function renameForReaping(runtime: Runtime, dbDir: string, targetPath: string): string | null {
  const reapingPath = join(dbDir, `${REAPING_DIRECTORY_PREFIX}${runtime.ids.uuid()}`);
  try {
    runtime.storage.renameSync(targetPath, reapingPath);
    return reapingPath;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    auditSweepFailure(targetPath, error);
    return targetPath;
  }
}

function removeAfterReapingRename(runtime: Runtime, dbDir: string, targetPath: string): LockedRemoval {
  const reapingPath = renameForReaping(runtime, dbDir, targetPath);
  if (reapingPath === null) return 'removed';
  if (reapingPath === targetPath) return 'target-failed';
  return removeDuringSweep(runtime.storage, dbDir, reapingPath) ? 'removed' : 'target-failed';
}

function removeWhileExclusivelyLocked(
  runtime: Runtime,
  dbDir: string,
  lockPath: string,
  targetPath: string,
): LockedRemoval {
  const attempt = attemptExclusiveFileLockSync(lockPath);
  if (attempt.kind === 'malformed') return removeAfterReapingRename(runtime, dbDir, targetPath);
  if (attempt.kind === 'unobservable') {
    auditSweepFailure(lockPath, attempt.cause);
    return 'target-failed';
  }
  if (attempt.kind === 'contended') return 'locked';
  const removal = removeAfterReapingRename(runtime, dbDir, targetPath);
  try {
    attempt.lease();
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'lock-release-failed';
  }
  return removal;
}

export function removeEpochEntry(
  runtime: Runtime,
  dbDir: string,
  epoch: StoreEpoch,
  closureEpochKey?: string,
): LockedRemoval {
  const targetPath = epochDirectory(dbDir, epoch);
  const root = observeContainedDirectory(runtime.storage, dbDir, targetPath);
  if (root.kind === 'unobservable') return 'target-failed';
  if (root.kind === 'disproven') return removeAfterReapingRename(runtime, dbDir, targetPath);
  const lock = observeStoreEpochLock(runtime.storage, dbDir, epoch, root);
  if (lock.kind === 'unobservable') return 'target-failed';
  if (lock.kind === 'disproven') {
    return readEpochMetadata(runtime.storage, targetPath).kind === 'valid'
      ? 'target-failed'
      : removeAfterReapingRename(runtime, dbDir, targetPath);
  }
  if (closureEpochKey !== undefined) {
    const marker = join(targetPath, '.coral-closed-reaping.v1.json');
    if (
      !runtime.storage.writeAtomicDurableSync(
        marker,
        `${JSON.stringify({ version: 'v1', epochKey: closureEpochKey, epoch })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    )
      return 'target-failed';
  }
  return removeWhileExclusivelyLocked(runtime, dbDir, storeEpochLockPath(dbDir, epoch), targetPath);
}

type StoreEpochHolderCleanupResult =
  | Readonly<{ kind: 'unobservable' }>
  | Readonly<{
      kind: 'cleaned';
      changed: boolean;
      deletionFailed: boolean;
      releaseHolderLive: boolean;
      unobservableHolder: boolean;
    }>;

function cleanStoreEpochHolders(
  runtime: Runtime,
  dbDir: string,
  releaseEpoch: StoreEpoch | undefined,
): StoreEpochHolderCleanupResult {
  const holderRead = observeStoreEpochHolders(runtime, dbDir, true);
  if (holderRead.kind === 'unobservable') return holderRead;

  let changed = false;
  let deletionFailed = false;
  let releaseHolderLive = false;
  let unobservableHolder = false;
  for (const holder of holderRead.holders) {
    if (holder.state === 'live') {
      releaseHolderLive ||= holder.epoch === releaseEpoch;
      continue;
    }
    if (holder.state === 'unobservable' && (releaseEpoch === undefined || !holder.removable)) {
      unobservableHolder = true;
      continue;
    }
    try {
      changed = true;
      const removed = removeDuringSweep(runtime.storage, dbDir, holder.path);
      deletionFailed ||= !removed;
      if (holder.state === 'unobservable') unobservableHolder = true;
    } finally {
      holder.proof?.();
    }
  }
  return { kind: 'cleaned', changed, deletionFailed, releaseHolderLive, unobservableHolder };
}

function syncStoreEpochSweepDirectory(storage: StoragePort, dbDir: string): boolean {
  try {
    return storage.syncDirectoryDurableSync(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return false;
  }
}

function guardStoreEpochSweepCoordinator(
  runtime: Runtime,
  dbDir: string,
  releaseEpoch: StoreEpoch | undefined,
): StoreEpochSweepResult | null {
  try {
    const coordinator = probeCoordinator(runtime);
    if (
      coordinator.kind === 'unobservable' ||
      (coordinator.kind === 'absent' && releaseEpoch === undefined) ||
      (coordinator.kind === 'live' &&
        coordinator.record.pid !== runtime.env.pid() &&
        (releaseEpoch === undefined ||
          coordinator.record.storeEpoch === undefined ||
          coordinator.record.storeEpoch === releaseEpoch))
    ) {
      return coordinator.kind === 'live' ? 'live-holder' : 'unobservable-metadata';
    }
    return null;
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'unobservable-metadata';
  }
}

function releaseStoreEpochDuringSweep(
  runtime: Runtime,
  dbDir: string,
  releaseEpoch: StoreEpoch,
  assertOwned: (() => void) | undefined,
): StoreEpochSweepResult {
  assertOwned?.();
  const proof = proveReleaseTarget(runtime.storage, dbDir, releaseEpoch);
  if (proof === 'current') return 'current';
  if (proof === 'unobservable') return 'unobservable-metadata';
  if (proof === 'absent') {
    return syncStoreEpochSweepDirectory(runtime.storage, dbDir) ? 'absent' : 'absent-durability-sync-failed';
  }

  return 'closure-required';
}

export function sweepStoreEpochs(
  runtime: Runtime,
  configuredDbDir: string,
  current: StoreEpoch | null,
  options: {
    readonly assertOwned?: () => void;
    readonly releaseEpoch?: StoreEpoch;
  } = {},
): StoreEpochSweepResult {
  const { storage } = runtime;
  const dbDir = storage.realpathSync(configuredDbDir);
  if (options.releaseEpoch !== undefined) {
    const initialReleaseProof = proveReleaseTarget(storage, dbDir, options.releaseEpoch);
    if (initialReleaseProof === 'current') return 'current';
    if (initialReleaseProof === 'unobservable') return 'unobservable-metadata';
  }

  const holderCleanup = cleanStoreEpochHolders(runtime, dbDir, options.releaseEpoch);
  if (holderCleanup.kind === 'unobservable') return 'unobservable-holder';
  if (holderCleanup.changed && !syncStoreEpochSweepDirectory(storage, dbDir)) {
    return options.releaseEpoch === undefined ? 'durability-sync-failed' : 'pre-deletion-durability-sync-failed';
  }
  if (holderCleanup.deletionFailed) {
    return options.releaseEpoch === undefined ? 'deletion-failed' : 'holder-cleanup-failed';
  }
  if (holderCleanup.unobservableHolder) return 'unobservable-holder';
  if (holderCleanup.releaseHolderLive) return 'live-holder';

  const coordinatorResult = guardStoreEpochSweepCoordinator(runtime, dbDir, options.releaseEpoch);
  if (coordinatorResult !== null) return coordinatorResult;

  if (options.releaseEpoch !== undefined) {
    return releaseStoreEpochDuringSweep(runtime, dbDir, options.releaseEpoch, options.assertOwned);
  }

  if (current === null) return 'unobservable-metadata';

  let complete = true;
  if (compareEpoch(current, '1') >= 0) {
    complete = removeDuringSweep(storage, dbDir, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY)) && complete;
  }
  if (!syncStoreEpochSweepDirectory(storage, dbDir)) return 'durability-sync-failed';
  if (!complete) return 'deletion-failed';
  return 'complete';
}
