import { join, resolve, dirname, basename } from 'node:path';
import { type Runtime } from '../../runtime/ports.js';
import { type StoragePort } from '../../infra/port-types.js';
import { observeStorePath } from '../path-observation.js';
import { readOrCreateEpochKey, inspectEpochKey, readEpochKey } from './key.js';
import { resolveProtectedEpoch, observeProtectedEpoch } from './protection.js';
import {
  type StoreEpoch,
  type StoreEpochProof,
  type StoreEpochMetadataDisposition,
  type CurrentStoreInspection,
  type ResolvedStoreEpoch,
  type ResolvedStorePath,
} from './types.js';
import {
  EPOCH_DIRECTORY_PATTERN,
  STORE_DATABASE_FILE_NAME,
  EPOCH_HOLDER_PREFIX,
  STORE_LOCK_FILE_NAME,
  MINT_DIRECTORY_PREFIX,
  RETIREMENT_ATTEMPT_FILE_NAME,
} from './constants.js';
import { errorCode } from './classification.js';
import { readEpochMetadata } from './metadata.js';

function epochNumber(name: string): StoreEpoch | null {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  return match?.[1] ?? null;
}

export function compareEpoch(left: StoreEpoch, right: StoreEpoch): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function successorEpoch(epoch: StoreEpoch | null): StoreEpoch {
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

export type StoreEpochObservation = Readonly<{
  epoch: StoreEpoch;
  proof: StoreEpochProof;
  epochJson: StoreEpochMetadataDisposition;

  retirementMint?: true;
}>;

export type ProvenStoreEpochObservation = StoreEpochObservation &
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

export function observeContainedDirectory(
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

export function observeContainedRegularFile(
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

export function observeStoreEpochLock(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  dbDir: string,
  epoch: StoreEpoch,
  directoryProof?: StoreEpochProof,
): StoreEpochProof {
  const directory = epochDirectory(dbDir, epoch);
  return observeContainedRegularFile(storage, directory, storeEpochLockPath(dbDir, epoch), directoryProof);
}

export function observeStoreEpochs(
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

export function resolveObservedStoreRoot(
  storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>,
  configuredDbDir: string,
): Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'present'; path: string }> {
  if (observeStorePath(storage, configuredDbDir) === 'absent') return { kind: 'absent' };
  return { kind: 'present', path: storage.realpathSync(configuredDbDir) };
}

export function observeStoreEpoch(
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
  const proof = epochJson.kind === 'valid' ? lock : ({ kind: 'disproven' } as const);
  const retirementMint =
    proof.kind === 'proven' &&
    observeContainedRegularFile(storage, directory, join(directory, RETIREMENT_ATTEMPT_FILE_NAME), contained).kind !==
      'disproven';
  return { epoch, proof, epochJson, ...(retirementMint ? { retirementMint: true } : {}) };
}

/**
 * A retirement moves its predecessor out of the store root before minting, and only a failed attempt's reclaim
 * returns it; a mint whose predecessor is proven there again was never served and must not be read as the store.
 */
export function currentProvenEpoch(observations: readonly StoreEpochObservation[]): ProvenStoreEpochObservation | null {
  const proven = new Set(
    observations.filter((observation) => observation.proof.kind === 'proven').map(({ epoch }) => epoch),
  );
  return observations.reduce<ProvenStoreEpochObservation | null>((current, observation) => {
    if (observation.proof.kind !== 'proven') return current;
    if (observation.retirementMint === true && proven.has((BigInt(observation.epoch) - 1n).toString())) {
      return current;
    }
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

export function encodeResolvedStoreEpoch(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>,
  resolved: ResolvedStoreEpoch,
): string {
  if (resolved.path === ':memory:') return JSON.stringify(resolved);
  return fullEpochKey(resolved, readOrCreateEpochKey(runtime, resolved));
}

function fullEpochKey(resolved: ResolvedStoreEpoch, lineageKey: string): string {
  const storeRoot = resolved.canonicalStoreRoot ?? resolved.storeRoot;
  return JSON.stringify({ storeRoot, epoch: resolved.epoch, path: epochPath(storeRoot, resolved.epoch), lineageKey });
}

export function lineageJobEpochKey(storeRoot: string, lineageKey: string): string {
  return fullEpochKey(resolvedStoreEpoch(storeRoot, lineageKey.slice(lineageKey.lastIndexOf(':') + 1)), lineageKey);
}

/** Store inspection must not take the epoch lock or create a missing marker. */
export function inspectResolvedStoreEpochKey(
  runtime: Pick<Runtime, 'storage'>,
  resolved: ResolvedStoreEpoch,
): string | null {
  const lineageKey = inspectEpochKey(runtime, resolved);
  return lineageKey === null ? null : fullEpochKey(resolved, lineageKey);
}

/** Startup preparation may not create a missing lineage marker. */
export function observeResolvedStoreEpochKey(
  runtime: Pick<Runtime, 'storage'>,
  resolved: ResolvedStoreEpoch,
): string | null {
  if (resolved.path === ':memory:') return JSON.stringify(resolved);
  const lineageKey = readEpochKey(runtime, resolved);
  return lineageKey === null ? null : fullEpochKey(resolved, lineageKey);
}

export function decodeResolvedStoreEpoch(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'env'>,
  value: string | undefined,
): ResolvedStoreEpoch | undefined {
  return decodeStoreEpoch(value, (storeRoot, epochKey) => resolveProtectedEpoch(runtime, storeRoot, epochKey));
}

/** Pre-bind selection may not repair a protected address while decoding its key. */
export function observeResolvedStoreEpoch(
  runtime: Pick<Runtime, 'storage'>,
  value: string | undefined,
): ResolvedStoreEpoch | undefined {
  return decodeStoreEpoch(value, (storeRoot, epochKey) => observeProtectedEpoch(runtime, storeRoot, epochKey));
}

function decodeStoreEpoch(
  value: string | undefined,
  protectedEpoch: (storeRoot: string, epochKey: string) => ResolvedStoreEpoch | null,
): ResolvedStoreEpoch | undefined {
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
      ('lineageKey' in decoded && typeof decoded.lineageKey !== 'string') ||
      resolve(decoded.storeRoot) !== decoded.storeRoot ||
      epochNumber(`epoch-${decoded.epoch}`) !== decoded.epoch ||
      epochPath(decoded.storeRoot, decoded.epoch) !== decoded.path ||
      ('lineageKey' in decoded &&
        typeof decoded.lineageKey === 'string' &&
        !decoded.lineageKey.endsWith(`:${decoded.epoch}`))
    ) {
      return undefined;
    }
    if ('lineageKey' in decoded && typeof decoded.lineageKey === 'string') {
      const mapped = protectedEpoch(decoded.storeRoot, decoded.lineageKey);
      if (mapped !== null) return { ...mapped, lineageKey: decoded.lineageKey };
      return { storeRoot: decoded.storeRoot, epoch: decoded.epoch, path: decoded.path, lineageKey: decoded.lineageKey };
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

export function garbageStoreEpochs(provenEpochs: readonly StoreEpoch[]): ReadonlySet<StoreEpoch> {
  const ordered = [...new Set(provenEpochs)].sort(compareEpoch);
  const retained = new Set(ordered.slice(-2));
  return new Set(ordered.filter((epoch) => !retained.has(epoch)));
}

export function proveReleaseTarget(
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

export async function observeContainedDirectoryAsync(
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

export async function observeContainedRegularFileAsync(
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

export async function observeStoreEpochLockAsync(
  storage: StoragePort,
  dbDir: string,
  epoch: StoreEpoch,
  directoryProof?: StoreEpochProof,
): Promise<StoreEpochProof> {
  const directory = epochDirectory(dbDir, epoch);
  const lock = storeEpochLockPath(dbDir, epoch);
  return observeContainedRegularFileAsync(storage, directory, lock, directoryProof);
}
