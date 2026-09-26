import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  createRecordedProcessObserver,
  observeProcessLiveness,
  probeProcessIncarnation,
  readPidNamespace,
  type ProcessIncarnation,
  type ProcessLiveness,
  type RecordedProcessObserver,
} from './node-process.js';
import { persistedProcessIncarnationSchema } from './persisted-scalar-contracts.js';
import type { StoragePort, TimePort, TimerHandle } from './port-types.js';
import type { StorageActuator } from './storage-actuator.js';

const LOCK_RETRY_INTERVAL_MS = 50;
const STALE_LOCK_MS = 30_000;
const syncWaitState = new Int32Array(new SharedArrayBuffer(4));

export type DirectoryLockOwner = Readonly<{
  pid: number;
  incarnation: ProcessIncarnation | null;
  pidNamespace: string | null;
}>;

/** Who this process records as a lock's owner, and how it observes an owner another process recorded. */
export type DirectoryLockOwnerProbe = Readonly<{
  self: DirectoryLockOwner;
  observe: RecordedProcessObserver;
}>;

export type DirectoryLockDeps = {
  storage: StoragePort;
  time: Pick<TimePort, 'now' | 'monotonicNow' | 'sleep' | 'setInterval' | 'clearInterval'>;
  staleMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
  owner?: DirectoryLockOwnerProbe;
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
  maintain(): void;
};

export type ActuatedDirectoryLockLease = DirectoryLockLease & {
  readonly actuator: StorageActuator;
};

export type FileLockLease = () => void;

export type ExclusiveFileLockAttempt =
  | Readonly<{ kind: 'acquired'; lease: FileLockLease }>
  | Readonly<{ kind: 'contended' }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'unobservable'; cause: unknown }>;

function sqliteLockLease(db: DatabaseSync): FileLockLease {
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try {
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  };
}

function sqliteErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

