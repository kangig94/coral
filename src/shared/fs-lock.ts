import { mkdirSync, rmdirSync, statSync } from 'node:fs';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function waitSync(ms: number): void {
  Atomics.wait(syncWaitState, 0, 0, ms);
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function tryRemoveLockDirectory(lockDir: string): void {
  try {
    rmdirSync(lockDir);
  } catch {
    /* empty */
  }
}

function releaseDirectoryLock(lockDir: string): () => void {
  return () => {
    tryRemoveLockDirectory(lockDir);
  };
}

function isStaleLock(lockDir: string): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export async function acquireDirectoryLock(lockDir: string, timeoutMs = 5000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return releaseDirectoryLock(lockDir);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (isStaleLock(lockDir)) {
      tryRemoveLockDirectory(lockDir);
      continue;
    }

    await wait(LOCK_RETRY_INTERVAL_MS);
  }

  throw new Error(`Directory lock timeout: ${lockDir}`);
}

export function acquireDirectoryLockSync(lockDir: string, timeoutMs = 5000): () => void {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return releaseDirectoryLock(lockDir);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (isStaleLock(lockDir)) {
      tryRemoveLockDirectory(lockDir);
      continue;
    }

    waitSync(LOCK_RETRY_INTERVAL_MS);
  }

  throw new Error(`Directory lock timeout: ${lockDir}`);
}
