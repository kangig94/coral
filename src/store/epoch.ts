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
import { observeStorePath } from './path-observation.js';
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
const STORE_EPOCH_HOLDER_PUBLICATION_ATTEMPTS = 2;
// Measured on Node 26 / Linux 6.18: node:sqlite reports SQLITE_BUSY as errcode 5 and a removed directory as
// errcode 14 while its public code remains ERR_SQLITE_ERROR.
const SQLITE_BUSY_ERRCODE = 5;

export type StoreEpochClassification =
  | StoreFormatClassification
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'operator-discard' };

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
  store: ResolvedStoreEpoch;
}>;

export type StoreEpochListEntry = Readonly<{
  epoch: StoreEpoch;
  role: 'current' | 'preserved' | 'garbage' | 'unobservable';
  bytes: number | null;
  publicationReason: StoreEpochClassification;
  supersededStoreVersion: string | null;
  epochJson: StoreEpochMetadataDisposition;
  resolved: ResolvedStoreEpoch | null;
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
  | Readonly<{ kind: 'unreadable' }>;

export type StoreEpochOptions = Readonly<{
  path?: string;
  storeFormat: StoreFormatDescription;
  build: StrictBundleManifest;
  startupBusyTimeoutMs?: number;
  steadyStateBusyTimeoutMs?: number;
}>;

export type StoreEpoch = string;

export type ResolvedStoreEpoch = Readonly<{
  storeRoot: string;
  epoch: StoreEpoch;
  path: string;
}>;

export type ResolvedStorePath = Readonly<{
  path: string;
  epoch: ResolvedStoreEpoch | null;
  epochCandidate: boolean;
}>;

export type CurrentStoreInspection =
  | Readonly<{ kind: 'current'; epoch: ResolvedStoreEpoch }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unobservable' }>;

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
  const observations: StoreEpochObservation[] = [];
  for (const entry of entries) {
    const observation = observeStoreEpoch(storage, dbDir, entry);
    if (observation !== null) observations.push(observation);
  }
  return observations;
}

function resolveObservedStoreRoot(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  configuredDbDir: string,
): Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'present'; path: string }> {
  if (observeStorePath(storage, configuredDbDir) === 'absent') return { kind: 'absent' };
  return { kind: 'present', path: storage.realpathSync(configuredDbDir) };
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
      epochJson: contained.kind === 'unobservable' ? { kind: 'unreadable' } : { kind: 'malformed' },
    };
  }
  const epochJson = readEpochMetadata(storage, directory);
  if (epochJson.kind === 'unreadable') {
    return { epoch, proof: { kind: 'unobservable', cause: 'epoch metadata is unreadable' }, epochJson };
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

type CurrentStoreObservation =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; storeRoot: string; epochs: readonly StoreEpochObservation[] }>;

function observeCurrentStore(runtime: Pick<Runtime, 'paths' | 'storage'>): CurrentStoreObservation {
  const configuredDbDir = runtime.paths.coral.store.dbDir;
  const root = resolveObservedStoreRoot(runtime.storage, configuredDbDir);
  if (root.kind === 'absent') return root;
  const storeRoot = root.path;
  return { kind: 'present', storeRoot, epochs: observeStoreEpochs(runtime.storage, storeRoot) };
}

export function inspectCurrentStore(runtime: Pick<Runtime, 'paths' | 'storage'>): CurrentStoreInspection {
  try {
    const observation = observeCurrentStore(runtime);
    if (observation.kind === 'absent') return observation;
    const current = currentProvenEpoch(observation.epochs);
    if (current !== null) {
      return { kind: 'current', epoch: resolvedStoreEpoch(observation.storeRoot, current.epoch) };
    }
    return { kind: observation.epochs.length === 0 ? 'absent' : 'unobservable' };
  } catch {
    return { kind: 'unobservable' };
  }
}

export function resolvedStoreEpoch(storeRoot: string, epoch: StoreEpoch): ResolvedStoreEpoch {
  return { storeRoot, epoch, path: epochPath(storeRoot, epoch) };
}

export function encodeResolvedStoreEpoch(resolved: ResolvedStoreEpoch): string {
  return JSON.stringify(resolved);
}

export function decodeResolvedStoreEpoch(value: string | undefined): ResolvedStoreEpoch | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('storeRoot' in decoded) ||
      !('epoch' in decoded) ||
      !('path' in decoded) ||
      typeof decoded.storeRoot !== 'string' ||
      typeof decoded.epoch !== 'string' ||
      typeof decoded.path !== 'string' ||
      resolve(decoded.storeRoot) !== decoded.storeRoot ||
      epochNumber(`epoch-${decoded.epoch}`) !== decoded.epoch ||
      epochPath(decoded.storeRoot, decoded.epoch) !== decoded.path
    ) {
      return undefined;
    }
    return { storeRoot: decoded.storeRoot, epoch: decoded.epoch, path: decoded.path };
  } catch {
    return undefined;
  }
}

