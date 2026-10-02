import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

export type DirectoryLockOwnerProbe = Readonly<{
  self: DirectoryLockOwner;
  observe: RecordedProcessObserver;
}>;

export type DirectoryLockDeps = {
  storage: StoragePort;
  time: Pick<TimePort, 'now' | 'monotonicNow' | 'sleep' | 'setInterval' | 'clearInterval'>;
  staleMs?: number;
  reclaim?: 'absent-only';
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

function malformedSqliteLockError(error: unknown): boolean {
  return (
    sqliteErrorCode(error) === 'ERR_SQLITE_ERROR' &&
    /file is not a database|database disk image is malformed|attempt to write a readonly database/u.test(String(error))
  );
}

function withFileLockRepairSync<T>(path: string, open: () => T, timeoutMs: number): T {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      return open();
    } catch (error: unknown) {
      if (!malformedSqliteLockError(error)) throw error;
      const repair = repairMalformedFileLockSync(path);
      if (repair.kind === 'moved-aside') {
        new DatabaseSync(path).close();
        continue;
      }
      if (performance.now() >= deadline)
        throw new Error(`File lock repair withheld: ${path} (${repair.kind})`, { cause: error });
      waitSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

function openSharedFileLockSync(path: string, readOnly: boolean, busyTimeoutMs: number): FileLockLease {
  return withFileLockRepairSync(
    path,
    () => {
      const db = new DatabaseSync(path, { readOnly, timeout: busyTimeoutMs });
      try {
        db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN; SELECT count(*) FROM sqlite_schema`);
        return sqliteLockLease(db);
      } catch (error: unknown) {
        db.close();
        throw error;
      }
    },
    busyTimeoutMs,
  );
}

export function createSharedFileLockSync(path: string): FileLockLease {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return openSharedFileLockSync(path, false, 5_000);
}

export function acquireSharedFileLockSync(path: string, busyTimeoutMs = 5_000): FileLockLease {
  return openSharedFileLockSync(path, true, busyTimeoutMs);
}

/**
 * A nonzero `busyTimeoutMs` blocks the calling thread while it waits. Throughout that wait SQLite holds PENDING,
 * which refuses every new shared locker, so the wait drains the existing holders without starving behind new ones
 * (measured across processes with node:sqlite on Node v26).
 */
export function attemptExclusiveFileLockSync(path: string, busyTimeoutMs = 0): ExclusiveFileLockAttempt {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch (cause: unknown) {
    return { kind: 'unobservable', cause };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return { kind: 'malformed' };

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { timeout: busyTimeoutMs });
  } catch (cause: unknown) {
    return { kind: 'unobservable', cause };
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN EXCLUSIVE`);
    return { kind: 'acquired', lease: sqliteLockLease(db) };
  } catch (error: unknown) {
    try {
      db.close();
    } catch (cause: unknown) {
      return { kind: 'unobservable', cause };
    }
    if (sqliteErrorCode(error) === 'ERR_SQLITE_ERROR') {
      if (/database is locked/u.test(String(error))) return { kind: 'contended' };
      if (
        /file is not a database|database disk image is malformed|attempt to write a readonly database/u.test(
          String(error),
        )
      )
        return { kind: 'malformed' };
    }
    return { kind: 'unobservable', cause: error };
  }
}

export type MalformedFileLockRepair =
  | Readonly<{ kind: 'moved-aside'; quarantinePath: string }>
  | Readonly<{ kind: 'not-malformed' }>
  | Readonly<{ kind: 'held' }>
  | Readonly<{ kind: 'repair-in-progress' }>
  | Readonly<{ kind: 'unobservable'; cause: unknown }>;

/**
 * The repair child uses SQLite's unix-excl VFS: its first read takes a kernel write lock before parsing the
 * header, retained until close even if parsing fails. A separate process avoids SQLite's in-process inode
 * lock sharing. The child checks the exact inode and keeps that lock across the rename. See unixFileLock in
 * https://sqlite.org/src/doc/trunk/src/os_unix.c.
 */
const malformedLockRepairProbe = `
(() => {
  const { DatabaseSync } = require('node:sqlite');
  const { lstatSync, renameSync } = require('node:fs');
  const { pathToFileURL } = require('node:url');
  const [path, dev, ino, quarantinePath] = process.argv.slice(1);
  const unchanged = () => {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink() && String(entry.dev) === dev && String(entry.ino) === ino;
  };
  if (!unchanged()) throw new Error('Lock inode changed before repair');
  const uri = pathToFileURL(path);
  uri.search = 'mode=rw&vfs=unix-excl';
  const db = new DatabaseSync(uri.href, { timeout: 0 });
  try {
    let malformed = false;
    try {
      db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
    } catch (error) {
      if (error.code !== 'ERR_SQLITE_ERROR') throw error;
      if (/database is locked/u.test(error.message)) {
        process.stdout.write('held');
        return;
      }
      if (!/file is not a database|database disk image is malformed|attempt to write a readonly database/u.test(error.message)) throw error;
      malformed = true;
    }
    if (!unchanged()) throw new Error('Lock inode changed during repair');
    if (malformed || lstatSync(path).nlink !== 1) {
      renameSync(path, quarantinePath);
      process.stdout.write('moved-aside');
    } else process.stdout.write('not-malformed');
  } finally {
    db.close();
  }
})();
`;

export function repairMalformedFileLockSync(path: string): MalformedFileLockRepair {
  let repair: DirectoryLockLease | null;
  try {
    repair = tryAcquireDirectoryLock(`${path}.repair`);
  } catch (cause: unknown) {
    return { kind: 'unobservable', cause };
  }
  if (repair === null) return { kind: 'repair-in-progress' };
  try {
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(path);
    } catch (cause: unknown) {
      return (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'not-malformed' }
        : { kind: 'unobservable', cause };
    }
    const quarantinePath = `${path}.malformed-${Date.now()}-${randomUUID()}`;
    const moveAside = (): MalformedFileLockRepair => {
      renameSync(path, quarantinePath);
      return { kind: 'moved-aside', quarantinePath };
    };
    if (!entry.isFile() || entry.isSymbolicLink()) return moveAside();

    const result = execFileSync(
      process.execPath,
      ['-e', malformedLockRepairProbe, path, String(entry.dev), String(entry.ino), quarantinePath],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result === 'moved-aside') return { kind: 'moved-aside', quarantinePath };
    if (result === 'held') return { kind: 'held' };
    if (result === 'not-malformed') return { kind: 'not-malformed' };
    return { kind: 'unobservable', cause: new Error(`Unexpected lock repair result: ${result}`) };
  } catch (cause: unknown) {
    return { kind: 'unobservable', cause };
  } finally {
    repair();
  }
}

export function tryAcquireExclusiveFileLockSync(path: string): FileLockLease | null {
  const attempt = attemptExclusiveFileLockSync(path);
  if (attempt.kind === 'acquired') return attempt.lease;
  if (attempt.kind === 'contended') return null;
  if (attempt.kind === 'malformed') {
    const repair = repairMalformedFileLockSync(path);
    if (repair.kind === 'moved-aside') {
      createSharedFileLockSync(path)();
      return tryAcquireExclusiveFileLockSync(path);
    }
    if (repair.kind === 'unobservable') throw repair.cause;
    return null;
  }
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
  if (
    processOwnerProbe === undefined ||
    processOwnerProbe.self.incarnation === null ||
    processOwnerProbe.self.pidNamespace === null
  ) {
    processOwnerProbe = {
      self: { pid: process.pid, incarnation: probeProcessIncarnation(process.pid), pidNamespace: readPidNamespace() },
      observe: createRecordedProcessObserver({
        readIncarnation: (pid) => probeProcessIncarnation(pid),
        observeLiveness: observeProcessLiveness,
      }),
    };
  }
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
type HeldLockDirectory = Readonly<{
  lockDir: string;
  ownerToken: string;
  markerContent: string;
  expectedIdentity: LockDirectoryIdentity;
  deps: DirectoryLockDeps;
  diagnosticPreparation?: string;
}>;

function refreshLockOwnerMarker({
  lockDir,
  ownerToken,
  markerContent,
  expectedIdentity,
  deps,
}: HeldLockDirectory): void {
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

function startDirectoryLockHeartbeat(held: HeldLockDirectory, loseOwnership: () => void): TimerHandle {
  const { deps } = held;
  const staleMs = deps.staleMs ?? STALE_LOCK_MS;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3));
  return deps.time.setInterval(() => {
    try {
      refreshLockOwnerMarker(held);
    } catch {
      loseOwnership();
    }
  }, heartbeatMs);
}

function releaseDirectoryLock(
  held: HeldLockDirectory,
  heartbeat: TimerHandle,
  isOwned: () => boolean,
  loseOwnership: () => void,
): DirectoryLockLease {
  const { lockDir, ownerToken, expectedIdentity, deps } = held;
  const heartbeatMs = deps.heartbeatMs ?? Math.max(10, Math.floor((deps.staleMs ?? STALE_LOCK_MS) / 3));
  let refreshedAt: number | undefined;
  const release = (() => {
    loseOwnership();
    deps.time.clearInterval(heartbeat);
    if (held.diagnosticPreparation === undefined)
      tryRemoveOwnedLockDirectory(lockDir, ownerToken, expectedIdentity, deps.storage);
    else releaseDiagnosticDirectoryLock(held, held.diagnosticPreparation);
  }) as DirectoryLockLease;
  const refresh = (): void => {
    if (!isOwned()) {
      throw new DirectoryLockOwnershipLostError(lockDir);
    }
    try {
      refreshLockOwnerMarker(held);
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
  if (deps.reclaim !== 'absent-only' && markerIsStale(markerPath, deps)) return 'window-expired';
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
  expectedIdentity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
): boolean {
  if (!lockDirectoryIdentityMatches(lockDir, expectedIdentity, deps.storage)) return false;
  const entries = deps.storage.readdirSync(lockDir);
  if (entries.length !== 1 || entries[0] !== basename(claimPath)) return false;
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

type ReclamationAttempt = {
  readonly identity: LockDirectoryIdentity;
  readonly restorePath: string;
};

const abandonedReclamations = new Map<string, ReclamationAttempt>();

function completeReclamationAttempt(
  lockDir: string,
  claimPath: string,
  attempt: ReclamationAttempt,
  deps: DirectoryLockDeps,
): boolean {
  let quarantined = false;
  try {
    if (!RECLAIMABLE_OWNER_MARKERS.has(ownerMarkerDisposition(claimPath, deps))) return false;
    quarantined = quarantineClaimedLock(lockDir, claimPath, attempt.identity, deps);
    return quarantined;
  } finally {
    abandonedReclamations.delete(claimPath);
    if (!quarantined) {
      const identity = readLockDirectoryIdentity(lockDir, deps.storage);
      if (identity === null) {
        abandonedReclamations.set(claimPath, attempt);
      } else if (identity.dev === attempt.identity.dev && identity.ino === attempt.identity.ino) {
        try {
          deps.storage.renameSync(claimPath, attempt.restorePath);
        } catch (error) {
          if (!isMissingPathError(error)) abandonedReclamations.set(claimPath, attempt);
        }
      }
    }
  }
}

function tryClaimAndQuarantineStaleMarker(
  lockDir: string,
  markerPath: string,
  restorePath: string,
  deps: DirectoryLockDeps,
): boolean {
  const identity = readLockDirectoryIdentity(lockDir, deps.storage);
  if (identity === null) return false;
  if (!RECLAIMABLE_OWNER_MARKERS.has(ownerMarkerDisposition(markerPath, deps))) return false;

  const claimant = ownerProbe(deps).self;
  if (deps.reclaim === 'absent-only' && claimant.pidNamespace === null)
    throw new Error('Status reclaimer identity is unavailable');
  const claimantName = Buffer.from(
    JSON.stringify([claimant.pid, claimant.incarnation, claimant.pidNamespace]),
  ).toString('base64url');
  const claimPath = join(
    lockDir,
    deps.reclaim === 'absent-only'
      ? `claim-reclaim-${claimantName}-${randomUUID()}.lock`
      : `claim-${randomUUID()}.lock`,
  );
  try {
    deps.storage.renameSync(markerPath, claimPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }

  return completeReclamationAttempt(lockDir, claimPath, { identity, restorePath }, deps);
}

function reclamationClaimantDisposition(claimPath: string, deps: DirectoryLockDeps): OwnerMarkerDisposition {
  const name = basename(claimPath);
  if (name.startsWith('claim-release-') || name.startsWith('claim-refresh-'))
    return ownerMarkerDisposition(claimPath, deps);
  if (/^claim-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.lock$/u.test(name))
    return ownerMarkerDisposition(claimPath, deps);
  if (!name.startsWith('claim-reclaim-')) return 'owner-unobserved';
  let tuple: unknown;
  try {
    tuple = JSON.parse(Buffer.from(name.slice('claim-reclaim-'.length, -42), 'base64url').toString('utf8'));
  } catch {
    return 'owner-unobserved';
  }
  if (!Array.isArray(tuple) || tuple.length !== 3) return 'owner-unobserved';
  const claimant = lockOwnerRecordSchema.safeParse({
    pid: tuple[0],
    incarnation: tuple[1] ?? undefined,
    pidNamespace: tuple[2],
  });
  const probe = ownerProbe(deps);
  if (!claimant.success || probe.self.pidNamespace === null || claimant.data.pidNamespace !== probe.self.pidNamespace)
    return 'owner-unobserved';
  const liveness = probe.observe(claimant.data);
  if (liveness === 'absent') return 'owner-absent';
  return liveness === 'alive' ? 'owner-alive' : 'owner-unobserved';
}

function tryReclaimClaim(lockDir: string, claimPath: string, deps: DirectoryLockDeps): boolean {
  const abandoned = abandonedReclamations.get(claimPath);
  if (abandoned !== undefined) return completeReclamationAttempt(lockDir, claimPath, abandoned, deps);
  if (deps.reclaim === 'absent-only' && reclamationClaimantDisposition(claimPath, deps) !== 'owner-absent')
    return false;
  return tryClaimAndQuarantineStaleMarker(lockDir, claimPath, claimPath, deps);
}

function tryQuarantineEmptyLock(lockDir: string, deps: DirectoryLockDeps): boolean {
  if (!directoryIsStale(lockDir, deps)) return false;
  const quarantinePath = `${lockDir}.stale-${randomUUID()}`;
  try {
    deps.storage.renameSync(lockDir, quarantinePath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  tryRemoveLockDirectory(quarantinePath, deps.storage);
  return true;
}

function tryQuarantineStaleLock(lockDir: string, deps: DirectoryLockDeps): boolean {
  const owners = ownerMarkerEntries(lockDir, deps);
  const claims = claimMarkerEntries(lockDir, deps);
  if (deps.reclaim === 'absent-only' && owners.length + claims.length !== 1) return false;
  if (owners.length > 1 || claims.length > 1) return false;
  const [owner] = owners;
  if (owner !== undefined) {
    const ownerPath = join(lockDir, owner);
    return tryClaimAndQuarantineStaleMarker(lockDir, ownerPath, ownerPath, deps);
  }
  const [claim] = claims;
  if (claim !== undefined) return tryReclaimClaim(lockDir, join(lockDir, claim), deps);
  return tryQuarantineEmptyLock(lockDir, deps);
}

function createDirectoryLockLease(
  lockDir: string,
  ownerToken: string,
  markerContent: string,
  identity: LockDirectoryIdentity,
  deps: DirectoryLockDeps,
  actuatorStorage?: StoragePort,
  diagnosticPreparation?: string,
): DirectoryLockLease | ActuatedDirectoryLockLease {
  let owned = true;
  const loseOwnership = () => {
    owned = false;
  };
  const held: HeldLockDirectory = {
    lockDir,
    ownerToken,
    markerContent,
    expectedIdentity: identity,
    deps,
    diagnosticPreparation,
  };
  const heartbeat = startDirectoryLockHeartbeat(held, loseOwnership);
  const lease = releaseDirectoryLock(held, heartbeat, () => owned, loseOwnership);
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

/** Diagnostic publication cannot reclaim a directory on silence or age. */
export function tryAcquireDiagnosticDirectoryLock(lockDir: string): DirectoryLockLease | null {
  const deps = { ...resolveDirectoryLockDeps(), reclaim: 'absent-only' as const };
  const lease = tryPublishDiagnosticDirectoryLock(lockDir, deps);
  if (lease !== null) return lease;
  if (!tryQuarantineStaleLock(lockDir, deps)) return null;
  return tryPublishDiagnosticDirectoryLock(lockDir, deps);
}

function tryPublishDiagnosticDirectoryLock(lockDir: string, deps: DirectoryLockDeps): DirectoryLockLease | null {
  const probe = ownerProbe(deps);
  if (probe.self.pidNamespace === null) throw new Error('Status publisher identity is unavailable');
  const prefix = `${basename(lockDir)}.publisher-`;
  for (const name of deps.storage.readdirSync(dirname(lockDir))) {
    if (!name.startsWith(prefix)) continue;
    let tuple: unknown;
    try {
      tuple = JSON.parse(Buffer.from(name.slice(prefix.length, -37), 'base64url').toString('utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(tuple) || tuple.length !== 3) continue;
    const owner = lockOwnerRecordSchema.safeParse({
      pid: tuple[0],
      incarnation: tuple[1] ?? undefined,
      pidNamespace: tuple[2],
    });
    if (!owner.success || owner.data.pidNamespace !== probe.self.pidNamespace) continue;
    if (probe.observe(owner.data) === 'absent')
      deps.storage.rmSync(join(dirname(lockDir), name), { recursive: true, force: true });
  }
  // Canonical publication must be nonempty; a rename cannot replace a concurrent publisher.
  // Existing anonymous directories must also remain untouched.
  if (!diagnosticLockPathAbsent(lockDir)) return null;
  const ownerToken = randomUUID();
  const markerContent = lockOwnerMarkerContent(ownerToken, deps);
  const ownerName = Buffer.from(
    JSON.stringify([probe.self.pid, probe.self.incarnation, probe.self.pidNamespace]),
  ).toString('base64url');
  const prepared = join(dirname(lockDir), `${prefix}${ownerName}-${ownerToken}`);
  deps.storage.mkdirSync(prepared);
  let published = false;
  try {
    writeLockOwnerMarker(prepared, ownerToken, markerContent, deps.storage);
    for (const path of [lockOwnerMarkerPath(prepared, ownerToken), prepared]) {
      const fd = openSync(path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const identity = readLockDirectoryIdentity(prepared, deps.storage);
    if (identity === null) throw new DirectoryLockOwnershipLostError(prepared);
    if (!diagnosticLockPathAbsent(lockDir)) return null;
    try {
      deps.storage.renameSync(prepared, lockDir);
      published = true;
    } catch (error: unknown) {
      if (isAlreadyExistsError(error) || (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY'))
        return null;
      throw error;
    }
    return createDirectoryLockLease(lockDir, ownerToken, markerContent, identity, deps, undefined, prepared);
  } finally {
    if (!published) deps.storage.rmSync(prepared, { recursive: true, force: true });
  }
}

function releaseDiagnosticDirectoryLock(held: HeldLockDirectory, prepared: string): void {
  const { lockDir, ownerToken, markerContent, expectedIdentity, deps } = held;
  let retry: TimerHandle | null = null;
  const cleanup = (): void => {
    try {
      if (!diagnosticLockPathAbsent(prepared)) {
        const current = deps.storage.statSync(prepared, { bigint: true });
        if (current.dev !== expectedIdentity.dev || current.ino !== expectedIdentity.ino)
          throw new DirectoryLockOwnershipLostError(prepared);
        deps.storage.rmSync(prepared, { recursive: true, force: true });
      } else if (!diagnosticLockPathAbsent(lockDir)) {
        const current = deps.storage.statSync(lockDir, { bigint: true });
        if (current.dev === expectedIdentity.dev && current.ino === expectedIdentity.ino) {
          const claim = join(lockDir, `claim-release-${ownerToken}.lock`);
          try {
            deps.storage.renameSync(lockOwnerMarkerPath(lockDir, ownerToken), claim);
          } catch (error: unknown) {
            if (!isMissingPathError(error)) throw error;
          }
          if (deps.storage.readFileSync(claim, 'utf-8') !== markerContent)
            throw new DirectoryLockOwnershipLostError(lockDir);
          const entries = deps.storage.readdirSync(lockDir);
          if (entries.length !== 1 || entries[0] !== basename(claim))
            throw new DirectoryLockOwnershipLostError(lockDir);
          const checked = deps.storage.statSync(lockDir, { bigint: true });
          if (checked.dev !== current.dev || checked.ino !== current.ino)
            throw new DirectoryLockOwnershipLostError(lockDir);
          deps.storage.renameSync(lockDir, prepared);
          deps.storage.rmSync(prepared, { recursive: true, force: true });
        }
      }
      if (retry !== null) deps.time.clearInterval(retry);
      retry = null;
    } catch {
      retry ??= deps.time.setInterval(cleanup, LOCK_RETRY_INTERVAL_MS);
    }
  };
  cleanup();
}

function diagnosticLockPathAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error: unknown) {
    if (isMissingPathError(error)) return true;
    throw error;
  }
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
