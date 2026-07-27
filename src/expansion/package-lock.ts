import {
  acquirePackageOperationLockAtPath,
  PACKAGE_OPERATION_LOCK_HEARTBEAT_MS,
  PACKAGE_OPERATION_LOCK_STALE_MS,
  PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
} from '../infra/package-operation-lock.js';
import type { DirectoryLockLease } from '../infra/fs-lock.js';
import type { Runtime } from '../runtime/ports.js';
import { assertExpansionPackageId } from './package-id.js';

export { PACKAGE_OPERATION_LOCK_HEARTBEAT_MS, PACKAGE_OPERATION_LOCK_STALE_MS, PACKAGE_OPERATION_LOCK_TIMEOUT_MS };

export async function acquirePackageOperationLock(
  runtime: Runtime,
  packageId: string,
  timeoutMs = PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
): Promise<DirectoryLockLease> {
  const id = assertExpansionPackageId(packageId);
  return acquirePackageOperationLockAtPath(
    runtime.paths.coral.engine.installLockPath(id),
    {
      storage: runtime.storage,
      time: runtime.time,
    },
    timeoutMs,
  );
}
