import { mkdirSync, rmSync, statSync } from 'node:fs';
import type { RuntimeStoragePort, RuntimeTimePort } from '../execution/runtime.js';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DirectoryLockDeps = {
  storage: Pick<RuntimeStoragePort, 'mkdirSync' | 'rmSync' | 'statSync'>;
  time: Pick<RuntimeTimePort, 'now' | 'sleep'>;
};

function waitSync(ms: number): void {
  Atomics.wait(syncWaitState, 0, 0, ms);
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function resolveDirectoryLockDeps(deps?: DirectoryLockDeps): DirectoryLockDeps {
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
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }),
    },
  };
}

function tryRemoveLockDirectory(lockDir: string, storage: DirectoryLockDeps['storage']): void {
  try {
    storage.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* empty */
  }
}

function releaseDirectoryLock(lockDir: string, storage: DirectoryLockDeps['storage']): () => void {
  return () => {
    tryRemoveLockDirectory(lockDir, storage);
  };
}

function isStaleLock(lockDir: string, deps: DirectoryLockDeps): boolean {
  try {
    return deps.time.now() - deps.storage.statSync(lockDir).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export async function acquireDirectoryLock(lockDir: string, timeoutMs?: number): Promise<() => void>;
export async function acquireDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  timeoutMs?: number,
): Promise<() => void>;
export async function acquireDirectoryLock(
  lockDir: string,
  depsOrTimeout: DirectoryLockDeps | number = 5000,
  timeoutMs = 5000,
): Promise<() => void> {
  if (typeof depsOrTimeout === 'number') {
    const deps = resolveDirectoryLockDeps();
    const deadline = deps.time.now() + depsOrTimeout;

    while (deps.time.now() < deadline) {
      try {
        deps.storage.mkdirSync(lockDir);
        return releaseDirectoryLock(lockDir, deps.storage);
      } catch (error: unknown) {
        if (!isAlreadyExistsError(error)) throw error;
      }

      if (isStaleLock(lockDir, deps)) {
        tryRemoveLockDirectory(lockDir, deps.storage);
        continue;
      }

      await deps.time.sleep(LOCK_RETRY_INTERVAL_MS);
    }

    throw new Error(`Directory lock timeout: ${lockDir}`);
  }

  const deps = resolveDirectoryLockDeps(depsOrTimeout);
  const deadline = deps.time.now() + timeoutMs;

  while (deps.time.now() < deadline) {
    try {
      deps.storage.mkdirSync(lockDir);
      return releaseDirectoryLock(lockDir, deps.storage);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (isStaleLock(lockDir, deps)) {
      tryRemoveLockDirectory(lockDir, deps.storage);
      continue;
    }

    await deps.time.sleep(LOCK_RETRY_INTERVAL_MS);
  }

  throw new Error(`Directory lock timeout: ${lockDir}`);
}

export function acquireDirectoryLockSync(lockDir: string, timeoutMs = 5000): () => void {
  const deps = resolveDirectoryLockDeps();
  const deadline = deps.time.now() + timeoutMs;

  while (deps.time.now() < deadline) {
    try {
      deps.storage.mkdirSync(lockDir);
      return releaseDirectoryLock(lockDir, deps.storage);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (isStaleLock(lockDir, deps)) {
      tryRemoveLockDirectory(lockDir, deps.storage);
      continue;
    }

    waitSync(LOCK_RETRY_INTERVAL_MS);
  }

  throw new Error(`Directory lock timeout: ${lockDir}`);
}
