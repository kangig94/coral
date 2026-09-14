import { join, resolve } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { writeAuditEvent } from '../infra/audit-log.js';
import type { StoragePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { classifyStoreFile, openWritableStoreDatabase, type Database } from './db.js';
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
  epochJson: StoreEpochMetadata | null;
}>;

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
  return Number.isSafeInteger(value) ? value : null;
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

export function resolveCurrentStoreEpoch(storage: Pick<StoragePort, 'readdirSync'>, dbDir: string): number {
  let current = 0;
  for (const entry of storage.readdirSync(dbDir)) {
    const epoch = epochNumber(entry);
    if (epoch !== null && epoch > current) current = epoch;
  }
  return current;
}

export function resolveCurrentStorePath(runtime: Pick<Runtime, 'paths' | 'storage'>, path?: string): string {
  if (path === ':memory:') return path;
  const dbDir = resolveStoreDbDir(runtime, path);
  if (!runtime.storage.existsSync(dbDir)) return epochPath(dbDir, 0);
  return epochPath(dbDir, resolveCurrentStoreEpoch(runtime.storage, dbDir));
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

export function sweepStoreEpochs(
  storage: StoragePort,
  dbDir: string,
  current: number,
  options: { readonly releaseEpoch?: number } = {},
): boolean {
  if (options.releaseEpoch !== undefined) {
    if (options.releaseEpoch !== 0) {
      return removeDuringSweep(storage, epochDirectory(dbDir, options.releaseEpoch), true);
    }
    let released = true;
    for (const name of [
      STORE_DATABASE_FILE_NAME,
      `${STORE_DATABASE_FILE_NAME}-wal`,
      `${STORE_DATABASE_FILE_NAME}-shm`,
      `${STORE_DATABASE_FILE_NAME}${STORE_FORMAT_SIDECAR_SUFFIX}`,
    ]) {
      released = removeDuringSweep(storage, join(dbDir, name), false) && released;
    }
    return released;
  }

  let entries: readonly string[];
  try {
    entries = storage.readdirSync(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return false;
  }

  let complete = true;
  for (const entry of entries) {
    const epoch = epochNumber(entry);
    if ((epoch !== null && isGarbageStoreEpoch(current, epoch)) || entry.startsWith(MINT_DIRECTORY_PREFIX)) {
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
      opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
      sweepStoreEpochs(runtime.storage, dbDir, current);
      return { db: opened.db, epoch: current, path };
    }
    mintNextEpoch(runtime, options, dbDir, current, opened.classification);
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

function readEpochMetadata(storage: StoragePort, dbDir: string, epoch: number): StoreEpochMetadata | null {
  if (epoch === 0) return null;
  try {
    return parseStoreEpochMetadata(
      JSON.parse(storage.readFileSync(join(epochDirectory(dbDir, epoch), STORE_EPOCH_METADATA_FILE_NAME), 'utf-8')),
    );
  } catch {
    return null;
  }
}

function epochBytes(storage: StoragePort, dbDir: string, epoch: number): number | null {
  const path = epochPath(dbDir, epoch);
  let total = 0;
  try {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}${STORE_FORMAT_SIDECAR_SUFFIX}`]) {
      if (!storage.existsSync(file)) continue;
      const size = storage.statSync(file, { bigint: true }).size;
      if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER - total)) return null;
      total += Number(size);
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
  const entries = runtime.storage.readdirSync(dbDir);
  const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
  const epochs = entries.flatMap((entry) => {
    const epoch = epochNumber(entry);
    return epoch === null ? [] : [epoch];
  });
  if (runtime.storage.existsSync(epochPath(dbDir, 0))) epochs.push(0);

  return [...new Set(epochs)]
    .sort((left, right) => right - left)
    .map((epoch) => {
      let classification: StoreEpochClassification;
      try {
        classification = classifyStoreFile(epochPath(dbDir, epoch), runtime.storage, storeFormat);
      } catch (error: unknown) {
        classification = unavailableClassification(error);
      }
      return {
        epoch,
        role: epoch === current ? 'current' : epoch === current - 1 ? 'preserved' : 'garbage',
        bytes: epochBytes(runtime.storage, dbDir, epoch),
        classification,
        storedProductVersion: 'storedProductVersion' in classification ? classification.storedProductVersion : null,
        epochJson: readEpochMetadata(runtime.storage, dbDir, epoch),
      };
    });
}