export function resolveCurrentStore(runtime: Pick<Runtime, 'paths' | 'storage'>, path?: string): ResolvedStorePath {
  const configuredDbDir = runtime.paths.coral.store.dbDir;
  if (path === ':memory:') return { path, epoch: null, epochCandidate: false };
  if (path !== undefined) {
    const epoch = resolveProvenStoreEpochAtPath(runtime.storage, configuredDbDir, path);
    if (epoch !== null) return { path: epoch.path, epoch, epochCandidate: true };
    let epochCandidate = false;
    try {
      const storeRoot = runtime.storage.realpathSync(configuredDbDir);
      const addressedPath = runtime.storage.realpathSync(path);
      epochCandidate = storeEpochAtPath(storeRoot, addressedPath) !== null;
    } catch {
      /* unresolved path accepted */
    }
    return { path, epoch: null, epochCandidate };
  }
  const observation = observeCurrentStore(runtime);
  if (observation.kind === 'absent') {
    return { path: epochPath(configuredDbDir, '1'), epoch: null, epochCandidate: true };
  }
  const current = currentProvenEpoch(observation.epochs);
  if (current === null) return { path: epochPath(observation.storeRoot, '1'), epoch: null, epochCandidate: true };
  const epoch = resolvedStoreEpoch(observation.storeRoot, current.epoch);
  return { path: epoch.path, epoch, epochCandidate: true };
}

export function openWritableStoreDbNoReset(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'storage'>,
  options: ({ readonly path?: string; readonly resolved?: never } | { readonly resolved: ResolvedStoreEpoch }) & {
    readonly busyTimeoutMs?: number;
    readonly storeFormat: StoreFormatDescription;
  },
): Database {
  const resolved =
    options.resolved === undefined
      ? resolveCurrentStore(runtime, options.path)
      : { path: options.resolved.path, epoch: options.resolved, epochCandidate: true };
  const lease = resolved.epoch === null ? null : acquireStoreEpochReadLock(runtime, resolved.epoch);
  const proof =
    resolved.path === ':memory:'
      ? { kind: 'disproven' as const }
      : resolved.epoch === null && !resolved.epochCandidate
        ? observeContainedRegularFile(runtime.storage, dirname(resolved.path), resolved.path, { kind: 'proven' })
        : lease !== null
          ? { kind: 'proven' as const }
          : { kind: 'disproven' as const };
  if (proof.kind === 'proven') {
    try {
      const db = openStoreDatabase({
        path: resolved.path,
        storage: runtime.storage,
        storeFormat: options.storeFormat,
        flavor: runtime.flavor,
        busyTimeoutMs: options.busyTimeoutMs,
      });
      return resolved.epoch === null || lease === null
        ? db
        : registerStoreEpochHolder(runtime, resolved.epoch, db, lease);
    } catch (error: unknown) {
      lease?.();
      throw error;
    }
  }
  lease?.();
  throw documentedCoralSetupError('store_not_initialized', { path: resolved.path });
}

export function storeEpochAtPath(dbDir: string, path: string): StoreEpoch | null {
  if (basename(path) !== STORE_DATABASE_FILE_NAME) return null;
  const directory = resolve(path, '..');
  return resolve(directory, '..') === resolve(dbDir) ? epochNumber(basename(directory)) : null;
}

export function resolveProvenStoreEpochAtPath(
  storage: StoragePort,
  dbDir: string,
  path: string,
): ResolvedStoreEpoch | null {
  const root = resolveObservedStoreRoot(storage, dbDir);
  if (root.kind === 'absent') return null;
  let addressedPath: string;
  try {
    addressedPath = storage.realpathSync(path);
  } catch {
    return null;
  }
  const storeRoot = root.path;
  const epoch = storeEpochAtPath(storeRoot, addressedPath);
  if (epoch === null) return null;
  const observation = observeStoreEpoch(storage, storeRoot, `epoch-${epoch}`);
  return observation?.proof.kind === 'proven' ? resolvedStoreEpoch(storeRoot, epoch) : null;
}

