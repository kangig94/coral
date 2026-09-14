import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { probeCoordinator, readDiscoveryRecordDisposition } from '../infra/backend-discovery.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { classifyStoreFile, openStoreDatabase, openWritableStoreDatabase, type Database } from './db.js';
import type { StoreFormatClassification, StoreFormatDescription } from './format-fingerprint.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from './reset-incident.js';

export const STORE_DATABASE_FILE_NAME = 'store.db';
export const STORE_EPOCH_METADATA_FILE_NAME = 'epoch.json';

const STORE_FORMAT_SIDECAR_SUFFIX = '.format';
const EPOCH_DIRECTORY_PATTERN = /^epoch-(0|[1-9]\d*)$/;
const MINT_DIRECTORY_PREFIX = '.mint-';
const EPOCH_HOLDER_PREFIX = '.epoch-holder-';

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

type StoreEpochObjectIdentity = Readonly<{ dev: bigint; ino: bigint }>;

type StoreEpochProof =
  | Readonly<{ kind: 'proven'; identity: StoreEpochObjectIdentity }>
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

export function resolveStoreDbDir(runtime: Pick<Runtime, 'paths'>, path?: string): string {
  if (path === undefined) return runtime.paths.coral.store.dbDir;
  if (path === ':memory:') return ':memory:';
  return resolve(path, '..');
}

type StoreEpochDiscoveryStorage = Pick<StoragePort, 'lstatSync' | 'readFileSync' | 'readdirSync' | 'realpathSync'>;

type StoreEpochObservation = Readonly<{
  epoch: StoreEpoch;
  proof: StoreEpochProof;
  epochJson: StoreEpochMetadataDisposition;
}>;

type ProvenStoreEpochObservation = StoreEpochObservation &
  Readonly<{ proof: Extract<StoreEpochProof, { readonly kind: 'proven' }> }>;

function identityOf(entry: StorageBigIntStat): StoreEpochObjectIdentity {
  return { dev: entry.dev, ino: entry.ino };
}

