import { basename, dirname, join, resolve } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { probeCoordinator } from '../infra/backend-discovery.js';
import {
  acquireSharedFileLockSync,
  attemptExclusiveFileLockSync,
  createSharedFileLockSync,
  type FileLockLease,
} from '../infra/fs-lock.js';
import type { StoragePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { openStoreDatabase, openWritableStoreDatabase, type Database } from './db.js';
import type { StoreFormatClassification, StoreFormatDescription } from './format-fingerprint.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from './reset-incident.js';

export const STORE_DATABASE_FILE_NAME = 'store.db';
export const STORE_EPOCH_METADATA_FILE_NAME = 'epoch.json';
export const STORE_LOCK_FILE_NAME = '.lock';
export const MAX_STORE_EPOCH_METADATA_BYTES = 64 * 1024;
export const MAX_STORE_EPOCH_HOLDER_BYTES = 4 * 1024;

const EPOCH_DIRECTORY_PATTERN = /^epoch-([1-9]\d*)$/;
const MINT_DIRECTORY_PREFIX = '.mint-';
const MINT_PREPARATION_DIRECTORY_PREFIX = '.preparing-';
const PRIVATE_MINT_CONSTRUCTION_PREFIX = '.coral-store-epoch-construction-';
const REAPING_DIRECTORY_PREFIX = '.reaping-';
const EPOCH_HOLDER_PREFIX = '.epoch-holder-';

export type StoreEpochClassification =
  | StoreFormatClassification
  | { readonly kind: 'unavailable'; readonly cause: string };

export type StoreEpochMetadata = Readonly<{
  supersedes: StoreEpoch | null;
  classification: StoreEpochClassification;
  build: Readonly<{
    version: string;
    buildSetId: string;
    bundleHash: string;
    flavor: StrictBundleManifest['flavor'];
    storeFormatFingerprint: string;
  }>;
  publishedAt: string;
}>;

export type StoreEpochSettlement = Readonly<{
  db: Database;
  epoch: StoreEpoch;
  path: string;
}>;

export type StoreEpochListEntry = Readonly<{
  epoch: StoreEpoch;
  role: 'current' | 'preserved' | 'garbage' | 'unobservable';
  bytes: number | null;
  publicationReason: StoreEpochClassification;
  supersededStoreVersion: string | null;
  epochJson: StoreEpochMetadataDisposition;
}>;

export type StoreEpochHolderListEntry = Readonly<{
  id: string;
  epoch: StoreEpoch | null;
  pid: number | null;
  state: 'live' | 'stale' | 'unobservable';
}>;

export type StoreEpochResidueListEntry = Readonly<{
  name: string;
  bytes: number | null;
  state: 'live' | 'reclaimable' | 'unobservable';
}>;

export type StoreEpochSweepResult =
  | 'absent'
  | 'cancelled'
  | 'complete'
  | 'current'
  | 'unobservable-metadata'
  | 'live-holder'
  | 'unobservable-holder'
  | 'holder-cleanup-failed'
  | 'deletion-failed'
  | 'lock-release-failed'
  | 'pre-deletion-durability-sync-failed'
  | 'absent-durability-sync-failed'
  | 'durability-sync-failed';

export type StoreEpochMetadataDisposition =
  | Readonly<{ kind: 'valid'; value: StoreEpochMetadata }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{ kind: 'unreadable'; cause: string }>;

export type StoreEpochOptions = Readonly<{
  path?: string;
  storeFormat: StoreFormatDescription;
  build: StrictBundleManifest;
  startupBusyTimeoutMs?: number;
  steadyStateBusyTimeoutMs?: number;
}>;

export type StoreEpoch = string;

type StoreEpochProof =
  | Readonly<{ kind: 'proven' }>
  | Readonly<{ kind: 'disproven' }>
  | Readonly<{ kind: 'unobservable'; cause: string }>;

function epochNumber(name: string): StoreEpoch | null {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  return match?.[1] ?? null;
}

function compareEpoch(left: StoreEpoch, right: StoreEpoch): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function successorEpoch(epoch: StoreEpoch | null): StoreEpoch {
  return epoch === null ? '1' : (BigInt(epoch) + 1n).toString();
}

export function epochDirectory(dbDir: string, epoch: StoreEpoch): string {
  return join(dbDir, `epoch-${epoch}`);
}

export function epochPath(dbDir: string, epoch: StoreEpoch): string {
  return join(epochDirectory(dbDir, epoch), STORE_DATABASE_FILE_NAME);
}

export function storeEpochHolderPath(dbDir: string, id: string): string {
  return join(dbDir, `${EPOCH_HOLDER_PREFIX}${id}.json`);
}

export function storeEpochLockPath(dbDir: string, epoch: StoreEpoch): string {
  return join(epochDirectory(dbDir, epoch), STORE_LOCK_FILE_NAME);
}

export function storeMintLockPath(dbDir: string, id: string): string {
  return join(dbDir, `${MINT_DIRECTORY_PREFIX}${id}`, STORE_LOCK_FILE_NAME);
}

export function resolveStoreDbDir(runtime: Pick<Runtime, 'paths'>, path?: string): string {
  if (path === undefined) return runtime.paths.coral.store.dbDir;
  if (path === ':memory:') return ':memory:';
  return resolve(path, '..');
}

type StoreEpochDiscoveryStorage = Pick<
  StoragePort,
  'lstatSync' | 'readFileSync' | 'readdirSync' | 'realpathSync' | 'statSync'
>;

type StoreEpochObservation = Readonly<{
  epoch: StoreEpoch;
  proof: StoreEpochProof;
  epochJson: StoreEpochMetadataDisposition;
}>;

type ProvenStoreEpochObservation = StoreEpochObservation &
  Readonly<{ proof: Extract<StoreEpochProof, { readonly kind: 'proven' }> }>;

function observeRegularFile(storage: Pick<StoragePort, 'lstatSync'>, path: string, device: bigint): StoreEpochProof {
  try {
    const entry = storage.lstatSync(path, { bigint: true });
    return entry.isFile() && entry.nlink === 1n && entry.dev === device ? { kind: 'proven' } : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function observeContainedDirectory(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  parent: string,
  path: string,
): StoreEpochProof {
  try {
    const parentEntry = storage.lstatSync(parent, { bigint: true });
    const entry = storage.lstatSync(path, { bigint: true });
    if (!entry.isDirectory() || entry.dev !== parentEntry.dev) return { kind: 'disproven' };
    return dirname(storage.realpathSync(path)) === storage.realpathSync(parent)
      ? { kind: 'proven' }
      : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function observeContainedRegularFile(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  directory: string,
  path: string,
  directoryProof: StoreEpochProof = observeContainedDirectory(storage, dirname(directory), directory),
): StoreEpochProof {
  if (directoryProof.kind !== 'proven') return directoryProof;
  try {
    const directoryEntry = storage.lstatSync(directory, { bigint: true });
    const regular = observeRegularFile(storage, path, directoryEntry.dev);
    if (regular.kind !== 'proven') return regular;
    return dirname(storage.realpathSync(path)) === storage.realpathSync(directory)
      ? { kind: 'proven' }
      : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function observeStoreEpochLock(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  dbDir: string,
  epoch: StoreEpoch,
  directoryProof?: StoreEpochProof,
): StoreEpochProof {
  const directory = epochDirectory(dbDir, epoch);
  return observeContainedRegularFile(storage, directory, storeEpochLockPath(dbDir, epoch), directoryProof);
}

function observeStoreEpochs(
  storage: StoreEpochDiscoveryStorage,
  dbDir: string,
  entries: readonly string[] = storage.readdirSync(dbDir),
): readonly StoreEpochObservation[] {
  // This is a static classification, not an atomic pathname proof. Symlinks and wrong-kind entries are
  // disproven at observation time. A same-user process actively replacing entries inside ~/.coral between
  // this lstat and SQLite's path open is outside the threat model: it can already replace Coral's executable,
  // plugin bundle, hooks, and CLI.
  const observations: StoreEpochObservation[] = [];
  for (const entry of entries) {
    const observation = observeStoreEpoch(storage, dbDir, entry);
    if (observation !== null) observations.push(observation);
  }
  return observations;
}

function observeStoreEpoch(
  storage: StoreEpochDiscoveryStorage,
  dbDir: string,
  entry: string,
): StoreEpochObservation | null {
  const epoch = epochNumber(entry);
  if (epoch === null) return null;
  const directory = join(dbDir, entry);
  const contained = observeContainedDirectory(storage, dbDir, directory);
  if (contained.kind !== 'proven') {
    return {
      epoch,
      proof: contained,
      epochJson:
        contained.kind === 'unobservable' ? { kind: 'unreadable', cause: contained.cause } : { kind: 'malformed' },
    };
  }
  const epochJson = readEpochMetadata(storage, directory);
  if (epochJson.kind === 'unreadable') {
    return { epoch, proof: { kind: 'unobservable', cause: epochJson.cause }, epochJson };
  }
  const database = observeContainedRegularFile(storage, directory, epochPath(dbDir, epoch), contained);
  const lock = database.kind === 'proven' ? observeStoreEpochLock(storage, dbDir, epoch, contained) : database;
  return { epoch, proof: epochJson.kind === 'valid' ? lock : { kind: 'disproven' }, epochJson };
}

function currentProvenEpoch(observations: readonly StoreEpochObservation[]): ProvenStoreEpochObservation | null {
  return observations.reduce<ProvenStoreEpochObservation | null>((current, observation) => {
    if (observation.proof.kind !== 'proven') return current;
    return current === null || compareEpoch(observation.epoch, current.epoch) > 0
      ? (observation as ProvenStoreEpochObservation)
      : current;
  }, null);
}

export function resolveCurrentStoreEpoch(storage: StoreEpochDiscoveryStorage, dbDir: string): StoreEpoch | null {
  const storeRoot = storage.realpathSync(dbDir);
  return currentProvenEpoch(observeStoreEpochs(storage, storeRoot))?.epoch ?? null;
}

export function resolveCurrentStorePath(runtime: Pick<Runtime, 'paths' | 'storage'>, path?: string): string {
  if (path !== undefined) return path;
  const dbDir = resolveStoreDbDir(runtime);
  if (!runtime.storage.existsSync(dbDir)) return epochPath(dbDir, '1');
  const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
  return epochPath(dbDir, current ?? '1');
}

export function openWritableStoreDbNoReset(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'storage'>,
  options: {
    readonly path?: string;
    readonly busyTimeoutMs?: number;
    readonly storeFormat: StoreFormatDescription;
  },
): Database {
  const storeDbPath = resolveCurrentStorePath(runtime, options.path);
  const epoch = storeEpochAtPath(runtime.paths.coral.store.dbDir, storeDbPath);
  const lease = epoch === null ? null : acquireStoreEpochReadLock(runtime, storeDbPath);
  const proof =
    storeDbPath === ':memory:'
      ? { kind: 'disproven' as const }
      : epoch === null
        ? observeContainedRegularFile(runtime.storage, dirname(storeDbPath), storeDbPath, { kind: 'proven' })
        : lease !== null
          ? { kind: 'proven' as const }
          : { kind: 'disproven' as const };
  if (proof.kind === 'proven') {
    try {
      const db = openStoreDatabase({
        path: storeDbPath,
        storage: runtime.storage,
        storeFormat: options.storeFormat,
        flavor: runtime.flavor,
        busyTimeoutMs: options.busyTimeoutMs,
      });
      return epoch === null || lease === null ? db : registerStoreEpochHolder(runtime, epoch, db, lease);
    } catch (error: unknown) {
      lease?.();
      throw error;
    }
  }
  lease?.();
  throw documentedCoralSetupError('store_not_initialized', { path: storeDbPath });
}

export function storeEpochAtPath(dbDir: string, path: string): StoreEpoch | null {
  if (basename(path) !== STORE_DATABASE_FILE_NAME) return null;
  const directory = resolve(path, '..');
  return resolve(directory, '..') === resolve(dbDir) ? epochNumber(basename(directory)) : null;
}

export function provenStoreEpochAtPath(storage: StoragePort, dbDir: string, path: string): StoreEpoch | null {
  return resolveProvenStoreEpochAtPath(storage, dbDir, path)?.epoch ?? null;
}

function resolveProvenStoreEpochAtPath(
  storage: StoragePort,
  dbDir: string,
  path: string,
): Readonly<{ epoch: StoreEpoch; storeRoot: string }> | null {
  const epoch = storeEpochAtPath(dbDir, path);
  if (epoch === null) return null;
  let storeRoot: string;
  try {
    storeRoot = storage.realpathSync(dbDir);
  } catch {
    return null;
  }
  const observation = observeStoreEpoch(storage, storeRoot, `epoch-${epoch}`);
  return observation?.proof.kind === 'proven' ? { epoch, storeRoot } : null;
}

export function acquireStoreEpochReadLock(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  storeDbPath: string,
): FileLockLease | null {
  const dbDir = runtime.paths.coral.store.dbDir;
  const proven = resolveProvenStoreEpochAtPath(runtime.storage, dbDir, storeDbPath);
  if (proven === null) return null;
  const lease = acquireSharedFileLockSync(storeEpochLockPath(proven.storeRoot, proven.epoch));
  const observation = observeStoreEpoch(runtime.storage, proven.storeRoot, `epoch-${proven.epoch}`);
  if (observation?.proof.kind === 'proven') return lease;
  lease();
  return null;
}

export function holdStoreEpochLockUntilClose(db: Database, lease: FileLockLease | null): Database {
  if (lease === null) return db;
  const close = db.close.bind(db);
  let closed = false;
  Object.defineProperty(db, 'close', {
    configurable: true,
    value: () => {
      if (closed) return;
      closed = true;
      try {
        close();
      } finally {
        lease();
      }
    },
  });
  return db;
}

function registerStoreEpochHolder(
  runtime: Pick<Runtime, 'env' | 'ids' | 'paths' | 'storage'>,
  epoch: StoreEpoch,
  db: Database,
  lease: FileLockLease,
): Database {
  const dbDir = runtime.paths.coral.store.dbDir;
  const holderPath = storeEpochHolderPath(dbDir, runtime.ids.uuid());
  if (
    !runtime.storage.writeAtomicDurableSync(holderPath, `${JSON.stringify({ epoch, pid: runtime.env.pid() })}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    db.close();
    lease();
    throw new Error(`Failed to publish store epoch ${epoch} holder.`);
  }
  const close = db.close.bind(db);
  let closed = false;
  Object.defineProperty(db, 'close', {
    configurable: true,
    value: () => {
      if (closed) return;
      closed = true;
      try {
        close();
      } finally {
        try {
          runtime.storage.unlinkSync(holderPath);
          runtime.storage.syncDirectoryDurableSync(dbDir);
        } catch {
          // The lock is decisive; a stale diagnostic record is cleaned by the next sweep.
        } finally {
          lease();
        }
      }
    },
  });
  return db;
}

export function garbageStoreEpochs(provenEpochs: readonly StoreEpoch[]): ReadonlySet<StoreEpoch> {
  const ordered = [...new Set(provenEpochs)].sort(compareEpoch);
  const retained = new Set(ordered.slice(-2));
  return new Set(ordered.filter((epoch) => !retained.has(epoch)));
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function unavailableClassification(error: unknown): StoreEpochClassification {
  return {
    kind: 'unavailable',
    cause: error instanceof Error ? error.message : String(error),
  };
}

function metadataFor(
  supersedes: StoreEpoch | null,
  classification: StoreEpochClassification,
  build: StrictBundleManifest,
  publishedAt: string,
): StoreEpochMetadata {
  return {
    supersedes,
    classification,
    build: {
      version: build.version,
      buildSetId: build.buildSetId,
      bundleHash: build.bundleHash,
      flavor: build.flavor,
      storeFormatFingerprint: build.storeFormatFingerprint,
    },
    publishedAt,
  };
}

function writeEpochMetadata(storage: StoragePort, mint: string, metadata: StoreEpochMetadata): void {
  if (
    !storage.writeAtomicDurableSync(join(mint, STORE_EPOCH_METADATA_FILE_NAME), `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    throw new Error(`Failed to publish ${STORE_EPOCH_METADATA_FILE_NAME} in '${mint}'.`);
  }
  if (!storage.syncDirectoryDurableSync(mint)) {
    throw new Error(`Failed to durably sync store mint '${mint}'.`);
  }
}

function auditSweepFailure(path: string, error: unknown): void {
  writeAuditEvent(
    'store_epoch_sweep_failed',
    { path, cause: error instanceof Error ? error.message : String(error) },
    'warn',
  );
}

function auditSweepSkip(path: string): void {
  writeAuditEvent('store_epoch_sweep_skipped', { path, reason: 'live-holder' }, 'info');
}

function treeStaysOnDevice(storage: StoragePort, path: string, device: bigint): boolean {
  const entry = storage.lstatSync(path, { bigint: true });
  if (entry.dev !== device) return false;
  return (
    !entry.isDirectory() ||
    storage.readdirSync(path).every((child) => treeStaysOnDevice(storage, join(path, child), device))
  );
}

async function treeStaysOnDeviceAsync(storage: StoragePort, path: string, device: bigint): Promise<boolean> {
  const entry = storage.lstatSync(path, { bigint: true });
  if (entry.dev !== device) return false;
  if (!entry.isDirectory()) return true;
  for (const child of await storage.readdir(path)) {
    if (!(await treeStaysOnDeviceAsync(storage, join(path, child), device))) return false;
  }
  return true;
}

function removeDuringSweep(storage: StoragePort, dbDir: string, path: string): boolean {
  try {
    const observed = storage.lstatSync(path);
    const device = storage.lstatSync(dbDir, { bigint: true }).dev;
    if (!treeStaysOnDevice(storage, path, device)) {
      auditSweepFailure(path, new Error('Recursive removal crossed the store device boundary.'));
      return false;
    }
    if (observed.isDirectory() && !observed.isSymbolicLink()) {
      storage.rmSync(path, { recursive: true, force: true });
    } else {
      storage.unlinkSync(path);
    }
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return true;
    auditSweepFailure(path, error);
    return false;
  }
}

type LockedRemoval = 'removed' | 'locked' | 'target-failed' | 'lock-release-failed';

function renameForReaping(runtime: Runtime, dbDir: string, targetPath: string): string | null {
  const reapingPath = join(dbDir, `${REAPING_DIRECTORY_PREFIX}${runtime.ids.uuid()}`);
  try {
    runtime.storage.renameSync(targetPath, reapingPath);
    return reapingPath;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    auditSweepFailure(targetPath, error);
    return targetPath;
  }
}

function removeAfterReapingRename(runtime: Runtime, dbDir: string, targetPath: string): LockedRemoval {
  const reapingPath = renameForReaping(runtime, dbDir, targetPath);
  if (reapingPath === null) return 'removed';
  if (reapingPath === targetPath) return 'target-failed';
  return removeDuringSweep(runtime.storage, dbDir, reapingPath) ? 'removed' : 'target-failed';
}

function removeWhileExclusivelyLocked(
  runtime: Runtime,
  dbDir: string,
  lockPath: string,
  targetPath: string,
): LockedRemoval {
  const attempt = attemptExclusiveFileLockSync(lockPath);
  if (attempt.kind === 'malformed') return removeAfterReapingRename(runtime, dbDir, targetPath);
  if (attempt.kind === 'unobservable') {
    auditSweepFailure(lockPath, attempt.cause);
    return 'target-failed';
  }
  if (attempt.kind === 'contended') return 'locked';
  const removal = removeAfterReapingRename(runtime, dbDir, targetPath);
  try {
    attempt.lease();
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'lock-release-failed';
  }
  return removal;
}

function removeEpochEntry(runtime: Runtime, dbDir: string, epoch: StoreEpoch): LockedRemoval {
  const targetPath = epochDirectory(dbDir, epoch);
  const root = observeContainedDirectory(runtime.storage, dbDir, targetPath);
  if (root.kind === 'unobservable') return 'target-failed';
  if (root.kind === 'disproven') return removeAfterReapingRename(runtime, dbDir, targetPath);
  const lock = observeStoreEpochLock(runtime.storage, dbDir, epoch, root);
  if (lock.kind === 'unobservable') return 'target-failed';
  if (lock.kind === 'disproven') {
    return readEpochMetadata(runtime.storage, targetPath).kind === 'valid'
      ? 'target-failed'
      : removeAfterReapingRename(runtime, dbDir, targetPath);
  }
  return removeWhileExclusivelyLocked(runtime, dbDir, storeEpochLockPath(dbDir, epoch), targetPath);
}

function proveReleaseTarget(
  storage: StoreEpochDiscoveryStorage,
  dbDir: string,
  targetEpoch: StoreEpoch,
): 'absent' | 'current' | 'deletable' | 'unobservable' {
  try {
    const observations = observeStoreEpochs(storage, dbDir);
    const target = observations.find(({ epoch }) => epoch === targetEpoch);
    if (target === undefined) return 'absent';
    if (target.proof.kind === 'unobservable') return 'unobservable';
    return currentProvenEpoch(observations)?.epoch === targetEpoch ? 'current' : 'deletable';
  } catch {
    return 'unobservable';
  }
}

type StoreEpochHolderObservation = StoreEpochHolderListEntry &
  Readonly<{ entry: string; path: string; removable: boolean; proof: FileLockLease | null }>;

function observeStoreEpochHolder(runtime: Runtime, dbDir: string, entry: string): StoreEpochHolderObservation | null {
  const path = join(dbDir, entry);
  const id = entry.slice(EPOCH_HOLDER_PREFIX.length, -'.json'.length);
  const unobservable = (removable: boolean): StoreEpochHolderObservation => ({
    id,
    entry,
    path,
    epoch: null,
    pid: null,
    state: 'unobservable',
    removable,
    proof: null,
  });
  try {
    const proof = observeContainedRegularFile(runtime.storage, dbDir, path, { kind: 'proven' });
    if (proof.kind !== 'proven') return unobservable(proof.kind === 'disproven');
    if (runtime.storage.statSync(path).size > MAX_STORE_EPOCH_HOLDER_BYTES) return unobservable(true);
    const value: unknown = JSON.parse(runtime.storage.readFileSync(path, 'utf-8'));
    if (
      !isRecord(value) ||
      typeof value.epoch !== 'string' ||
      !/^[1-9]\d*$/.test(value.epoch) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0
    ) {
      return unobservable(true);
    }
    const pid = Number(value.pid);
    const directory = epochDirectory(dbDir, value.epoch);
    const rootProof = observeContainedDirectory(runtime.storage, dbDir, directory);
    const lockProof = observeStoreEpochLock(runtime.storage, dbDir, value.epoch, rootProof);
    if (lockProof.kind !== 'proven') return unobservable(lockProof.kind === 'disproven');
    return {
      id,
      entry,
      path,
      epoch: value.epoch,
      pid,
      state: 'unobservable',
      removable: false,
      proof: null,
    };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return unobservable(error instanceof SyntaxError);
  }
}

function inspectStoreEpochHolder(runtime: Runtime, dbDir: string, entry: string): StoreEpochHolderObservation | null {
  const holder = observeStoreEpochHolder(runtime, dbDir, entry);
  if (holder?.epoch === null || holder === null) return holder;
  const attempt = attemptExclusiveFileLockSync(storeEpochLockPath(dbDir, holder.epoch));
  if (attempt.kind === 'unobservable') return holder;
  return {
    ...holder,
    state: attempt.kind === 'contended' ? 'live' : 'stale',
    removable: true,
    proof: attempt.kind === 'acquired' ? attempt.lease : null,
  };
}

function observeStoreEpochHolders(
  runtime: Runtime,
  dbDir: string,
  inspectLiveness = false,
):
  | Readonly<{ kind: 'observed'; holders: readonly StoreEpochHolderObservation[] }>
  | Readonly<{ kind: 'unobservable' }> {
  let entries: readonly string[];
  try {
    entries = runtime.storage.readdirSync(dbDir);
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT' ? { kind: 'observed', holders: [] } : { kind: 'unobservable' };
  }
  const holders: StoreEpochHolderObservation[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(EPOCH_HOLDER_PREFIX) || !entry.endsWith('.json')) continue;
    const holder = inspectLiveness
      ? inspectStoreEpochHolder(runtime, dbDir, entry)
      : observeStoreEpochHolder(runtime, dbDir, entry);
    if (holder !== null) holders.push(holder);
  }
  return { kind: 'observed', holders };
}

export function listStoreEpochHolders(runtime: Runtime): readonly StoreEpochHolderListEntry[] {
  let dbDir: string;
  try {
    dbDir = runtime.storage.realpathSync(runtime.paths.coral.store.dbDir);
  } catch {
    return [];
  }
  const observed = observeStoreEpochHolders(runtime, dbDir);
  if (observed.kind === 'unobservable') {
    return [{ id: 'unobservable', epoch: null, pid: null, state: 'unobservable' }];
  }
  return observed.holders.map(({ id, epoch, pid, state, proof }) => {
    proof?.();
    return { id, epoch, pid, state };
  });
}

export function sweepStoreEpochs(
  runtime: Runtime,
  configuredDbDir: string,
  current: StoreEpoch | null,
  options: {
    readonly assertOwned?: () => void;
    readonly releaseEpoch?: StoreEpoch;
  } = {},
): StoreEpochSweepResult {
  const { storage } = runtime;
  const dbDir = storage.realpathSync(configuredDbDir);
  if (options.releaseEpoch !== undefined) {
    const initialReleaseProof = proveReleaseTarget(storage, dbDir, options.releaseEpoch);
    if (initialReleaseProof === 'current') return 'current';
    if (initialReleaseProof === 'unobservable') return 'unobservable-metadata';
  }

  const holderRead = observeStoreEpochHolders(runtime, dbDir, true);
  if (holderRead.kind === 'unobservable') return 'unobservable-holder';
  let holdersChanged = false;
  let holderDeletionFailed = false;
  let releaseHolderLive = false;
  let unobservableHolder = false;
  for (const holder of holderRead.holders) {
    if (holder.state === 'live') {
      releaseHolderLive ||= holder.epoch === options.releaseEpoch;
      continue;
    }
    if (holder.state === 'unobservable' && (options.releaseEpoch === undefined || !holder.removable)) {
      unobservableHolder = true;
      continue;
    }
    try {
      holdersChanged = true;
      const removed = removeDuringSweep(storage, dbDir, holder.path);
      holderDeletionFailed ||= !removed;
      if (holder.state === 'unobservable') unobservableHolder = true;
    } finally {
      holder.proof?.();
    }
  }
  if (holdersChanged) {
    try {
      if (!storage.syncDirectoryDurableSync(dbDir)) {
        return options.releaseEpoch === undefined ? 'durability-sync-failed' : 'pre-deletion-durability-sync-failed';
      }
    } catch (error: unknown) {
      auditSweepFailure(dbDir, error);
      return options.releaseEpoch === undefined ? 'durability-sync-failed' : 'pre-deletion-durability-sync-failed';
    }
  }
  if (holderDeletionFailed) {
    return options.releaseEpoch === undefined ? 'deletion-failed' : 'holder-cleanup-failed';
  }
  if (unobservableHolder) return 'unobservable-holder';
  if (releaseHolderLive) return 'live-holder';

  try {
    const coordinator = probeCoordinator(runtime);
    if (
      coordinator.kind === 'unobservable' ||
      (coordinator.kind === 'absent' && options.releaseEpoch === undefined) ||
      (coordinator.kind === 'live' &&
        coordinator.record.pid !== runtime.env.pid() &&
        (options.releaseEpoch === undefined ||
          coordinator.record.storeEpoch === undefined ||
          coordinator.record.storeEpoch === options.releaseEpoch))
    ) {
      return coordinator.kind === 'live' ? 'live-holder' : 'unobservable-metadata';
    }
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'unobservable-metadata';
  }

  if (options.releaseEpoch !== undefined) {
    options.assertOwned?.();
    const proof = proveReleaseTarget(storage, dbDir, options.releaseEpoch);
    if (proof === 'current') return 'current';
    if (proof === 'unobservable') return 'unobservable-metadata';
    if (proof === 'absent') {
      try {
        return storage.syncDirectoryDurableSync(dbDir) ? 'absent' : 'absent-durability-sync-failed';
      } catch (error: unknown) {
        auditSweepFailure(dbDir, error);
        return 'absent-durability-sync-failed';
      }
    }
    const removal = removeEpochEntry(runtime, dbDir, options.releaseEpoch);
    if (removal === 'locked') return 'live-holder';
    const releaseRemoval: Exclude<LockedRemoval, 'locked'> = removal;
    try {
      if (!storage.syncDirectoryDurableSync(dbDir)) return 'durability-sync-failed';
      if (releaseRemoval === 'lock-release-failed') return 'lock-release-failed';
      return releaseRemoval === 'removed' ? 'complete' : 'deletion-failed';
    } catch (error: unknown) {
      auditSweepFailure(dbDir, error);
      return 'durability-sync-failed';
    }
  }

  if (current === null) return 'unobservable-metadata';

  let entries: readonly string[];
  try {
    entries = storage.readdirSync(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'unobservable-metadata';
  }

  const observations = observeStoreEpochs(storage, dbDir, entries);
  const byEpoch = new Map(observations.map((observation) => [observation.epoch, observation]));
  const garbageEpochs = garbageStoreEpochs(
    observations.filter(({ proof }) => proof.kind === 'proven').map(({ epoch }) => epoch),
  );
  let complete = true;
  let liveHolder = false;
  let lockReleaseFailed = false;
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && garbageEpochs.has(observation.epoch);
    if (invalidEpochEntry || (epoch !== current && (disprovenEpochEntry || garbageEpoch))) {
      if (epoch === null) {
        complete = removeDuringSweep(storage, dbDir, join(dbDir, entry)) && complete;
      } else {
        const removal = removeEpochEntry(runtime, dbDir, epoch);
        if (removal === 'locked') {
          liveHolder = true;
          auditSweepSkip(join(dbDir, entry));
          continue;
        }
        lockReleaseFailed ||= removal === 'lock-release-failed';
        complete = removal === 'removed' && complete;
      }
    }
  }

  if (compareEpoch(current, '1') >= 0) {
    complete = removeDuringSweep(storage, dbDir, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY)) && complete;
  }
  try {
    if (!storage.syncDirectoryDurableSync(dbDir)) return 'durability-sync-failed';
    if (lockReleaseFailed) return 'lock-release-failed';
    if (!complete) return 'deletion-failed';
    return liveHolder ? 'live-holder' : 'complete';
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'durability-sync-failed';
  }
}

async function yieldSweepTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

async function observeRegularFileAsync(storage: StoragePort, path: string, device: bigint): Promise<StoreEpochProof> {
  try {
    const entry = await storage.lstat(path);
    const identity = storage.lstatSync(path, { bigint: true });
    return entry.isFile() && !entry.isSymbolicLink() && identity.nlink === 1n && identity.dev === device
      ? { kind: 'proven' }
      : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

async function observeContainedDirectoryAsync(
  storage: StoragePort,
  parent: string,
  path: string,
): Promise<StoreEpochProof> {
  try {
    const entry = await storage.lstat(path);
    const parentEntry = storage.lstatSync(parent, { bigint: true });
    const identity = storage.lstatSync(path, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink() || identity.dev !== parentEntry.dev) {
      return { kind: 'disproven' };
    }
    return dirname(storage.realpathSync(path)) === storage.realpathSync(parent)
      ? { kind: 'proven' }
      : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

async function observeContainedRegularFileAsync(
  storage: StoragePort,
  directory: string,
  path: string,
  directoryProof?: StoreEpochProof,
): Promise<StoreEpochProof> {
  directoryProof ??= await observeContainedDirectoryAsync(storage, dirname(directory), directory);
  if (directoryProof.kind !== 'proven') return directoryProof;
  try {
    const directoryEntry = storage.lstatSync(directory, { bigint: true });
    const regular = await observeRegularFileAsync(storage, path, directoryEntry.dev);
    if (regular.kind !== 'proven') return regular;
    return dirname(storage.realpathSync(path)) === storage.realpathSync(directory)
      ? { kind: 'proven' }
      : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

async function observeStoreEpochLockAsync(
  storage: StoragePort,
  dbDir: string,
  epoch: StoreEpoch,
  directoryProof?: StoreEpochProof,
): Promise<StoreEpochProof> {
  const directory = epochDirectory(dbDir, epoch);
  const lock = storeEpochLockPath(dbDir, epoch);
  return observeContainedRegularFileAsync(storage, directory, lock, directoryProof);
}

async function readEpochMetadataAsync(storage: StoragePort, directory: string): Promise<StoreEpochMetadataDisposition> {
  const metadataPath = join(directory, STORE_EPOCH_METADATA_FILE_NAME);
  try {
    const entry = await storage.lstat(metadataPath);
    const identity = storage.lstatSync(metadataPath, { bigint: true });
    const directoryEntry = storage.lstatSync(directory, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      identity.nlink !== 1n ||
      identity.dev !== directoryEntry.dev ||
      entry.size > MAX_STORE_EPOCH_METADATA_BYTES
    ) {
      return { kind: 'malformed' };
    }
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable', cause: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = parseStoreEpochMetadata(JSON.parse(await storage.readFile(metadataPath, 'utf-8')));
    return parsed === null ? { kind: 'malformed' } : { kind: 'valid', value: parsed };
  } catch (error: unknown) {
    return error instanceof SyntaxError
      ? { kind: 'malformed' }
      : { kind: 'unreadable', cause: error instanceof Error ? error.message : String(error) };
  }
}

async function observeStoreEpochAsync(
  storage: StoragePort,
  dbDir: string,
  entry: string,
): Promise<StoreEpochObservation | null> {
  const epoch = epochNumber(entry);
  if (epoch === null) return null;
  const directory = join(dbDir, entry);
  const contained = await observeContainedDirectoryAsync(storage, dbDir, directory);
  if (contained.kind !== 'proven') {
    return {
      epoch,
      proof: contained,
      epochJson:
        contained.kind === 'unobservable' ? { kind: 'unreadable', cause: contained.cause } : { kind: 'malformed' },
    };
  }
  const epochJson = await readEpochMetadataAsync(storage, directory);
  if (epochJson.kind === 'unreadable') {
    return { epoch, proof: { kind: 'unobservable', cause: epochJson.cause }, epochJson };
  }
  const database = await observeContainedRegularFileAsync(storage, directory, epochPath(dbDir, epoch), contained);
  const lock =
    database.kind === 'proven' ? await observeStoreEpochLockAsync(storage, dbDir, epoch, contained) : database;
  return { epoch, proof: epochJson.kind === 'valid' ? lock : { kind: 'disproven' }, epochJson };
}

async function observeStoreEpochHolderAsync(
  runtime: Runtime,
  dbDir: string,
  entry: string,
): Promise<StoreEpochHolderObservation | null> {
  const path = join(dbDir, entry);
  const id = entry.slice(EPOCH_HOLDER_PREFIX.length, -'.json'.length);
  const unobservable = (removable: boolean): StoreEpochHolderObservation => ({
    id,
    entry,
    path,
    epoch: null,
    pid: null,
    state: 'unobservable',
    removable,
    proof: null,
  });
  try {
    const proof = await observeContainedRegularFileAsync(runtime.storage, dbDir, path, { kind: 'proven' });
    if (proof.kind !== 'proven') return unobservable(proof.kind === 'disproven');
    const kind = await runtime.storage.lstat(path);
    if (kind.size > MAX_STORE_EPOCH_HOLDER_BYTES) return unobservable(true);
    const value: unknown = JSON.parse(await runtime.storage.readFile(path, 'utf-8'));
    if (
      !isRecord(value) ||
      typeof value.epoch !== 'string' ||
      !/^[1-9]\d*$/u.test(value.epoch) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0
    ) {
      return unobservable(true);
    }
    const pid = Number(value.pid);
    const directory = epochDirectory(dbDir, value.epoch);
    const rootProof = await observeContainedDirectoryAsync(runtime.storage, dbDir, directory);
    const lockProof = await observeStoreEpochLockAsync(runtime.storage, dbDir, value.epoch, rootProof);
    if (lockProof.kind !== 'proven') return unobservable(lockProof.kind === 'disproven');
    return {
      id,
      entry,
      path,
      epoch: value.epoch,
      pid,
      state: 'unobservable',
      removable: false,
      proof: null,
    };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return unobservable(error instanceof SyntaxError);
  }
}

async function inspectStoreEpochHolderAsync(
  runtime: Runtime,
  dbDir: string,
  entry: string,
): Promise<StoreEpochHolderObservation | null> {
  const holder = await observeStoreEpochHolderAsync(runtime, dbDir, entry);
  if (holder === null || holder.epoch === null) return holder;
  const attempt = attemptExclusiveFileLockSync(storeEpochLockPath(dbDir, holder.epoch));
  if (attempt.kind === 'unobservable') return holder;
  return {
    ...holder,
    state: attempt.kind === 'contended' ? 'live' : 'stale',
    removable: true,
    proof: attempt.kind === 'acquired' ? attempt.lease : null,
  };
}

async function removeDuringPostReadySweep(storage: StoragePort, dbDir: string, path: string): Promise<boolean> {
  try {
    const observed = await storage.lstat(path);
    const device = storage.lstatSync(dbDir, { bigint: true }).dev;
    if (!(await treeStaysOnDeviceAsync(storage, path, device))) {
      auditSweepFailure(path, new Error('Recursive removal crossed the store device boundary.'));
      return false;
    }
    if (observed.isDirectory() && !observed.isSymbolicLink()) {
      await storage.rm(path, { recursive: true, force: true });
    } else {
      await storage.unlink(path);
    }
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return true;
    auditSweepFailure(path, error);
    return false;
  }
}

async function removeWhileExclusivelyLockedAsync(
  runtime: Runtime,
  dbDir: string,
  lockPath: string,
  targetPath: string,
): Promise<LockedRemoval> {
  const attempt = attemptExclusiveFileLockSync(lockPath);
  if (attempt.kind === 'malformed') return removeAfterReapingRenameAsync(runtime, dbDir, targetPath);
  if (attempt.kind === 'unobservable') {
    auditSweepFailure(lockPath, attempt.cause);
    return 'target-failed';
  }
  if (attempt.kind === 'contended') return 'locked';
  const reapingPath = renameForReaping(runtime, dbDir, targetPath);
  const removal =
    reapingPath === null
      ? 'removed'
      : reapingPath === targetPath
        ? 'target-failed'
        : (await removeDuringPostReadySweep(runtime.storage, dbDir, reapingPath))
          ? 'removed'
          : 'target-failed';
  try {
    attempt.lease();
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'lock-release-failed';
  }
  return removal;
}

async function removeAfterReapingRenameAsync(
  runtime: Runtime,
  dbDir: string,
  targetPath: string,
): Promise<LockedRemoval> {
  const reapingPath = renameForReaping(runtime, dbDir, targetPath);
  if (reapingPath === null) return 'removed';
  if (reapingPath === targetPath) return 'target-failed';
  return (await removeDuringPostReadySweep(runtime.storage, dbDir, reapingPath)) ? 'removed' : 'target-failed';
}

async function removeEpochEntryAsync(runtime: Runtime, dbDir: string, epoch: StoreEpoch): Promise<LockedRemoval> {
  const targetPath = epochDirectory(dbDir, epoch);
  const root = await observeContainedDirectoryAsync(runtime.storage, dbDir, targetPath);
  if (root.kind === 'unobservable') return 'target-failed';
  if (root.kind === 'disproven') return removeAfterReapingRenameAsync(runtime, dbDir, targetPath);
  const lock = await observeStoreEpochLockAsync(runtime.storage, dbDir, epoch, root);
  if (lock.kind === 'unobservable') return 'target-failed';
  if (lock.kind === 'disproven') {
    return (await readEpochMetadataAsync(runtime.storage, targetPath)).kind === 'valid'
      ? 'target-failed'
      : removeAfterReapingRenameAsync(runtime, dbDir, targetPath);
  }
  return removeWhileExclusivelyLockedAsync(runtime, dbDir, storeEpochLockPath(dbDir, epoch), targetPath);
}

async function removeAbandonedStoreDirectory(
  runtime: Runtime,
  dbDir: string,
  path: string,
): Promise<LockedRemoval | 'unobservable'> {
  const root = await observeContainedDirectoryAsync(runtime.storage, dbDir, path);
  if (root.kind === 'unobservable') return 'unobservable';
  if (root.kind === 'disproven') return removeAfterReapingRenameAsync(runtime, dbDir, path);
  const lockPath = join(path, STORE_LOCK_FILE_NAME);
  const lock = await observeContainedRegularFileAsync(runtime.storage, path, lockPath, root);
  if (lock.kind === 'unobservable') return 'unobservable';
  if (lock.kind === 'disproven') return 'unobservable';
  return removeWhileExclusivelyLockedAsync(runtime, dbDir, lockPath, path);
}

async function syncDirectoryDurable(storage: StoragePort, path: string): Promise<boolean> {
  try {
    return await storage.syncDirectoryDurable(path);
  } catch (error: unknown) {
    auditSweepFailure(path, error);
    return false;
  }
}

export async function sweepStoreEpochsPostReady(
  runtime: Runtime,
  configuredDbDir: string,
  openEpoch: StoreEpoch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<StoreEpochSweepResult> {
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  let unsyncedMutation = false;
  const syncMutations = async (): Promise<boolean> => {
    if (!unsyncedMutation) return true;
    if (!(await syncDirectoryDurable(runtime.storage, dbDir))) return false;
    unsyncedMutation = false;
    return true;
  };
  const finish = async (result: StoreEpochSweepResult): Promise<StoreEpochSweepResult> =>
    (await syncMutations()) ? result : 'durability-sync-failed';

  if (options.signal?.aborted) return 'cancelled';
  let entries: readonly string[];
  try {
    entries = await runtime.storage.readdir(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'unobservable-metadata';
  }
  if (options.signal?.aborted) return 'cancelled';

  let holderDeletionFailed = false;
  let unobservableHolder = false;
  for (const entry of entries) {
    if (options.signal?.aborted) return finish('cancelled');
    if (!entry.startsWith(EPOCH_HOLDER_PREFIX) || !entry.endsWith('.json')) {
      await yieldSweepTurn();
      continue;
    }
    const holder = await inspectStoreEpochHolderAsync(runtime, dbDir, entry);
    if (holder?.state === 'live') continue;
    if (holder?.state === 'unobservable' && !holder.removable) {
      unobservableHolder = true;
      continue;
    }
    if (holder !== null) {
      try {
        unsyncedMutation = true;
        const removed = await removeDuringPostReadySweep(runtime.storage, dbDir, holder.path);
        holderDeletionFailed ||= !removed;
      } finally {
        holder.proof?.();
      }
    }
    await yieldSweepTurn();
  }
  if (!(await syncMutations())) return 'durability-sync-failed';
  if (holderDeletionFailed) return 'deletion-failed';
  if (unobservableHolder) return 'unobservable-holder';

  const observations: StoreEpochObservation[] = [];
  for (const entry of entries) {
    if (options.signal?.aborted) return finish('cancelled');
    const observation = await observeStoreEpochAsync(runtime.storage, dbDir, entry);
    if (observation !== null) observations.push(observation);
    await yieldSweepTurn();
  }
  const byEpoch = new Map(observations.map((observation) => [observation.epoch, observation]));
  const garbageEpochs = garbageStoreEpochs(
    observations.filter(({ proof }) => proof.kind === 'proven').map(({ epoch }) => epoch),
  );
  let complete = true;
  let liveHolder = false;
  let lockReleaseFailed = false;
  let unobservableResidue = false;
  for (const entry of entries) {
    if (options.signal?.aborted) return finish('cancelled');
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const abandonedStoreDirectory = isStoreEpochResidue(entry);
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && garbageEpochs.has(observation.epoch);
    if (
      abandonedStoreDirectory ||
      invalidEpochEntry ||
      (epoch !== openEpoch && (disprovenEpochEntry || garbageEpoch))
    ) {
      const wasUnsynced: boolean = unsyncedMutation;
      unsyncedMutation = true;
      const removal = abandonedStoreDirectory
        ? await removeAbandonedStoreDirectory(runtime, dbDir, join(dbDir, entry))
        : epoch === null
          ? (await removeDuringPostReadySweep(runtime.storage, dbDir, join(dbDir, entry)))
            ? 'removed'
            : 'target-failed'
          : await removeEpochEntryAsync(runtime, dbDir, epoch);
      if (removal === 'unobservable') {
        unsyncedMutation = wasUnsynced;
        unobservableResidue = true;
        await yieldSweepTurn();
        continue;
      }
      if (removal === 'locked') {
        liveHolder = true;
        auditSweepSkip(join(dbDir, entry));
        await yieldSweepTurn();
        continue;
      }
      lockReleaseFailed ||= removal === 'lock-release-failed';
      complete = removal === 'removed' && complete;
    }
    await yieldSweepTurn();
  }

  if (options.signal?.aborted) return finish('cancelled');
  if (compareEpoch(openEpoch, '1') >= 0) {
    unsyncedMutation = true;
    const removed = await removeDuringPostReadySweep(
      runtime.storage,
      dbDir,
      join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY),
    );
    complete = removed && complete;
  }
  if (!(await syncMutations())) return 'durability-sync-failed';
  if (lockReleaseFailed) return 'lock-release-failed';
  if (!complete) return 'deletion-failed';
  if (unobservableResidue) return 'unobservable-metadata';
  return liveHolder ? 'live-holder' : 'complete';
}

function cleanupMint(storage: StoragePort, mint: string): void {
  try {
    storage.rmSync(mint, { recursive: true, force: true });
  } catch (error: unknown) {
    auditSweepFailure(mint, error);
  }
}

function selectSuccessor(
  runtime: Runtime,
  dbDir: string,
  current: StoreEpoch | null,
): Readonly<{ kind: 'selected'; epoch: StoreEpoch }> {
  let candidate = successorEpoch(current);
  const attempts = runtime.storage.readdirSync(dbDir).length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runtime.storage.lstatSync(epochDirectory(dbDir, candidate));
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return { kind: 'selected', epoch: candidate };
      if (error instanceof Error) {
        error.message = `The lstat syscall for store epoch successor '${epochDirectory(dbDir, candidate)}' was refused with errno ${errorCode(error) ?? 'UNKNOWN'}: ${error.message}`;
      }
      throw error;
    }
    candidate = successorEpoch(candidate);
  }
  return { kind: 'selected', epoch: candidate };
}

function mintNextEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  supersedes: StoreEpoch | null,
  successor: StoreEpoch,
  classification: StoreEpochClassification,
): Readonly<{ kind: 'published'; lease: FileLockLease }> | Readonly<{ kind: 'contended' | 'swept' }> {
  const id = runtime.ids.uuid();
  const construction = join(dbDir, `${PRIVATE_MINT_CONSTRUCTION_PREFIX}${id}`);
  const preparation = join(dbDir, `${MINT_PREPARATION_DIRECTORY_PREFIX}${id}`);
  const mint = join(dbDir, `${MINT_DIRECTORY_PREFIX}${id}`);
  let mintLease: FileLockLease;
  try {
    mintLease = createSharedFileLockSync(join(construction, STORE_LOCK_FILE_NAME));
  } catch (error: unknown) {
    cleanupMint(runtime.storage, construction);
    if (errorCode(error) === 'ENOENT') return { kind: 'swept' };
    throw error;
  }
  try {
    runtime.storage.renameSync(construction, preparation);
  } catch (error: unknown) {
    mintLease();
    cleanupMint(runtime.storage, construction);
    const code = errorCode(error);
    if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return { kind: 'contended' };
    if (code === 'ENOENT') return { kind: 'swept' };
    throw error;
  }
  try {
    runtime.storage.renameSync(preparation, mint);
  } catch (error: unknown) {
    mintLease();
    cleanupMint(runtime.storage, preparation);
    const code = errorCode(error);
    if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return { kind: 'contended' };
    if (code === 'ENOENT') return { kind: 'swept' };
    throw error;
  }
  let leaseTransferred = false;
  try {
    const opened = openWritableStoreDatabase({
      path: join(mint, STORE_DATABASE_FILE_NAME),
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    if (opened.kind !== 'opened') {
      throw new Error(`A private store mint was classified as ${opened.classification.kind}.`);
    }
    opened.db.close();
    writeEpochMetadata(
      runtime.storage,
      mint,
      metadataFor(supersedes, classification, options.build, new Date(runtime.time.now()).toISOString()),
    );
    try {
      runtime.storage.renameSync(mint, epochDirectory(dbDir, successor));
      if (!runtime.storage.syncDirectoryDurableSync(dbDir)) {
        throw new Error(`Failed to durably sync store epoch root '${dbDir}'.`);
      }
      leaseTransferred = true;
      return { kind: 'published', lease: mintLease };
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return { kind: 'contended' };
      if (code === 'ENOENT') return { kind: 'swept' };
      throw error;
    }
  } finally {
    cleanupMint(runtime.storage, construction);
    cleanupMint(runtime.storage, preparation);
    cleanupMint(runtime.storage, mint);
    if (!leaseTransferred) mintLease();
  }
}

function openPublishedEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  epoch: StoreEpoch,
  lease: FileLockLease,
): StoreEpochSettlement {
  const path = epochPath(dbDir, epoch);
  try {
    assertProvenStoreOpenable(runtime.storage, path);
    const db = openStoreDatabase({
      path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
    return { db: registerStoreEpochHolder(runtime, epoch, db, lease), epoch, path };
  } catch (error: unknown) {
    lease();
    throw error;
  }
}

function assertProvenStoreOpenable(storage: StoragePort, path: string): void {
  let descriptor: number;
  try {
    descriptor = storage.openSync(path, 'r+');
  } catch (error: unknown) {
    if (error instanceof Error) {
      error.message = `The open syscall for proven store epoch '${path}' was refused with errno ${errorCode(error) ?? 'UNKNOWN'}: ${error.message}`;
    }
    throw error;
  }
  try {
    storage.closeSync(descriptor);
  } catch {
    // This descriptor is only an openability probe. SQLite owns the database handle it opens by pathname.
  }
}

function tryOpenCurrentEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  epoch: StoreEpoch,
  path: string,
):
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'replace'; readonly classification: StoreEpochClassification } {
  let lease: FileLockLease | null = null;
  try {
    lease = acquireStoreEpochReadLock(runtime, epochPath(runtime.paths.coral.store.dbDir, epoch));
    if (lease === null) {
      return {
        kind: 'replace',
        classification: unavailableClassification(
          new Error(`Store epoch ${epoch} did not retain its canonical proof.`),
        ),
      };
    }
    assertProvenStoreOpenable(runtime.storage, path);
  } catch (error: unknown) {
    lease?.();
    return { kind: 'replace', classification: unavailableClassification(error) };
  }
  try {
    const decision = openWritableStoreDatabase({
      path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    if (decision.kind !== 'opened') {
      lease();
      return { kind: 'replace', classification: decision.classification };
    }
    return { kind: 'opened', db: registerStoreEpochHolder(runtime, epoch, decision.db, lease) };
  } catch (error: unknown) {
    lease();
    return { kind: 'replace', classification: unavailableClassification(error) };
  }
}

export function settleStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const configuredDbDir = resolveStoreDbDir(runtime, options.path);
  if (configuredDbDir === ':memory:') {
    const opened = openWritableStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    if (opened.kind !== 'opened') throw new Error('An in-memory store cannot be incompatible before opening.');
    return { db: opened.db, epoch: '1', path: ':memory:' };
  }

  runtime.storage.mkdirSync(configuredDbDir, { recursive: true, mode: 0o700 });
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  for (;;) {
    const observations = observeStoreEpochs(runtime.storage, dbDir);
    const current = currentProvenEpoch(observations);
    let classification: StoreEpochClassification = { kind: 'absent' };
    if (current !== null) {
      const path = epochPath(dbDir, current.epoch);
      const opened = tryOpenCurrentEpoch(runtime, options, current.epoch, path);
      if (opened.kind === 'opened') {
        if (!runtime.storage.syncDirectoryDurableSync(dbDir)) {
          opened.db.close();
          throw new Error(`Failed to durably adopt store epoch ${current.epoch} in '${dbDir}'.`);
        }
        opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
        return { db: opened.db, epoch: current.epoch, path };
      }
      classification = opened.classification;
    }
    const successor = selectSuccessor(runtime, dbDir, current?.epoch ?? null);
    const published = mintNextEpoch(runtime, options, dbDir, current?.epoch ?? null, successor.epoch, classification);
    if (published.kind === 'published') {
      return openPublishedEpoch(runtime, options, dbDir, successor.epoch, published.lease);
    }
    if (published.kind === 'swept') continue;
  }
}

export function discardCurrentStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const configuredDbDir = resolveStoreDbDir(runtime, options.path);
  if (configuredDbDir === ':memory:') throw new Error('Cannot discard an in-memory store epoch.');
  runtime.storage.mkdirSync(configuredDbDir, { recursive: true, mode: 0o700 });
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  for (;;) {
    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    const successor = selectSuccessor(runtime, dbDir, current);
    const published = mintNextEpoch(runtime, options, dbDir, current, successor.epoch, {
      kind: 'unavailable',
      cause: 'operator-discard',
    });
    if (published.kind === 'published') {
      return openPublishedEpoch(runtime, options, dbDir, successor.epoch, published.lease);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStoreEpochMetadata(value: unknown): StoreEpochMetadata | null {
  if (!isRecord(value)) return null;
  const supersedes =
    value.supersedes === null
      ? null
      : typeof value.supersedes === 'string' && /^[1-9]\d*$/.test(value.supersedes)
        ? value.supersedes
        : typeof value.supersedes === 'number' && Number.isSafeInteger(value.supersedes) && value.supersedes >= 1
          ? String(value.supersedes)
          : undefined;
  if (supersedes === undefined) return null;
  if (!isRecord(value.classification) || typeof value.classification.kind !== 'string') return null;
  if (!isRecord(value.build) || typeof value.build.version !== 'string') return null;
  if (typeof value.publishedAt !== 'string') return null;
  const build = value.build;
  if (
    typeof build.buildSetId !== 'string' ||
    typeof build.bundleHash !== 'string' ||
    (build.flavor !== 'prod' && build.flavor !== 'dev') ||
    typeof build.storeFormatFingerprint !== 'string'
  ) {
    return null;
  }
  return { ...value, supersedes } as StoreEpochMetadata;
}

function readEpochMetadata(
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync'>,
  directory: string,
): StoreEpochMetadataDisposition {
  const metadataPath = join(directory, STORE_EPOCH_METADATA_FILE_NAME);
  try {
    const directoryEntry = storage.lstatSync(directory, { bigint: true });
    const entry = storage.lstatSync(metadataPath, { bigint: true });
    if (
      !entry.isFile() ||
      entry.nlink !== 1n ||
      entry.dev !== directoryEntry.dev ||
      entry.size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)
    ) {
      return { kind: 'malformed' };
    }
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable', cause: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = parseStoreEpochMetadata(JSON.parse(storage.readFileSync(metadataPath, 'utf-8')));
    return parsed === null ? { kind: 'malformed' } : { kind: 'valid', value: parsed };
  } catch (error: unknown) {
    return error instanceof SyntaxError
      ? { kind: 'malformed' }
      : { kind: 'unreadable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function entryBytes(storage: StoragePort, root: string): number | null {
  let total = 0;
  const inventory = (path: string): boolean => {
    const entry = storage.lstatSync(path, { bigint: true });
    if (entry.isDirectory()) {
      for (const child of storage.readdirSync(path)) {
        if (!inventory(join(path, child))) return false;
      }
      return true;
    }
    if (entry.size < 0n || entry.size > BigInt(Number.MAX_SAFE_INTEGER - total)) return false;
    total += Number(entry.size);
    return true;
  };
  try {
    return inventory(root) ? total : null;
  } catch {
    return null;
  }
}

function epochBytes(storage: StoragePort, dbDir: string, epoch: StoreEpoch): number | null {
  return entryBytes(storage, epochDirectory(dbDir, epoch));
}

function isStoreEpochResidue(name: string): boolean {
  return (
    name.startsWith(MINT_DIRECTORY_PREFIX) ||
    name.startsWith(MINT_PREPARATION_DIRECTORY_PREFIX) ||
    name.startsWith(PRIVATE_MINT_CONSTRUCTION_PREFIX) ||
    name.startsWith(REAPING_DIRECTORY_PREFIX)
  );
}

export function listStoreEpochResidues(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
): readonly StoreEpochResidueListEntry[] {
  const configuredDbDir = runtime.paths.coral.store.dbDir;
  if (!runtime.storage.existsSync(configuredDbDir)) return [];
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  return runtime.storage
    .readdirSync(dbDir)
    .filter(isStoreEpochResidue)
    .sort()
    .map((name) => {
      const path = join(dbDir, name);
      const root = observeContainedDirectory(runtime.storage, dbDir, path);
      let state: StoreEpochResidueListEntry['state'];
      if (root.kind === 'unobservable' || root.kind === 'proven') {
        state = 'unobservable';
      } else {
        state = 'reclaimable';
      }
      return { name, bytes: entryBytes(runtime.storage, path), state };
    });
}

export function listStoreEpochs(runtime: Pick<Runtime, 'paths' | 'storage'>): readonly StoreEpochListEntry[] {
  const configuredDbDir = runtime.paths.coral.store.dbDir;
  if (!runtime.storage.existsSync(configuredDbDir)) return [];
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  const observations = observeStoreEpochs(runtime.storage, dbDir);
  const current = currentProvenEpoch(observations)?.epoch ?? null;
  const garbageEpochs = garbageStoreEpochs(
    observations.filter(({ proof }) => proof.kind === 'proven').map(({ epoch }) => epoch),
  );

  return [...observations]
    .sort((left, right) => compareEpoch(right.epoch, left.epoch))
    .map((observation) => {
      const { epoch } = observation;
      const publicationReason =
        observation.epochJson.kind === 'valid'
          ? observation.epochJson.value.classification
          : unavailableClassification(new Error('Epoch metadata is not valid.'));
      return {
        epoch,
        role:
          observation.proof.kind === 'unobservable'
            ? 'unobservable'
            : observation.proof.kind === 'proven' && epoch === current
              ? 'current'
              : observation.proof.kind === 'proven' && !garbageEpochs.has(epoch)
                ? 'preserved'
                : 'garbage',
        bytes: observation.proof.kind === 'proven' ? epochBytes(runtime.storage, dbDir, epoch) : null,
        publicationReason,
        supersededStoreVersion:
          'storedProductVersion' in publicationReason ? publicationReason.storedProductVersion : null,
        epochJson: observation.epochJson,
      };
    });
}

export function storeEpochHookSource(): string {
  return String.raw`// Generated from src/store/epoch.ts by scripts/build-server.mjs. Do not edit directly.
import { lstatSync, readFileSync, readdirSync, realpathSync } from '${'node:' + 'fs'}';
import { DatabaseSync } from '${'node:' + 'sqlite'}';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const EPOCH_DIRECTORY_PATTERN = /^epoch-([1-9]\d*)$/;
const MAX_STORE_EPOCH_METADATA_BYTES = ${MAX_STORE_EPOCH_METADATA_BYTES};
const HOOK_LOCK_TIMEOUT_MS = 1000;

function epochNumber(name) {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  return match?.[1] ?? null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEpochMetadata(value) {
  if (!isRecord(value)) return false;
  const validSupersedes =
    value.supersedes === null ||
    (typeof value.supersedes === 'string' && /^[1-9]\d*$/.test(value.supersedes)) ||
    (Number.isSafeInteger(value.supersedes) && value.supersedes >= 1);
  if (!validSupersedes) return false;
  if (!isRecord(value.classification) || typeof value.classification.kind !== 'string') return false;
  if (!isRecord(value.build) || typeof value.build.version !== 'string') return false;
  if (typeof value.publishedAt !== 'string') return false;
  return (
    typeof value.build.buildSetId === 'string' &&
    typeof value.build.bundleHash === 'string' &&
    (value.build.flavor === 'prod' || value.build.flavor === 'dev') &&
    typeof value.build.storeFormatFingerprint === 'string'
  );
}

function isRegularFile(path, device) {
  try {
    const entry = lstatSync(path, { bigint: true });
    return entry.isFile() && entry.nlink === 1n && entry.dev === device;
  } catch {
    return false;
  }
}

function resolveStoreRoot(dbDir) {
  const path = realpathSync(dbDir);
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isDirectory()) throw new Error('Store root is not a directory.');
  return { path, device: entry.dev };
}

function isPublishedEpoch(root, name) {
  const directory = join(root.path, name);
  try {
    const entry = lstatSync(directory, { bigint: true });
    if (!entry.isDirectory() || entry.dev !== root.device) return false;
    const relativePath = relative(root.path, realpathSync(directory));
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith('..' + sep) ||
      isAbsolute(relativePath)
    ) {
      return false;
    }
    const metadataPath = join(directory, 'epoch.json');
    const databasePath = join(directory, 'store.db');
    const lockPath = join(directory, '.lock');
    if (
      !isRegularFile(databasePath, entry.dev) ||
      !isRegularFile(metadataPath, entry.dev) ||
      !isRegularFile(lockPath, entry.dev)
    ) {
      return false;
    }
    const realDirectory = realpathSync(directory);
    if (dirname(realpathSync(databasePath)) !== realDirectory || dirname(realpathSync(lockPath)) !== realDirectory) {
      return false;
    }
    if (lstatSync(metadataPath, { bigint: true }).size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)) return false;
    return isValidEpochMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')));
  } catch {
    return false;
  }
}

export function resolveCurrentStoreDbPath(dbDir) {
  let current = null;
  let entries;
  let root;
  try {
    root = resolveStoreRoot(dbDir);
    entries = readdirSync(root.path);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (
      epoch !== null &&
      (current === null || BigInt(epoch) > BigInt(current)) &&
      isPublishedEpoch(root, entry)
    ) {
      current = epoch;
    }
  }
  if (current === null) return null;
  return join(root.path, 'epoch-' + current, 'store.db');
}

function storeEpochForDbPath(dbDir, dbPath) {
  const resolvedPath = resolve(dbPath);
  if (basename(resolvedPath) !== 'store.db') return null;
  const directory = dirname(resolvedPath);
  return dirname(directory) === resolve(dbDir) ? epochNumber(basename(directory)) : null;
}

function acquireSharedStoreEpochLock(dbDir, epoch) {
  const lock = new DatabaseSync(join(dbDir, 'epoch-' + epoch, '.lock'), {
    readOnly: true,
    timeout: HOOK_LOCK_TIMEOUT_MS,
  });
  try {
    lock.exec('PRAGMA busy_timeout = ' + HOOK_LOCK_TIMEOUT_MS + '; BEGIN; SELECT count(*) FROM sqlite_schema');
  } catch (error) {
    lock.close();
    throw error;
  }
  return () => {
    try {
      lock.exec('ROLLBACK');
    } finally {
      lock.close();
    }
  };
}

export function openLockedReadOnlyStoreDatabase(dbDir, dbPath) {
  const epoch = storeEpochForDbPath(dbDir, dbPath);
  const root = resolveStoreRoot(dbDir);
  if (epoch === null || !isPublishedEpoch(root, 'epoch-' + epoch)) {
    throw new Error('Resolved store database is outside the proven canonical epoch layout.');
  }
  const releaseLock = acquireSharedStoreEpochLock(root.path, epoch);
  let db;
  try {
    db = new DatabaseSync(join(root.path, 'epoch-' + epoch, 'store.db'), { readOnly: true });
  } catch (error) {
    releaseLock();
    throw error;
  }
  let closed = false;
  return {
    db,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        releaseLock();
      }
    },
  };
}
`;
}