export function createSharedFileLockSync(path: string): FileLockLease {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN; SELECT count(*) FROM sqlite_schema');
    return sqliteLockLease(db);
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

export function acquireSharedFileLockSync(path: string, busyTimeoutMs = 5_000): FileLockLease {
  const db = new DatabaseSync(path, { readOnly: true, timeout: busyTimeoutMs });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN; SELECT count(*) FROM sqlite_schema`);
    return sqliteLockLease(db);
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

export function attemptExclusiveFileLockSync(path: string): ExclusiveFileLockAttempt {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch (cause: unknown) {
    return { kind: 'unobservable', cause };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return { kind: 'malformed' };

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { timeout: 0 });
  } catch (cause: unknown) {
    return { kind: 'unobservable', cause };
  }
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    return { kind: 'acquired', lease: sqliteLockLease(db) };
  } catch (error: unknown) {
    try {
      db.close();
    } catch (cause: unknown) {
      return { kind: 'unobservable', cause };
    }
    if (sqliteErrorCode(error) === 'ERR_SQLITE_ERROR') {
      if (/database is locked/u.test(String(error))) return { kind: 'contended' };
      if (/file is not a database/u.test(String(error))) return { kind: 'malformed' };
    }
    return { kind: 'unobservable', cause: error };
  }
}

export function tryAcquireExclusiveFileLockSync(path: string): FileLockLease | null {
  const attempt = attemptExclusiveFileLockSync(path);
  if (attempt.kind === 'acquired') return attempt.lease;
  if (attempt.kind === 'contended') return null;
  if (attempt.kind === 'malformed') throw new Error(`File lock is malformed: ${path}`);
  throw attempt.cause;
}

type StorageActuatorOperations = Pick<StorageActuator, Extract<keyof StorageActuator, string>>;

function createStorageActuator(storage: StoragePort, prove: () => void): StorageActuator {
  const actuator: StorageActuatorOperations = {
    writeWholeFile(path, data, options) {
      prove();
      storage.writeFileSync(path, data, options);
    },
    rename(oldPath, newPath) {
      prove();
      storage.renameSync(oldPath, newPath);
    },
    link(existingPath, newPath) {
      prove();
      storage.linkSync(existingPath, newPath);
    },
    makeDirectory(path, options) {
      prove();
      storage.mkdirSync(path, options);
    },
    remove(path, options) {
      prove();
      storage.rmSync(path, options);
    },
    createFile(path, flags, mode) {
      prove();
      return storage.openSync(path, flags, mode);
    },
    read(fd, buffer, offset, length, position) {
      prove();
      return storage.readSync(fd, buffer, offset, length, position);
    },
    write(fd, buffer, offset, length, position) {
      prove();
      return storage.writeSync(fd, buffer, offset, length, position);
    },
    syncFile(fd) {
      prove();
      storage.fdatasyncSync(fd);
    },
    appendWholeFile(path, data) {
      prove();
      storage.appendFileSync(path, data);
    },
    appendWholeFileDurable(path, data) {
      prove();
      return storage.appendFileDurableSync(path, data);
    },
    appendWholeFileCanonical(path, data, options) {
      prove();
      return storage.appendFileWithCanonicalCheckSync(path, data, options);
    },
    removeDirectory(path) {
      prove();
      storage.rmdirSync(path);
    },
    unlink(path) {
      prove();
      storage.unlinkSync(path);
    },
    tryCreateWholeFile(path, data, options) {
      prove();
      return storage.tryExclusiveWriteSync(path, data, options);
    },
    writeWholeFileAtomic(path, data, options) {
      prove();
      return storage.writeAtomicSync(path, data, options);
    },
    writeWholeFileDurable(path, data, options) {
      prove();
      return storage.writeAtomicDurableSync(path, data, options);
    },
    syncDirectory(path) {
      prove();
      return storage.syncDirectoryDurableSync(path);
    },
    setMode(path, mode) {
      prove();
      storage.chmodSync(path, mode);
    },
  };
  return actuator as StorageActuator;
}

export function waitSync(ms: number): void {
  Atomics.wait(syncWaitState, 0, 0, ms);
}

function isDirectoryLockDeps(value: DirectoryLockDeps | number | undefined): value is DirectoryLockDeps {
  return typeof value === 'object' && value !== null && 'storage' in value && 'time' in value;
}

export function isDirectoryLockTimeoutError(error: unknown): error is DirectoryLockTimeoutError {
  return error instanceof DirectoryLockTimeoutError;
}

export function createDirectoryLockParent(storage: Pick<StoragePort, 'mkdirSync'>, path: string): void {
  storage.mkdirSync(path, { recursive: true });
}

function resolveDirectoryLockDeps(deps?: DirectoryLockDeps): DirectoryLockDeps {
  if (deps) {
    return deps;
  }

  return {
    storage: {
      mkdirSync,
      readFileSync,
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
      monotonicNow: () => process.hrtime.bigint() / 1_000_000n,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }),
      setInterval: (fn: () => void, ms: number) => {
        const timer = setInterval(fn, ms);
        timer.unref?.();
        return timer;
      },
      clearInterval: (handle: TimerHandle) => {
        if (handle !== null) {
          clearInterval(handle as NodeJS.Timeout);
        }
      },
    },
  } as unknown as DirectoryLockDeps;
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

let processOwnerProbe: DirectoryLockOwnerProbe | undefined;

function ownerProbe(deps: DirectoryLockDeps): DirectoryLockOwnerProbe {
  if (deps.owner !== undefined) return deps.owner;
  processOwnerProbe ??= {
    self: { pid: process.pid, incarnation: probeProcessIncarnation(process.pid), pidNamespace: readPidNamespace() },
    observe: createRecordedProcessObserver({
      readIncarnation: (pid) => probeProcessIncarnation(pid),
      observeLiveness: observeProcessLiveness,
    }),
  };
  return processOwnerProbe;
}

const lockOwnerRecordSchema = z.object({
  pid: z.number().int().positive(),
  incarnation: persistedProcessIncarnationSchema.optional(),
  pidNamespace: z.string().min(1),
});

function lockOwnerMarkerContent(ownerToken: string, deps: DirectoryLockDeps): string {
  const { pid, incarnation, pidNamespace } = ownerProbe(deps).self;
  return JSON.stringify({
    token: ownerToken,
    pid,
    ...(incarnation === null ? {} : { incarnation }),
    ...(pidNamespace === null ? {} : { pidNamespace }),
  });
}

function writeLockOwnerMarker(
  lockDir: string,
  ownerToken: string,
  markerContent: string,
  storage: DirectoryLockDeps['storage'],
): void {
  storage.writeFileSync(lockOwnerMarkerPath(lockDir, ownerToken), markerContent, { encoding: 'utf-8', mode: 0o600 });
}

/** A marker this build cannot read and an owner recorded in another pid namespace are both unobserved. */
function observeMarkerOwner(markerPath: string, deps: DirectoryLockDeps): ProcessLiveness {
  let raw: unknown;
  try {
    raw = JSON.parse(deps.storage.readFileSync(markerPath, 'utf-8'));
  } catch {
    return 'unknown';
  }
  const recorded = lockOwnerRecordSchema.safeParse(raw);
  if (!recorded.success) return 'unknown';
  const probe = ownerProbe(deps);
  if (probe.self.pidNamespace === null || recorded.data.pidNamespace !== probe.self.pidNamespace) return 'unknown';
  const { pid, incarnation } = recorded.data;
  return probe.observe(incarnation === undefined ? { pid } : { pid, incarnation });
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
  markerContent: string,
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
    deps.storage.writeFileSync(refreshPath, markerContent, { encoding: 'utf-8', mode: 0o600, flag: 'r+' });
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
  markerContent: string,
  expectedIdentity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
  loseOwnership: () => void,
): TimerHandle {
  const staleMs = deps.staleMs ?? STALE_LOCK_MS;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3));
  return deps.time.setInterval(() => {
    try {
      refreshLockOwnerMarker(lockDir, ownerToken, markerContent, expectedIdentity, deps);
    } catch {
      loseOwnership();
    }
  }, heartbeatMs);
}

function releaseDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  ownerToken: string,
  markerContent: string,
  expectedIdentity: LockDirectoryIdentity,
  heartbeat: TimerHandle,
  isOwned: () => boolean,
  loseOwnership: () => void,
): DirectoryLockLease {
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor((deps.staleMs ?? STALE_LOCK_MS) / 3));
  let refreshedAt: number | undefined;
  const release = (() => {
    loseOwnership();
    deps.time.clearInterval(heartbeat);
    tryRemoveOwnedLockDirectory(lockDir, ownerToken, expectedIdentity, deps.storage);
  }) as DirectoryLockLease;
  const refresh = (): void => {
    if (!isOwned()) {
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
    try {
      refreshLockOwnerMarker(lockDir, ownerToken, markerContent, expectedIdentity, deps);
    } catch {
      loseOwnership();
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
  };
  release.assertOwned = refresh;
  release.maintain = () => {
    const currentTime = deps.time.now();
    if (refreshedAt !== undefined && currentTime - refreshedAt < heartbeatMs) return;
    refresh();
    refreshedAt = currentTime;
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

type OwnerMarkerDisposition = 'window-expired' | 'owner-absent' | 'owner-alive' | 'owner-unobserved';

/** Only an expired window or an owner proven absent may be reclaimed; an unobserved owner waits out the window. */
const RECLAIMABLE_OWNER_MARKERS: ReadonlySet<OwnerMarkerDisposition> = new Set(['window-expired', 'owner-absent']);

function ownerMarkerDisposition(markerPath: string, deps: DirectoryLockDeps): OwnerMarkerDisposition {
  if (markerIsStale(markerPath, deps)) return 'window-expired';
  const liveness = observeMarkerOwner(markerPath, deps);
  if (liveness === 'absent') return 'owner-absent';
  return liveness === 'alive' ? 'owner-alive' : 'owner-unobserved';
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

function tryClaimAndQuarantineStaleMarker(
  lockDir: string,
  markerPath: string,
  restorePath: string,
  deps: DirectoryLockDeps,
): boolean {
  if (!RECLAIMABLE_OWNER_MARKERS.has(ownerMarkerDisposition(markerPath, deps))) return false;

  const claimPath = join(lockDir, `claim-${randomUUID()}.lock`);
  try {
    deps.storage.renameSync(markerPath, claimPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }

  if (!RECLAIMABLE_OWNER_MARKERS.has(ownerMarkerDisposition(claimPath, deps))) {
    try {
      deps.storage.renameSync(claimPath, restorePath);
    } catch {
      /* recoverable after the marker becomes stale */
    }
    return false;
  }
  return quarantineClaimedLock(lockDir, claimPath, restorePath, deps);
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
      return tryClaimAndQuarantineStaleMarker(lockDir, staleClaimPath, staleClaimPath, deps);
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
  return tryClaimAndQuarantineStaleMarker(lockDir, ownerPath, ownerPath, deps);
}

function createDirectoryLockLease(
  lockDir: string,
  ownerToken: string,
  markerContent: string,
  identity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
  actuatorStorage?: StoragePort,
): DirectoryLockLease | ActuatedDirectoryLockLease {
  let owned = true;
  const loseOwnership = () => {
    owned = false;
  };
  const heartbeat = startDirectoryLockHeartbeat(lockDir, ownerToken, markerContent, identity, deps, loseOwnership);
  const lease = releaseDirectoryLock(
    lockDir,
    deps,
    ownerToken,
    markerContent,
    identity,
    heartbeat,
    () => owned,
    loseOwnership,
  );
  if (actuatorStorage !== undefined) {
    Object.defineProperty(lease, 'actuator', {
      value: createStorageActuator(actuatorStorage, () => {
        lease.assertOwned();
      }),
      enumerable: true,
    });
  }
  return lease;
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
function tryCreateDirectoryLock(
  lockDir: string,
  deps: DirectoryLockDeps,
  actuatorStorage?: StoragePort,
): DirectoryLockLease | ActuatedDirectoryLockLease | null {
  const ownerToken = randomUUID();
  const markerContent = lockOwnerMarkerContent(ownerToken, deps);
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
  writeLockOwnerMarker(lockDir, ownerToken, markerContent, deps.storage);

  if (!ownsLockDirectory(lockDir, ownerToken, identity, deps)) {
    tryRemoveOwnedLockDirectory(lockDir, ownerToken, identity, deps.storage);
    throw new DirectoryLockOwnershipLostError(lockDir);
  }
  return createDirectoryLockLease(lockDir, ownerToken, markerContent, identity, deps, actuatorStorage);
}

function throwIfDirectoryLockAborted(deps: DirectoryLockDeps): void {
  deps.signal?.throwIfAborted();
}

export function tryAcquireDirectoryLock(lockDir: string): DirectoryLockLease | null;
export function tryAcquireDirectoryLock(
  lockDir: string,
  providedDeps: DirectoryLockDeps,
): ActuatedDirectoryLockLease | null;
export function tryAcquireDirectoryLock(
  lockDir: string,
  providedDeps?: DirectoryLockDeps,
): DirectoryLockLease | ActuatedDirectoryLockLease | null {
  const deps = resolveDirectoryLockDeps(providedDeps);
  throwIfDirectoryLockAborted(deps);
  const lease = tryCreateDirectoryLock(lockDir, deps, providedDeps?.storage);
  if (lease !== null) return lease;
  if (!tryQuarantineStaleLock(lockDir, deps)) return null;
  throwIfDirectoryLockAborted(deps);
  return tryCreateDirectoryLock(lockDir, deps, providedDeps?.storage);
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
): Promise<ActuatedDirectoryLockLease>;
export async function acquireDirectoryLock(
  lockDir: string,
  depsOrTimeout: DirectoryLockDeps | number = 5000,
  timeoutMs = 5000,
): Promise<DirectoryLockLease | ActuatedDirectoryLockLease> {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.monotonicNow() + BigInt(effectiveTimeoutMs);

  while (deps.time.monotonicNow() < deadline) {
    throwIfDirectoryLockAborted(deps);
    const lease = tryCreateDirectoryLock(
      lockDir,
      deps,
      isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout.storage : undefined,
    );
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
): ActuatedDirectoryLockLease;
export function acquireDirectoryLockSync(
  lockDir: string,
  depsOrTimeout: DirectoryLockDeps | number = 5000,
  timeoutMs = 5000,
): DirectoryLockLease | ActuatedDirectoryLockLease {
  const deps = resolveDirectoryLockDeps(isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout : undefined);
  const effectiveTimeoutMs = typeof depsOrTimeout === 'number' ? depsOrTimeout : timeoutMs;
  const deadline = deps.time.monotonicNow() + BigInt(effectiveTimeoutMs);

  while (deps.time.monotonicNow() < deadline) {
    const lease = tryCreateDirectoryLock(
      lockDir,
      deps,
      isDirectoryLockDeps(depsOrTimeout) ? depsOrTimeout.storage : undefined,
    );
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
