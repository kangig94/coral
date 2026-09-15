import { basename, join, resolve } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { probeCoordinator } from '../infra/backend-discovery.js';
import { acquireSharedFileLockSync, tryAcquireExclusiveFileLockSync, type FileLockLease } from '../infra/fs-lock.js';
import type { StoragePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { classifyStoreFile, openStoreDatabase, openWritableStoreDatabase, type Database } from './db.js';
import type { StoreFormatClassification, StoreFormatDescription } from './format-fingerprint.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from './reset-incident.js';

export const STORE_DATABASE_FILE_NAME = 'store.db';
export const STORE_EPOCH_METADATA_FILE_NAME = 'epoch.json';
export const MAX_STORE_EPOCH_METADATA_BYTES = 64 * 1024;
export const MAX_STORE_EPOCH_HOLDER_BYTES = 4 * 1024;

const STORE_FORMAT_SIDECAR_SUFFIX = '.format';
const EPOCH_DIRECTORY_PATTERN = /^epoch-([1-9]\d*)$/;
const EPOCH_LOCK_PATTERN = /^\.epoch-lock-(0|[1-9]\d*)\.sqlite$/;
const MINT_DIRECTORY_PREFIX = '.mint-';
const EPOCH_HOLDER_PREFIX = '.epoch-holder-';
const EPOCH_LOCK_PREFIX = '.epoch-lock-';
const MINT_LOCK_PREFIX = '.mint-lock-';

export type StoreEpochClassification =
  | StoreFormatClassification
  | { readonly kind: 'unavailable'; readonly cause: string };

export type StoreEpochMetadata = Readonly<{
  supersedes: StoreEpoch;
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
  classification: StoreEpochClassification;
  storedProductVersion: string | null;
  epochJson: StoreEpochMetadataDisposition;
}>;

export type StoreEpochHolderListEntry = Readonly<{
  id: string;
  epoch: StoreEpoch | null;
  pid: number | null;
  state: 'live' | 'stale' | 'unobservable';
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
  | 'lock-cleanup-failed'
  | 'pre-deletion-durability-sync-failed'
  | 'durability-sync-failed';

export type StoreEpochMetadataDisposition =
  | Readonly<{ kind: 'legacy-epoch-0' }>
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

function successorEpoch(epoch: StoreEpoch): StoreEpoch {
  return (BigInt(epoch) + 1n).toString();
}

export function epochDirectory(dbDir: string, epoch: StoreEpoch): string {
  return epoch === '0' ? dbDir : join(dbDir, `epoch-${epoch}`);
}

export function epochPath(dbDir: string, epoch: StoreEpoch): string {
  return join(epochDirectory(dbDir, epoch), STORE_DATABASE_FILE_NAME);
}

export function storeEpochHolderPath(dbDir: string, id: string): string {
  return join(dbDir, `${EPOCH_HOLDER_PREFIX}${id}.json`);
}

export function storeEpochLockPath(dbDir: string, epoch: StoreEpoch): string {
  return join(dbDir, `${EPOCH_LOCK_PREFIX}${epoch}.sqlite`);
}

export function storeMintLockPath(dbDir: string, id: string): string {
  return join(dbDir, `${MINT_LOCK_PREFIX}${id}.sqlite`);
}

export function resolveStoreDbDir(runtime: Pick<Runtime, 'paths'>, path?: string): string {
  if (path === undefined) return runtime.paths.coral.store.dbDir;
  if (path === ':memory:') return ':memory:';
  return resolve(path, '..');
}

type StoreEpochDiscoveryStorage = Pick<StoragePort, 'lstatSync' | 'readFileSync' | 'readdirSync' | 'statSync'>;

type StoreEpochObservation = Readonly<{
  epoch: StoreEpoch;
  proof: StoreEpochProof;
  epochJson: StoreEpochMetadataDisposition;
}>;

type ProvenStoreEpochObservation = StoreEpochObservation &
  Readonly<{ proof: Extract<StoreEpochProof, { readonly kind: 'proven' }> }>;

function observeRegularFile(storage: Pick<StoragePort, 'lstatSync'>, path: string): StoreEpochProof {
  try {
    const entry = storage.lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink() ? { kind: 'proven' } : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function observeEpochZero(storage: Pick<StoragePort, 'lstatSync'>, dbDir: string): StoreEpochObservation | null {
  const path = epochPath(dbDir, '0');
  try {
    const entry = storage.lstatSync(path);
    const proof =
      entry.isFile() && !entry.isSymbolicLink() ? ({ kind: 'proven' } as const) : ({ kind: 'disproven' } as const);
    return { epoch: '0', proof, epochJson: { kind: 'legacy-epoch-0' } };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return {
      epoch: '0',
      proof: { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) },
      epochJson: { kind: 'legacy-epoch-0' },
    };
  }
}

function observeEpochDirectory(
  storage: Pick<StoragePort, 'lstatSync'>,
  path: string,
): Exclude<StoreEpochProof, { readonly kind: 'proven' }> | Readonly<{ kind: 'contained' }> {
  try {
    const entry = storage.lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return { kind: 'disproven' };
    return { kind: 'contained' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
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
  const epochZero = observeEpochZero(storage, dbDir);
  if (epochZero !== null) observations.push(epochZero);
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (epoch === null || epoch === '0') continue;
    const directory = join(dbDir, entry);
    const contained = observeEpochDirectory(storage, directory);
    if (contained.kind !== 'contained') {
      observations.push({
        epoch,
        proof: contained,
        epochJson:
          contained.kind === 'unobservable' ? { kind: 'unreadable', cause: contained.cause } : { kind: 'malformed' },
      });
      continue;
    }
    const epochJson = readEpochMetadata(storage, directory);
    if (epochJson.kind === 'unreadable') {
      observations.push({ epoch, proof: { kind: 'unobservable', cause: epochJson.cause }, epochJson });
      continue;
    }
    const database = observeRegularFile(storage, epochPath(directory, '0'));
    const proof = epochJson.kind === 'valid' ? database : { kind: 'disproven' as const };
    observations.push({ epoch, proof, epochJson });
  }
  return observations;
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
  return currentProvenEpoch(observeStoreEpochs(storage, dbDir))?.epoch ?? null;
}

export function resolveCurrentStorePath(runtime: Pick<Runtime, 'paths' | 'storage'>, path?: string): string {
  if (path !== undefined) return path;
  const dbDir = resolveStoreDbDir(runtime);
  if (!runtime.storage.existsSync(dbDir)) return epochPath(dbDir, '0');
  const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
  return epochPath(dbDir, current ?? '0');
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
  const proof =
    storeDbPath === ':memory:' ? { kind: 'disproven' as const } : observeRegularFile(runtime.storage, storeDbPath);
  if (proof.kind === 'proven') {
    const epoch = storeEpochAtPath(runtime.paths.coral.store.dbDir, storeDbPath);
    const lease =
      epoch === null ? null : acquireSharedFileLockSync(storeEpochLockPath(runtime.paths.coral.store.dbDir, epoch));
    if (epoch !== null && observeRegularFile(runtime.storage, storeDbPath).kind !== 'proven') {
      lease?.();
    } else {
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
  }
  throw documentedCoralSetupError('store_not_initialized', { path: storeDbPath });
}

function storeEpochAtPath(dbDir: string, path: string): StoreEpoch | null {
  if (path === epochPath(dbDir, '0')) return '0';
  const directory = resolve(path, '..');
  return resolve(directory, '..') === resolve(dbDir) ? epochNumber(basename(directory)) : null;
}

export function acquireStoreEpochReadLock(runtime: Pick<Runtime, 'paths'>, storeDbPath: string): FileLockLease | null {
  const dbDir = runtime.paths.coral.store.dbDir;
  const epoch = storeEpochAtPath(dbDir, storeDbPath);
  return epoch === null ? null : acquireSharedFileLockSync(storeEpochLockPath(dbDir, epoch));
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
  retained.add('0');
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
  supersedes: StoreEpoch,
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

function removeDuringSweep(storage: StoragePort, path: string): boolean {
  try {
    const observed = storage.lstatSync(path);
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

type LockedRemoval = 'removed' | 'locked' | 'target-failed' | 'lock-cleanup-failed';

function removeWhileExclusivelyLocked(
  runtime: Runtime,
  lockPath: string,
  targetPath: string,
  removeLockFile: boolean,
): LockedRemoval {
  let lease: FileLockLease | null;
  try {
    lease = tryAcquireExclusiveFileLockSync(lockPath);
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'target-failed';
  }
  if (lease === null) return 'locked';
  const removed = removeDuringSweep(runtime.storage, targetPath);
  lease();
  if (removed && removeLockFile) {
    try {
      runtime.storage.unlinkSync(lockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        auditSweepFailure(lockPath, error);
        return 'lock-cleanup-failed';
      }
    }
  }
  return removed ? 'removed' : 'target-failed';
}

function removeOrphanedEpochLock(runtime: Runtime, dbDir: string, entry: string): LockedRemoval | null {
  const epoch = EPOCH_LOCK_PATTERN.exec(entry)?.[1];
  if (epoch === undefined) return null;
  const targetPath = epoch === '0' ? epochPath(dbDir, epoch) : epochDirectory(dbDir, epoch);
  try {
    runtime.storage.lstatSync(targetPath);
    return null;
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      auditSweepFailure(targetPath, error);
      return 'target-failed';
    }
  }
  let lease: FileLockLease | null;
  try {
    lease = tryAcquireExclusiveFileLockSync(join(dbDir, entry));
  } catch (error: unknown) {
    auditSweepFailure(join(dbDir, entry), error);
    return 'target-failed';
  }
  if (lease === null) return 'locked';
  try {
    try {
      runtime.storage.lstatSync(targetPath);
      return null;
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        auditSweepFailure(targetPath, error);
        return 'target-failed';
      }
    }
  } finally {
    lease();
  }
  try {
    runtime.storage.unlinkSync(join(dbDir, entry));
    return 'removed';
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return 'removed';
    auditSweepFailure(join(dbDir, entry), error);
    return 'lock-cleanup-failed';
  }
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
    const kind = runtime.storage.lstatSync(path);
    if (!kind.isFile() || kind.isSymbolicLink()) return unobservable(true);
    if (runtime.storage.statSync(path).size > MAX_STORE_EPOCH_HOLDER_BYTES) return unobservable(true);
    const value: unknown = JSON.parse(runtime.storage.readFileSync(path, 'utf-8'));
    if (
      !isRecord(value) ||
      typeof value.epoch !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(value.epoch) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0
    ) {
      return unobservable(true);
    }
    const pid = Number(value.pid);
    const proof = tryAcquireExclusiveFileLockSync(storeEpochLockPath(dbDir, value.epoch));
    return {
      id,
      entry,
      path,
      epoch: value.epoch,
      pid,
      state: proof === null ? 'live' : 'stale',
      removable: true,
      proof,
    };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return unobservable(error instanceof SyntaxError);
  }
}

function observeStoreEpochHolders(
  runtime: Runtime,
  dbDir: string,
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
    const holder = observeStoreEpochHolder(runtime, dbDir, entry);
    if (holder !== null) holders.push(holder);
  }
  return { kind: 'observed', holders };
}

export function listStoreEpochHolders(runtime: Runtime): readonly StoreEpochHolderListEntry[] {
  const observed = observeStoreEpochHolders(runtime, runtime.paths.coral.store.dbDir);
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
  dbDir: string,
  current: StoreEpoch | null,
  options: {
    readonly assertOwned?: () => void;
    readonly releaseEpoch?: StoreEpoch;
  } = {},
): StoreEpochSweepResult {
  const { storage } = runtime;
  if (options.releaseEpoch !== undefined) {
    const initialReleaseProof = proveReleaseTarget(storage, dbDir, options.releaseEpoch);
    if (initialReleaseProof === 'current') return 'current';
    if (initialReleaseProof === 'unobservable') return 'unobservable-metadata';
  }

  const holderRead = observeStoreEpochHolders(runtime, dbDir);
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
      const removed = removeDuringSweep(storage, holder.path);
      holderDeletionFailed ||= !removed;
      holdersChanged ||= removed;
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
    if (proof === 'absent' && options.releaseEpoch !== '0') {
      try {
        return storage.syncDirectoryDurableSync(dbDir) ? 'absent' : 'durability-sync-failed';
      } catch (error: unknown) {
        auditSweepFailure(dbDir, error);
        return 'durability-sync-failed';
      }
    }
    let releaseRemoval: Exclude<LockedRemoval, 'locked'>;
    if (options.releaseEpoch !== '0') {
      const removal = removeWhileExclusivelyLocked(
        runtime,
        storeEpochLockPath(dbDir, options.releaseEpoch),
        epochDirectory(dbDir, options.releaseEpoch),
        true,
      );
      if (removal === 'locked') return 'live-holder';
      releaseRemoval = removal;
    } else {
      const lease = tryAcquireExclusiveFileLockSync(storeEpochLockPath(dbDir, '0'));
      if (lease === null) return 'live-holder';
      try {
        releaseRemoval = 'removed';
        for (const name of [
          `${STORE_DATABASE_FILE_NAME}-wal`,
          `${STORE_DATABASE_FILE_NAME}-shm`,
          `${STORE_DATABASE_FILE_NAME}${STORE_FORMAT_SIDECAR_SUFFIX}`,
          STORE_DATABASE_FILE_NAME,
        ]) {
          if (!removeDuringSweep(storage, join(dbDir, name))) {
            releaseRemoval = 'target-failed';
            break;
          }
        }
      } finally {
        lease();
      }
    }
    try {
      if (!storage.syncDirectoryDurableSync(dbDir)) return 'durability-sync-failed';
      if (releaseRemoval === 'lock-cleanup-failed') return 'lock-cleanup-failed';
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
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && garbageEpochs.has(observation.epoch);
    if (invalidEpochEntry || (epoch !== current && (disprovenEpochEntry || garbageEpoch))) {
      if (epoch === null) {
        complete = removeDuringSweep(storage, join(dbDir, entry)) && complete;
      } else {
        const removal = removeWhileExclusivelyLocked(
          runtime,
          storeEpochLockPath(dbDir, epoch),
          join(dbDir, entry),
          true,
        );
        if (removal === 'locked') {
          liveHolder = true;
          auditSweepSkip(join(dbDir, entry));
          continue;
        }
        complete = removal === 'removed' && complete;
      }
    }
  }

  for (const entry of entries) {
    const removal = removeOrphanedEpochLock(runtime, dbDir, entry);
    if (removal === null) continue;
    if (removal === 'locked') {
      liveHolder = true;
      auditSweepSkip(join(dbDir, entry));
      continue;
    }
    complete = removal === 'removed' && complete;
  }

  if (compareEpoch(current, '1') >= 0) {
    complete = removeDuringSweep(storage, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY)) && complete;
  }
  try {
    if (!storage.syncDirectoryDurableSync(dbDir)) return 'durability-sync-failed';
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

async function observeRegularFileAsync(storage: StoragePort, path: string): Promise<StoreEpochProof> {
  try {
    const entry = await storage.lstat(path);
    return entry.isFile() && !entry.isSymbolicLink() ? { kind: 'proven' } : { kind: 'disproven' };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

async function readEpochMetadataAsync(storage: StoragePort, directory: string): Promise<StoreEpochMetadataDisposition> {
  const metadataPath = join(directory, STORE_EPOCH_METADATA_FILE_NAME);
  try {
    const entry = await storage.lstat(metadataPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_STORE_EPOCH_METADATA_BYTES) {
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
  if (epoch === null || epoch === '0') return null;
  const directory = join(dbDir, entry);
  try {
    const container = await storage.lstat(directory);
    if (!container.isDirectory() || container.isSymbolicLink()) {
      return { epoch, proof: { kind: 'disproven' }, epochJson: { kind: 'malformed' } };
    }
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    const cause = error instanceof Error ? error.message : String(error);
    return { epoch, proof: { kind: 'unobservable', cause }, epochJson: { kind: 'unreadable', cause } };
  }
  const epochJson = await readEpochMetadataAsync(storage, directory);
  if (epochJson.kind === 'unreadable') {
    return { epoch, proof: { kind: 'unobservable', cause: epochJson.cause }, epochJson };
  }
  const database = await observeRegularFileAsync(storage, epochPath(dbDir, epoch));
  return { epoch, proof: epochJson.kind === 'valid' ? database : { kind: 'disproven' }, epochJson };
}

async function observeEpochZeroAsync(storage: StoragePort, dbDir: string): Promise<StoreEpochObservation | null> {
  try {
    const entry = await storage.lstat(epochPath(dbDir, '0'));
    const proof =
      entry.isFile() && !entry.isSymbolicLink() ? ({ kind: 'proven' } as const) : ({ kind: 'disproven' } as const);
    return { epoch: '0', proof, epochJson: { kind: 'legacy-epoch-0' } };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return {
      epoch: '0',
      proof: { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) },
      epochJson: { kind: 'legacy-epoch-0' },
    };
  }
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
    const kind = await runtime.storage.lstat(path);
    if (!kind.isFile() || kind.isSymbolicLink()) return unobservable(true);
    if (kind.size > MAX_STORE_EPOCH_HOLDER_BYTES) return unobservable(true);
    const value: unknown = JSON.parse(await runtime.storage.readFile(path, 'utf-8'));
    if (
      !isRecord(value) ||
      typeof value.epoch !== 'string' ||
      !/^(0|[1-9]\d*)$/u.test(value.epoch) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0
    ) {
      return unobservable(true);
    }
    const pid = Number(value.pid);
    const proof = tryAcquireExclusiveFileLockSync(storeEpochLockPath(dbDir, value.epoch));
    return {
      id,
      entry,
      path,
      epoch: value.epoch,
      pid,
      state: proof === null ? 'live' : 'stale',
      removable: true,
      proof,
    };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    return unobservable(error instanceof SyntaxError);
  }
}

async function removeDuringPostReadySweep(storage: StoragePort, path: string): Promise<boolean> {
  try {
    const observed = await storage.lstat(path);
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
  lockPath: string,
  targetPath: string,
  removeLockFile: boolean,
): Promise<LockedRemoval> {
  let lease: FileLockLease | null;
  try {
    lease = tryAcquireExclusiveFileLockSync(lockPath);
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'target-failed';
  }
  if (lease === null) return 'locked';
  const removed = await removeDuringPostReadySweep(runtime.storage, targetPath);
  lease();
  if (removed && removeLockFile) {
    try {
      await runtime.storage.unlink(lockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        auditSweepFailure(lockPath, error);
        return 'lock-cleanup-failed';
      }
    }
  }
  return removed ? 'removed' : 'target-failed';
}

async function removeOrphanedEpochLockAsync(
  runtime: Runtime,
  dbDir: string,
  entry: string,
): Promise<LockedRemoval | null> {
  const epoch = EPOCH_LOCK_PATTERN.exec(entry)?.[1];
  if (epoch === undefined) return null;
  const lockPath = join(dbDir, entry);
  const targetPath = epoch === '0' ? epochPath(dbDir, epoch) : epochDirectory(dbDir, epoch);
  try {
    await runtime.storage.lstat(targetPath);
    return null;
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      auditSweepFailure(targetPath, error);
      return 'target-failed';
    }
  }
  let lease: FileLockLease | null;
  try {
    lease = tryAcquireExclusiveFileLockSync(lockPath);
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'target-failed';
  }
  if (lease === null) return 'locked';
  try {
    try {
      await runtime.storage.lstat(targetPath);
      return null;
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        auditSweepFailure(targetPath, error);
        return 'target-failed';
      }
    }
  } finally {
    lease();
  }
  try {
    await runtime.storage.unlink(lockPath);
    return 'removed';
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return 'removed';
    auditSweepFailure(lockPath, error);
    return 'lock-cleanup-failed';
  }
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
  dbDir: string,
  openEpoch: StoreEpoch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<StoreEpochSweepResult> {
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
    const holder = await observeStoreEpochHolderAsync(runtime, dbDir, entry);
    if (holder?.state === 'live') continue;
    if (holder?.state === 'unobservable' && !holder.removable) {
      unobservableHolder = true;
      continue;
    }
    if (holder !== null) {
      try {
        const removed = await removeDuringPostReadySweep(runtime.storage, holder.path);
        holderDeletionFailed ||= !removed;
        unsyncedMutation ||= removed;
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
  const epochZero = await observeEpochZeroAsync(runtime.storage, dbDir);
  if (epochZero !== null) observations.push(epochZero);
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
  for (const entry of entries) {
    if (options.signal?.aborted) return finish('cancelled');
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const abandonedMint = entry.startsWith(MINT_DIRECTORY_PREFIX);
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && garbageEpochs.has(observation.epoch);
    if (abandonedMint || invalidEpochEntry || (epoch !== openEpoch && (disprovenEpochEntry || garbageEpoch))) {
      const removal = abandonedMint
        ? await removeWhileExclusivelyLockedAsync(
            runtime,
            storeMintLockPath(dbDir, entry.slice(MINT_DIRECTORY_PREFIX.length)),
            join(dbDir, entry),
            true,
          )
        : epoch === null
          ? (await removeDuringPostReadySweep(runtime.storage, join(dbDir, entry)))
            ? 'removed'
            : 'target-failed'
          : await removeWhileExclusivelyLockedAsync(
              runtime,
              storeEpochLockPath(dbDir, epoch),
              join(dbDir, entry),
              true,
            );
      if (removal === 'locked') {
        liveHolder = true;
        auditSweepSkip(join(dbDir, entry));
        await yieldSweepTurn();
        continue;
      }
      unsyncedMutation = true;
      complete = removal === 'removed' && complete;
    }
    await yieldSweepTurn();
  }

  for (const entry of entries) {
    if (options.signal?.aborted) return finish('cancelled');
    const removal = await removeOrphanedEpochLockAsync(runtime, dbDir, entry);
    if (removal === null) continue;
    if (removal === 'locked') {
      liveHolder = true;
      auditSweepSkip(join(dbDir, entry));
    } else {
      unsyncedMutation ||= removal === 'removed';
      complete = removal === 'removed' && complete;
    }
    await yieldSweepTurn();
  }

  if (options.signal?.aborted) return finish('cancelled');
  if (compareEpoch(openEpoch, '1') >= 0) {
    const removed = await removeDuringPostReadySweep(runtime.storage, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY));
    unsyncedMutation ||= removed;
    complete = removed && complete;
  }
  if (!(await syncMutations())) return 'durability-sync-failed';
  if (!complete) return 'deletion-failed';
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
  let candidate = successorEpoch(current ?? '0');
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
  supersedes: StoreEpoch,
  successor: StoreEpoch,
  classification: StoreEpochClassification,
): 'published' | 'contended' | 'swept' {
  const id = runtime.ids.uuid();
  const mint = join(dbDir, `${MINT_DIRECTORY_PREFIX}${id}`);
  const mintLockPath = storeMintLockPath(dbDir, id);
  const mintLease = acquireSharedFileLockSync(mintLockPath);
  try {
    runtime.storage.mkdirSync(mint, { mode: 0o700 });
    const opened = openWritableStoreDatabase({
      path: epochPath(mint, '0'),
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
      return 'published';
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return 'contended';
      if (code === 'ENOENT') return 'swept';
      throw error;
    }
  } finally {
    cleanupMint(runtime.storage, mint);
    mintLease();
    try {
      runtime.storage.unlinkSync(mintLockPath);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') auditSweepFailure(mintLockPath, error);
    }
  }
}

function assertProvenStoreOpenable(storage: StoragePort, path: string): void {
  let descriptor: number;
  try {
    descriptor = storage.openSync(path, 'r+');
  } catch (error: unknown) {
    throw new Error(
      `The open syscall for proven store epoch '${path}' was refused with errno ${errorCode(error) ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
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
  const lease = acquireSharedFileLockSync(storeEpochLockPath(runtime.paths.coral.store.dbDir, epoch));
  try {
    assertProvenStoreOpenable(runtime.storage, path);
  } catch (error: unknown) {
    lease();
    throw error;
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
  const dbDir = resolveStoreDbDir(runtime, options.path);
  if (dbDir === ':memory:') {
    const opened = openWritableStoreDatabase({
      path: ':memory:',
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    if (opened.kind !== 'opened') throw new Error('An in-memory store cannot be incompatible before opening.');
    return { db: opened.db, epoch: '0', path: ':memory:' };
  }

  runtime.storage.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const observations = observeStoreEpochs(runtime.storage, dbDir);
    const current = currentProvenEpoch(observations);
    let classification: StoreEpochClassification = { kind: 'absent' };
    if (current !== null) {
      const path = epochPath(dbDir, current.epoch);
      const opened = tryOpenCurrentEpoch(runtime, options, current.epoch, path);
      if (opened.kind === 'opened') {
        if (current.epoch !== '0' && !runtime.storage.syncDirectoryDurableSync(dbDir)) {
          opened.db.close();
          throw new Error(`Failed to durably adopt store epoch ${current.epoch} in '${dbDir}'.`);
        }
        opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
        return { db: opened.db, epoch: current.epoch, path };
      }
      classification = opened.classification;
    }
    const successor = selectSuccessor(runtime, dbDir, current?.epoch ?? null);
    const published = mintNextEpoch(runtime, options, dbDir, current?.epoch ?? '0', successor.epoch, classification);
    if (published === 'swept') continue;
  }
}

export function discardCurrentStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const dbDir = resolveStoreDbDir(runtime, options.path);
  if (dbDir === ':memory:') throw new Error('Cannot discard an in-memory store epoch.');
  runtime.storage.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    const successor = selectSuccessor(runtime, dbDir, current);
    const published = mintNextEpoch(runtime, options, dbDir, current ?? '0', successor.epoch, {
      kind: 'unavailable',
      cause: 'operator-discard',
    });
    if (published === 'published') return settleStoreEpoch(runtime, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStoreEpochMetadata(value: unknown): StoreEpochMetadata | null {
  if (!isRecord(value)) return null;
  const supersedes =
    typeof value.supersedes === 'string' && /^(0|[1-9]\d*)$/.test(value.supersedes)
      ? value.supersedes
      : typeof value.supersedes === 'number' && Number.isSafeInteger(value.supersedes) && value.supersedes >= 0
        ? String(value.supersedes)
        : null;
  if (supersedes === null) return null;
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
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync' | 'statSync'>,
  directory: string,
): StoreEpochMetadataDisposition {
  const metadataPath = join(directory, STORE_EPOCH_METADATA_FILE_NAME);
  try {
    const entry = storage.lstatSync(metadataPath);
    if (!entry.isFile() || entry.isSymbolicLink()) return { kind: 'malformed' };
    const size = storage.statSync(metadataPath, { bigint: true }).size;
    if (size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)) return { kind: 'malformed' };
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

function epochBytes(storage: StoragePort, dbDir: string, epoch: StoreEpoch): number | null {
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
    if (epoch !== '0') return inventory(epochDirectory(dbDir, epoch)) ? total : null;
    const path = epochPath(dbDir, '0');
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}${STORE_FORMAT_SIDECAR_SUFFIX}`]) {
      if (storage.existsSync(file) && !inventory(file)) return null;
    }
    return total;
  } catch {
    return null;
  }
}

export function listStoreEpochs(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  storeFormat: StoreFormatDescription,
): readonly StoreEpochListEntry[] {
  const dbDir = runtime.paths.coral.store.dbDir;
  if (!runtime.storage.existsSync(dbDir)) return [];
  const observations = observeStoreEpochs(runtime.storage, dbDir);
  const current = currentProvenEpoch(observations)?.epoch ?? null;
  const garbageEpochs = garbageStoreEpochs(
    observations.filter(({ proof }) => proof.kind === 'proven').map(({ epoch }) => epoch),
  );

  return [...observations]
    .sort((left, right) => compareEpoch(right.epoch, left.epoch))
    .map((observation) => {
      const { epoch } = observation;
      let classification: StoreEpochClassification;
      if (observation.proof.kind !== 'proven') {
        classification = unavailableClassification(new Error('Epoch entry is not proven.'));
      } else {
        try {
          classification = classifyStoreFile(epochPath(dbDir, epoch), runtime.storage, storeFormat, () =>
            acquireSharedFileLockSync(storeEpochLockPath(dbDir, epoch)),
          );
        } catch (error: unknown) {
          classification = unavailableClassification(error);
        }
      }
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
        classification,
        storedProductVersion: 'storedProductVersion' in classification ? classification.storedProductVersion : null,
        epochJson: observation.epochJson,
      };
    });
}

export function storeEpochHookSource(): string {
  return String.raw`// Generated from src/store/epoch.ts by scripts/build-server.mjs. Do not edit directly.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from '${'node:' + 'fs'}';
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
    (typeof value.supersedes === 'string' && /^(0|[1-9]\d*)$/.test(value.supersedes)) ||
    (Number.isSafeInteger(value.supersedes) && value.supersedes >= 0);
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

function isRegularFile(path) {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPublishedEpoch(dbDir, name) {
  const directory = join(dbDir, name);
  try {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const relativePath = relative(realpathSync(dbDir), realpathSync(directory));
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith('..' + sep) ||
      isAbsolute(relativePath)
    ) {
      return false;
    }
    const metadataPath = join(directory, 'epoch.json');
    if (!isRegularFile(join(directory, 'store.db')) || !isRegularFile(metadataPath)) return false;
    if (statSync(metadataPath, { bigint: true }).size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)) return false;
    return isValidEpochMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')));
  } catch {
    return false;
  }
}

export function resolveCurrentStoreDbPath(dbDir) {
  let current = isRegularFile(join(dbDir, 'store.db')) ? '0' : null;
  let entries;
  try {
    entries = readdirSync(dbDir);
  } catch {
    return join(dbDir, 'store.db');
  }
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (
      epoch !== null &&
      epoch !== '0' &&
      (current === null || BigInt(epoch) > BigInt(current)) &&
      isPublishedEpoch(dbDir, entry)
    ) {
      current = epoch;
    }
  }
  if (current === null) return null;
  return current === '0' ? join(dbDir, 'store.db') : join(dbDir, 'epoch-' + current, 'store.db');
}

function storeEpochForDbPath(dbDir, dbPath) {
  if (resolve(dbPath) === resolve(dbDir, 'store.db')) return '0';
  const directory = dirname(resolve(dbPath));
  return dirname(directory) === resolve(dbDir) ? epochNumber(basename(directory)) : null;
}

function acquireSharedStoreEpochLock(dbDir, epoch) {
  const lock = new DatabaseSync(join(dbDir, '.epoch-lock-' + epoch + '.sqlite'), {
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
  if (epoch === null) throw new Error('Resolved store database is outside the canonical epoch layout.');
  const releaseLock = acquireSharedStoreEpochLock(dbDir, epoch);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
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
