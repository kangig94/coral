import { isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import {
  acquirePackageOperationLockAtPath,
  PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
} from '../../infra/package-operation-lock.js';
import type { Runtime } from '../../runtime/ports.js';
import { KIWI_INSTALL_ONLY_ID } from './constants.js';
import { kiwiInstallError, type KiwiInstallError } from './install-error.js';

export type KiwiPackageOperationOptions = {
  readonly lockTimeoutMs?: number;
  readonly operationLockHeld?: true;
};

function lockContendedError(): KiwiInstallError {
  return kiwiInstallError('expansion_install_lock_contended', { name: KIWI_INSTALL_ONLY_ID });
}

export async function withKiwiPackageOperationLock<T>(
  runtime: Runtime,
  options: KiwiPackageOperationOptions,
  run: () => Promise<T>,
): Promise<T | KiwiInstallError> {
  if (options.operationLockHeld === true) {
    return run();
  }

  let lease: Awaited<ReturnType<typeof acquirePackageOperationLockAtPath>>;
  try {
    lease = await acquirePackageOperationLockAtPath(
      runtime.paths.coral.engine.installLockPath(KIWI_INSTALL_ONLY_ID),
      {
        storage: runtime.storage,
        time: runtime.time,
      },
      options.lockTimeoutMs ?? PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return lockContendedError();
    }
    throw error;
  }

  try {
    const result = await run();
    lease.assertOwned();
    return result;
  } finally {
    lease();
  }
}
