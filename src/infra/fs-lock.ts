import { mkdirSync, rmSync, statSync } from 'node:fs';
import type { StoragePort, TimePort } from './port-types.js';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DirectoryLockDeps = {
  storage: Pick<StoragePort, 'mkdirSync' | 'rmSync' | 'statSync'>;
  time: Pick<TimePort, 'now' | 'sleep'>;
};

export class DirectoryLockTimeoutError extends Error {
  constructor(lockDir: string) {
    super(`Directory lock timeout: ${lockDir}`);
    this.name = 'DirectoryLockTimeoutError';
    Object.setPrototypeOf(this, DirectoryLockTimeoutError.prototype);
  }
}

function waitSync(ms: number): void {
  Atomics.wait(syncWaitState, 0, 0, ms);
}

function isDirectoryLockDeps(value: DirectoryLockDeps | number | undefined): value is DirectoryLockDeps {
  return typeof value === 'object' && value !== null && 'storage' in value && 'time' in value;
}

export function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export function isDirectoryLockTimeoutError(error: unknown): error is DirectoryLockTimeoutError {
  return error instanceof DirectoryLockTimeoutError;
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
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.now() + effectiveTimeoutMs;

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

  throw new DirectoryLockTimeoutError(lockDir);
}

export function acquireDirectoryLockSync(lockDir: string, timeoutMs?: number): () => void;
export function acquireDirectoryLockSync(lockDir: string, deps: DirectoryLockDeps, timeoutMs?: number): () => void;
export function acquireDirectoryLockSync(
  lockDir: string,
  depsOrTimeout: DirectoryLockDeps | number = 5000,
  timeoutMs = 5000,
): () => void {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.now() + effectiveTimeoutMs;

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

    // Sync retry sleeping intentionally stays on Atomics.wait. DirectoryLockDeps
    // only provides async sleep until a sync time abstraction is introduced.
    waitSync(LOCK_RETRY_INTERVAL_MS);
  }

  throw new DirectoryLockTimeoutError(lockDir);
}
