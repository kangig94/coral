import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { StoragePort, TimePort, TimerHandle } from './port-types.js';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DirectoryLockDeps = {
  storage: Pick<
    StoragePort,
    | 'closeSync'
    | 'mkdirSync'
    | 'openSync'
    | 'readdirSync'
    | 'renameSync'
    | 'rmSync'
    | 'rmdirSync'
    | 'statSync'
    | 'unlinkSync'
    | 'writeFileSync'
    | 'writeSync'
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

export class DirectoryLockOwnershipLostError extends Error {
  constructor(lockDir: string) {
    super(`Directory lock ownership lost: ${lockDir}`);
    this.name = 'DirectoryLockOwnershipLostError';
    Object.setPrototypeOf(this, DirectoryLockOwnershipLostError.prototype);
  }
}

export type DirectoryLockLease = (() => void) & {
  assertOwned(): void;
};

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
      openSync,
      readdirSync,
      renameSync,
      rmSync,
      rmdirSync,
      statSync,
      unlinkSync,
      writeFileSync,
      writeSync,
      closeSync,
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

function refreshLockOwnerMarker(ownerPath: string, ownerToken: string, deps: DirectoryLockDeps): void {
  let fd: number | null = null;
  try {
    fd = deps.storage.openSync(ownerPath, 'r+');
    deps.storage.writeSync(fd, Buffer.from(ownerToken), 0, Buffer.byteLength(ownerToken), 0);
  } finally {
    if (fd !== null) {
      deps.storage.closeSync(fd);
    }
  }
}

function startDirectoryLockHeartbeat(
  lockDir: string,
  ownerToken: string,
  deps: DirectoryLockDeps,
  loseOwnership: () => void,
): TimerHandle {
  const ownerPath = lockOwnerMarkerPath(lockDir, ownerToken);
  const staleMs = deps.staleMs ?? STALE_LOCK_MS;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3));
  return deps.time.setInterval(() => {
    try {
      refreshLockOwnerMarker(ownerPath, ownerToken, deps);
    } catch {
      loseOwnership();
    }
  }, heartbeatMs);
}

function releaseDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  ownerToken: string,
  heartbeat: TimerHandle,
  isOwned: () => boolean,
  loseOwnership: () => void,
): DirectoryLockLease {
  const release = (() => {
    loseOwnership();
    deps.time.clearInterval(heartbeat);
    tryRemoveOwnedLockDirectory(lockDir, ownerToken, deps.storage);
  }) as DirectoryLockLease;
  release.assertOwned = () => {
    if (!isOwned()) {
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
    try {
      deps.storage.statSync(lockOwnerMarkerPath(lockDir, ownerToken));
    } catch {
      loseOwnership();
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
  };
  return release;
}

function ownerMarkerEntries(lockDir: string, deps: DirectoryLockDeps): string[] {
  try {
    return deps.storage.readdirSync(lockDir).filter((entry) => entry.startsWith('owner-') && entry.endsWith('.lock'));
  } catch {
    return [];
  }
}

function markerIsStale(markerPath: string, deps: DirectoryLockDeps): boolean {
  try {
    return deps.time.now() - deps.storage.statSync(markerPath).mtimeMs > (deps.staleMs ?? STALE_LOCK_MS);
  } catch {
    return false;
  }
}

function directoryIsStale(lockDir: string, deps: DirectoryLockDeps): boolean {
  try {
    return deps.time.now() - deps.storage.statSync(lockDir).mtimeMs > (deps.staleMs ?? STALE_LOCK_MS);
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Claims a stale owner marker with an atomic rename before deleting anything.
 * Heartbeats update an already-open file descriptor, so a refresh racing with
 * the rename updates the claimed inode and makes the post-claim stale check
 * fail. Other contenders cannot claim the marker after it has moved.
 */
function tryQuarantineStaleLock(lockDir: string, deps: DirectoryLockDeps): boolean {
  const ownerEntries = ownerMarkerEntries(lockDir, deps);
  const [ownerEntry] = ownerEntries;
  if (ownerEntry === undefined) {
    let entries: string[];
    try {
      entries = deps.storage.readdirSync(lockDir);
    } catch {
      return false;
    }
    if (entries.some((entry) => entry.startsWith('claim-')) || !directoryIsStale(lockDir, deps)) {
      return false;
    }
    const quarantinePath = `${lockDir}.stale-${randomUUID()}`;
    try {
      deps.storage.renameSync(lockDir, quarantinePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return false;
      }
      throw error;
    }
    tryRemoveLockDirectory(quarantinePath, deps.storage);
    return true;
  }
  if (ownerEntries.length !== 1) {
    return false;
  }
  const ownerPath = join(lockDir, ownerEntry);
  if (!markerIsStale(ownerPath, deps)) {
    return false;
  }

  const claimPath = join(lockDir, `claim-${randomUUID()}.lock`);
  try {
    deps.storage.renameSync(ownerPath, claimPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }

  if (!markerIsStale(claimPath, deps)) {
    try {
      deps.storage.renameSync(claimPath, ownerPath);
    } catch {
      // The holder may have released while its refreshed claim was restored.
    }
    return false;
  }

  const quarantinePath = `${lockDir}.stale-${randomUUID()}`;
  try {
    deps.storage.renameSync(lockDir, quarantinePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
  tryRemoveLockDirectory(quarantinePath, deps.storage);
  return true;
}

function createDirectoryLockLease(lockDir: string, ownerToken: string, deps: DirectoryLockDeps): DirectoryLockLease {
  let owned = true;
  const loseOwnership = () => {
    owned = false;
  };
  const heartbeat = startDirectoryLockHeartbeat(lockDir, ownerToken, deps, loseOwnership);
  return releaseDirectoryLock(lockDir, deps, ownerToken, heartbeat, () => owned, loseOwnership);
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

export async function acquireDirectoryLock(lockDir: string, timeoutMs?: number): Promise<DirectoryLockLease>;
export async function acquireDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  timeoutMs?: number,
): Promise<DirectoryLockLease>;
export async function acquireDirectoryLock(
  lockDir: string,
  depsOrTimeout: DirectoryLockDeps | number = 5000,
  timeoutMs = 5000,
): Promise<DirectoryLockLease> {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.now() + effectiveTimeoutMs;

  while (deps.time.now() < deadline) {
    throwIfDirectoryLockAborted(deps);
    try {
      deps.storage.mkdirSync(lockDir);
      const ownerToken = randomUUID();
      writeLockOwnerMarker(lockDir, ownerToken, deps.storage);
      return createDirectoryLockLease(lockDir, ownerToken, deps);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (tryQuarantineStaleLock(lockDir, deps)) {
      continue;
    }

    await waitForDirectoryLockRetry(deps);
  }

  throwIfDirectoryLockAborted(deps);
  throw new DirectoryLockTimeoutError(lockDir);
}

export function acquireDirectoryLockSync(lockDir: string, timeoutMs?: number): DirectoryLockLease;
export function acquireDirectoryLockSync(
  lockDir: string,
  deps: DirectoryLockDeps,
  timeoutMs?: number,
): DirectoryLockLease;
export function acquireDirectoryLockSync(
  lockDir: string,
  depsOrTimeout: DirectoryLockDeps | number = 5000,
  timeoutMs = 5000,
): DirectoryLockLease {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.now() + effectiveTimeoutMs;

  while (deps.time.now() < deadline) {
    try {
      deps.storage.mkdirSync(lockDir);
      const ownerToken = randomUUID();
      writeLockOwnerMarker(lockDir, ownerToken, deps.storage);
      return createDirectoryLockLease(lockDir, ownerToken, deps);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    if (tryQuarantineStaleLock(lockDir, deps)) {
      continue;
    }

    // Sync retry sleeping intentionally stays on Atomics.wait. DirectoryLockDeps
    // only provides async sleep until a sync time abstraction is introduced.
    waitSync(LOCK_RETRY_INTERVAL_MS);
  }

  throw new DirectoryLockTimeoutError(lockDir);
}