export function acquireStoreEpochReadLock(
  runtime: Pick<Runtime, 'storage'>,
  resolved: ResolvedStoreEpoch,
): FileLockLease | null {
  const lease = acquireSharedFileLockSync(storeEpochLockPath(resolved.storeRoot, resolved.epoch));
  const observation = observeStoreEpoch(runtime.storage, resolved.storeRoot, `epoch-${resolved.epoch}`);
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
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage'>,
  resolved: ResolvedStoreEpoch,
  db: Database,
  lease: FileLockLease,
): Database {
  let holderPath: string | undefined;
  try {
    for (let attempt = 0; attempt < STORE_EPOCH_HOLDER_PUBLICATION_ATTEMPTS; attempt += 1) {
      const candidate = storeEpochHolderPath(resolved.storeRoot, runtime.ids.uuid());
      if (
        runtime.storage.writeAtomicDurableSync(
          candidate,
          `${JSON.stringify({ epoch: resolved.epoch, pid: runtime.env.pid() })}\n`,
          {
            encoding: 'utf-8',
            mode: 0o600,
          },
        )
      ) {
        holderPath = candidate;
        break;
      }
      if (observeStorePath(runtime.storage, candidate) === 'present') break;
    }
    if (holderPath === undefined) {
      throw new Error(`Failed to publish store epoch ${resolved.epoch} holder.`);
    }
  } catch (error: unknown) {
    db.close();
    lease();
    throw error;
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
          runtime.storage.syncDirectoryDurableSync(resolved.storeRoot);
        } catch {
          /* best-effort holder cleanup */
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

function unavailableClassification(): StoreEpochClassification {
  return { kind: 'unavailable' };
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
  } catch {
    return { kind: 'unobservable' };
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
  let root: ReturnType<typeof resolveObservedStoreRoot>;
  try {
    root = resolveObservedStoreRoot(runtime.storage, runtime.paths.coral.store.dbDir);
  } catch {
    return [{ id: 'unobservable', epoch: null, pid: null, state: 'unobservable' }];
  }
  if (root.kind === 'absent') return [];
  const dbDir = root.path;
  const observed = observeStoreEpochHolders(runtime, dbDir);
  if (observed.kind === 'unobservable') {
    return [{ id: 'unobservable', epoch: null, pid: null, state: 'unobservable' }];
  }
  return observed.holders.map(({ id, epoch, pid, state, proof }) => {
    proof?.();
    return { id, epoch, pid, state };
  });
}

type StoreEpochHolderCleanupResult =
  | Readonly<{ kind: 'unobservable' }>
  | Readonly<{
      kind: 'cleaned';
      changed: boolean;
      deletionFailed: boolean;
      releaseHolderLive: boolean;
      unobservableHolder: boolean;
    }>;

function cleanStoreEpochHolders(
  runtime: Runtime,
  dbDir: string,
  releaseEpoch: StoreEpoch | undefined,
): StoreEpochHolderCleanupResult {
  const holderRead = observeStoreEpochHolders(runtime, dbDir, true);
  if (holderRead.kind === 'unobservable') return holderRead;

  let changed = false;
  let deletionFailed = false;
  let releaseHolderLive = false;
  let unobservableHolder = false;
  for (const holder of holderRead.holders) {
    if (holder.state === 'live') {
      releaseHolderLive ||= holder.epoch === releaseEpoch;
      continue;
    }
    if (holder.state === 'unobservable' && (releaseEpoch === undefined || !holder.removable)) {
      unobservableHolder = true;
      continue;
    }
    try {
      changed = true;
      const removed = removeDuringSweep(runtime.storage, dbDir, holder.path);
      deletionFailed ||= !removed;
      if (holder.state === 'unobservable') unobservableHolder = true;
    } finally {
      holder.proof?.();
    }
  }
  return { kind: 'cleaned', changed, deletionFailed, releaseHolderLive, unobservableHolder };
}

function syncStoreEpochSweepDirectory(storage: StoragePort, dbDir: string): boolean {
  try {
    return storage.syncDirectoryDurableSync(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return false;
  }
}

function guardStoreEpochSweepCoordinator(
  runtime: Runtime,
  dbDir: string,
  releaseEpoch: StoreEpoch | undefined,
): StoreEpochSweepResult | null {
  try {
    const coordinator = probeCoordinator(runtime);
    if (
      coordinator.kind === 'unobservable' ||
      (coordinator.kind === 'absent' && releaseEpoch === undefined) ||
      (coordinator.kind === 'live' &&
        coordinator.record.pid !== runtime.env.pid() &&
        (releaseEpoch === undefined ||
          coordinator.record.storeEpoch === undefined ||
          coordinator.record.storeEpoch === releaseEpoch))
    ) {
      return coordinator.kind === 'live' ? 'live-holder' : 'unobservable-metadata';
    }
    return null;
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'unobservable-metadata';
  }
}

function releaseStoreEpochDuringSweep(
  runtime: Runtime,
  dbDir: string,
  releaseEpoch: StoreEpoch,
  assertOwned: (() => void) | undefined,
): StoreEpochSweepResult {
  assertOwned?.();
  const proof = proveReleaseTarget(runtime.storage, dbDir, releaseEpoch);
  if (proof === 'current') return 'current';
  if (proof === 'unobservable') return 'unobservable-metadata';
  if (proof === 'absent') {
    return syncStoreEpochSweepDirectory(runtime.storage, dbDir) ? 'absent' : 'absent-durability-sync-failed';
  }

  const removal = removeEpochEntry(runtime, dbDir, releaseEpoch);
  if (removal === 'locked') return 'live-holder';
  if (!syncStoreEpochSweepDirectory(runtime.storage, dbDir)) return 'durability-sync-failed';
  if (removal === 'lock-release-failed') return 'lock-release-failed';
  return removal === 'removed' ? 'complete' : 'deletion-failed';
}

type StoreEpochRetentionSelection = Readonly<{
  byEpoch: ReadonlyMap<StoreEpoch, StoreEpochObservation>;
  garbageEpochs: ReadonlySet<StoreEpoch>;
}>;

function selectStoreEpochRetention(observations: readonly StoreEpochObservation[]): StoreEpochRetentionSelection {
  return {
    byEpoch: new Map(observations.map((observation) => [observation.epoch, observation])),
    garbageEpochs: garbageStoreEpochs(
      observations.filter(({ proof }) => proof.kind === 'proven').map(({ epoch }) => epoch),
    ),
  };
}

type StoreEpochReapingResult = Readonly<{
  complete: boolean;
  liveHolder: boolean;
  lockReleaseFailed: boolean;
}>;

function reapStoreEpochEntries(
  runtime: Runtime,
  dbDir: string,
  current: StoreEpoch,
  entries: readonly string[],
  retention: StoreEpochRetentionSelection,
): StoreEpochReapingResult {
  let complete = true;
  let liveHolder = false;
  let lockReleaseFailed = false;
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : retention.byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && retention.garbageEpochs.has(observation.epoch);
    if (!invalidEpochEntry && (epoch === current || (!disprovenEpochEntry && !garbageEpoch))) continue;

    if (epoch === null) {
      complete = removeDuringSweep(runtime.storage, dbDir, join(dbDir, entry)) && complete;
      continue;
    }
    const removal = removeEpochEntry(runtime, dbDir, epoch);
    if (removal === 'locked') {
      liveHolder = true;
      auditSweepSkip(join(dbDir, entry));
      continue;
    }
    lockReleaseFailed ||= removal === 'lock-release-failed';
    complete = removal === 'removed' && complete;
  }
  return { complete, liveHolder, lockReleaseFailed };
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

  const holderCleanup = cleanStoreEpochHolders(runtime, dbDir, options.releaseEpoch);
  if (holderCleanup.kind === 'unobservable') return 'unobservable-holder';
  if (holderCleanup.changed && !syncStoreEpochSweepDirectory(storage, dbDir)) {
    return options.releaseEpoch === undefined ? 'durability-sync-failed' : 'pre-deletion-durability-sync-failed';
  }
  if (holderCleanup.deletionFailed) {
    return options.releaseEpoch === undefined ? 'deletion-failed' : 'holder-cleanup-failed';
  }
  if (holderCleanup.unobservableHolder) return 'unobservable-holder';
  if (holderCleanup.releaseHolderLive) return 'live-holder';

  const coordinatorResult = guardStoreEpochSweepCoordinator(runtime, dbDir, options.releaseEpoch);
  if (coordinatorResult !== null) return coordinatorResult;

  if (options.releaseEpoch !== undefined) {
    return releaseStoreEpochDuringSweep(runtime, dbDir, options.releaseEpoch, options.assertOwned);
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
  const retention = selectStoreEpochRetention(observations);
  const reaping = reapStoreEpochEntries(runtime, dbDir, current, entries, retention);

  let complete = reaping.complete;
  if (compareEpoch(current, '1') >= 0) {
    complete = removeDuringSweep(storage, dbDir, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY)) && complete;
  }
  if (!syncStoreEpochSweepDirectory(storage, dbDir)) return 'durability-sync-failed';
  if (reaping.lockReleaseFailed) return 'lock-release-failed';
  if (!complete) return 'deletion-failed';
  return reaping.liveHolder ? 'live-holder' : 'complete';
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
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const parsed = parseStoreEpochMetadata(JSON.parse(await storage.readFile(metadataPath, 'utf-8')));
    return parsed === null ? { kind: 'malformed' } : { kind: 'valid', value: parsed };
  } catch (error: unknown) {
    return error instanceof SyntaxError ? { kind: 'malformed' } : { kind: 'unreadable' };
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
      epochJson: contained.kind === 'unobservable' ? { kind: 'unreadable' } : { kind: 'malformed' },
    };
  }
  const epochJson = await readEpochMetadataAsync(storage, directory);
  if (epochJson.kind === 'unreadable') {
    return { epoch, proof: { kind: 'unobservable', cause: 'epoch metadata is unreadable' }, epochJson };
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
  if (lock.kind === 'disproven') {
    try {
      runtime.storage.rmdirSync(path);
      return 'removed';
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOENT') return 'removed';
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'unobservable';
      auditSweepFailure(path, error);
      return 'target-failed';
    }
  }
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

type PostReadyStoreEpochSweepContext = Readonly<{
  runtime: Runtime;
  dbDir: string;
  openEpoch: StoreEpoch;
  signal: AbortSignal | undefined;
}>;

type PostReadySweepMutationState = { pending: boolean };

async function syncPostReadySweepMutations(
  runtime: Runtime,
  dbDir: string,
  mutations: PostReadySweepMutationState,
): Promise<boolean> {
  if (!mutations.pending) return true;
  if (!(await syncDirectoryDurable(runtime.storage, dbDir))) return false;
  mutations.pending = false;
  return true;
}

type PostReadyHolderCleanupResult =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{
      kind: 'cleaned';
      deletionFailed: boolean;
      lockReleaseFailed: boolean;
      unobservableHolder: boolean;
    }>;

async function cleanPostReadyStoreEpochHolders(
  context: PostReadyStoreEpochSweepContext,
  entries: readonly string[],
  mutations: PostReadySweepMutationState,
): Promise<PostReadyHolderCleanupResult> {
  const { runtime, dbDir, signal } = context;
  let deletionFailed = false;
  let lockReleaseFailed = false;
  let unobservableHolder = false;
  for (const entry of entries) {
    if (signal?.aborted) return { kind: 'cancelled' };
    if (!entry.startsWith(EPOCH_HOLDER_PREFIX)) {
      await yieldSweepTurn();
      continue;
    }
    if (!entry.endsWith('.json')) {
      mutations.pending = true;
      const removed = await removeDuringPostReadySweep(runtime.storage, dbDir, join(dbDir, entry));
      deletionFailed ||= !removed;
      await yieldSweepTurn();
      continue;
    }
    const holder = await inspectStoreEpochHolderAsync(runtime, dbDir, entry);
    if (holder?.state === 'live') continue;
    if (holder?.state === 'unobservable' && !holder.removable) {
      unobservableHolder = true;
      continue;
    }
    try {
      if (holder?.path !== undefined) {
        mutations.pending = true;
        const removed = await removeDuringPostReadySweep(runtime.storage, dbDir, holder.path);
        deletionFailed ||= !removed;
      }
    } finally {
      try {
        holder?.proof?.();
      } catch (error: unknown) {
        auditSweepFailure(holder?.path ?? join(dbDir, entry), error);
        lockReleaseFailed = true;
      }
    }
    await yieldSweepTurn();
  }
  return { kind: 'cleaned', deletionFailed, lockReleaseFailed, unobservableHolder };
}

type PostReadyEpochObservationResult =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'observed'; observations: readonly StoreEpochObservation[] }>;

async function observePostReadyStoreEpochs(
  context: PostReadyStoreEpochSweepContext,
  entries: readonly string[],
): Promise<PostReadyEpochObservationResult> {
  const { runtime, dbDir, signal } = context;
  const observations: StoreEpochObservation[] = [];
  for (const entry of entries) {
    if (signal?.aborted) return { kind: 'cancelled' };
    const observation = await observeStoreEpochAsync(runtime.storage, dbDir, entry);
    if (observation !== null) observations.push(observation);
    await yieldSweepTurn();
  }
  return { kind: 'observed', observations };
}

type PostReadyEpochReapingResult =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{
      kind: 'reaped';
      complete: boolean;
      liveHolder: boolean;
      lockReleaseFailed: boolean;
      unobservableResidue: boolean;
    }>;

async function reapPostReadyStoreEpochEntries(
  context: PostReadyStoreEpochSweepContext,
  entries: readonly string[],
  residueEntries: ReadonlySet<string>,
  retention: StoreEpochRetentionSelection,
  mutations: PostReadySweepMutationState,
): Promise<PostReadyEpochReapingResult> {
  const { runtime, dbDir, openEpoch, signal } = context;
  let complete = true;
  let liveHolder = false;
  let lockReleaseFailed = false;
  let unobservableResidue = false;
  for (const entry of entries) {
    if (signal?.aborted) return { kind: 'cancelled' };
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : retention.byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const abandonedStoreDirectory = residueEntries.has(entry);
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && retention.garbageEpochs.has(observation.epoch);
    if (
      abandonedStoreDirectory ||
      invalidEpochEntry ||
      (epoch !== openEpoch && (disprovenEpochEntry || garbageEpoch))
    ) {
      const wasPending = mutations.pending;
      mutations.pending = true;
      const removal = abandonedStoreDirectory
        ? await removeAbandonedStoreDirectory(runtime, dbDir, join(dbDir, entry))
        : epoch === null
          ? (await removeDuringPostReadySweep(runtime.storage, dbDir, join(dbDir, entry)))
            ? 'removed'
            : 'target-failed'
          : await removeEpochEntryAsync(runtime, dbDir, epoch);
      if (removal === 'unobservable') {
        mutations.pending = wasPending;
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
  return { kind: 'reaped', complete, liveHolder, lockReleaseFailed, unobservableResidue };
}

async function finishPostReadyStoreEpochSweep(
  runtime: Runtime,
  dbDir: string,
  mutations: PostReadySweepMutationState,
  result: StoreEpochSweepResult,
): Promise<StoreEpochSweepResult> {
  return (await syncPostReadySweepMutations(runtime, dbDir, mutations)) ? result : 'durability-sync-failed';
}

export async function sweepStoreEpochsPostReady(
  runtime: Runtime,
  openStore: ResolvedStoreEpoch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<StoreEpochSweepResult> {
  const context: PostReadyStoreEpochSweepContext = {
    runtime,
    dbDir: openStore.storeRoot,
    openEpoch: openStore.epoch,
    signal: options.signal,
  };
  const { dbDir, openEpoch, signal } = context;
  const mutations: PostReadySweepMutationState = { pending: false };

  if (signal?.aborted) return 'cancelled';
  let entries: readonly string[];
  try {
    entries = await runtime.storage.readdir(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'unobservable-metadata';
  }
  if (signal?.aborted) return 'cancelled';

  const holderCleanup = await cleanPostReadyStoreEpochHolders(context, entries, mutations);
  if (holderCleanup.kind === 'cancelled') {
    return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
  }
  if (!(await syncPostReadySweepMutations(runtime, dbDir, mutations))) return 'durability-sync-failed';
  if (holderCleanup.lockReleaseFailed) return 'lock-release-failed';
  if (holderCleanup.deletionFailed) return 'deletion-failed';
  if (holderCleanup.unobservableHolder) return 'unobservable-holder';

  const observation = await observePostReadyStoreEpochs(context, entries);
  if (observation.kind === 'cancelled') {
    return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
  }
  const residueEntries = new Set(entries.filter((entry) => isStoreEpochResidue(entry)));
  const retention = selectStoreEpochRetention(observation.observations);
  const reaping = await reapPostReadyStoreEpochEntries(context, entries, residueEntries, retention, mutations);
  if (reaping.kind === 'cancelled') {
    return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
  }

  if (signal?.aborted) {
    return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
  }
  let complete = reaping.complete;
  if (compareEpoch(openEpoch, '1') >= 0) {
    mutations.pending = true;
    const removed = await removeDuringPostReadySweep(
      runtime.storage,
      dbDir,
      join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY),
    );
    complete = removed && complete;
  }
  const result: StoreEpochSweepResult = reaping.lockReleaseFailed
    ? 'lock-release-failed'
    : !complete
      ? 'deletion-failed'
      : reaping.unobservableResidue
        ? 'unobservable-metadata'
        : reaping.liveHolder
          ? 'live-holder'
          : 'complete';
  return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, result);
}

function cleanupMint(storage: StoragePort, mint: string): void {
  try {
    storage.rmSync(mint, { recursive: true, force: true });
  } catch (error: unknown) {
    auditSweepFailure(mint, error);
  }
}

type MintStageMoveResult = Readonly<{ kind: 'moved' }> | Readonly<{ kind: 'contended' | 'swept' }>;

function advanceMintStagingDirectory(
  storage: StoragePort,
  source: string,
  destination: string,
  lease: FileLockLease,
): MintStageMoveResult {
  try {
    storage.renameSync(source, destination);
    return { kind: 'moved' };
  } catch (error: unknown) {
    lease();
    cleanupMint(storage, source);
    const code = errorCode(error);
    if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return { kind: 'contended' };
    if (code === 'ENOENT') return { kind: 'swept' };
    throw error;
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
    let observation: ReturnType<typeof observeStorePath>;
    try {
      observation = observeStorePath(runtime.storage, construction);
    } finally {
      cleanupMint(runtime.storage, construction);
    }
    if (observation === 'absent') return { kind: 'swept' };
    if (error instanceof Error && 'errcode' in error && error.errcode === SQLITE_BUSY_ERRCODE) {
      return { kind: 'contended' };
    }
    throw error;
  }
  const preparationMove = advanceMintStagingDirectory(runtime.storage, construction, preparation, mintLease);
  if (preparationMove.kind !== 'moved') return preparationMove;
  const mintMove = advanceMintStagingDirectory(runtime.storage, preparation, mint, mintLease);
  if (mintMove.kind !== 'moved') return mintMove;
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
  const resolved = resolvedStoreEpoch(dbDir, epoch);
  try {
    assertProvenStoreOpenable(runtime.storage, resolved.path);
    const db = openStoreDatabase({
      path: resolved.path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
    return { db: registerStoreEpochHolder(runtime, resolved, db, lease), store: resolved };
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
    /* best-effort probe cleanup */
  }
}

function tryOpenCurrentEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  resolved: ResolvedStoreEpoch,
):
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'replace'; readonly classification: StoreEpochClassification } {
  let lease: FileLockLease | null = null;
  try {
    lease = acquireStoreEpochReadLock(runtime, resolved);
    if (lease === null) {
      return {
        kind: 'replace',
        classification: unavailableClassification(),
      };
    }
    assertProvenStoreOpenable(runtime.storage, resolved.path);
  } catch {
    lease?.();
    return { kind: 'replace', classification: unavailableClassification() };
  }
  try {
    const decision = openWritableStoreDatabase({
      path: resolved.path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    if (decision.kind !== 'opened') {
      lease();
      return { kind: 'replace', classification: decision.classification };
    }
    return { kind: 'opened', db: registerStoreEpochHolder(runtime, resolved, decision.db, lease) };
  } catch {
    lease();
    return { kind: 'replace', classification: unavailableClassification() };
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
    return { db: opened.db, store: { storeRoot: ':memory:', epoch: '1', path: ':memory:' } };
  }

  runtime.storage.mkdirSync(configuredDbDir, { recursive: true, mode: 0o700 });
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  for (;;) {
    const observations = observeStoreEpochs(runtime.storage, dbDir);
    const current = currentProvenEpoch(observations);
    let classification: StoreEpochClassification = { kind: 'absent' };
    if (current !== null) {
      const resolved = resolvedStoreEpoch(dbDir, current.epoch);
      const opened = tryOpenCurrentEpoch(runtime, options, resolved);
      if (opened.kind === 'opened') {
        if (!runtime.storage.syncDirectoryDurableSync(dbDir)) {
          opened.db.close();
          throw new Error(`Failed to durably adopt store epoch ${current.epoch} in '${dbDir}'.`);
        }
        opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
        return { db: opened.db, store: resolved };
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
      kind: 'operator-discard',
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
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const parsed = parseStoreEpochMetadata(JSON.parse(storage.readFileSync(metadataPath, 'utf-8')));
    return parsed === null ? { kind: 'malformed' } : { kind: 'valid', value: parsed };
  } catch (error: unknown) {
    return error instanceof SyntaxError ? { kind: 'malformed' } : { kind: 'unreadable' };
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
  let root: ReturnType<typeof resolveObservedStoreRoot>;
  try {
    root = resolveObservedStoreRoot(runtime.storage, configuredDbDir);
  } catch {
    return [{ name: 'unobservable', bytes: null, state: 'unobservable' }];
  }
  if (root.kind === 'absent') return [];
  const dbDir = root.path;
  let entries: readonly string[];
  try {
    entries = runtime.storage.readdirSync(dbDir);
  } catch {
    return [{ name: 'unobservable', bytes: null, state: 'unobservable' }];
  }
  return entries
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
  let root: ReturnType<typeof resolveObservedStoreRoot>;
  try {
    root = resolveObservedStoreRoot(runtime.storage, configuredDbDir);
  } catch {
    return [
      {
        epoch: 'unobservable',
        role: 'unobservable',
        bytes: null,
        publicationReason: unavailableClassification(),
        supersededStoreVersion: null,
        epochJson: { kind: 'unreadable' },
        resolved: null,
      },
    ];
  }
  if (root.kind === 'absent') return [];
  const dbDir = root.path;
  let observations: readonly StoreEpochObservation[];
  try {
    observations = observeStoreEpochs(runtime.storage, dbDir);
  } catch {
    return [
      {
        epoch: 'unobservable',
        role: 'unobservable',
        bytes: null,
        publicationReason: unavailableClassification(),
        supersededStoreVersion: null,
        epochJson: { kind: 'unreadable' },
        resolved: null,
      },
    ];
  }
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
          : unavailableClassification();
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
        resolved: observation.proof.kind === 'proven' ? resolvedStoreEpoch(dbDir, epoch) : null,
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
const SQLITE_WAIT_BUDGET_EXHAUSTED = 'SQLite wait budget exhausted before the compact snapshot could be captured.';

function epochNumber(name) {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  return match?.[1] ?? null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error) {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
}

function sqliteWaitBudgetError(cause) {
  return new Error(SQLITE_WAIT_BUDGET_EXHAUSTED, { cause });
}

export function isSqliteWaitBudgetExhausted(error) {
  return error instanceof Error && error.message === SQLITE_WAIT_BUDGET_EXHAUSTED;
}

function remainingSqliteWaitMs(deadlineMs) {
  const remainingMs = Math.floor(deadlineMs - performance.now());
  if (!(remainingMs > 0)) throw sqliteWaitBudgetError();
  return remainingMs;
}

function runWithinSqliteWaitBudget(db, deadlineMs, operation) {
  db.exec('PRAGMA busy_timeout = ' + remainingSqliteWaitMs(deadlineMs));
  try {
    return operation();
  } catch (error) {
    if (performance.now() >= deadlineMs) throw sqliteWaitBudgetError(error);
    throw error;
  } finally {
    db.exec('PRAGMA busy_timeout = 0');
  }
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
  try {
    lstatSync(dbDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  const root = resolveStoreRoot(dbDir);
  const entries = readdirSync(root.path);
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

function storeEpochForDbPath(dbPath) {
  const resolvedPath = resolve(dbPath);
  if (basename(resolvedPath) !== 'store.db') return null;
  const directory = dirname(resolvedPath);
  const epoch = epochNumber(basename(directory));
  return epoch === null ? null : { epoch, storeRoot: dirname(directory), path: resolvedPath };
}

function acquireSharedStoreEpochLock(dbDir, epoch, sqliteWaitDeadlineMs) {
  const lock = new DatabaseSync(join(dbDir, 'epoch-' + epoch, '.lock'), {
    readOnly: true,
    timeout: remainingSqliteWaitMs(sqliteWaitDeadlineMs),
  });
  try {
    lock.exec(
      'PRAGMA busy_timeout = ' +
        remainingSqliteWaitMs(sqliteWaitDeadlineMs) +
        '; BEGIN; SELECT count(*) FROM sqlite_schema',
    );
  } catch (error) {
    lock.close();
    if (performance.now() >= sqliteWaitDeadlineMs) throw sqliteWaitBudgetError(error);
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

export function openLockedReadOnlyStoreDatabase(dbPath, sqliteWaitDeadlineMs) {
  const resolved = storeEpochForDbPath(dbPath);
  if (resolved === null) {
    throw new Error('Resolved store database is outside the proven canonical epoch layout.');
  }
  const root = resolveStoreRoot(resolved.storeRoot);
  if (!isPublishedEpoch(root, 'epoch-' + resolved.epoch)) {
    throw new Error('Resolved store database is outside the proven canonical epoch layout.');
  }
  const releaseLock = acquireSharedStoreEpochLock(resolved.storeRoot, resolved.epoch, sqliteWaitDeadlineMs);
  let db;
  try {
    db = new DatabaseSync(resolved.path, {
      readOnly: true,
      timeout: remainingSqliteWaitMs(sqliteWaitDeadlineMs),
    });
    db.exec('PRAGMA busy_timeout = 0');
  } catch (error) {
    releaseLock();
    if (performance.now() >= sqliteWaitDeadlineMs) throw sqliteWaitBudgetError(error);
    throw error;
  }
  let closed = false;
  return {
    get: (source, ...params) =>
      runWithinSqliteWaitBudget(db, sqliteWaitDeadlineMs, () => db.prepare(source).get(...params)),
    all: (source, ...params) =>
      runWithinSqliteWaitBudget(db, sqliteWaitDeadlineMs, () => db.prepare(source).all(...params)),
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
