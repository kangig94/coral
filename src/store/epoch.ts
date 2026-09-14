import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import { probeCoordinator } from '../infra/backend-discovery.js';
import type { StoragePort } from '../infra/port-types.js';
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

export type StoreEpochClassification =
  | StoreFormatClassification
  | { readonly kind: 'unavailable'; readonly cause: string };

export type StoreEpochMetadata = Readonly<{
  supersedes: number;
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
  epoch: number;
  path: string;
}>;

export type StoreEpochListEntry = Readonly<{
  epoch: number;
  role: 'current' | 'preserved' | 'garbage';
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

function epochNumber(name: string): number | null {
  const match = EPOCH_DIRECTORY_PATTERN.exec(name);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER ? value : null;
}

export function epochDirectory(dbDir: string, epoch: number): string {
  return epoch === 0 ? dbDir : join(dbDir, `epoch-${epoch}`);
}

export function epochPath(dbDir: string, epoch: number): string {
  return join(epochDirectory(dbDir, epoch), STORE_DATABASE_FILE_NAME);
}

export function resolveStoreDbDir(runtime: Pick<Runtime, 'paths'>, path?: string): string {
  if (path === undefined) return runtime.paths.coral.store.dbDir;
  if (path === ':memory:') return ':memory:';
  return resolve(path, '..');
}

type StoreEpochDiscoveryStorage = Pick<StoragePort, 'lstatSync' | 'readFileSync' | 'readdirSync' | 'realpathSync'>;

type StoreEpochObservation = Readonly<{
  epoch: number;
  proven: boolean;
  epochJson: StoreEpochMetadataDisposition;
}>;

function isRegularFile(storage: Pick<StoragePort, 'lstatSync'>, path: string): boolean {
  try {
    const entry = storage.lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function isContainedDirectory(storage: Pick<StoragePort, 'lstatSync' | 'realpathSync'>, dbDir: string, path: string) {
  try {
    const entry = storage.lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const relativePath = relative(storage.realpathSync(dbDir), storage.realpathSync(path));
    return (
      relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
    );
  } catch {
    return false;
  }
}

function observeStoreEpochs(
  storage: StoreEpochDiscoveryStorage,
  dbDir: string,
  entries: readonly string[] = storage.readdirSync(dbDir),
): readonly StoreEpochObservation[] {
  const observations: StoreEpochObservation[] = [];
  if (isRegularFile(storage, epochPath(dbDir, 0))) {
    observations.push({ epoch: 0, proven: true, epochJson: { kind: 'legacy-epoch-0' } });
  }
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if (epoch === null || epoch === 0) continue;
    const directory = join(dbDir, entry);
    const contained = isContainedDirectory(storage, dbDir, directory);
    const epochJson = contained ? readEpochMetadata(storage, directory) : { kind: 'malformed' as const };
    const proven = contained && isRegularFile(storage, epochPath(directory, 0)) && epochJson.kind === 'valid';
    observations.push({ epoch, proven, epochJson });
  }
  return observations;
}

function currentProvenEpoch(observations: readonly StoreEpochObservation[]): number {
  return observations.reduce((current, observation) => {
    return observation.proven && observation.epoch > current ? observation.epoch : current;
  }, 0);
}

export function resolveCurrentStoreEpoch(storage: StoreEpochDiscoveryStorage, dbDir: string): number {
  return currentProvenEpoch(observeStoreEpochs(storage, dbDir));
}

export function resolveCurrentStorePath(runtime: Pick<Runtime, 'paths' | 'storage'>, path?: string): string {
  if (path !== undefined) return path;
  const dbDir = resolveStoreDbDir(runtime);
  if (!runtime.storage.existsSync(dbDir)) return epochPath(dbDir, 0);
  return epochPath(dbDir, resolveCurrentStoreEpoch(runtime.storage, dbDir));
}

export function openWritableStoreDbNoReset(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage'>,
  options: {
    readonly path?: string;
    readonly busyTimeoutMs?: number;
    readonly storeFormat: StoreFormatDescription;
  },
): Database {
  const storeDbPath = resolveCurrentStorePath(runtime, options.path);
  if (storeDbPath === ':memory:' || !runtime.storage.existsSync(storeDbPath)) {
    throw documentedCoralSetupError('store_not_initialized', { path: storeDbPath });
  }
  return openStoreDatabase({
    path: storeDbPath,
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    flavor: runtime.flavor,
    busyTimeoutMs: options.busyTimeoutMs,
  });
}

export function isGarbageStoreEpoch(current: number, candidate: number): boolean {
  return candidate <= current - 2;
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
  supersedes: number,
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

function failStoreEpoch(message: string): never {
  throw new Error(message);
}

function writeEpochMetadata(storage: StoragePort, mint: string, metadata: StoreEpochMetadata): void {
  if (
    !storage.writeAtomicDurableSync(join(mint, STORE_EPOCH_METADATA_FILE_NAME), `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    failStoreEpoch(`Failed to publish ${STORE_EPOCH_METADATA_FILE_NAME} in '${mint}'.`);
  }
  if (!storage.syncDirectoryDurableSync(mint)) {
    failStoreEpoch(`Failed to durably sync store mint '${mint}'.`);
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

export function sweepStoreEpochs(
  runtime: Runtime,
  dbDir: string,
  current: number,
  options: { readonly assertOwned?: () => void; readonly releaseEpoch?: number } = {},
): boolean {
  const { storage } = runtime;
  try {
    const coordinator = probeCoordinator(runtime);
    if (
      coordinator.kind === 'unobservable' ||
      (coordinator.kind === 'live' && (coordinator.record.pid !== runtime.env.pid() || options.releaseEpoch === 0))
    ) {
      return false;
    }
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return false;
  }

  if (options.releaseEpoch !== undefined) {
    options.assertOwned?.();
    let released: boolean;
    if (options.releaseEpoch !== 0) {
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
      return storage.syncDirectoryDurableSync(dbDir) && released;
    } catch (error: unknown) {
      auditSweepFailure(dbDir, error);
      return false;
    }
  }

  let entries: readonly string[];
  try {
    entries = storage.readdirSync(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return false;
  }

  const observations = observeStoreEpochs(storage, dbDir, entries);
  const byEpoch = new Map(observations.map((observation) => [observation.epoch, observation]));
  let complete = true;
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    const observation = epoch === null ? undefined : byEpoch.get(epoch);
    const unprovenEpochEntry = EPOCH_DIRECTORY_PATTERN.test(entry) && observation?.proven !== true;
    if (unprovenEpochEntry || (observation?.proven === true && isGarbageStoreEpoch(current, observation.epoch))) {
      complete = removeDuringSweep(storage, join(dbDir, entry), true) && complete;
    }
  }

  if (current >= 1) {
    complete = removeDuringSweep(storage, join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY), true) && complete;
  }
  if (current >= 2) {
    for (const name of [
      STORE_DATABASE_FILE_NAME,
      `${STORE_DATABASE_FILE_NAME}-wal`,
      `${STORE_DATABASE_FILE_NAME}-shm`,
      `${STORE_DATABASE_FILE_NAME}${STORE_FORMAT_SIDECAR_SUFFIX}`,
    ]) {
      complete = removeDuringSweep(storage, join(dbDir, name), false) && complete;
    }
  }
  return complete;
}

function cleanupMint(storage: StoragePort, mint: string): void {
  try {
    storage.rmSync(mint, { recursive: true, force: true });
  } catch (error: unknown) {
    auditSweepFailure(mint, error);
  }
}

function mintNextEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  supersedes: number,
  classification: StoreEpochClassification,
): 'published' | 'contended' | 'swept' {
  const mint = join(dbDir, `${MINT_DIRECTORY_PREFIX}${runtime.ids.uuid()}`);
  runtime.storage.mkdirSync(mint, { mode: 0o700 });
  try {
    const opened = openWritableStoreDatabase({
      path: epochPath(mint, 0),
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
      runtime.storage.renameSync(mint, epochDirectory(dbDir, supersedes + 1));
      if (!runtime.storage.syncDirectoryDurableSync(dbDir)) {
        throw new Error(`Failed to durably sync store epoch root '${dbDir}'.`);
      }
      return 'published';
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'contended';
      if (code === 'ENOENT') return 'swept';
      throw error;
    }
  } finally {
    cleanupMint(runtime.storage, mint);
  }
}

function tryOpenCurrentEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  path: string,
):
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'replace'; readonly classification: StoreEpochClassification } {
  try {
    const decision = openWritableStoreDatabase({
      path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs,
    });
    return decision.kind === 'opened' ? decision : { kind: 'replace', classification: decision.classification };
  } catch (error: unknown) {
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
    return { db: opened.db, epoch: 0, path: ':memory:' };
  }

  runtime.storage.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    const path = epochPath(dbDir, current);
    const opened = tryOpenCurrentEpoch(runtime, options, path);
    if (opened.kind === 'opened') {
      const verified = resolveCurrentStoreEpoch(runtime.storage, dbDir);
      if (verified !== current) {
        opened.db.close();
        if (verified > current) continue;
        failStoreEpoch(`Store epoch settlement regressed from ${current} to ${verified}.`);
      }
      if (current > 0 && !runtime.storage.syncDirectoryDurableSync(dbDir)) {
        opened.db.close();
        failStoreEpoch(`Failed to durably adopt store epoch ${current} in '${dbDir}'.`);
      }
      sweepStoreEpochs(runtime, dbDir, current);
      const settled = resolveCurrentStoreEpoch(runtime.storage, dbDir);
      if (settled !== current) {
        opened.db.close();
        if (settled > current) continue;
        failStoreEpoch(`Store epoch settlement regressed from ${current} to ${settled}.`);
      }
      opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
      return { db: opened.db, epoch: current, path };
    }
    mintNextEpoch(runtime, options, dbDir, current, opened.classification);
    const advanced = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    if (advanced <= current) {
      failStoreEpoch(`Store epoch settlement made no progress beyond epoch ${current}.`);
    }
  }
}

export function discardCurrentStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const dbDir = resolveStoreDbDir(runtime, options.path);
  if (dbDir === ':memory:') throw new Error('Cannot discard an in-memory store epoch.');
  runtime.storage.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    const published = mintNextEpoch(runtime, options, dbDir, current, {
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
  if (!isRecord(value) || !Number.isSafeInteger(value.supersedes) || Number(value.supersedes) < 0) return null;
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
  return value as StoreEpochMetadata;
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

function epochBytes(storage: StoragePort, dbDir: string, epoch: number): number | null {
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
    if (epoch > 0) return inventory(epochDirectory(dbDir, epoch)) ? total : null;
    const path = epochPath(dbDir, 0);
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
  if (!observations.some(({ proven }) => proven)) return [];
  const current = currentProvenEpoch(observations);

  return [...observations]
    .sort((left, right) => right.epoch - left.epoch)
    .map((observation) => {
      const { epoch } = observation;
      let classification: StoreEpochClassification;
      if (!observation.proven) {
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
          observation.proven && epoch === current
            ? 'current'
            : observation.proven && epoch === current - 1
              ? 'preserved'
              : 'garbage',
        bytes: epochBytes(runtime.storage, dbDir, epoch),
        classification,
        storedProductVersion: 'storedProductVersion' in classification ? classification.storedProductVersion : null,
        epochJson: observation.epochJson,
      };
    });
}
