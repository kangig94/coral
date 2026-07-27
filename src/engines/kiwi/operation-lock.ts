import { isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import {
  acquirePackageOperationLockAtPath,
  PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
} from '../../infra/package-operation-lock.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';
import { KIWI_INSTALL_ONLY_ID } from './constants.js';

type KiwiPackageOperationOptions = {
  readonly lockTimeoutMs?: number;
  readonly operationLockHeld?: true;
};

export type KiwiPackageOperationLockError = {
  readonly status: 'error';
  readonly code: string;
  readonly userMessage: string;
  readonly remediation: string;
  readonly context?: Record<string, unknown>;
};

function lockContendedError(): KiwiPackageOperationLockError {
  const error = documentedCoralSetupError('expansion_install_lock_contended', { name: KIWI_INSTALL_ONLY_ID });
  return {
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  };
}

export async function withKiwiPackageOperationLock<T>(
  runtime: Runtime,
  options: KiwiPackageOperationOptions,
  run: () => Promise<T>,
): Promise<T | KiwiPackageOperationLockError> {
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
