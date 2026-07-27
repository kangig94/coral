import { acquireDirectoryLock } from '../infra/fs-lock.js';
import type { Runtime } from '../runtime/ports.js';
import { assertExpansionPackageId } from './package-id.js';

export const PACKAGE_OPERATION_LOCK_TIMEOUT_MS = 250;
export const PACKAGE_OPERATION_LOCK_STALE_MS = 10 * 60 * 1000;
export const PACKAGE_OPERATION_LOCK_HEARTBEAT_MS = 10 * 1000;

export async function acquirePackageOperationLock(
  runtime: Runtime,
  packageId: string,
  timeoutMs = PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
): Promise<() => void> {
  const id = assertExpansionPackageId(packageId);
  runtime.storage.mkdirSync(runtime.paths.coral.engine.operationLockRoot, { recursive: true });
  return acquireDirectoryLock(
    runtime.paths.coral.engine.installLockPath(id),
    {
      storage: runtime.storage,
      time: runtime.time,
      staleMs: PACKAGE_OPERATION_LOCK_STALE_MS,
      heartbeatMs: PACKAGE_OPERATION_LOCK_HEARTBEAT_MS,
    },
    timeoutMs,
  );
}
