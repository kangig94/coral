import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoragePort, TimePort, TimerHandle } from './port-types.js';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DirectoryLockDeps = {
  storage: Pick<
    StoragePort,
    'mkdirSync' | 'readdirSync' | 'renameSync' | 'rmSync' | 'rmdirSync' | 'statSync' | 'unlinkSync' | 'writeFileSync'
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
      renameSync,
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
  storage.writeFileSync(lockOwnerMarkerPath(lockDir, ownerToken), ownerToken, { encoding: 'utf-8', mode: 0o600 });
}

type LockDirectoryIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

function readLockDirectoryIdentity(
  lockDir: string,
  storage: DirectoryLockDeps['storage'],
): LockDirectoryIdentity | null {
  try {
    const stat = storage.statSync(lockDir, { bigint: true });
    return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function lockDirectoryIdentityMatches(
  lockDir: string,
  expected: LockDirectoryIdentity,
  storage: DirectoryLockDeps['storage'],
): boolean {
  const current = readLockDirectoryIdentity(lockDir, storage);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

function tryRemoveOwnedLockDirectory(
  lockDir: string,
  ownerToken: string,
  expectedIdentity: LockDirectoryIdentity,
  storage: DirectoryLockDeps['storage'],
): void {
  const ownsExpectedDirectory = lockDirectoryIdentityMatches(lockDir, expectedIdentity, storage);
  try {
    storage.unlinkSync(lockOwnerMarkerPath(lockDir, ownerToken));
  } catch {
    return;
  }

  if (!ownsExpectedDirectory) {
    return;
  }
  try {
    if (!lockDirectoryIdentityMatches(lockDir, expectedIdentity, storage)) {
      return;
    }
    storage.rmdirSync(lockDir);
  } catch {
    // Another owner can appear after stale stealing; leave its non-empty lock.
  }
}

function ownerMarkerEntries(lockDir: string, deps: DirectoryLockDeps): string[] {
  try {
    return deps.storage.readdirSync(lockDir).filter((entry) => entry.startsWith('owner-') && entry.endsWith('.lock'));
  } catch {
    return [];
  }
}

function ownsLockDirectory(
  lockDir: string,
  ownerToken: string,
  expectedIdentity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
): boolean {
  if (!lockDirectoryIdentityMatches(lockDir, expectedIdentity, deps.storage)) {
    return false;
  }
  const entries = ownerMarkerEntries(lockDir, deps);
  return (
    entries.length === 1 && entries[0] === `owner-${ownerToken}.lock` && claimMarkerEntries(lockDir, deps).length === 0
  );
}

/**
 * Refresh by atomically moving the owner marker out of the claimable name.
 * A stale claimant and a heartbeat therefore compete on the same rename:
 * exactly one wins, and no open descriptor can refresh an already-checked
 * claim after the claimant has decided to quarantine it.
 */
function refreshLockOwnerMarker(
  lockDir: string,
  ownerToken: string,
  expectedIdentity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
): void {
  if (!lockDirectoryIdentityMatches(lockDir, expectedIdentity, deps.storage)) {
    throw new DirectoryLockOwnershipLostError(lockDir);
  }
  const ownerPath = lockOwnerMarkerPath(lockDir, ownerToken);
  const refreshPath = join(lockDir, `claim-refresh-${ownerToken}.lock`);
  deps.storage.renameSync(ownerPath, refreshPath);
  try {
    deps.storage.writeFileSync(refreshPath, ownerToken, { encoding: 'utf-8', mode: 0o600, flag: 'r+' });
    if (!lockDirectoryIdentityMatches(lockDir, expectedIdentity, deps.storage)) {
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
    deps.storage.renameSync(refreshPath, ownerPath);
  } catch (error) {
    if (lockDirectoryIdentityMatches(lockDir, expectedIdentity, deps.storage)) {
      try {
        deps.storage.renameSync(refreshPath, ownerPath);
      } catch {
        /* stale claim recovery handles an interrupted refresh */
      }
    }
    throw error;
  }
  if (!ownsLockDirectory(lockDir, ownerToken, expectedIdentity, deps)) {
    throw new DirectoryLockOwnershipLostError(lockDir);
  }
}

function startDirectoryLockHeartbeat(
  lockDir: string,
  ownerToken: string,
  expectedIdentity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
  loseOwnership: () => void,
): TimerHandle {
  const staleMs = deps.staleMs ?? STALE_LOCK_MS;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3));
  return deps.time.setInterval(() => {
    try {
      refreshLockOwnerMarker(lockDir, ownerToken, expectedIdentity, deps);
    } catch {
      loseOwnership();
    }
  }, heartbeatMs);
}

function releaseDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  ownerToken: string,
  expectedIdentity: LockDirectoryIdentity,
  heartbeat: TimerHandle,
  isOwned: () => boolean,
  loseOwnership: () => void,
): DirectoryLockLease {
  const release = (() => {
    loseOwnership();
    deps.time.clearInterval(heartbeat);
    tryRemoveOwnedLockDirectory(lockDir, ownerToken, expectedIdentity, deps.storage);
  }) as DirectoryLockLease;
  release.assertOwned = () => {
    if (!isOwned()) {
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
    try {
      refreshLockOwnerMarker(lockDir, ownerToken, expectedIdentity, deps);
    } catch {
      loseOwnership();
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
  };
  return release;
}

function claimMarkerEntries(lockDir: string, deps: DirectoryLockDeps): string[] {
  try {
    return deps.storage.readdirSync(lockDir).filter((entry) => entry.startsWith('claim-') && entry.endsWith('.lock'));
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

function quarantineClaimedLock(
  lockDir: string,
  claimPath: string,
  restorePath: string,
  deps: DirectoryLockDeps,
): boolean {
  const quarantinePath = `${lockDir}.stale-${randomUUID()}`;
  try {
    deps.storage.renameSync(lockDir, quarantinePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    try {
      deps.storage.renameSync(claimPath, restorePath);
    } catch {
      // A later contender can recover the stale claim if restoration loses a
      // race or the claimant crashes during this error path.
    }
    throw error;
  }
  tryRemoveLockDirectory(quarantinePath, deps.storage);
  return true;
}

/**
 * Claims a stale owner marker with an atomic rename before deleting anything.
 * Heartbeats rename that same marker through a claim-prefixed refresh path, so
 * a refresh and a stale claimant cannot both win. Other contenders cannot
 * claim the marker after it has moved.
 */
function tryQuarantineStaleLock(lockDir: string, deps: DirectoryLockDeps): boolean {
  const ownerEntries = ownerMarkerEntries(lockDir, deps);
  const [ownerEntry] = ownerEntries;
  if (ownerEntry === undefined) {
    const claimEntries = claimMarkerEntries(lockDir, deps);
    if (claimEntries.length === 1) {
      const staleClaimPath = join(lockDir, claimEntries[0]);
      if (!markerIsStale(staleClaimPath, deps)) {
        return false;
      }
      const recoveryClaimPath = join(lockDir, `claim-${randomUUID()}.lock`);
      try {
        deps.storage.renameSync(staleClaimPath, recoveryClaimPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          return false;
        }
        throw error;
      }
      if (!markerIsStale(recoveryClaimPath, deps)) {
        try {
          deps.storage.renameSync(recoveryClaimPath, staleClaimPath);
        } catch {
          /* recoverable after the marker becomes stale */
        }
        return false;
      }
      return quarantineClaimedLock(lockDir, recoveryClaimPath, staleClaimPath, deps);
    }
    if (claimEntries.length > 1) {
      return false;
    }
    if (!directoryIsStale(lockDir, deps)) {
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

  return quarantineClaimedLock(lockDir, claimPath, ownerPath, deps);
}

function createDirectoryLockLease(
  lockDir: string,
  ownerToken: string,
  identity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
): DirectoryLockLease {
  let owned = true;
  const loseOwnership = () => {
    owned = false;
  };
  const heartbeat = startDirectoryLockHeartbeat(lockDir, ownerToken, identity, deps, loseOwnership);
  return releaseDirectoryLock(lockDir, deps, ownerToken, identity, heartbeat, () => owned, loseOwnership);
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Publishes ownership through atomic mkdir and fences the short marker-write
 * window with the directory's device/inode identity. If stale recovery replaces
 * that directory before this creator resumes, identity verification prevents
 * the displaced creator from returning a lease or removing the replacement.
 */
function tryCreateDirectoryLock(lockDir: string, deps: DirectoryLockDeps): DirectoryLockLease | null {
  const ownerToken = randomUUID();
  try {
    deps.storage.mkdirSync(lockDir);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return null;
    }
    throw error;
  }

  const identity = readLockDirectoryIdentity(lockDir, deps.storage);
  if (identity === null) {
    throw new DirectoryLockOwnershipLostError(lockDir);
  }
  // If this write fails, leave the markerless publication for stale recovery.
  // Deleting by pathname could race with another process replacing the directory.
  writeLockOwnerMarker(lockDir, ownerToken, deps.storage);

  if (!ownsLockDirectory(lockDir, ownerToken, identity, deps)) {
    tryRemoveOwnedLockDirectory(lockDir, ownerToken, identity, deps.storage);
    throw new DirectoryLockOwnershipLostError(lockDir);
  }
  return createDirectoryLockLease(lockDir, ownerToken, identity, deps);
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
    const lease = tryCreateDirectoryLock(lockDir, deps);
    if (lease !== null) {
      return lease;
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
    const lease = tryCreateDirectoryLock(lockDir, deps);
    if (lease !== null) {
      return lease;
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
