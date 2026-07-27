import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoragePort, TimePort, TimerHandle } from './port-types.js';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DirectoryLockDeps = {
  storage: Pick<
    StoragePort,
    'mkdirSync' | 'readdirSync' | 'rmSync' | 'rmdirSync' | 'statSync' | 'unlinkSync' | 'writeFileSync'
  >;
  time: Pick<TimePort, 'now' | 'sleep' | 'setInterval' | 'clearInterval'>;
  staleMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
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

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
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
      readdirSync,
      rmSync,
      rmdirSync,
      statSync,
      unlinkSync,
      writeFileSync,
    },
    time: {
      now: () => new Date().getTime(),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }),
      setInterval: (fn, ms) => {
        const timer = setInterval(fn, ms);
        timer.unref?.();
        return timer;
      },
      clearInterval: (handle) => {
        if (handle !== null) {
          clearInterval(handle as NodeJS.Timeout);
        }
      },
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

function lockOwnerMarkerPath(lockDir: string, ownerToken: string): string {
  return join(lockDir, `owner-${ownerToken}.lock`);
}

function writeLockOwnerMarker(lockDir: string, ownerToken: string, storage: DirectoryLockDeps['storage']): void {
  try {
    storage.writeFileSync(lockOwnerMarkerPath(lockDir, ownerToken), ownerToken, { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    tryRemoveLockDirectory(lockDir, storage);
    throw error;
  }
}

function tryRemoveOwnedLockDirectory(lockDir: string, ownerToken: string, storage: DirectoryLockDeps['storage']): void {
  try {
    storage.unlinkSync(lockOwnerMarkerPath(lockDir, ownerToken));
  } catch {
    return;
  }

  try {
    storage.rmdirSync(lockDir);
  } catch {
    // Another owner can appear after stale stealing; leave its non-empty lock.
  }
}

function startDirectoryLockHeartbeat(lockDir: string, ownerToken: string, deps: DirectoryLockDeps): TimerHandle {
  const ownerPath = lockOwnerMarkerPath(lockDir, ownerToken);
  const staleMs = deps.staleMs ?? STALE_LOCK_MS;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3));
  return deps.time.setInterval(() => {
    try {
      deps.storage.statSync(ownerPath);
      deps.storage.writeFileSync(ownerPath, ownerToken, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // The owner marker vanished, so this holder was fenced out. The release
      // path remains token-safe and will not remove a replacement lock.
    }
  }, heartbeatMs);
}

function releaseDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  ownerToken: string,
  heartbeat: TimerHandle,
): () => void {
  return () => {
    deps.time.clearInterval(heartbeat);
    tryRemoveOwnedLockDirectory(lockDir, ownerToken, deps.storage);
  };
}

function latestLockMtime(lockDir: string, deps: DirectoryLockDeps): number {
  let latest = deps.storage.statSync(lockDir).mtimeMs;
  for (const entry of deps.storage.readdirSync(lockDir)) {
    if (!entry.startsWith('owner-') || !entry.endsWith('.lock')) {
      continue;
    }
    try {
      latest = Math.max(latest, deps.storage.statSync(join(lockDir, entry)).mtimeMs);
    } catch {
      // A concurrent release may remove the marker between list and stat.
    }
  }
  return latest;
}

function isStaleLock(lockDir: string, deps: DirectoryLockDeps): boolean {
  try {
    return deps.time.now() - latestLockMtime(lockDir, deps) > (deps.staleMs ?? STALE_LOCK_MS);
  } catch {
    return false;
  }
}

function throwIfDirectoryLockAborted(deps: DirectoryLockDeps): void {
  deps.signal?.throwIfAborted();
}

async function waitForDirectoryLockRetry(deps: DirectoryLockDeps): Promise<void> {
  const signal = deps.signal;
  if (signal === undefined) {
    await deps.time.sleep(LOCK_RETRY_INTERVAL_MS);
    return;
  }

  signal.throwIfAborted();
  let abortHandler: (() => void) | null = null;
  const abort = new Promise<never>((_, reject) => {
    abortHandler = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    if (signal.aborted) {
      abortHandler();
    }
  });

  try {
    await Promise.race([deps.time.sleep(LOCK_RETRY_INTERVAL_MS), abort]);
  } finally {
    if (abortHandler !== null) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
  signal.throwIfAborted();
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
    throwIfDirectoryLockAborted(deps);
    try {
      deps.storage.mkdirSync(lockDir);
      const ownerToken = randomUUID();
      writeLockOwnerMarker(lockDir, ownerToken, deps.storage);
      const heartbeat = startDirectoryLockHeartbeat(lockDir, ownerToken, deps);
      return releaseDirectoryLock(lockDir, deps, ownerToken, heartbeat);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (isStaleLock(lockDir, deps)) {
      tryRemoveLockDirectory(lockDir, deps.storage);
      continue;
    }

    await waitForDirectoryLockRetry(deps);
  }

  throwIfDirectoryLockAborted(deps);
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
      const ownerToken = randomUUID();
      writeLockOwnerMarker(lockDir, ownerToken, deps.storage);
      const heartbeat = startDirectoryLockHeartbeat(lockDir, ownerToken, deps);
      return releaseDirectoryLock(lockDir, deps, ownerToken, heartbeat);
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