function sameIdentity(left: StoreEpochObjectIdentity, right: StoreEpochObjectIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function observeRegularFile(storage: Pick<StoragePort, 'lstatSync'>, path: string): StoreEpochProof {
  try {
    const entry = storage.lstatSync(path, { bigint: true });
    if (!entry.isFile()) return { kind: 'disproven' };
    return { kind: 'proven', identity: identityOf(entry) };
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'disproven' }
      : { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function observeEpochZero(storage: Pick<StoragePort, 'lstatSync'>, dbDir: string): StoreEpochObservation | null {
  const path = epochPath(dbDir, '0');
  try {
    const entry = storage.lstatSync(path, { bigint: true });
    const proof = entry.isFile()
      ? ({ kind: 'proven', identity: identityOf(entry) } as const)
      : ({ kind: 'disproven' } as const);
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

function observeContainedDirectory(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  dbDir: string,
  path: string,
): Exclude<StoreEpochProof, { readonly kind: 'proven' }> | Readonly<{ kind: 'contained' }> {
  try {
    const entry = storage.lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return { kind: 'disproven' };
    const relativePath = relative(storage.realpathSync(dbDir), storage.realpathSync(path));
    return relativePath !== '' &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
      ? { kind: 'contained' }
      : { kind: 'disproven' };
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
  const observations: StoreEpochObservation[] = [];
  const epochZero = observeEpochZero(storage, dbDir);
  if (epochZero !== null) observations.push(epochZero);
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (epoch === null || epoch === '0') continue;
    const directory = join(dbDir, entry);
    const contained = observeContainedDirectory(storage, dbDir, directory);
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
  runtime: Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage'>,
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
    const bound = openProvenStoreDescriptor(runtime, storeDbPath, proof);
    if (bound !== null) {
      try {
        const db = openStoreDatabase({
          path: bound.path,
          storage: runtime.storage,
          storeFormat: options.storeFormat,
          flavor: runtime.flavor,
          busyTimeoutMs: options.busyTimeoutMs,
        });
        if (provenPathStillNamesObject(runtime.storage, storeDbPath, proof)) return db;
        db.close();
      } finally {
        runtime.storage.closeSync(bound.descriptor);
      }
    }
  }
  throw documentedCoralSetupError('store_not_initialized', { path: storeDbPath });
}

export function isGarbageStoreEpoch(current: StoreEpoch, candidate: StoreEpoch): boolean {
  return BigInt(candidate) <= BigInt(current) - 2n;
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

function removeDuringSweep(storage: StoragePort, path: string, recursive: boolean): boolean {
  try {
    if (recursive) storage.rmSync(path, { recursive: true, force: true });
    else storage.unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return true;
    auditSweepFailure(path, error);
    return false;
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

function storeEpochHolderBlocksSweep(runtime: Runtime, dbDir: string): boolean {
  let entries: readonly string[];
  try {
    entries = runtime.storage.readdirSync(dbDir);
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!entry.startsWith(EPOCH_HOLDER_PREFIX) || !entry.endsWith('.json')) continue;
    const path = join(dbDir, entry);
    try {
      const kind = runtime.storage.lstatSync(path);
      if (!kind.isFile() || kind.isSymbolicLink()) return true;
      const value: unknown = JSON.parse(runtime.storage.readFileSync(path, 'utf-8'));
      if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return true;
      if (runtime.process.observeLiveness(Number(value.pid)) !== 'absent') return true;
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') return true;
    }
  }
  return false;
}

export function sweepStoreEpochs(
  runtime: Runtime,
  dbDir: string,
  current: StoreEpoch | null,
  options: {
    readonly assertOwned?: () => void;
    readonly releaseEpoch?: StoreEpoch;
    readonly replaceEpoch?: StoreEpoch;
  } = {},
): 'absent' | 'complete' | 'incomplete' | 'current' {
  const { storage } = runtime;
  if (options.replaceEpoch !== undefined) {
    const name = `epoch-${options.replaceEpoch}`;
    const observation = observeStoreEpochs(storage, dbDir, [name]).find(({ epoch }) => epoch === options.replaceEpoch);
    if (observation?.proof.kind !== 'disproven') return 'incomplete';
    const removed = removeDuringSweep(storage, join(dbDir, name), true);
    try {
      return storage.syncDirectoryDurableSync(dbDir) && removed ? 'complete' : 'incomplete';
    } catch (error: unknown) {
      auditSweepFailure(dbDir, error);
      return 'incomplete';
    }
  }
  if (options.releaseEpoch !== undefined) {
    const initial = proveReleaseTarget(storage, dbDir, options.releaseEpoch);
    if (initial === 'absent') return 'absent';
    if (initial === 'current') return 'current';
    if (initial === 'unobservable') return 'incomplete';
  }
  if (storeEpochHolderBlocksSweep(runtime, dbDir)) return 'incomplete';
  try {
    if (readDiscoveryRecordDisposition(runtime).kind === 'missing') return 'incomplete';
    const coordinator = probeCoordinator(runtime);
    if (
      coordinator.kind === 'unobservable' ||
      (coordinator.kind === 'live' && (coordinator.record.pid !== runtime.env.pid() || options.releaseEpoch === '0'))
    ) {
      return 'incomplete';
    }
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'incomplete';
  }

  if (options.releaseEpoch !== undefined) {
    options.assertOwned?.();
    const proof = proveReleaseTarget(storage, dbDir, options.releaseEpoch);
    if (proof === 'absent') return 'absent';
    if (proof === 'current') return 'current';
    if (proof === 'unobservable') return 'incomplete';
    let released: boolean;
    if (options.releaseEpoch !== '0') {
      released = removeDuringSweep(storage, epochDirectory(dbDir, options.releaseEpoch), true);
    } else {
      released = true;
      for (const name of [
        STORE_DATABASE_FILE_NAME,
        `${STORE_DATABASE_FILE_NAME}-wal`,
        `${STORE_DATABASE_FILE_NAME}-shm`,
        `${STORE_DATABASE_FILE_NAME}${STORE_FORMAT_SIDECAR_SUFFIX}`,
      ]) {
        released = removeDuringSweep(storage, join(dbDir, name), false) && released;
      }
    }
    try {
      return storage.syncDirectoryDurableSync(dbDir) && released ? 'complete' : 'incomplete';
    } catch (error: unknown) {
      auditSweepFailure(dbDir, error);
      return 'incomplete';
    }
  }

  if (current === null) return 'incomplete';

  let entries: readonly string[];
  try {
    entries = storage.readdirSync(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'incomplete';
  }

  const observations = observeStoreEpochs(storage, dbDir, entries);
  const byEpoch = new Map(observations.map((observation) => [observation.epoch, observation]));
  let complete = true;
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : byEpoch.get(epoch);
    const invalidEpochEntry = entry.startsWith('epoch-') && epoch === null;
    const disprovenEpochEntry = observation?.proof.kind === 'disproven';
    const garbageEpoch = observation?.proof.kind === 'proven' && isGarbageStoreEpoch(current, observation.epoch);
    if (invalidEpochEntry || disprovenEpochEntry || garbageEpoch) {
      complete = removeDuringSweep(storage, join(dbDir, entry), true) && complete;
    }
  }

  if (compareEpoch(current, '1') >= 0) {
    complete = removeDuringSweep(storage, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY), true) && complete;
  }
  const epochZero = byEpoch.get('0');
  if (compareEpoch(current, '2') >= 0 && epochZero?.proof.kind !== 'unobservable') {
    for (const name of [
      STORE_DATABASE_FILE_NAME,
      `${STORE_DATABASE_FILE_NAME}-wal`,
      `${STORE_DATABASE_FILE_NAME}-shm`,
      `${STORE_DATABASE_FILE_NAME}${STORE_FORMAT_SIDECAR_SUFFIX}`,
    ]) {
      complete = removeDuringSweep(storage, join(dbDir, name), false) && complete;
    }
  }
  try {
    return storage.syncDirectoryDurableSync(dbDir) && complete ? 'complete' : 'incomplete';
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return 'incomplete';
  }
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
): Readonly<{ kind: 'selected'; epoch: StoreEpoch }> | Readonly<{ kind: 'retry' }> {
  let candidate = successorEpoch(current ?? '0');
  for (;;) {
    const name = `epoch-${candidate}`;
    try {
      runtime.storage.lstatSync(join(dbDir, name));
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return { kind: 'selected', epoch: candidate };
      candidate = successorEpoch(candidate);
      continue;
    }
    const observation = observeStoreEpochs(runtime.storage, dbDir, [name]).find(({ epoch }) => epoch === candidate);
    if (observation?.proof.kind === 'proven') return { kind: 'retry' };
    if (observation?.proof.kind === 'unobservable') {
      candidate = successorEpoch(candidate);
      continue;
    }
    if (sweepStoreEpochs(runtime, dbDir, current, { replaceEpoch: candidate }) === 'complete') {
      return { kind: 'selected', epoch: candidate };
    }
    candidate = successorEpoch(candidate);
  }
}

function mintNextEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  supersedes: StoreEpoch,
  successor: StoreEpoch,
  classification: StoreEpochClassification,
): 'published' | 'contended' | 'swept' {
  const mint = join(dbDir, `${MINT_DIRECTORY_PREFIX}${runtime.ids.uuid()}`);
  runtime.storage.mkdirSync(mint, { mode: 0o700 });
  try {
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
  }
}

function openProvenStoreDescriptor(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  path: string,
  proof: Extract<StoreEpochProof, { readonly kind: 'proven' }>,
): Readonly<{ descriptor: number; path: string }> | null {
  let descriptor: number | null = null;
  try {
    descriptor = runtime.storage.openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    const openedIdentity = identityOf(runtime.storage.fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(proof.identity, openedIdentity)) {
      runtime.storage.closeSync(descriptor);
      return null;
    }
    return {
      descriptor,
      path:
        runtime.env.platform() === 'linux'
          ? `/proc/self/fd/${descriptor}`
          : runtime.env.platform() === 'darwin'
            ? `/dev/fd/${descriptor}`
            : path,
    };
  } catch {
    if (descriptor !== null) {
      try {
        runtime.storage.closeSync(descriptor);
      } catch {
        // The failed proof cannot authorize an open regardless of descriptor cleanup.
      }
    }
    return null;
  }
}

function provenPathStillNamesObject(
  storage: Pick<StoragePort, 'lstatSync'>,
  path: string,
  proof: Extract<StoreEpochProof, { readonly kind: 'proven' }>,
): boolean {
  try {
    const entry = storage.lstatSync(path, { bigint: true });
    return entry.isFile() && sameIdentity(proof.identity, identityOf(entry));
  } catch {
    return false;
  }
}

function tryOpenCurrentEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  path: string,
  proof: Extract<StoreEpochProof, { readonly kind: 'proven' }>,
):
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'retry' }
  | { readonly kind: 'replace'; readonly classification: StoreEpochClassification } {
  const bound = openProvenStoreDescriptor(runtime, path, proof);
  if (bound === null) return { kind: 'retry' };
  try {
    const decision = openWritableStoreDatabase({
      path: bound.path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    if (decision.kind !== 'opened') return { kind: 'replace', classification: decision.classification };
    if (provenPathStillNamesObject(runtime.storage, path, proof)) return decision;
    try {
      decision.db.close();
    } catch {
      // Preserve the proof mismatch as the reason to iterate.
    }
    return { kind: 'retry' };
  } catch (error: unknown) {
    return { kind: 'replace', classification: unavailableClassification(error) };
  } finally {
    runtime.storage.closeSync(bound.descriptor);
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
      const opened = tryOpenCurrentEpoch(runtime, options, path, current.proof);
      if (opened.kind === 'retry') continue;
      if (opened.kind === 'opened') {
        const verifiedObservations = observeStoreEpochs(runtime.storage, dbDir);
        const verified = currentProvenEpoch(verifiedObservations);
        if (verified?.epoch !== current.epoch) {
          opened.db.close();
          if (verified !== null && compareEpoch(verified.epoch, current.epoch) > 0) continue;
          if (verifiedObservations.find(({ epoch }) => epoch === current.epoch)?.proof.kind === 'unobservable') {
            continue;
          }
          throw new Error(`Store epoch settlement regressed from ${current.epoch} to ${verified?.epoch ?? 'none'}.`);
        }
        if (current.epoch !== '0' && !runtime.storage.syncDirectoryDurableSync(dbDir)) {
          opened.db.close();
          throw new Error(`Failed to durably adopt store epoch ${current.epoch} in '${dbDir}'.`);
        }
        sweepStoreEpochs(runtime, dbDir, current.epoch);
        const settledObservations = observeStoreEpochs(runtime.storage, dbDir);
        const settled = currentProvenEpoch(settledObservations);
        if (settled?.epoch !== current.epoch) {
          opened.db.close();
          if (settled !== null && compareEpoch(settled.epoch, current.epoch) > 0) continue;
          if (settledObservations.find(({ epoch }) => epoch === current.epoch)?.proof.kind === 'unobservable') {
            continue;
          }
          throw new Error(`Store epoch settlement regressed from ${current.epoch} to ${settled?.epoch ?? 'none'}.`);
        }
        opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
        return { db: opened.db, epoch: current.epoch, path };
      }
      classification = opened.classification;
    }
    const successor = selectSuccessor(runtime, dbDir, current?.epoch ?? null);
    if (successor.kind === 'retry') continue;
    const published = mintNextEpoch(runtime, options, dbDir, current?.epoch ?? '0', successor.epoch, classification);
    if (published === 'swept') {
      throw new Error(`Store epoch settlement made no progress beyond epoch ${current?.epoch ?? 'none'}.`);
    }
  }
}

export function discardCurrentStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const dbDir = resolveStoreDbDir(runtime, options.path);
  if (dbDir === ':memory:') throw new Error('Cannot discard an in-memory store epoch.');
  runtime.storage.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    const successor = selectSuccessor(runtime, dbDir, current);
    if (successor.kind === 'retry') continue;
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
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync'>,
  directory: string,
): StoreEpochMetadataDisposition {
  const metadataPath = join(directory, STORE_EPOCH_METADATA_FILE_NAME);
  try {
    const entry = storage.lstatSync(metadataPath);
    if (!entry.isFile() || entry.isSymbolicLink()) return { kind: 'malformed' };
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

  return [...observations]
    .sort((left, right) => compareEpoch(right.epoch, left.epoch))
    .map((observation) => {
      const { epoch } = observation;
      let classification: StoreEpochClassification;
      if (observation.proof.kind !== 'proven') {
        classification = unavailableClassification(new Error('Epoch entry is not proven.'));
      } else {
        try {
          classification = classifyStoreFile(epochPath(dbDir, epoch), runtime.storage, storeFormat);
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
              : observation.proof.kind === 'proven' && current !== null && BigInt(epoch) === BigInt(current) - 1n
                ? 'preserved'
                : 'garbage',
        bytes: epochBytes(runtime.storage, dbDir, epoch),
        classification,
        storedProductVersion: 'storedProductVersion' in classification ? classification.storedProductVersion : null,
        epochJson: observation.epochJson,
      };
    });
}
