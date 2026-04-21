import { mkdirSync, rmSync, statSync } from 'node:fs';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export class DirectoryLockTimeoutError extends Error {
  constructor(lockDir) {
    super(`Directory lock timeout: ${lockDir}`);
    this.name = 'DirectoryLockTimeoutError';
    Object.setPrototypeOf(this, DirectoryLockTimeoutError.prototype);
  }
}

function waitSync(ms) {
  Atomics.wait(syncWaitState, 0, 0, ms);
}

function isDirectoryLockDeps(value) {
  return typeof value === 'object' && value !== null && 'storage' in value && 'time' in value;
}

export function isAlreadyExistsError(error) {
  return error instanceof Error && error.code === 'EEXIST';
}

export function isDirectoryLockTimeoutError(error) {
  return error instanceof DirectoryLockTimeoutError;
}

function resolveDirectoryLockDeps(deps) {
  if (deps) {
    return deps;
  }

  return {
    storage: {
      mkdirSync,
      rmSync,
      statSync,
    },
    time: {
      now: () => new Date().getTime(),
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    },
  };
}

function tryRemoveLockDirectory(lockDir, storage) {
  try {
    storage.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

function releaseDirectoryLock(lockDir, storage) {
  return () => {
    tryRemoveLockDirectory(lockDir, storage);
  };
}

function isStaleLock(lockDir, deps) {
  try {
    return deps.time.now() - deps.storage.statSync(lockDir).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export async function acquireDirectoryLock(lockDir, depsOrTimeout = 5000, timeoutMs = 5000) {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.now() + effectiveTimeoutMs;

  while (deps.time.now() < deadline) {
    try {
      deps.storage.mkdirSync(lockDir);
      return releaseDirectoryLock(lockDir, deps.storage);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    if (isStaleLock(lockDir, deps)) {
      tryRemoveLockDirectory(lockDir, deps.storage);
      continue;
    }

    await deps.time.sleep(LOCK_RETRY_INTERVAL_MS);
  }

  throw new DirectoryLockTimeoutError(lockDir);
}

export function acquireDirectoryLockSync(lockDir, depsOrTimeout = 5000, timeoutMs = 5000) {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.now() + effectiveTimeoutMs;

  while (deps.time.now() < deadline) {
    try {
      deps.storage.mkdirSync(lockDir);
      return releaseDirectoryLock(lockDir, deps.storage);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    if (isStaleLock(lockDir, deps)) {
      tryRemoveLockDirectory(lockDir, deps.storage);
      continue;
    }

    waitSync(LOCK_RETRY_INTERVAL_MS);
  }

  throw new DirectoryLockTimeoutError(lockDir);
}
