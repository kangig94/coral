import { dirname } from 'node:path';
import { acquireDirectoryLock, type DirectoryLockDeps, type DirectoryLockLease } from './fs-lock.js';

export const PACKAGE_OPERATION_LOCK_TIMEOUT_MS = 250;
export const PACKAGE_OPERATION_LOCK_STALE_MS = 10 * 60 * 1000;
export const PACKAGE_OPERATION_LOCK_HEARTBEAT_MS = 10 * 1000;

type PackageOperationLockDeps = Pick<DirectoryLockDeps, 'storage' | 'time'>;

export async function acquirePackageOperationLockAtPath(
  lockPath: string,
  deps: PackageOperationLockDeps,
  timeoutMs = PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
): Promise<DirectoryLockLease> {
  deps.storage.mkdirSync(dirname(lockPath), { recursive: true });
  return acquireDirectoryLock(
    lockPath,
    {
      storage: deps.storage,
      time: deps.time,
      staleMs: PACKAGE_OPERATION_LOCK_STALE_MS,
      heartbeatMs: PACKAGE_OPERATION_LOCK_HEARTBEAT_MS,
    },
    timeoutMs,
  );
}
