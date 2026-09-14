import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import { errorNumber } from '../infra/error-number.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { ACTIVE_STORE_TRANSITION_VERSION } from './active-store-selection.js';
import {
  dropParkedEvidence,
  describeParkedEntries,
  enumerateActiveEvidence,
  activeNameHasIdentity,
  linkOwnedEvidenceToActive,
  openActiveEvidence,
  parkActiveEvidence,
  parkCurrentEvidence,
  readParkedEvidence,
  restoreParkedEvidence,
  type ActiveEvidence,
  type ActiveEvidenceIdentity,
  type ActiveEvidenceFileSet,
  type ParkedActiveEvidence,
  type StableSource,
} from './reset-active-evidence.js';
import {
  isStoreFormatFingerprint,
  type StoreFormatClassification,
  type StoreFormatDescription,
  type StoreFormatFingerprint,
} from './format-fingerprint.js';
import {
  acquireGenerationMaintenanceLease,
  type GenerationAdoptionLockLease,
  type GenerationMaintenanceLease,
} from './generation-mutation-coordination.js';
import { classifyStoreFile, openWritableStoreDatabase, refuseLegacyStore, type Database } from './db.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_ACTIVE_STORE_TRANSITION_BYTES,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_INCIDENT_SCHEMA_VERSION,
  STORE_RESET_IN_FLIGHT_DIRECTORY,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_PARKED_DIRECTORY,
  STORE_RESET_PARKED_SIDECAR_FILE_NAME,
  STORE_RESET_MINTED_DIRECTORY,
  STORE_RESET_MINTED_STORE_DIRECTORY,
  type STORE_RESET_RETAINED_INCIDENT_SCHEMA_VERSION,
  STORE_RESET_QUARANTINE_DIRECTORY,
  STORE_RESET_STAGING_DIRECTORY,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentFile,
  type StoreResetIncidentManifest,
  type StoreResetIncidentManifestV3,
  type StoreResetNewerTargetEvidence,
  type StoreResetPolicyCause,
} from './reset-incident.js';
import {
  assertContainedDirectory,
  assertQuarantineRoot,
  clearStoreResetPending,
  discoverStoreResetParkedRecords,
  recordStoreResetParked,
  recordStoreResetPending,
  recordStoreResetPreserved,
  recordStoreResetResumeLeftActive,
  readStoreResetRetentionLedger,
  readStoreResetParkedRecord,
  resolveStoreResetRetentionSlot,
  settleStoreResetPending,
  writeStoreResetParkedRecord,
  type PreservationMechanism,
  type StoreResetRetentionLedger,
  type StoreResetRetentionIncident,
  type StoreResetRetentionPending,
  type StoreResetParkedRecord,
} from './reset-retention.js';

const STORE_FORMAT_SIDECAR_SUFFIX = '.format';
const RETAINED_TRANSITION_DIRECTORY = 'retained-active-store-transitions';
const TRANSITION_EVIDENCE_SUFFIX = `.active-store-transition.v${ACTIVE_STORE_TRANSITION_VERSION}.json`;
const RETAINED_TRANSITION_STAGING_SUFFIX = '.tmp';
export const STEADY_STATE_BUSY_TIMEOUT_MS = 5_000;

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const BACKEND_STORE_RESET_AUTHORITY_BRAND: unique symbol = Symbol('BackendStoreResetAuthority');
const BACKEND_STORE_RESET_LOCK_BRAND: unique symbol = Symbol('BackendStoreResetLock');

type ResettableStoreFormatClassification =
  | Extract<StoreFormatClassification, { readonly kind: 'older-incompatible' }>
  | Extract<StoreFormatClassification, { readonly kind: 'corrupt-or-unsupported' }>;

type LegacyOperatorResetClassification = Extract<StoreFormatClassification, { readonly kind: 'newer-incompatible' }>;

export type BackendStoreResetClassification = ResettableStoreFormatClassification | LegacyOperatorResetClassification;

export type NewerStoreResetPolicy = Readonly<{
  cause: 'newer-incompatible-invalid-target';
  evidence: StoreResetNewerTargetEvidence;
}>;

export type BackendStoreResetAuthority = Readonly<{
  socketPath: string;
  storeDbPath: string;
  version: string;
  buildSetId: string;
  bundleHash: string;
  flavor: Runtime['flavor'];
  namespace: string;
  storeFormatFingerprint: StoreFormatFingerprint;
  acquiredViaHandoff: boolean;
  issuedAt: number;
  [BACKEND_STORE_RESET_AUTHORITY_BRAND]: true;
}>;

export type BackendStoreResetLockLease = Readonly<{
  assertOwned(): void;
  release(): void;
  [BACKEND_STORE_RESET_LOCK_BRAND]: true;
}>;

export type BackendStorePathOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
  readonly storeFormat: StoreFormatDescription;
};

type BackendStoreResetAuthorityOptions = BackendStorePathOptions & {
  readonly namespace: string;
  readonly build: StrictBundleManifest;
};

export type OpenOrResetBackendStoreOptions = BackendStorePathOptions & {
  readonly startupBusyTimeoutMs?: number;
  readonly steadyStateBusyTimeoutMs?: number;
};

export type BackendStoreFileSet = ActiveEvidenceFileSet & {
  readonly dbDir: string;
};

type EvidenceFileCandidate<Name extends string> = {
  readonly source: string;
  readonly name: Name;
};

type PublishedEvidenceFile<Name extends string> = Omit<StoreResetIncidentFile, 'name'> & { readonly name: Name };

type PublishedEvidenceCopy<Name extends string> = Readonly<{
  evidence: PublishedEvidenceFile<Name>;
  sourceIdentity: StorageBigIntStat;
  coherence: 'coherent' | 'torn';
}>;

export type WriterExclusion =
  | { readonly kind: 'proven'; readonly lease: GenerationMaintenanceLease }
  | {
      readonly kind: 'unproven';
      readonly reason: 'writer-live' | 'writer-unobservable' | 'lock-timeout';
      readonly blockers: string | null;
    };

export type IncidentPublication =
  | {
      readonly kind: 'preserved';
      readonly incident: BackendStoreResetIncident;
      readonly preservation: PreservationMechanism;
      readonly leftActive: readonly StoreResetEvidenceFileName[];
    }
  | { readonly kind: 'no-evidence'; readonly leftActive: readonly StoreResetEvidenceFileName[] };

export type StoreSettlementEpoch =
  | { readonly kind: 'described'; readonly publication: IncidentPublication }
  | {
      readonly kind: 'parked';
      readonly parkingId: string;
      readonly cause: 'intruder' | 'residual';
      readonly names: readonly StoreResetEvidenceFileName[];
      readonly classification: StoreFormatClassification | null;
    }
  | { readonly kind: 'adopted' }
  | { readonly kind: 'claimed' };

export type MintedBackendStore = Readonly<{
  directory: string;
  path: string;
  identity: { readonly dev: bigint; readonly ino: bigint };
  db: Database;
}>;

export type BackendStoreClaimAttempt =
  | {
      readonly kind: 'retry';
      readonly candidate: MintedBackendStore;
      readonly epochs: readonly StoreSettlementEpoch[];
    }
  | { readonly kind: 'opened'; readonly db: Database; readonly epochs: readonly StoreSettlementEpoch[] };

type ParkedStoreAdoptionAttempt =
  | { readonly kind: 'retry'; readonly epochs: readonly StoreSettlementEpoch[] }
  | { readonly kind: 'opened'; readonly db: Database; readonly epochs: readonly StoreSettlementEpoch[] };

export async function acquireBackendStoreWriterExclusion(
  runtime: Runtime,
  timeoutMs?: number,
): Promise<WriterExclusion> {
  try {
    return { kind: 'proven', lease: await acquireGenerationMaintenanceLease(runtime, timeoutMs) };
  } catch (error: unknown) {
    if (error instanceof CoralSetupError && error.code === 'legacy_source_not_quiescent') {
      return {
        kind: 'unproven',
        reason: 'writer-live',
        blockers: typeof error.context?.holder === 'string' ? error.context.holder : null,
      };
    }
    if (error instanceof CoralSetupError && error.code === 'legacy_source_writer_observation_unknown') {
      return {
        kind: 'unproven',
        reason: 'writer-unobservable',
        blockers: typeof error.context?.holder === 'string' ? error.context.holder : null,
      };
    }
    if (isDirectoryLockTimeoutError(error)) {
      return { kind: 'unproven', reason: 'lock-timeout', blockers: null };
    }
    throw error;
  }
}

type InterruptedStoreResetRefusalCode =
  | 'store_reset_interrupted_ambiguous'
  | 'store_reset_interrupted_foreign'
  | 'store_reset_interrupted_mismatched'
  | 'store_reset_interrupted_authority_mismatch'
  | 'store_reset_interrupted_malformed'
  | 'store_reset_interrupted_non_resettable';

class InterruptedStoreResetRefusal extends Error {
  readonly code: InterruptedStoreResetRefusalCode;

  constructor(code: InterruptedStoreResetRefusalCode, cause?: unknown) {
    super('Interrupted backend store reset cannot be resumed automatically.', { cause });
    this.name = 'InterruptedStoreResetRefusal';
    this.code = code;
  }
}

export type BackendStoreResetIncident = {
  readonly incidentId: string;
  readonly resetAt: string;
  readonly reason: 'missing' | 'mismatch';
  readonly schemaVersion:
    | typeof STORE_RESET_RETAINED_INCIDENT_SCHEMA_VERSION
    | typeof STORE_RESET_INCIDENT_SCHEMA_VERSION;
  readonly resetPolicyCause: StoreResetPolicyCause | null;
  readonly fileCount: number;
};

function resolveStoreDbPath(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions): string {
  if (options.path === ':memory:') {
    return ':memory:';
  }
  const { dbFile } = runtime.paths.coral.store;
  return resolve(options.path ?? dbFile);
}

export function resolveBackendStoreFileSet(
  runtime: Pick<Runtime, 'paths'>,
  options: BackendStorePathOptions,
): BackendStoreFileSet {
  if (options.path === undefined) {
    const { dbDir, dbFile } = runtime.paths.coral.store;
    return {
      dbDir,
      dbFile,
      walFile: `${dbFile}-wal`,
      shmFile: `${dbFile}-shm`,
      formatFile: `${dbFile}${STORE_FORMAT_SIDECAR_SUFFIX}`,
    };
  }

  const dbFile = resolveStoreDbPath(runtime, options);
  return {
    dbDir: dirname(dbFile),
    dbFile,
    walFile: `${dbFile}-wal`,
    shmFile: `${dbFile}-shm`,
    formatFile: `${dbFile}${STORE_FORMAT_SIDECAR_SUFFIX}`,
  };
}

/**
 * Mint the reset capability after coordinator handoff and build/store-format
 * identity have converged for this backend instance.
 */
export function createBackendStoreResetAuthority(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'time'>,
  handoff: { readonly acquiredViaHandoff: boolean },
  options: BackendStoreResetAuthorityOptions,
): BackendStoreResetAuthority {
  if (
    options.build.flavor !== runtime.flavor ||
    options.build.storeFormatFingerprint !== options.storeFormat.fingerprint
  ) {
    throw documentedCoralSetupError({
      code: 'store_schema_outdated',
      reason: 'reset_build_identity_mismatch',
    });
  }
  return {
    socketPath: runtime.paths.coral.coordinator.socketPath,
    storeDbPath: resolveStoreDbPath(runtime, options),
    version: options.build.version,
    buildSetId: options.build.buildSetId,
    bundleHash: options.build.bundleHash,
    flavor: runtime.flavor,
    namespace: options.namespace,
    storeFormatFingerprint: options.storeFormat.fingerprint,
    acquiredViaHandoff: handoff.acquiredViaHandoff,
    issuedAt: runtime.time.now(),
    [BACKEND_STORE_RESET_AUTHORITY_BRAND]: true,
  };
}

export function assertBackendStoreResetAuthority(
  runtime: Pick<Runtime, 'flavor' | 'paths'>,
  authority: BackendStoreResetAuthority,
  options: OpenOrResetBackendStoreOptions,
): void {
  const expected = {
    socketPath: runtime.paths.coral.coordinator.socketPath,
    storeDbPath: resolveStoreDbPath(runtime, options),
    flavor: runtime.flavor,
    storeFormatFingerprint: options.storeFormat.fingerprint,
  };

  const mismatches: string[] = [];
  if (authority[BACKEND_STORE_RESET_AUTHORITY_BRAND] !== true) mismatches.push('brand');
  if (authority.socketPath !== expected.socketPath) mismatches.push('socketPath');
  if (authority.storeDbPath !== expected.storeDbPath) mismatches.push('storeDbPath');
  if (authority.flavor !== expected.flavor) mismatches.push('flavor');
  if (authority.storeFormatFingerprint !== expected.storeFormatFingerprint) {
    mismatches.push('storeFormatFingerprint');
  }

  if (mismatches.length > 0) {
    throw documentedCoralSetupError({
      code: 'store_schema_outdated',
      reason: 'reset_authority_mismatch',
      mismatches,
    });
  }
}

function storedFingerprint(classification: BackendStoreResetClassification): string | null {
  return isStoreFormatFingerprint(classification.storedFingerprint) ? classification.storedFingerprint : null;
}

/**
 * True when two stats of a store-reset evidence path (a file, or the containing directory checkpoints this
 * module re-verifies the same way) describe the same on-disk entry: device, inode, mode, size, mtime, and
 * file-vs-directory kind.
 */
function sameEvidenceFileStat(left: StorageBigIntStat, right: StorageBigIntStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory()
  );
}

function stablePathStat(storage: StoragePort, path: string): StorageBigIntStat {
  const link = storage.lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new Error('Store-reset evidence is not a regular file.');
  }
  return storage.statSync(path, { bigint: true });
}

function parkedDatabaseHasPrivateInode(storage: StoragePort, path: string, identity: ActiveEvidenceIdentity): boolean {
  const descriptor = storage.openSync(path, 'r');
  try {
    const stat = storage.fstatSync(descriptor, { bigint: true });
    return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && stat.nlink === 1n;
  } finally {
    storage.closeSync(descriptor);
  }
}

function hashExactDescriptor(
  storage: StoragePort,
  descriptor: number,
  expectedSize: number,
  consume?: (buffer: Buffer, length: number) => void,
): { readonly sha256: string; readonly bytesConsumed: number; readonly overrun: boolean } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (total < expectedSize) {
    const requested = Math.min(buffer.length, expectedSize - total);
    const bytesRead = storage.readSync(descriptor, buffer, 0, requested, null);
    if (bytesRead === 0) break;
    if (bytesRead < 0 || bytesRead > requested) throw new Error('Store-reset evidence read failed.');
    consume?.(buffer, bytesRead);
    total += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  const overrunBytes = storage.readSync(descriptor, buffer, 0, 1, null);
  if (overrunBytes < 0 || overrunBytes > 1) throw new Error('Store-reset evidence read failed.');
  if (overrunBytes === 1) {
    consume?.(buffer, 1);
    total += 1;
    hash.update(buffer.subarray(0, 1));
  }
  return { sha256: hash.digest('hex'), bytesConsumed: total, overrun: overrunBytes === 1 };
}

function writeExactDescriptor(storage: StoragePort, descriptor: number, buffer: Buffer, length: number): void {
  let written = 0;
  while (written < length) {
    const bytesWritten = storage.writeSync(descriptor, buffer, written, length - written, null);
    if (bytesWritten <= 0 || bytesWritten > length - written) {
      throw new Error('Store-reset evidence write failed during publication.');
    }
    written += bytesWritten;
  }
}

function describeCandidate<Name extends string>(
  storage: StoragePort,
  candidate: EvidenceFileCandidate<Name>,
  remainingBudget: number | null,
): PublishedEvidenceFile<Name> {
  const pathBefore = stablePathStat(storage, candidate.source);
  if (
    !pathBefore.isFile() ||
    pathBefore.size < 0n ||
    (remainingBudget !== null && pathBefore.size > BigInt(remainingBudget)) ||
    pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Store-reset evidence exceeds the bounded hashing budget.');
  }

  const descriptor = storage.openSync(candidate.source, 'r');
  let digest: string;
  let closeFailure: unknown = null;
  try {
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameEvidenceFileStat(pathBefore, opened)) {
      throw new StoreResetEvidenceMutation('Store-reset evidence identity changed before hashing.');
    }
    const expectedSize = Number(opened.size);
    const hashed = hashExactDescriptor(storage, descriptor, expectedSize);
    if (hashed.bytesConsumed !== expectedSize || hashed.overrun) {
      throw new StoreResetEvidenceMutation('Store-reset evidence changed size during hashing.');
    }
    digest = hashed.sha256;
    const openedAfter = storage.fstatSync(descriptor, { bigint: true });
    const pathAfter = stablePathStat(storage, candidate.source);
    if (!sameEvidenceFileStat(opened, openedAfter) || !sameEvidenceFileStat(opened, pathAfter)) {
      throw new StoreResetEvidenceMutation('Store-reset evidence identity changed during hashing.');
    }
  } finally {
    try {
      storage.closeSync(descriptor);
    } catch (error: unknown) {
      closeFailure = error;
    }
  }
  if (closeFailure !== null) {
    throw new Error('Store-reset evidence descriptor could not be closed safely.');
  }
  return {
    name: candidate.name,
    sizeBytes: Number(pathBefore.size),
    mtimeMs: Number(pathBefore.mtimeNs / 1_000_000n),
    sha256: digest,
  };
}

function copyPathCandidateForPublication<Name extends string>(
  storage: StoragePort,
  pathCandidate: EvidenceFileCandidate<Name>,
  destination: string,
  remainingBudget: number | null,
): PublishedEvidenceCopy<Name> {
  const pathBefore = stablePathStat(storage, pathCandidate.source);
  if (
    !pathBefore.isFile() ||
    pathBefore.size < 0n ||
    (remainingBudget !== null && pathBefore.size > BigInt(remainingBudget)) ||
    pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Store-reset evidence exceeds the bounded publication budget.');
  }

  let sourceDescriptor: number | null = null;
  let destinationDescriptor: number | null = null;
  let closeFailure = false;
  let result: PublishedEvidenceCopy<Name> | null = null;
  try {
    sourceDescriptor = storage.openSync(pathCandidate.source, 'r');
    const sourceOpened = storage.fstatSync(sourceDescriptor, { bigint: true });
    if (!sourceOpened.isFile() || !sameEvidenceFileStat(pathBefore, sourceOpened)) {
      throw new Error('Store-reset evidence identity changed before publication.');
    }
    const openedDestination = storage.openSync(destination, 'wx', 0o600);
    destinationDescriptor = openedDestination;

    const expectedSize = Number(sourceOpened.size);
    const hashed = hashExactDescriptor(storage, sourceDescriptor, expectedSize, (buffer, length) => {
      writeExactDescriptor(storage, openedDestination, buffer, length);
    });
    const sourceAfter = storage.fstatSync(sourceDescriptor, { bigint: true });
    const sourcePathAfter = stablePathStat(storage, pathCandidate.source);
    const coherence =
      !hashed.overrun &&
      hashed.bytesConsumed === expectedSize &&
      sameEvidenceFileStat(sourceOpened, sourceAfter) &&
      sameEvidenceFileStat(sourceOpened, sourcePathAfter)
        ? 'coherent'
        : 'torn';

    storage.fdatasyncSync(destinationDescriptor);
    const destinationOpened = storage.fstatSync(destinationDescriptor, { bigint: true });
    if (!destinationOpened.isFile() || destinationOpened.size !== BigInt(hashed.bytesConsumed)) {
      throw new Error('Published store-reset evidence has an unexpected size.');
    }
    result = {
      evidence: {
        name: pathCandidate.name,
        sizeBytes: hashed.bytesConsumed,
        mtimeMs: Number(sourceOpened.mtimeNs / 1_000_000n),
        sha256: hashed.sha256,
      },
      sourceIdentity: sourceOpened,
      coherence,
    };
  } finally {
    for (const descriptor of [destinationDescriptor, sourceDescriptor]) {
      if (descriptor === null) continue;
      try {
        storage.closeSync(descriptor);
      } catch {
        closeFailure = true;
      }
    }
    if (result === null || closeFailure) {
      try {
        storage.unlinkSync(destination);
      } catch {
        // The primary publication failure remains authoritative.
      }
    }
  }
  if (closeFailure || result === null) {
    throw new Error('Store-reset publication descriptors could not be closed safely.');
  }
  const destinationAfter = stablePathStat(storage, destination);
  if (
    !destinationAfter.isFile() ||
    destinationAfter.size !== BigInt(result.evidence.sizeBytes) ||
    !evidenceMatches(storage, { source: destination, name: pathCandidate.name }, result.evidence)
  ) {
    throw new Error('Published store-reset evidence failed stable verification.');
  }
  return result;
}

function copyActiveEvidenceForPublication(
  storage: StoragePort,
  source: StableSource,
  destination: string,
): PublishedEvidenceCopy<StoreResetEvidenceFileName> {
  const sourceOpened = source.openedStat;
  let destinationDescriptor: number | null = null;
  let closeFailure = false;
  let result: PublishedEvidenceCopy<StoreResetEvidenceFileName> | null = null;
  try {
    const openedDestination = storage.openSync(destination, 'wx', 0o600);
    destinationDescriptor = openedDestination;
    const expectedSize = source.sizeBytes;
    const hashed = hashExactDescriptor(storage, source.descriptor, expectedSize, (buffer, length) => {
      writeExactDescriptor(storage, openedDestination, buffer, length);
    });
    const sourceAfter = storage.fstatSync(source.descriptor, { bigint: true });
    const coherence =
      !hashed.overrun &&
      hashed.bytesConsumed === expectedSize &&
      source.evidence.sizeBytes === expectedSize &&
      source.evidence.mtimeMs === source.mtimeMs &&
      sameEvidenceFileStat(sourceOpened, sourceAfter)
        ? 'coherent'
        : 'torn';

    storage.fdatasyncSync(destinationDescriptor);
    const destinationOpened = storage.fstatSync(destinationDescriptor, { bigint: true });
    if (!destinationOpened.isFile() || destinationOpened.size !== BigInt(hashed.bytesConsumed)) {
      throw new Error('Published store-reset evidence has an unexpected size.');
    }
    result = {
      evidence: {
        name: source.evidence.name,
        sizeBytes: hashed.bytesConsumed,
        mtimeMs: source.mtimeMs,
        sha256: hashed.sha256,
      },
      sourceIdentity: sourceOpened,
      coherence,
    };
  } finally {
    if (destinationDescriptor !== null) {
      try {
        storage.closeSync(destinationDescriptor);
      } catch {
        closeFailure = true;
      }
    }
    try {
      source.close();
    } catch {
      closeFailure = true;
    }
    if (result === null || closeFailure) {
      try {
        storage.unlinkSync(destination);
      } catch {
        // The primary publication failure remains authoritative.
      }
    }
  }
  if (closeFailure || result === null) {
    throw new Error('Store-reset publication descriptors could not be closed safely.');
  }
  const destinationAfter = stablePathStat(storage, destination);
  if (
    destinationAfter.size !== BigInt(result.evidence.sizeBytes) ||
    !evidenceMatches(storage, { source: destination, name: source.evidence.name }, result.evidence)
  ) {
    throw new Error('Published store-reset evidence failed stable verification.');
  }
  return result;
}

function readManifestBounded(storage: StoragePort, path: string): Buffer {
  const pathBefore = stablePathStat(storage, path);
  if (pathBefore.size < 0n || pathBefore.size > BigInt(MAX_RESET_MANIFEST_BYTES)) {
    throw new Error('Interrupted store-reset manifest exceeds its byte limit.');
  }
  const descriptor = storage.openSync(path, 'r');
  let contents: Buffer;
  let closeFailure: unknown = null;
  try {
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!sameEvidenceFileStat(pathBefore, opened)) {
      throw new Error('Interrupted store-reset manifest identity changed.');
    }
    const expectedSize = Number(opened.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const read = storage.readSync(descriptor, bytes, offset, expectedSize - offset, null);
      if (read <= 0 || read > expectedSize - offset) {
        throw new Error('Interrupted store-reset manifest read failed.');
      }
      offset += read;
    }
    const probe = Buffer.allocUnsafe(1);
    if (storage.readSync(descriptor, probe, 0, 1, null) !== 0) {
      throw new Error('Interrupted store-reset manifest grew during reading.');
    }
    const openedAfter = storage.fstatSync(descriptor, { bigint: true });
    const pathAfter = stablePathStat(storage, path);
    if (!sameEvidenceFileStat(opened, openedAfter) || !sameEvidenceFileStat(opened, pathAfter)) {
      throw new Error('Interrupted store-reset manifest identity changed.');
    }
    contents = bytes;
  } finally {
    try {
      storage.closeSync(descriptor);
    } catch (error: unknown) {
      closeFailure = error;
    }
  }
  if (closeFailure !== null) {
    throw new Error('Interrupted store-reset manifest descriptor could not be closed safely.');
  }
  return contents;
}

function ensureQuarantineRoot(storage: StoragePort, root: string, platform: string): void {
  if (!storage.existsSync(root)) {
    storage.mkdirSync(root);
    if (platform !== 'win32') {
      storage.chmodSync(root, 0o700);
    }
  }
  assertQuarantineRoot(storage, root);
}

function ensurePrivateDirectory(storage: StoragePort, path: string, platform: string): void {
  if (!storage.existsSync(path)) {
    storage.mkdirSync(path);
    if (platform !== 'win32') {
      storage.chmodSync(path, 0o700);
    }
  }
  assertPrivateDirectory(storage, path, platform);
}

function createPrivateOperationDirectory(
  storage: StoragePort,
  parent: string,
  path: string,
  platform: string,
  onCreated: () => void = () => undefined,
): StorageBigIntStat {
  storage.mkdirSync(path);
  onCreated();
  if (platform !== 'win32') storage.chmodSync(path, 0o700);
  requireDirectorySync(storage, parent);
  return assertContainedDirectory(storage, parent, path);
}

export type BackendStoreClassificationSnapshot = Readonly<{
  path: string;
  evidence: readonly ActiveEvidence[];
  release(): void;
}>;

export function stageBackendStoreClassification(
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage'>,
  files: BackendStoreFileSet,
): BackendStoreClassificationSnapshot {
  const { dbFile } = files;
  for (;;) {
    const evidence = enumerateActiveEvidence(runtime.storage, files);
    const database = evidence.find((item) => item.name === 'store.db');
    if (database === undefined) return { path: dbFile, evidence, release: () => undefined };

    const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
    const mintedRoot = join(quarantineRoot, STORE_RESET_MINTED_DIRECTORY);
    const quarantineExisted = runtime.storage.existsSync(quarantineRoot);
    const mintedExisted = runtime.storage.existsSync(mintedRoot);
    ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
    ensurePrivateDirectory(runtime.storage, mintedRoot, runtime.env.platform());
    requireDirectorySync(runtime.storage, quarantineRoot);
    const snapshotDirectory = join(mintedRoot, runtime.ids.uuid());
    createPrivateOperationDirectory(runtime.storage, mintedRoot, snapshotDirectory, runtime.env.platform());
    const removeSnapshot = (): void => {
      runtime.storage.rmSync(snapshotDirectory, { recursive: true });
      requireDirectorySync(runtime.storage, mintedRoot);
      if (!mintedExisted) {
        runtime.storage.rmdirSync(mintedRoot);
        requireDirectorySync(runtime.storage, quarantineRoot);
      }
      if (!quarantineExisted) {
        runtime.storage.rmdirSync(quarantineRoot);
        requireDirectorySync(runtime.storage, files.dbDir);
      }
    };

    let retry = false;
    try {
      for (const item of evidence) {
        const opened = openActiveEvidence(runtime.storage, files, item);
        if (opened.kind === 'absent' || opened.kind === 'changed') {
          retry = true;
          break;
        }
        if (opened.kind === 'undeterminable') throw new Error(opened.cause);
        copyActiveEvidenceForPublication(runtime.storage, opened.source, join(snapshotDirectory, item.name));
      }
      if (retry) {
        removeSnapshot();
        continue;
      }
      requireDirectorySync(runtime.storage, snapshotDirectory);
      let released = false;
      return {
        path: join(snapshotDirectory, 'store.db'),
        evidence,
        release: () => {
          if (released) return;
          released = true;
          removeSnapshot();
        },
      };
    } catch (error: unknown) {
      if (!retry) {
        try {
          removeSnapshot();
        } catch {
          // The classification failure remains authoritative; recovery retains any surviving snapshot.
        }
      }
      throw error;
    }
  }
}

function createParkingOperation(
  runtime: Pick<Runtime, 'env' | 'storage' | 'time'>,
  parkingRoot: string,
  parkingId: string,
  record: Omit<StoreResetParkedRecord, 'version' | 'parkingId' | 'parkedAt'>,
  onCreated?: () => void,
): { readonly directory: string; readonly record: StoreResetParkedRecord } {
  const parkingDirectory = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
  createPrivateOperationDirectory(runtime.storage, parkingRoot, parkingDirectory, runtime.env.platform(), onCreated);
  const parkedRecord: StoreResetParkedRecord = {
    version: 1,
    parkingId,
    parkedAt: new Date(runtime.time.now()).toISOString(),
    ...record,
  };
  writeStoreResetParkedRecord(runtime.storage, parkingRoot, parkedRecord, STORE_RESET_IN_FLIGHT_DIRECTORY);
  return { directory: parkingDirectory, record: parkedRecord };
}

function removeSettledParkingDirectory(
  storage: StoragePort,
  parkingRoot: string,
  parkingDirectory: string,
  record: StoreResetParkedRecord,
  coordinate: string,
): boolean {
  storage.unlinkSync(join(parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME));
  try {
    storage.rmdirSync(parkingDirectory);
    requireDirectorySync(storage, parkingRoot);
    return true;
  } catch (error: unknown) {
    writeStoreResetParkedRecord(storage, parkingRoot, record, coordinate);
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

function assertPrivateDirectory(storage: StoragePort, path: string, platform: string): void {
  const link = storage.lstatSync(path);
  const stat = storage.statSync(path, { bigint: true });
  if (
    !link.isDirectory() ||
    link.isSymbolicLink() ||
    !stat.isDirectory() ||
    (platform !== 'win32' && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error('Store-reset staging path is not a private directory.');
  }
}

function requireSameDirectory(storage: StoragePort, path: string, expected: StorageBigIntStat): void {
  const actual = assertContainedDirectory(storage, dirname(path), path);
  if (!actual.isDirectory() || !expected.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('Interrupted store-reset staging directory identity changed.');
  }
}

function requireStoreResetDurability(proven: boolean, failure: string): void {
  if (!proven) throw new Error(failure);
}

function requireDirectorySync(storage: StoragePort, ...directories: readonly string[]): void {
  for (const directory of new Set(directories)) {
    requireStoreResetDurability(
      storage.syncDirectoryDurableSync(directory),
      'Store-reset directory metadata could not be synchronized.',
    );
  }
}

function evidenceMatches<Name extends string>(
  storage: StoragePort,
  candidate: EvidenceFileCandidate<Name>,
  expected: PublishedEvidenceFile<Name>,
): boolean {
  if (!storage.existsSync(candidate.source)) return false;
  const actual = describeCandidate(storage, candidate, null);
  return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256;
}

function validateStagingEntries(
  storage: StoragePort,
  stagingDirectory: string,
  manifest: StoreResetIncidentManifest,
  requireComplete: boolean,
): void {
  const read = storage.readDirectoryBoundedSync(stagingDirectory, MAX_INCIDENT_DIR_ENTRIES + 1);
  if (read.overflow) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_ambiguous');
  }
  const expected = new Set<string>([STORE_RESET_MANIFEST_FILE_NAME, ...manifest.files.map((file) => file.name)]);
  const allowed = new Set([...expected, `${STORE_RESET_MANIFEST_FILE_NAME}.tmp`]);
  if (read.entries.some((entry) => !allowed.has(entry))) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign');
  }
  if (requireComplete && [...expected].some((entry) => !read.entries.includes(entry))) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_malformed');
  }
}

function removeAtomicManifestTemp(storage: StoragePort, stagingDirectory: string): void {
  try {
    storage.unlinkSync(join(stagingDirectory, `${STORE_RESET_MANIFEST_FILE_NAME}.tmp`));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
  requireDirectorySync(storage, stagingDirectory);
}

function discardUncommittedStaging(storage: StoragePort, stagingDirectory: string, stagingRoot: string): void {
  const read = storage.readDirectoryBoundedSync(stagingDirectory, MAX_INCIDENT_DIR_ENTRIES);
  if (read.overflow) throw new Error('Interrupted store-reset staging directory exceeds its entry limit.');
  const preManifestNames = new Set<string>([
    `${STORE_RESET_MANIFEST_FILE_NAME}.tmp`,
    ...STORE_RESET_EVIDENCE_FILE_NAMES,
  ]);
  if (read.entries.some((entry) => !preManifestNames.has(entry))) {
    throw new Error('Interrupted store-reset publication has unexpected pre-manifest content.');
  }
  storage.rmSync(stagingDirectory, { recursive: true, force: true });
  requireDirectorySync(storage, stagingRoot);
}

type StagedEvidenceIntegrity =
  | { readonly kind: 'intact' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'undeterminable'; readonly cause: string };

function stagedEvidenceIntegrity(
  storage: StoragePort,
  staged: EvidenceFileCandidate<StoreResetEvidenceFileName>,
  expected: StoreResetIncidentFile,
): StagedEvidenceIntegrity {
  try {
    return evidenceMatches(storage, staged, expected) ? { kind: 'intact' } : { kind: 'corrupt' };
  } catch (error: unknown) {
    return { kind: 'undeterminable', cause: error instanceof Error ? error.message : String(error) };
  }
}

function requireIntactStagedEvidence(
  storage: StoragePort,
  stagingDirectory: string,
  manifest: StoreResetIncidentManifest,
): void {
  for (const expected of manifest.files) {
    const staged = { source: join(stagingDirectory, expected.name), name: expected.name };
    const integrity = stagedEvidenceIntegrity(storage, staged, expected);
    switch (integrity.kind) {
      case 'intact':
        break;
      case 'corrupt':
        throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched');
      case 'undeterminable':
        throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched', new Error(integrity.cause));
      default:
        assertNever(integrity);
    }
  }
}

function pendingActiveEvidence(
  ledger: StoreResetRetentionLedger | null,
  incidentId: string,
  parkedRecord: StoreResetParkedRecord | null,
): readonly ActiveEvidence[] {
  const transaction = parkedRecord?.transaction;
  if (transaction?.kind === 'publication' && transaction.incidentId === incidentId) {
    return transaction.identities.map((identity) => ({
      name: identity.name,
      identity: { dev: BigInt(identity.dev), ino: BigInt(identity.ino) },
      sizeBytes: 0,
      mtimeMs: 0,
    }));
  }
  const pending = ledger?.pending;
  if (
    pending === null ||
    pending === undefined ||
    pending.outcome.kind !== 'preserve' ||
    pending.outcome.incident.incidentId !== incidentId
  ) {
    return [];
  }
  return pending.identities.map((identity) => ({
    name: identity.name,
    identity: { dev: BigInt(identity.dev), ino: BigInt(identity.ino) },
    sizeBytes: 0,
    mtimeMs: 0,
  }));
}

function settleResumedParking(
  storage: StoragePort,
  files: BackendStoreFileSet,
  parkingDirectory: string,
  stagingDirectory: string,
  manifest: StoreResetIncidentManifest,
  parked: readonly ParkedActiveEvidence[],
): readonly StoreResetEvidenceFileName[] {
  const expected = new Map(manifest.files.map((file) => [file.name, file]));
  const leftActive: StoreResetEvidenceFileName[] = [];
  for (const item of parked) {
    const file = expected.get(item.evidence.name);
    const parkingCandidate = { source: join(parkingDirectory, item.evidence.name), name: item.evidence.name };
    const stagedPath = join(stagingDirectory, item.evidence.name);
    let ours = false;
    if (item.ownership === 'ours' && file !== undefined) {
      const parkedStat = stablePathStat(storage, parkingCandidate.source);
      const stagedStat = stablePathStat(storage, stagedPath);
      ours =
        (parkedStat.dev === stagedStat.dev && parkedStat.ino === stagedStat.ino) ||
        evidenceMatches(storage, parkingCandidate, file);
    }
    if (ours) {
      dropParkedEvidence(storage, parkingDirectory, item);
      requireDirectorySync(storage, parkingDirectory);
      continue;
    }
    const restored = restoreParkedEvidence(storage, files, parkingDirectory, item);
    leftActive.push(item.evidence.name);
    if (restored.kind === 'restored') requireDirectorySync(storage, files.dbDir, parkingDirectory);
  }
  return leftActive;
}

function restoreUncommittedParking(
  storage: StoragePort,
  files: BackendStoreFileSet,
  parkingDirectory: string,
  parked: readonly ParkedActiveEvidence[],
): readonly StoreResetEvidenceFileName[] {
  const kept: StoreResetEvidenceFileName[] = [];
  for (const item of parked) {
    const restored = restoreParkedEvidence(storage, files, parkingDirectory, item);
    if (restored.kind === 'kept') kept.push(item.evidence.name);
    else requireDirectorySync(storage, files.dbDir, parkingDirectory);
  }
  return kept;
}

function restageEvidenceAsCopies(
  storage: StoragePort,
  stagingDirectory: string,
  parkingDirectory: string,
  manifest: StoreResetIncidentManifest,
  tolerateMutableLinks = false,
): readonly PublishedEvidenceFile<StoreResetEvidenceFileName>[] {
  const files: PublishedEvidenceFile<StoreResetEvidenceFileName>[] = [];
  for (const expected of manifest.files) {
    const stagedPath = join(stagingDirectory, expected.name);
    const restagedPath = join(parkingDirectory, `${expected.name}.restage`);
    storage.rmSync(restagedPath, { force: true });
    const copied = copyPathCandidateForPublication(
      storage,
      { source: stagedPath, name: expected.name },
      restagedPath,
      null,
    );
    const matchesManifest =
      copied.coherence === 'coherent' &&
      copied.evidence.sizeBytes === expected.sizeBytes &&
      copied.evidence.sha256 === expected.sha256;
    if (!matchesManifest && !tolerateMutableLinks) {
      throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched');
    }
    storage.renameSync(restagedPath, stagedPath);
    requireDirectorySync(storage, stagingDirectory, parkingDirectory);
    files.push(copied.evidence);
  }
  return files;
}

function validatedParkingDirectoryExists(
  storage: StoragePort,
  quarantineRoot: string,
  parkingRoot: string,
  parkingDirectory: string,
): boolean {
  try {
    const root = storage.lstatSync(parkingRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Store-reset parking root is unsafe.');
    assertContainedDirectory(storage, quarantineRoot, parkingRoot);
    const operation = storage.lstatSync(parkingDirectory);
    if (!operation.isDirectory() || operation.isSymbolicLink()) {
      throw new Error('Store-reset parking operation is unsafe.');
    }
    assertContainedDirectory(storage, parkingRoot, parkingDirectory);
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

function stagingUsesLinkedIdentities(
  storage: StoragePort,
  stagingDirectory: string,
  manifest: StoreResetIncidentManifest,
  pending: StoreResetRetentionPending | null,
): boolean {
  if (pending === null) return false;
  const identities = new Map(pending.identities.map((identity) => [identity.name, identity]));
  return manifest.files.every((file) => {
    const identity = identities.get(file.name);
    if (identity === undefined) return false;
    const stat = stablePathStat(storage, join(stagingDirectory, file.name));
    return stat.dev === BigInt(identity.dev) && stat.ino === BigInt(identity.ino);
  });
}

function resumeInterruptedIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
  writerExclusion: WriterExclusion,
  authorizeCommittedManifest?: (manifest: StoreResetIncidentManifest) => void,
): {
  readonly incident: BackendStoreResetIncident;
  readonly manifest: StoreResetIncidentManifest;
  readonly leftActive: readonly StoreResetEvidenceFileName[];
} | null {
  resumeNonPublicationParking(runtime, files, options);
  const interrupted = detectInterruptedIncident(runtime, files);
  if (interrupted === null) return null;
  if (writerExclusion.kind === 'proven') writerExclusion.lease.assertOwned();
  let ledger = readStoreResetRetentionLedger(runtime.storage, interrupted.quarantineRoot);
  const parkingRoot = join(interrupted.quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const matchingParking = discoverStoreResetParkedRecords(runtime.storage, interrupted.quarantineRoot).entries.find(
    (entry) =>
      entry.coordinate === STORE_RESET_IN_FLIGHT_DIRECTORY ||
      entry.record?.parkingId === interrupted.incidentId ||
      entry.record?.incidentId === interrupted.incidentId,
  );
  let parkingCoordinate = interrupted.parkingCoordinate ?? matchingParking?.coordinate ?? interrupted.incidentId;
  let parkingDirectory = join(parkingRoot, parkingCoordinate);
  let parkingExists = validatedParkingDirectoryExists(
    runtime.storage,
    interrupted.quarantineRoot,
    parkingRoot,
    parkingDirectory,
  );
  const parkedRecord = parkingExists
    ? readStoreResetParkedRecord(runtime.storage, parkingRoot, interrupted.incidentId, parkingCoordinate)
    : null;
  const pendingEvidence = pendingActiveEvidence(ledger, interrupted.incidentId, parkedRecord);
  const parkedRead = parkingExists ? readParkedEvidence(runtime.storage, parkingDirectory, pendingEvidence) : null;
  if (interrupted.manifest === null && parkedRecord?.phase === 'terminal') {
    discardUncommittedStaging(runtime.storage, interrupted.stagingDirectory, interrupted.stagingRoot);
    if (ledger !== null) clearStoreResetPending(runtime.storage, interrupted.quarantineRoot, ledger);
    return null;
  }
  if (parkedRead?.kind === 'unexpected') {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign');
  }
  let parked = parkedRead?.parked ?? [];
  if (interrupted.manifest === null) {
    restoreUncommittedParking(runtime.storage, files, parkingDirectory, parked);
    if (parkingExists && parkedRecord !== null) {
      terminalizeParking(runtime.storage, parkingRoot, parkedRecord, 'intruder', null, parkingCoordinate);
    }
    discardUncommittedStaging(runtime.storage, interrupted.stagingDirectory, interrupted.stagingRoot);
    if (ledger !== null) clearStoreResetPending(runtime.storage, interrupted.quarantineRoot, ledger);
    return null;
  }

  let parkingLeftActive: readonly StoreResetEvidenceFileName[] = [];

  let manifest = interrupted.manifest;
  const { quarantineRoot, stagingDirectory, stagingIdentity, stagingRoot } = interrupted;
  authorizeCommittedManifest?.(manifest);
  if (pendingEvidence.length === 0 && parked.length === 0) {
    const recordedNames = new Set(manifest.files.map((file) => file.name));
    const legacyActive = enumerateActiveEvidence(runtime.storage, files).filter((item) => recordedNames.has(item.name));
    if (legacyActive.length > 0) {
      if (!runtime.storage.existsSync(parkingRoot)) {
        ensurePrivateDirectory(runtime.storage, parkingRoot, runtime.env.platform());
        requireDirectorySync(runtime.storage, quarantineRoot);
      }
      if (!parkingExists) {
        parkingCoordinate = STORE_RESET_IN_FLIGHT_DIRECTORY;
        parkingDirectory = join(parkingRoot, parkingCoordinate);
        createPrivateOperationDirectory(runtime.storage, parkingRoot, parkingDirectory, runtime.env.platform());
        writeStoreResetParkedRecord(
          runtime.storage,
          parkingRoot,
          {
            version: 1,
            parkingId: interrupted.incidentId,
            parkedAt: manifest.resetAt,
            phase: 'in-flight',
            cause: 'publication',
            incidentId: interrupted.incidentId,
            names: [],
            entries: [],
            transaction: {
              kind: 'publication',
              incidentId: interrupted.incidentId,
              identities: pendingIdentities(legacyActive),
            },
            classification: null,
          },
          parkingCoordinate,
        );
        parkingExists = true;
      }
      const slot = resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot);
      ledger = recordStoreResetPending(runtime.storage, quarantineRoot, slot.ledger, {
        resetAt: manifest.resetAt,
        identities: pendingIdentities(legacyActive),
        outcome: {
          kind: 'preserve',
          incident: {
            incidentId: manifest.incidentId,
            resetAt: manifest.resetAt,
            evidenceBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
            preservation: { kind: 'linked', coherence: 'coherent' },
            resumeLeftActive: false,
          },
        },
      });
      parked = parkIncidentEvidence(runtime.storage, files, legacyActive, parkingDirectory, 'coherent').parked;
    }
  }
  if (parkingExists && pendingEvidence.length > 0) {
    const parkedNames = new Set(parked.map((item) => item.evidence.name));
    const remaining = pendingEvidence.filter((item) => !parkedNames.has(item.name));
    const resumedParking = parkIncidentEvidence(runtime.storage, files, remaining, parkingDirectory, 'coherent');
    parked = [...parked, ...resumedParking.parked];
    parkingLeftActive = resumedParking.leftActive;
  }
  const pending = ledger?.pending ?? null;
  const linkedStaging = stagingUsesLinkedIdentities(runtime.storage, stagingDirectory, manifest, pending);
  const describedAsLinked =
    pending?.outcome.kind === 'preserve' && pending.outcome.incident.preservation?.kind === 'linked';
  const mutableLinkedEvidence = linkedStaging || describedAsLinked;
  if (mutableLinkedEvidence || (!interrupted.committed && writerExclusion.kind === 'unproven')) {
    if (!runtime.storage.existsSync(parkingRoot)) {
      ensurePrivateDirectory(runtime.storage, parkingRoot, runtime.env.platform());
      requireDirectorySync(runtime.storage, quarantineRoot);
    }
    if (!parkingExists) {
      createPrivateOperationDirectory(runtime.storage, parkingRoot, parkingDirectory, runtime.env.platform());
      parkingExists = true;
    }
    if (pending?.outcome.kind === 'preserve' && ledger !== null) {
      const cause: Extract<PreservationMechanism, { readonly kind: 'copied' }>['cause'] =
        writerExclusion.kind === 'unproven'
          ? { kind: 'exclusion-unproven', reason: writerExclusion.reason }
          : pending.outcome.incident.preservation?.kind === 'copied'
            ? pending.outcome.incident.preservation.cause
            : { kind: 'link-unsupported', errno: 'other', code: 'RESTAGED_AFTER_CRASH' };
      const coherence = mutableLinkedEvidence ? 'torn' : 'coherent';
      const copiedPreservation: PreservationMechanism =
        cause.kind === 'exclusion-unproven'
          ? { kind: 'copied', cause, coherence }
          : { kind: 'copied', cause, coherence };
      recordStoreResetPending(runtime.storage, quarantineRoot, ledger, {
        ...pending,
        outcome: {
          ...pending.outcome,
          incident: {
            ...pending.outcome.incident,
            preservation: copiedPreservation,
          },
        },
      });
    }
    const restagedFiles = restageEvidenceAsCopies(
      runtime.storage,
      stagingDirectory,
      parkingDirectory,
      manifest,
      mutableLinkedEvidence,
    );
    if (mutableLinkedEvidence) {
      manifest = { ...manifest, files: restagedFiles };
      const rewritten = runtime.storage.writeAtomicDurableSync(
        join(stagingDirectory, STORE_RESET_MANIFEST_FILE_NAME),
        serializeStoreResetIncidentManifest(manifest),
        { encoding: 'utf-8', mode: 0o600 },
      );
      if (!rewritten) throw new Error('Mutable linked evidence could not be described durably.');
      requireDirectorySync(runtime.storage, stagingDirectory);
    }
  }

  requireIntactStagedEvidence(runtime.storage, stagingDirectory, manifest);
  validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
  removeAtomicManifestTemp(runtime.storage, stagingDirectory);
  requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
  if (!interrupted.committed) {
    runtime.storage.renameSync(stagingDirectory, join(quarantineRoot, manifest.incidentId));
    requireDirectorySync(runtime.storage, quarantineRoot, stagingRoot);
  }
  const settledLeftActive = parkingExists
    ? settleResumedParking(
        runtime.storage,
        files,
        parkingDirectory,
        join(quarantineRoot, manifest.incidentId),
        manifest,
        parked,
      )
    : [];
  const leftActive = [...new Set([...parkingLeftActive, ...settledLeftActive])];
  if (parkingExists) {
    terminalizeParking(
      runtime.storage,
      parkingRoot,
      parkedRecord ?? {
        version: 1,
        parkingId: interrupted.incidentId,
        parkedAt: manifest.resetAt,
        phase: 'terminal',
        cause: 'intruder',
        incidentId: manifest.incidentId,
        names: [],
        entries: [],
        transaction: null,
        classification: null,
      },
      'intruder',
      manifest.incidentId,
      parkingCoordinate,
    );
  }
  const retentionSlot = resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot);
  recordStoreResetResumeLeftActive(
    runtime.storage,
    quarantineRoot,
    retentionSlot.ledger,
    manifest.incidentId,
    leftActive,
  );
  if (leftActive.length > 0) {
    writeAuditEvent('store_reset_resume_left_active', { incidentId: manifest.incidentId, files: leftActive }, 'warn');
  }
  return {
    incident: {
      incidentId: manifest.incidentId,
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      schemaVersion: manifest.schemaVersion,
      resetPolicyCause:
        manifest.schemaVersion === STORE_RESET_INCIDENT_SCHEMA_VERSION ? manifest.resetPolicyCause : null,
      fileCount: manifest.files.length,
    },
    manifest,
    leftActive,
  };
}

type InterruptedIncident = {
  readonly incidentId: string;
  readonly manifest: StoreResetIncidentManifest | null;
  readonly quarantineRoot: string;
  readonly stagingDirectory: string;
  readonly stagingIdentity: StorageBigIntStat;
  readonly stagingRoot: string;
  readonly committed: boolean;
  readonly parkingCoordinate: string | null;
};

function detectInterruptedIncident(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: BackendStoreFileSet,
): InterruptedIncident | null {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  if (!runtime.storage.existsSync(quarantineRoot)) return null;
  try {
    assertQuarantineRoot(runtime.storage, quarantineRoot);
  } catch (error: unknown) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign', error);
  }
  const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
  let stagingName: string | null = null;
  if (runtime.storage.existsSync(stagingRoot)) {
    try {
      assertPrivateDirectory(runtime.storage, stagingRoot, runtime.env.platform());
    } catch (error: unknown) {
      throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign', error);
    }
    const stagingRead = runtime.storage.readDirectoryBoundedSync(stagingRoot, 1);
    if (stagingRead.overflow) {
      throw new InterruptedStoreResetRefusal('store_reset_interrupted_ambiguous');
    }
    const stagingNames = stagingRead.entries.filter(isCanonicalStoreResetIncidentId);
    if (stagingNames.length !== stagingRead.entries.length) {
      throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign');
    }
    stagingName = stagingNames[0] ?? null;
  }
  let committed = false;
  let parkingCoordinate: string | null = null;
  if (stagingName === null) {
    const parked = discoverStoreResetParkedRecords(runtime.storage, quarantineRoot);
    if (parked.truncated) {
      writeAuditEvent('store_reset_parking_scan_truncated', { disposition: 'terminal-evidence-deferred' }, 'warn');
    }
    const transactions = parked.entries.filter(
      (entry) => entry.record?.phase === 'in-flight' && entry.record.transaction?.kind === 'publication',
    );
    if (transactions.length > 1) throw new InterruptedStoreResetRefusal('store_reset_interrupted_ambiguous');
    const transactionEntry = transactions[0];
    const transaction = transactionEntry?.record?.transaction;
    stagingName = transaction?.kind === 'publication' ? transaction.incidentId : null;
    committed = stagingName !== null;
    parkingCoordinate = committed ? (transactionEntry?.coordinate ?? null) : null;
  }
  if (stagingName === null) return null;

  const stagingDirectory = committed ? join(quarantineRoot, stagingName) : join(stagingRoot, stagingName);
  let stagingIdentity: StorageBigIntStat;
  try {
    stagingIdentity = assertContainedDirectory(
      runtime.storage,
      committed ? quarantineRoot : stagingRoot,
      stagingDirectory,
    );
  } catch (error: unknown) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign', error);
  }
  const manifestPath = join(stagingDirectory, STORE_RESET_MANIFEST_FILE_NAME);
  if (!runtime.storage.existsSync(manifestPath)) {
    return {
      incidentId: stagingName,
      manifest: null,
      quarantineRoot,
      stagingDirectory,
      stagingIdentity,
      stagingRoot,
      committed,
      parkingCoordinate,
    };
  }
  let manifest: StoreResetIncidentManifest;
  try {
    manifest = parseStoreResetIncidentManifest(readManifestBounded(runtime.storage, manifestPath));
  } catch (error: unknown) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_malformed', error);
  }
  if (manifest.incidentId !== stagingName) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched');
  }
  validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
  return {
    incidentId: manifest.incidentId,
    manifest,
    quarantineRoot,
    stagingDirectory,
    stagingIdentity,
    stagingRoot,
    committed,
    parkingCoordinate,
  };
}

export function hasPendingBackendStoreResetIncident(
  runtime: Pick<Runtime, 'storage'>,
  files: BackendStoreFileSet,
): boolean {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
  if (runtime.storage.existsSync(stagingRoot)) {
    const read = runtime.storage.readDirectoryBoundedSync(stagingRoot, 1);
    if (read.overflow || read.entries.length > 0) return true;
  }
  const mintedRoot = join(quarantineRoot, STORE_RESET_MINTED_DIRECTORY);
  if (runtime.storage.existsSync(mintedRoot)) {
    try {
      const read = runtime.storage.readDirectoryBoundedSync(mintedRoot, 1);
      if (read.overflow || read.entries.length > 0) return true;
    } catch {
      return true;
    }
  }
  const fixedParkingCoordinate = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY, STORE_RESET_IN_FLIGHT_DIRECTORY);
  try {
    runtime.storage.lstatSync(fixedParkingCoordinate);
    return true;
  } catch (error: unknown) {
    if (!isNoEntryError(error)) throw error;
  }
  const ledger = readStoreResetRetentionLedger(runtime.storage, quarantineRoot);
  if (ledger?.pending !== null && ledger?.pending !== undefined) return true;
  try {
    const discovered = discoverStoreResetParkedRecords(runtime.storage, quarantineRoot);
    if (discovered.entries.some((entry) => entry.record?.phase === 'in-flight')) return true;
    const terminal = discovered.entries.filter(
      (entry) => isCanonicalStoreResetIncidentId(entry.coordinate) && entry.record?.phase === 'terminal',
    );
    if (terminal.length === 0) return false;
    if (discovered.truncated || terminal.length > 1 || (ledger !== null && ledger.preserved !== null)) return true;
    const incidentRead = runtime.storage.readDirectoryBoundedSync(quarantineRoot, MAX_INCIDENT_ROOT_ENTRIES);
    return incidentRead.entries.some(isCanonicalStoreResetIncidentId);
  } catch {
    return true;
  }
}

type PublishedIncidentEvidence = Readonly<{
  published: readonly Readonly<{ active: ActiveEvidence; file: StoreResetIncidentFile }>[];
  coherence: 'coherent' | 'torn';
  leftActive: readonly StoreResetEvidenceFileName[];
}>;

class StoreResetEvidenceMutation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreResetEvidenceMutation';
  }
}

function copyIncidentEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  activeEvidence: readonly ActiveEvidence[],
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
  initialCoherence: PublishedIncidentEvidence['coherence'],
): PublishedIncidentEvidence {
  let coherence = initialCoherence;
  const published: Array<{ active: ActiveEvidence; file: StoreResetIncidentFile }> = [];
  const leftActive: StoreResetEvidenceFileName[] = [];
  for (const active of activeEvidence) {
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    const opened = openActiveEvidence(storage, files, active);
    if (opened.kind !== 'opened') {
      leftActive.push(active.name);
      coherence = 'torn';
      continue;
    }
    const copied = copyActiveEvidenceForPublication(storage, opened.source, join(stagingDirectory, active.name));
    if (copied.coherence === 'torn') coherence = 'torn';
    published.push({ active, file: copied.evidence });
  }
  return { published, coherence, leftActive };
}

type ParkedEvidenceBatch = Readonly<{
  parked: readonly ParkedActiveEvidence[];
  leftActive: readonly StoreResetEvidenceFileName[];
  coherence: PublishedIncidentEvidence['coherence'];
}>;

function parkIncidentEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  evidence: readonly ActiveEvidence[],
  parkingDirectory: string,
  initialCoherence: PublishedIncidentEvidence['coherence'],
): ParkedEvidenceBatch {
  const parked: ParkedActiveEvidence[] = [];
  const leftActive: StoreResetEvidenceFileName[] = [];
  let coherence = initialCoherence;
  for (const active of evidence) {
    const result = parkActiveEvidence(storage, files, active, parkingDirectory);
    if (result.kind === 'parked') {
      parked.push(result.parked);
      requireDirectorySync(storage, files.dbDir, parkingDirectory);
      if (
        result.parked.ownership === 'other' ||
        result.parked.evidence.sizeBytes !== active.sizeBytes ||
        result.parked.evidence.mtimeMs !== active.mtimeMs
      ) {
        coherence = 'torn';
      }
      continue;
    }
    leftActive.push(active.name);
    coherence = 'torn';
  }
  return { parked, leftActive, coherence };
}

function settleParkedEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  parkingDirectory: string,
  parked: readonly ParkedActiveEvidence[],
  droppableNames: ReadonlySet<StoreResetEvidenceFileName>,
): readonly StoreResetEvidenceFileName[] {
  const leftActive: StoreResetEvidenceFileName[] = [];
  for (const item of parked) {
    if (item.ownership === 'ours' && droppableNames.has(item.evidence.name)) {
      dropParkedEvidence(storage, parkingDirectory, item);
      requireDirectorySync(storage, parkingDirectory);
      continue;
    }
    const restored = restoreParkedEvidence(storage, files, parkingDirectory, item);
    leftActive.push(item.evidence.name);
    if (restored.kind === 'restored') requireDirectorySync(storage, files.dbDir, parkingDirectory);
  }
  return leftActive;
}

function createIncidentManifest(
  runtime: Pick<Runtime, 'env'>,
  authority: BackendStoreResetAuthority,
  classification: BackendStoreResetClassification,
  incidentId: string,
  resetAt: string,
  files: readonly StoreResetIncidentFile[],
  newerStorePolicy?: NewerStoreResetPolicy,
): StoreResetIncidentManifest {
  const recordedStoredFingerprint = storedFingerprint(classification);
  const common = {
    incidentId,
    resetAt,
    reason: recordedStoredFingerprint === null ? ('missing' as const) : ('mismatch' as const),
    storedFingerprint: recordedStoredFingerprint,
    expectedFingerprint: classification.currentFingerprint,
    build: {
      version: authority.version,
      buildSetId: authority.buildSetId,
      backendBundleHash: authority.bundleHash,
      flavor: authority.flavor,
    },
    runtime: {
      namespace: authority.namespace,
      nodeVersion: process.version,
      platform: runtime.env.platform() as NodeJS.Platform,
      architecture: runtime.env.arch(),
      processId: runtime.env.pid(),
    },
    handoff: {
      acquiredViaHandoff: authority.acquiredViaHandoff,
    },
    files,
  };

  let resetPolicyCause: StoreResetPolicyCause;
  if (classification.kind === 'newer-incompatible') {
    if (newerStorePolicy === undefined) {
      throw new Error('Newer-store reset policy evidence is required for a V3 incident.');
    }
    resetPolicyCause = newerStorePolicy.cause;
  } else {
    resetPolicyCause = classification.kind;
  }
  return {
    schemaVersion: STORE_RESET_INCIDENT_SCHEMA_VERSION,
    incidentId: common.incidentId,
    resetAt: common.resetAt,
    reason: common.reason,
    storedFingerprint: common.storedFingerprint,
    expectedFingerprint: common.expectedFingerprint,
    resetPolicyCause,
    resetPolicyEvidence: newerStorePolicy?.evidence ?? null,
    target: {
      storeDbPath: authority.storeDbPath,
      flavor: authority.flavor,
    },
    build: common.build,
    runtime: common.runtime,
    handoff: common.handoff,
    files: common.files,
  } satisfies StoreResetIncidentManifestV3;
}

function recordIncidentAudit(manifest: StoreResetIncidentManifest, preservation: PreservationMechanism): void {
  writeAuditEvent(
    'store_reset_quarantine',
    {
      incidentId: manifest.incidentId,
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      incidentSchemaVersion: `v${manifest.schemaVersion}`,
      resetPolicyCause:
        manifest.schemaVersion === STORE_RESET_INCIDENT_SCHEMA_VERSION ? manifest.resetPolicyCause : null,
      storedFingerprint: manifest.storedFingerprint,
      expectedFingerprint: manifest.expectedFingerprint,
      version: manifest.build.version,
      buildSetId: manifest.build.buildSetId,
      flavor: manifest.build.flavor,
      acquiredViaHandoff: manifest.handoff.acquiredViaHandoff,
      fileCount: manifest.files.length,
      preservation,
    },
    'warn',
  );
}

function pendingIdentities(evidence: readonly ActiveEvidence[]): StoreResetRetentionPending['identities'] {
  return evidence.map((active) => ({
    name: active.name,
    dev: active.identity.dev.toString(),
    ino: active.identity.ino.toString(),
  }));
}

function terminalizeParking(
  storage: StoragePort,
  parkingRoot: string,
  record: StoreResetParkedRecord,
  cause: 'intruder' | 'residual',
  incidentId: string | null = record.incidentId,
  coordinate: string = record.parkingId,
): boolean {
  const parkingDirectory = join(parkingRoot, coordinate);
  const names = observedStoreResetEvidenceNames(storage, parkingDirectory);
  const terminalRecord: StoreResetParkedRecord = {
    ...record,
    phase: 'terminal',
    cause,
    incidentId,
    names,
    entries: describeParkedEntries(storage, parkingDirectory, names),
    transaction: null,
  };
  return commitTerminalParking(storage, parkingRoot, terminalRecord, coordinate);
}

function commitTerminalParking(
  storage: StoragePort,
  parkingRoot: string,
  record: StoreResetParkedRecord,
  coordinate: string = record.parkingId,
  sourceRoot: string = parkingRoot,
  populate: () => void = () => undefined,
): boolean {
  const parkingDirectory = join(sourceRoot, coordinate);
  writeStoreResetParkedRecord(storage, sourceRoot, record, coordinate);
  populate();
  if (
    record.names.length === 0 &&
    removeSettledParkingDirectory(storage, sourceRoot, parkingDirectory, record, coordinate)
  ) {
    return false;
  }
  if (sourceRoot !== parkingRoot || coordinate !== record.parkingId) {
    storage.renameSync(parkingDirectory, join(parkingRoot, record.parkingId));
    requireDirectorySync(storage, sourceRoot, parkingRoot);
  }
  requireStoreResetDurability(
    recordStoreResetParked(storage, dirname(parkingRoot), record.parkingId),
    'Store-reset parking retention could not be synchronized durably.',
  );
  return true;
}

function resumeTerminalParkingCommit(
  storage: StoragePort,
  quarantineRoot: string,
  discovered: ReturnType<typeof discoverStoreResetParkedRecords>,
): boolean {
  const pendingIncidentId = readStoreResetRetentionLedger(storage, quarantineRoot)?.pending?.outcome.incident
    .incidentId;
  const newest = discovered.entries
    .flatMap((entry) => {
      const record = entry.record;
      return isCanonicalStoreResetIncidentId(entry.coordinate) &&
        record?.phase === 'terminal' &&
        (pendingIncidentId === undefined || record.incidentId === pendingIncidentId)
        ? [{ coordinate: entry.coordinate, record }]
        : [];
    })
    .sort((left, right) => {
      const byTime = left.record.parkedAt.localeCompare(right.record.parkedAt);
      return byTime === 0 ? left.coordinate.localeCompare(right.coordinate) : byTime;
    })
    .at(-1);
  if (newest === undefined) return false;
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  terminalizeParking(
    storage,
    parkingRoot,
    newest.record,
    newest.record.cause === 'intruder' ? 'intruder' : 'residual',
    newest.record.incidentId,
    newest.coordinate,
  );
  return true;
}

function observedStoreResetEvidenceNames(storage: StoragePort, directory: string): StoreResetEvidenceFileName[] {
  return STORE_RESET_EVIDENCE_FILE_NAMES.filter((name) => {
    try {
      storage.lstatSync(join(directory, name));
      return true;
    } catch (error: unknown) {
      if (isNoEntryError(error)) return false;
      throw error;
    }
  });
}

function retainInterruptedMintedStores(
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage' | 'time'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
): void {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const mintedRoot = join(quarantineRoot, STORE_RESET_MINTED_DIRECTORY);
  if (!runtime.storage.existsSync(mintedRoot)) return;
  ensurePrivateDirectory(runtime.storage, mintedRoot, runtime.env.platform());
  const read = runtime.storage.readDirectoryBoundedSync(mintedRoot, MAX_INCIDENT_ROOT_ENTRIES + 1);
  const fixedMintedPath = join(mintedRoot, STORE_RESET_MINTED_STORE_DIRECTORY);
  const mintedIds = [
    ...(runtime.storage.existsSync(fixedMintedPath) ? [STORE_RESET_MINTED_STORE_DIRECTORY] : []),
    ...read.entries.slice(0, MAX_INCIDENT_ROOT_ENTRIES).filter(isCanonicalStoreResetIncidentId),
  ];
  if (mintedIds.length === 0) return;
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  ensurePrivateDirectory(runtime.storage, parkingRoot, runtime.env.platform());
  requireDirectorySync(runtime.storage, quarantineRoot);
  for (const mintedId of mintedIds) {
    const mintedDirectory = join(mintedRoot, mintedId);
    let mintedStat: StorageBigIntStat;
    try {
      mintedStat = runtime.storage.lstatSync(mintedDirectory, { bigint: true });
    } catch (error: unknown) {
      if (isNoEntryError(error)) continue;
      throw error;
    }
    if (!mintedStat.isDirectory()) continue;
    assertContainedDirectory(runtime.storage, mintedRoot, mintedDirectory);
    const parkingId =
      mintedId === STORE_RESET_MINTED_STORE_DIRECTORY || runtime.storage.existsSync(join(parkingRoot, mintedId))
        ? runtime.ids.uuid()
        : mintedId;
    if (runtime.storage.existsSync(join(parkingRoot, parkingId))) continue;
    const initialNames = observedStoreResetEvidenceNames(runtime.storage, mintedDirectory);
    const initialEntries = describeParkedEntries(runtime.storage, mintedDirectory, initialNames);
    const parkedDb = initialEntries.find((entry) => entry.name === 'store.db');
    const classification =
      parkedDb?.kind === 'regular-file'
        ? classifyParkedStore(runtime, join(mintedDirectory, 'store.db'), options)
        : null;
    const finalNames = observedStoreResetEvidenceNames(runtime.storage, mintedDirectory);
    const finalEntries = describeParkedEntries(runtime.storage, mintedDirectory, finalNames);
    commitTerminalParking(
      runtime.storage,
      parkingRoot,
      terminalParkingRecord(runtime, parkingId, 'residual', finalEntries, classification),
      mintedId,
      mintedRoot,
    );
  }
}

function retireNonResumableFixedParking(
  runtime: Pick<Runtime, 'ids' | 'storage' | 'time'>,
  quarantineRoot: string,
  discovered: ReturnType<typeof discoverStoreResetParkedRecords>,
): boolean {
  const fixed = discovered.entries.find((entry) => entry.coordinate === STORE_RESET_IN_FLIGHT_DIRECTORY);
  if (fixed === undefined) return false;
  if (fixed.state === 'unsafe') return false;
  if (fixed.record?.phase === 'in-flight' && fixed.record.transaction !== null) return false;

  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  let parkingId = fixed.record?.parkingId ?? runtime.ids.uuid();
  while (runtime.storage.existsSync(join(parkingRoot, parkingId))) parkingId = runtime.ids.uuid();
  const baseRecord = fixed.record ?? terminalParkingRecord(runtime, parkingId, 'residual', [], null);
  terminalizeParking(
    runtime.storage,
    parkingRoot,
    { ...baseRecord, parkingId },
    'residual',
    fixed.record?.incidentId ?? null,
    STORE_RESET_IN_FLIGHT_DIRECTORY,
  );
  return true;
}

function resumeNonPublicationParking(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
): void {
  const { dbFile } = files;
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  let discovered = discoverStoreResetParkedRecords(runtime.storage, quarantineRoot);
  resumeTerminalParkingCommit(runtime.storage, quarantineRoot, discovered);
  retainInterruptedMintedStores(runtime, files, options);
  discovered = discoverStoreResetParkedRecords(runtime.storage, quarantineRoot);
  if (discovered.truncated) {
    writeAuditEvent('store_reset_parking_scan_truncated', { disposition: 'terminal-evidence-deferred' }, 'warn');
  }
  if (retireNonResumableFixedParking(runtime, quarantineRoot, discovered)) {
    discovered = discoverStoreResetParkedRecords(runtime.storage, quarantineRoot);
  }
  const inFlight = discovered.entries.filter((entry) => entry.record?.phase === 'in-flight');
  if (inFlight.length > 1) throw new InterruptedStoreResetRefusal('store_reset_interrupted_ambiguous');
  const discoveredTransaction = inFlight[0];
  const record = discoveredTransaction?.record;
  const transaction = record?.transaction;
  if (
    record === undefined ||
    record === null ||
    transaction === undefined ||
    transaction === null ||
    transaction.kind === 'publication'
  ) {
    return;
  }

  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const parkingDirectory = join(parkingRoot, discoveredTransaction.coordinate);
  if (transaction.kind === 'claim') {
    const parked = parkCurrentEvidence(runtime.storage, files, parkingDirectory);
    if (parked.length > 0) requireDirectorySync(runtime.storage, files.dbDir, parkingDirectory);
    const parkedDb = parked.find((item) => item.name === 'store.db');
    const classification =
      parkedDb?.entry.kind === 'regular-file'
        ? classifyParkedStore(runtime, join(parkingDirectory, 'store.db'), options)
        : null;
    if (classification !== null && parkedDb !== undefined) {
      switch (classification.kind) {
        case 'legacy-adoptable':
          if (
            restoreLegacyParkedStore(
              runtime,
              files,
              parkingRoot,
              parkingDirectory,
              record,
              discoveredTransaction.coordinate,
              parked,
              classification,
            )
          ) {
            return refuseLegacyStore(dbFile, classification, options.storeFormat, runtime.flavor);
          }
          break;
        case 'compatible':
        case 'fresh': {
          if (!parkedDatabaseHasPrivateInode(runtime.storage, join(parkingDirectory, 'store.db'), parkedDb.identity)) {
            terminalizeParking(
              runtime.storage,
              parkingRoot,
              { ...record, classification: classification.kind },
              'intruder',
              record.incidentId,
              discoveredTransaction.coordinate,
            );
            return;
          }
          const adoption = openCompatibleParkedStore(
            runtime,
            files,
            options,
            parkingRoot,
            parkingDirectory,
            record,
            discoveredTransaction.coordinate,
            parked,
            classification,
          );
          if (adoption.kind === 'opened') adoption.db.close();
          return;
        }
        case 'absent':
        case 'older-incompatible':
        case 'newer-incompatible':
        case 'corrupt-or-unsupported':
          break;
        default:
          assertNever(classification);
      }
    }
    terminalizeParking(
      runtime.storage,
      parkingRoot,
      record,
      parked.some((item) => item.name === 'store.db') ? 'intruder' : 'residual',
      record.incidentId,
      discoveredTransaction.coordinate,
    );
    return;
  }
}

function publishIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  activeEvidence: readonly ActiveEvidence[],
  classification: BackendStoreResetClassification,
  writerExclusion: WriterExclusion,
  newerStorePolicy?: NewerStoreResetPolicy,
): IncidentPublication {
  const incidentId = runtime.ids.uuid();
  const resetAt = new Date(runtime.time.now()).toISOString();
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
  const stagingDirectory = join(stagingRoot, incidentId);
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const parkingDirectory = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
  const finalDirectory = join(quarantineRoot, incidentId);
  let parkingStarted = false;
  let parkingOwned = false;
  let stagingOwned = false;
  let parkingRecord: StoreResetParkedRecord;
  let pendingLedger: StoreResetRetentionLedger | null = null;

  try {
    if (activeEvidence.length === 0) {
      return { kind: 'no-evidence', leftActive: [] };
    }

    ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
    const slot = resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot);
    ensurePrivateDirectory(runtime.storage, stagingRoot, runtime.env.platform());
    requireDirectorySync(runtime.storage, quarantineRoot);
    runtime.storage.mkdirSync(stagingDirectory);
    stagingOwned = true;
    if (runtime.env.platform() !== 'win32') {
      runtime.storage.chmodSync(stagingDirectory, 0o700);
    }
    requireDirectorySync(runtime.storage, stagingRoot, files.dbDir);
    const stagingIdentity = assertContainedDirectory(runtime.storage, stagingRoot, stagingDirectory);

    const publishedEvidence = copyIncidentEvidence(
      runtime.storage,
      files,
      activeEvidence,
      stagingDirectory,
      stagingIdentity,
      'coherent',
    );
    let preservation: PreservationMechanism =
      writerExclusion.kind === 'proven'
        ? {
            kind: 'copied',
            cause: { kind: 'link-unsupported', errno: 'other', code: 'HARD_LINK_NOT_IMMUTABLE' },
            coherence: publishedEvidence.coherence,
          }
        : {
            kind: 'copied',
            cause: { kind: 'exclusion-unproven', reason: writerExclusion.reason },
            coherence: publishedEvidence.coherence,
          };
    const manifestFiles = publishedEvidence.published.map(({ file }) => file);
    if (manifestFiles.length === 0) {
      runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
      requireDirectorySync(runtime.storage, stagingRoot);
      return { kind: 'no-evidence', leftActive: publishedEvidence.leftActive };
    }
    requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
    requireDirectorySync(runtime.storage, stagingDirectory);
    let retentionIncident: StoreResetRetentionIncident = {
      incidentId,
      resetAt,
      evidenceBytes: manifestFiles.reduce((total, file) => total + file.sizeBytes, 0),
      storedProductVersion: classification.storedProductVersion,
      preservation,
      resumeLeftActive: false,
    };
    ensurePrivateDirectory(runtime.storage, parkingRoot, runtime.env.platform());
    requireDirectorySync(runtime.storage, quarantineRoot);
    parkingRecord = createParkingOperation(
      runtime,
      parkingRoot,
      incidentId,
      {
        phase: 'in-flight',
        cause: 'publication',
        incidentId,
        names: [],
        entries: [],
        transaction: { kind: 'publication', incidentId, identities: pendingIdentities(activeEvidence) },
        classification: classification.kind,
      },
      () => {
        parkingOwned = true;
      },
    ).record;
    pendingLedger = recordStoreResetPending(runtime.storage, quarantineRoot, slot.ledger, {
      resetAt,
      identities: pendingIdentities(activeEvidence),
      outcome: { kind: 'preserve', incident: retentionIncident },
    });
    parkingStarted = true;
    const parked = parkIncidentEvidence(
      runtime.storage,
      files,
      activeEvidence,
      parkingDirectory,
      publishedEvidence.coherence,
    );
    if (parked.coherence !== publishedEvidence.coherence) {
      preservation = { ...preservation, coherence: 'torn' };
      retentionIncident = {
        ...retentionIncident,
        evidenceBytes: manifestFiles.reduce((total, file) => total + file.sizeBytes, 0),
        preservation,
      };
      pendingLedger = recordStoreResetPending(runtime.storage, quarantineRoot, pendingLedger, {
        resetAt,
        identities: pendingIdentities(activeEvidence),
        outcome: { kind: 'preserve', incident: retentionIncident },
      });
    }
    const manifest = createIncidentManifest(
      runtime,
      authority,
      classification,
      incidentId,
      resetAt,
      manifestFiles,
      newerStorePolicy,
    );
    const published = runtime.storage.writeAtomicDurableSync(
      join(stagingDirectory, STORE_RESET_MANIFEST_FILE_NAME),
      serializeStoreResetIncidentManifest(manifest),
      { encoding: 'utf-8', mode: 0o600 },
    );
    if (!published) {
      throw new Error('Store reset incident manifest could not be published durably.');
    }
    requireDirectorySync(runtime.storage, stagingDirectory);
    validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
    requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
    runtime.storage.renameSync(stagingDirectory, finalDirectory);
    requireDirectorySync(runtime.storage, quarantineRoot, stagingRoot);
    const droppableNames = new Set(publishedEvidence.published.map(({ active }) => active.name));
    const settledLeft = settleParkedEvidence(runtime.storage, files, parkingDirectory, parked.parked, droppableNames);
    const keptParked = STORE_RESET_EVIDENCE_FILE_NAMES.filter((name) => {
      try {
        runtime.storage.lstatSync(join(parkingDirectory, name));
        return true;
      } catch (error: unknown) {
        if (isNoEntryError(error)) return false;
        throw error;
      }
    });
    const leftActive = [...new Set([...publishedEvidence.leftActive, ...parked.leftActive, ...settledLeft])];
    if (leftActive.length > 0 && preservation.coherence !== 'torn') {
      preservation = { ...preservation, coherence: 'torn' };
    }
    retentionIncident = { ...retentionIncident, preservation };
    const keptByName = new Set(keptParked);
    const terminalCause = parked.parked.some((item) => keptByName.has(item.evidence.name) && item.ownership === 'other')
      ? 'intruder'
      : 'residual';
    const parkingSurvives = terminalizeParking(
      runtime.storage,
      parkingRoot,
      parkingRecord,
      terminalCause,
      incidentId,
      STORE_RESET_IN_FLIGHT_DIRECTORY,
    );
    if (!parkingSurvives) {
      recordStoreResetPreserved(runtime.storage, quarantineRoot, pendingLedger, retentionIncident);
    }

    recordIncidentAudit(manifest, preservation);
    return {
      kind: 'preserved',
      incident: {
        incidentId,
        resetAt,
        reason: manifest.reason,
        schemaVersion: manifest.schemaVersion,
        resetPolicyCause:
          manifest.schemaVersion === STORE_RESET_INCIDENT_SCHEMA_VERSION ? manifest.resetPolicyCause : null,
        fileCount: manifestFiles.length,
      },
      preservation,
      leftActive,
    };
  } catch (error: unknown) {
    if (!parkingStarted) {
      if (stagingOwned) runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
      if (parkingOwned) runtime.storage.rmSync(parkingDirectory, { recursive: true, force: true });
      if (pendingLedger !== null) clearStoreResetPending(runtime.storage, quarantineRoot, pendingLedger);
      try {
        requireDirectorySync(runtime.storage, stagingRoot, parkingRoot);
      } catch {
        // Preserve the fixed quarantine failure envelope from the primary failure.
      }
    }
    throw documentedCoralSetupError({
      code: 'store_reset_quarantine_failed',
      incidentId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function mintBackendStoreForClaim(
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
): MintedBackendStore {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const mintedRoot = join(quarantineRoot, STORE_RESET_MINTED_DIRECTORY);
  runtime.storage.mkdirSync(files.dbDir, { recursive: true });
  ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
  ensurePrivateDirectory(runtime.storage, mintedRoot, runtime.env.platform());
  requireDirectorySync(runtime.storage, quarantineRoot);
  const directory = join(mintedRoot, STORE_RESET_MINTED_STORE_DIRECTORY);
  createPrivateOperationDirectory(runtime.storage, mintedRoot, directory, runtime.env.platform());
  const path = join(directory, 'store.db');
  const decision = openWritableStoreDatabase({
    path,
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    busyTimeoutMs: options.startupBusyTimeoutMs ?? options.busyTimeoutMs,
  });
  if (decision.kind !== 'opened') {
    throw new Error('A store minted on an owned empty path was incompatible.');
  }
  try {
    const stat = stablePathStat(runtime.storage, path);
    return { directory, path, identity: { dev: stat.dev, ino: stat.ino }, db: decision.db };
  } catch (error: unknown) {
    decision.db.close();
    throw error;
  }
}

function cloneParkedStoreForClaim(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'storage'>,
  options: OpenOrResetBackendStoreOptions,
  minted: MintedBackendStore,
  parkingDirectory: string,
  parked: ReturnType<typeof parkCurrentEvidence>,
  cloneId: string,
): MintedBackendStore {
  const mintedRoot = dirname(minted.directory);
  const directory = join(mintedRoot, cloneId);
  let decision: ReturnType<typeof openWritableStoreDatabase> | null = null;
  let cloned: MintedBackendStore;
  const abandonClone = (): MintedBackendStore => {
    if (decision?.kind === 'opened') {
      try {
        decision.db.close();
      } catch {
        // The fixed minted store remains the safe claim candidate.
      }
    }
    try {
      runtime.storage.rmSync(directory, { recursive: true, force: true });
      requireDirectorySync(runtime.storage, mintedRoot);
    } catch {
      // The fixed minted store remains the safe claim candidate.
    }
    return minted;
  };
  try {
    createPrivateOperationDirectory(runtime.storage, mintedRoot, directory, runtime.env.platform());
    let coherent = true;
    for (const item of parked) {
      if (item.entry.kind !== 'regular-file') continue;
      const copied = copyPathCandidateForPublication(
        runtime.storage,
        { source: join(parkingDirectory, item.name), name: item.name },
        join(directory, item.name),
        null,
      );
      if (copied.coherence !== 'coherent') coherent = false;
    }
    requireDirectorySync(runtime.storage, directory);
    if (!coherent) return abandonClone();
    const path = join(directory, 'store.db');
    decision = openWritableStoreDatabase({
      path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: options.startupBusyTimeoutMs ?? options.busyTimeoutMs,
    });
    if (decision.kind !== 'opened') return abandonClone();
    const stat = stablePathStat(runtime.storage, path);
    cloned = { directory, path, identity: { dev: stat.dev, ino: stat.ino }, db: decision.db };
  } catch {
    return abandonClone();
  }
  try {
    minted.db.close();
  } catch (error: unknown) {
    try {
      cloned.db.close();
    } catch {
      // The original close failure remains authoritative.
    }
    try {
      runtime.storage.rmSync(directory, { recursive: true, force: true });
      requireDirectorySync(runtime.storage, mintedRoot);
    } catch {
      // The close failure remains authoritative.
    }
    throw error;
  }
  try {
    runtime.storage.rmSync(minted.directory, { recursive: true });
    requireDirectorySync(runtime.storage, mintedRoot);
  } catch (error: unknown) {
    writeAuditEvent(
      'store_reset_minted_cleanup_deferred',
      { cause: error instanceof Error ? error.message : String(error) },
      'warn',
    );
  }
  return cloned;
}

function unavailableStoreClassification(
  current: StoreFormatDescription,
): Extract<StoreFormatClassification, { readonly kind: 'corrupt-or-unsupported' }> {
  return {
    kind: 'corrupt-or-unsupported',
    currentFingerprint: current.fingerprint,
    currentProductVersion: current.productVersion,
    storedFingerprint: null,
    storedProductVersion: null,
    storedProductVersionState: 'unavailable',
  };
}

function classifyParkedStore(
  runtime: Pick<Runtime, 'storage'>,
  path: string,
  options: OpenOrResetBackendStoreOptions,
): StoreFormatClassification {
  try {
    return classifyStoreFile(path, runtime.storage, options.storeFormat);
  } catch {
    return unavailableStoreClassification(options.storeFormat);
  }
}

function terminalParkingRecord(
  runtime: Pick<Runtime, 'time'>,
  parkingId: string,
  cause: 'intruder' | 'residual',
  entries: StoreResetParkedRecord['entries'],
  classification: StoreFormatClassification | null,
): StoreResetParkedRecord {
  return {
    version: 1,
    parkingId,
    parkedAt: new Date(runtime.time.now()).toISOString(),
    phase: 'terminal',
    cause,
    incidentId: null,
    names: entries.map((entry) => entry.name),
    entries,
    transaction: null,
    classification: classification?.kind ?? null,
  };
}

function restoreCompatibleParkedStore(
  runtime: Pick<Runtime, 'storage'>,
  files: BackendStoreFileSet,
  parkingDirectory: string,
  names: readonly StoreResetEvidenceFileName[],
): boolean {
  const dbLast = [...names].sort((left, right) => (left === 'store.db' ? 1 : right === 'store.db' ? -1 : 0));
  for (const name of dbLast) {
    const claim = linkOwnedEvidenceToActive(runtime.storage, files, join(parkingDirectory, name), name);
    if (claim.kind === 'occupied') return false;
  }
  requireDirectorySync(runtime.storage, files.dbDir);
  return true;
}

function ownedRegularEvidenceNames(storage: StoragePort, directory: string): readonly StoreResetEvidenceFileName[] {
  return STORE_RESET_EVIDENCE_FILE_NAMES.filter((name) => {
    try {
      const link = storage.lstatSync(join(directory, name));
      return link.isFile() && !link.isSymbolicLink();
    } catch (error: unknown) {
      if (isNoEntryError(error)) return false;
      throw error;
    }
  });
}

function ownedActiveClaimNames(storage: StoragePort, directory: string): readonly StoreResetEvidenceFileName[] {
  return [...ownedRegularEvidenceNames(storage, directory)].sort((left, right) =>
    left === 'store.db' ? -1 : right === 'store.db' ? 1 : 0,
  );
}

function retainNonRegularParking(
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage'>,
  parkingRoot: string,
  parkingDirectory: string,
  parkingRecord: StoreResetParkedRecord,
  parked: ReturnType<typeof parkCurrentEvidence>,
): { readonly names: readonly StoreResetEvidenceFileName[]; readonly parkingId: string | null } {
  const retained = parked.filter((item) => item.entry.kind !== 'regular-file');
  if (retained.length === 0) return { names: [], parkingId: null };
  const terminalParkingId = runtime.ids.uuid();
  const terminalDirectory = join(parkingRoot, terminalParkingId);
  createPrivateOperationDirectory(runtime.storage, parkingRoot, terminalDirectory, runtime.env.platform());
  commitTerminalParking(
    runtime.storage,
    parkingRoot,
    {
      ...parkingRecord,
      parkingId: terminalParkingId,
      phase: 'terminal',
      cause: 'residual',
      names: retained.map((item) => item.name),
      entries: retained.map((item) => item.entry),
      transaction: null,
    },
    terminalParkingId,
    parkingRoot,
    () => {
      for (const item of retained) {
        runtime.storage.renameSync(join(parkingDirectory, item.name), join(terminalDirectory, item.name));
        requireDirectorySync(runtime.storage, parkingDirectory, terminalDirectory);
      }
    },
  );
  return { names: retained.map((item) => item.name), parkingId: terminalParkingId };
}

function restoreLegacyParkedStore(
  runtime: Pick<Runtime, 'env' | 'ids' | 'storage'>,
  files: BackendStoreFileSet,
  parkingRoot: string,
  parkingDirectory: string,
  parkingRecord: StoreResetParkedRecord,
  parkingCoordinate: string,
  parked: ReturnType<typeof parkCurrentEvidence>,
  classification: Extract<StoreFormatClassification, { readonly kind: 'legacy-adoptable' }>,
): boolean {
  const parkedDb = parked.find((item) => item.name === 'store.db');
  if (parkedDb === undefined) return false;
  retainNonRegularParking(runtime, parkingRoot, parkingDirectory, parkingRecord, parked);
  const restorableNames = ownedActiveClaimNames(runtime.storage, parkingDirectory);
  if (!restoreCompatibleParkedStore(runtime, files, parkingDirectory, restorableNames)) return false;
  const identity = activeNameHasIdentity(runtime.storage, files, 'store.db', parkedDb.identity);
  if (identity.kind === 'undeterminable') throw identity.error;
  if (identity.kind !== 'same') return false;
  for (const name of restorableNames) {
    runtime.storage.unlinkSync(join(parkingDirectory, name));
  }
  requireDirectorySync(runtime.storage, parkingDirectory);
  terminalizeParking(
    runtime.storage,
    parkingRoot,
    { ...parkingRecord, classification: classification.kind },
    'residual',
    parkingRecord.incidentId,
    parkingCoordinate,
  );
  return true;
}

function openCompatibleParkedStore(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
  parkingRoot: string,
  parkingDirectory: string,
  parkingRecord: StoreResetParkedRecord,
  parkingCoordinate: string,
  parked: ReturnType<typeof parkCurrentEvidence>,
  classification: Extract<StoreFormatClassification, { readonly kind: 'compatible' | 'fresh' }>,
): ParkedStoreAdoptionAttempt {
  const parkingId = parkingRecord.parkingId;
  const parkedDb = parked.find((item) => item.name === 'store.db');
  if (parkedDb === undefined) return { kind: 'retry', epochs: [] };
  const parkedEpoch: StoreSettlementEpoch = {
    kind: 'parked',
    parkingId,
    cause: 'intruder',
    names: parked.map((item) => item.name),
    classification,
  };
  const terminalize = (): void => {
    const record = runtime.storage.existsSync(join(parkingRoot, parkingRecord.parkingId))
      ? { ...parkingRecord, parkingId: runtime.ids.uuid() }
      : parkingRecord;
    terminalizeParking(
      runtime.storage,
      parkingRoot,
      { ...record, classification: classification.kind },
      'intruder',
      parkingRecord.incidentId,
      parkingCoordinate,
    );
  };
  const retainedNonRegular = retainNonRegularParking(runtime, parkingRoot, parkingDirectory, parkingRecord, parked);
  const decision = openWritableStoreDatabase({
    path: join(parkingDirectory, 'store.db'),
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    flavor: runtime.flavor,
    busyTimeoutMs: options.startupBusyTimeoutMs ?? options.busyTimeoutMs,
  });
  if (decision.kind === 'incompatible') {
    terminalize();
    return { kind: 'retry', epochs: [parkedEpoch] };
  }
  const restorableNames = ownedActiveClaimNames(runtime.storage, parkingDirectory);
  if (!restoreCompatibleParkedStore(runtime, files, parkingDirectory, restorableNames)) {
    decision.db.close();
    terminalize();
    return { kind: 'retry', epochs: [parkedEpoch] };
  }
  const identity = activeNameHasIdentity(runtime.storage, files, 'store.db', parkedDb.identity);
  if (identity.kind !== 'same') {
    decision.db.close();
    if (identity.kind === 'undeterminable') throw identity.error;
    terminalize();
    return { kind: 'retry', epochs: [parkedEpoch] };
  }
  const remainingEpoch: StoreSettlementEpoch | null =
    retainedNonRegular.parkingId === null
      ? null
      : {
          kind: 'parked',
          parkingId: retainedNonRegular.parkingId,
          cause: 'residual',
          names: retainedNonRegular.names,
          classification: null,
        };
  let closed = false;
  const db = new Proxy(decision.db, {
    // SQLite may remove WAL/SHM files while closing; the remaining directory is the recovery truth.
    get(target, property) {
      if (property === 'close') {
        return (): void => {
          if (closed) return;
          closed = true;
          target.close();
          try {
            for (const name of ownedRegularEvidenceNames(runtime.storage, parkingDirectory)) {
              try {
                runtime.storage.unlinkSync(join(parkingDirectory, name));
              } catch (error: unknown) {
                if (!isNoEntryError(error)) throw error;
              }
            }
            requireDirectorySync(runtime.storage, parkingDirectory);
            terminalizeParking(
              runtime.storage,
              parkingRoot,
              parkingRecord,
              'residual',
              parkingRecord.incidentId,
              parkingCoordinate,
            );
          } catch (error: unknown) {
            writeAuditEvent(
              'store_reset_parking_cleanup_deferred',
              { cause: error instanceof Error ? error.message : String(error) },
              'warn',
            );
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    kind: 'opened',
    db,
    epochs: [...(remainingEpoch === null ? [] : [remainingEpoch]), { kind: 'adopted' }],
  };
}

function databaseWithMintedCleanup(storage: StoragePort, minted: MintedBackendStore): Database {
  let closed = false;
  return new Proxy(minted.db, {
    get(target, property) {
      if (property === 'close') {
        return (): void => {
          if (closed) return;
          closed = true;
          target.close();
          try {
            storage.rmSync(minted.directory, { recursive: true });
            requireDirectorySync(storage, dirname(minted.directory));
          } catch (error: unknown) {
            writeAuditEvent(
              'store_reset_minted_cleanup_deferred',
              { cause: error instanceof Error ? error.message : String(error) },
              'warn',
            );
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function finishOpenedClaim(
  runtime: Pick<Runtime, 'storage'>,
  files: BackendStoreFileSet,
  minted: MintedBackendStore,
): BackendStoreClaimAttempt {
  const identity = activeNameHasIdentity(runtime.storage, files, 'store.db', minted.identity);
  if (identity.kind !== 'same') {
    if (identity.kind === 'undeterminable') {
      minted.db.close();
      throw identity.error;
    }
    return { kind: 'retry', candidate: minted, epochs: [] };
  }
  return { kind: 'opened', db: databaseWithMintedCleanup(runtime.storage, minted), epochs: [{ kind: 'claimed' }] };
}

export function attemptBackendStoreClaim(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
  minted: MintedBackendStore,
): BackendStoreClaimAttempt {
  const { dbFile } = files;
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  ensurePrivateDirectory(runtime.storage, parkingRoot, runtime.env.platform());
  requireDirectorySync(runtime.storage, quarantineRoot);
  const parkingId = runtime.ids.uuid();
  const parkingOperation = createParkingOperation(runtime, parkingRoot, parkingId, {
    phase: 'in-flight',
    cause: 'residual',
    incidentId: null,
    names: [],
    entries: [],
    transaction: { kind: 'claim', names: STORE_RESET_EVIDENCE_FILE_NAMES },
    classification: null,
  });
  const parkingDirectory = parkingOperation.directory;
  const parked = parkCurrentEvidence(runtime.storage, files, parkingDirectory);
  if (parked.length > 0) requireDirectorySync(runtime.storage, files.dbDir, parkingDirectory);
  const names = parked.map((item) => item.name);
  const parkedDb = parked.find((item) => item.name === 'store.db');
  const cause = parkedDb === undefined ? 'residual' : 'intruder';
  const classification =
    parkedDb?.entry.kind === 'regular-file'
      ? classifyParkedStore(runtime, join(parkingDirectory, 'store.db'), options)
      : null;
  const parkedEpoch: StoreSettlementEpoch | null =
    names.length === 0 ? null : { kind: 'parked', parkingId, cause, names, classification };
  let claimStore = minted;

  if (classification !== null && parkedDb !== undefined) {
    switch (classification.kind) {
      case 'legacy-adoptable':
        if (
          !restoreLegacyParkedStore(
            runtime,
            files,
            parkingRoot,
            parkingDirectory,
            parkingOperation.record,
            STORE_RESET_IN_FLIGHT_DIRECTORY,
            parked,
            classification,
          )
        ) {
          terminalizeParking(
            runtime.storage,
            parkingRoot,
            { ...parkingOperation.record, classification: classification.kind },
            'intruder',
            null,
            STORE_RESET_IN_FLIGHT_DIRECTORY,
          );
          return { kind: 'retry', candidate: minted, epochs: parkedEpoch === null ? [] : [parkedEpoch] };
        }
        minted.db.close();
        runtime.storage.rmSync(minted.directory, { recursive: true });
        requireDirectorySync(runtime.storage, dirname(minted.directory));
        return refuseLegacyStore(dbFile, classification, options.storeFormat, runtime.flavor);
      case 'compatible':
      case 'fresh': {
        if (!parkedDatabaseHasPrivateInode(runtime.storage, join(parkingDirectory, 'store.db'), parkedDb.identity)) {
          claimStore = cloneParkedStoreForClaim(runtime, options, minted, parkingDirectory, parked, parkingId);
          break;
        }
        const adoption = openCompatibleParkedStore(
          runtime,
          files,
          options,
          parkingRoot,
          parkingDirectory,
          parkingOperation.record,
          STORE_RESET_IN_FLIGHT_DIRECTORY,
          parked,
          classification,
        );
        if (adoption.kind === 'retry') return { ...adoption, candidate: minted };
        try {
          minted.db.close();
          const mintedRoot = dirname(minted.directory);
          runtime.storage.rmSync(minted.directory, { recursive: true });
          requireDirectorySync(runtime.storage, mintedRoot);
          settleStoreResetPending(runtime.storage, quarantineRoot);
        } catch (error: unknown) {
          adoption.db.close();
          throw error;
        }
        return adoption;
      }
      case 'absent':
      case 'older-incompatible':
      case 'newer-incompatible':
      case 'corrupt-or-unsupported':
        break;
      default:
        assertNever(classification);
    }
  }

  if (parkedEpoch === null) {
    terminalizeParking(
      runtime.storage,
      parkingRoot,
      { ...parkingOperation.record, classification: classification?.kind ?? null },
      'residual',
      null,
      STORE_RESET_IN_FLIGHT_DIRECTORY,
    );
  } else {
    terminalizeParking(
      runtime.storage,
      parkingRoot,
      { ...parkingOperation.record, classification: classification?.kind ?? null },
      cause,
      null,
      STORE_RESET_IN_FLIGHT_DIRECTORY,
    );
  }

  for (const name of ownedActiveClaimNames(runtime.storage, claimStore.directory)) {
    const claim = linkOwnedEvidenceToActive(runtime.storage, files, join(claimStore.directory, name), name);
    if (claim.kind === 'occupied') {
      return { kind: 'retry', candidate: claimStore, epochs: parkedEpoch === null ? [] : [parkedEpoch] };
    }
  }
  requireDirectorySync(runtime.storage, files.dbDir);
  const opened = finishOpenedClaim(runtime, files, claimStore);
  if (opened.kind === 'retry') {
    return {
      kind: 'retry',
      candidate: opened.candidate,
      epochs: [...(parkedEpoch === null ? [] : [parkedEpoch]), ...opened.epochs],
    };
  }
  try {
    settleStoreResetPending(runtime.storage, quarantineRoot);
  } catch (error: unknown) {
    opened.db.close();
    throw error;
  }
  return {
    ...opened,
    epochs: [...(parkedEpoch === null ? [] : [parkedEpoch]), ...opened.epochs],
  };
}

export function publishClassifiedBackendStoreResetIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  activeEvidence: readonly ActiveEvidence[],
  classification: BackendStoreResetClassification,
  resetLock: BackendStoreResetLockLease,
  writerExclusion: WriterExclusion,
  newerStorePolicy?: NewerStoreResetPolicy,
): IncidentPublication {
  resetLock.assertOwned();
  if (writerExclusion.kind === 'proven') writerExclusion.lease.assertOwned();
  return publishIncident(runtime, authority, files, activeEvidence, classification, writerExclusion, newerStorePolicy);
}

export function resumeBackendStoreResetIncidentForOperator(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
  resetLock: BackendStoreResetLockLease,
  writerExclusion: WriterExclusion,
): BackendStoreResetIncident | null {
  resetLock.assertOwned();
  return resumeInterruptedIncident(runtime, files, options, writerExclusion)?.incident ?? null;
}

export type RetainedStoreResetQuarantineFile = Readonly<{
  evidencePath: string;
  evidenceByteLength: number;
  evidenceSha256: string;
  sourceIdentity: StorageBigIntStat;
}>;

function retainedTransitionName(sourceIdentity: StorageBigIntStat): string {
  const identity = [
    sourceIdentity.dev,
    sourceIdentity.ino,
    sourceIdentity.mode,
    sourceIdentity.size,
    sourceIdentity.mtimeNs,
  ].join(':');
  return `${createHash('sha256').update(identity).digest('hex')}${TRANSITION_EVIDENCE_SUFFIX}`;
}

export function retainTransitionFileInStoreResetQuarantine(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: BackendStoreFileSet,
  sourcePath: string,
  adoption: GenerationAdoptionLockLease,
): RetainedStoreResetQuarantineFile {
  adoption.assertOwned();
  const sourceIdentity = stablePathStat(runtime.storage, sourcePath);
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const evidenceRoot = join(quarantineRoot, RETAINED_TRANSITION_DIRECTORY);
  const evidenceName = retainedTransitionName(sourceIdentity);
  const evidencePath = join(evidenceRoot, evidenceName);
  const stagingPath = `${evidencePath}${RETAINED_TRANSITION_STAGING_SUFFIX}`;

  runtime.storage.mkdirSync(files.dbDir, { recursive: true });
  ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
  ensurePrivateDirectory(runtime.storage, evidenceRoot, runtime.env.platform());
  requireDirectorySync(runtime.storage, quarantineRoot);
  // Retained transitions are bounded protocol evidence, not resumable reset incidents. The audit event's
  // evidencePath is deliberately their only index so the reset-incident surface does not misrepresent them
  // as operator-actionable incidents.
  if (runtime.storage.existsSync(evidencePath)) {
    const evidence = describeCandidate(
      runtime.storage,
      { source: sourcePath, name: evidenceName },
      MAX_ACTIVE_STORE_TRANSITION_BYTES,
    );
    const sourceAfter = stablePathStat(runtime.storage, sourcePath);
    if (!sameEvidenceFileStat(sourceIdentity, sourceAfter)) {
      throw new Error('Retained active-store transition source changed identity during verification.');
    }
    if (evidenceMatches(runtime.storage, { source: evidencePath, name: evidenceName }, evidence)) {
      return {
        evidencePath,
        evidenceByteLength: evidence.sizeBytes,
        evidenceSha256: evidence.sha256,
        sourceIdentity,
      };
    }
    // The source is unchanged (checked above) but evidencePath's bytes don't match it. evidencePath is
    // content-addressed to sourceIdentity, so with a stable source the only legitimate way to reach this
    // state is a copy that never finished — republish over it rather than refusing forever.
  }

  // Only a complete staged copy may become visible at the content-addressed evidence path.
  runtime.storage.rmSync(stagingPath, { force: true });
  const copied = copyPathCandidateForPublication(
    runtime.storage,
    { source: sourcePath, name: evidenceName },
    stagingPath,
    MAX_ACTIVE_STORE_TRANSITION_BYTES,
  );
  if (copied.coherence !== 'coherent') {
    throw new Error('Retained active-store transition source changed during publication.');
  }
  requireDirectorySync(runtime.storage, evidenceRoot);
  runtime.storage.renameSync(stagingPath, evidencePath);
  requireDirectorySync(runtime.storage, evidenceRoot);
  return {
    evidencePath,
    evidenceByteLength: copied.evidence.sizeBytes,
    evidenceSha256: copied.evidence.sha256,
    sourceIdentity: copied.sourceIdentity,
  };
}

function authorizeAutomaticIncidentResume(
  authority: BackendStoreResetAuthority,
  manifest: StoreResetIncidentManifest,
): void {
  if (manifest.schemaVersion !== STORE_RESET_INCIDENT_SCHEMA_VERSION) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_non_resettable');
  }
  if (
    manifest.build.version !== authority.version ||
    manifest.build.buildSetId !== authority.buildSetId ||
    manifest.build.backendBundleHash !== authority.bundleHash ||
    manifest.build.flavor !== authority.flavor ||
    manifest.target.storeDbPath !== authority.storeDbPath ||
    manifest.target.flavor !== authority.flavor ||
    manifest.runtime.namespace !== authority.namespace ||
    manifest.expectedFingerprint !== authority.storeFormatFingerprint
  ) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_authority_mismatch');
  }
}

function resumeAutomaticBackendStoreReset(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
  resetLock: BackendStoreResetLockLease,
  writerExclusion: WriterExclusion,
): ReturnType<typeof resumeInterruptedIncident> {
  resetLock.assertOwned();
  try {
    return resumeInterruptedIncident(runtime, files, options, writerExclusion, (manifest) => {
      authorizeAutomaticIncidentResume(authority, manifest);
    });
  } catch (error: unknown) {
    const refusalCode = error instanceof InterruptedStoreResetRefusal ? error.code : 'store_reset_quarantine_failed';
    const cause = error instanceof InterruptedStoreResetRefusal ? error.cause : error;
    throw documentedCoralSetupError({
      code: refusalCode,
      ...(refusalCode === 'store_reset_quarantine_failed' ? { reason: 'interrupted' } : {}),
      flavor: runtime.flavor,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export function resumeAutomaticBackendStoreResetIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  options: OpenOrResetBackendStoreOptions,
  resetLock: BackendStoreResetLockLease,
  writerExclusion: WriterExclusion,
): BackendStoreResetIncident | null {
  return (
    resumeAutomaticBackendStoreReset(runtime, authority, files, options, resetLock, writerExclusion)?.incident ?? null
  );
}

export function acquireBackendStoreResetLock(
  runtime: Pick<Runtime, 'storage' | 'time'>,
  files: BackendStoreFileSet,
  adoption: GenerationAdoptionLockLease,
): BackendStoreResetLockLease {
  adoption.assertOwned();
  runtime.storage.mkdirSync(files.dbDir, { recursive: true });
  const lockPath = join(files.dbDir, 'store.db.reset.lock');
  let releaseDirectoryLock: () => void;
  try {
    // Threaded deps, not the ambient-fs default overload: the composed Runtime is already the caller's only
    // I/O authority (Single Runtime World).
    releaseDirectoryLock = acquireDirectoryLockSync(lockPath, { storage: runtime.storage, time: runtime.time }, 250);
  } catch (error: unknown) {
    if (isDirectoryLockTimeoutError(error)) {
      throw documentedCoralSetupError({
        code: 'store_reset_lock_contended',
        lockPath,
        dbDir: files.dbDir,
      });
    }
    throw error;
  }

  let owned = true;
  return {
    assertOwned: () => {
      adoption.assertOwned();
      if (!owned) throw new Error('Backend store reset lock is no longer owned.');
    },
    release: () => {
      if (!owned) return;
      owned = false;
      releaseDirectoryLock();
    },
    [BACKEND_STORE_RESET_LOCK_BRAND]: true,
  };
}

type BackendStoreFailureClassification =
  | Readonly<{
      kind: 'corrupt-or-unsupported';
      classification: Extract<StoreFormatClassification, { readonly kind: 'corrupt-or-unsupported' }>;
    }>
  | Readonly<{
      kind: 'reset';
      classification: Extract<StoreFormatClassification, { readonly kind: 'corrupt-or-unsupported' }>;
    }>
  | Readonly<{ kind: 'unclassified'; cause: string }>;

function corruptBackendStoreFailure(
  current: StoreFormatDescription,
): Extract<BackendStoreFailureClassification, { readonly kind: 'corrupt-or-unsupported' }> {
  return {
    kind: 'corrupt-or-unsupported',
    classification: {
      kind: 'corrupt-or-unsupported',
      currentFingerprint: current.fingerprint,
      currentProductVersion: current.productVersion,
      storedFingerprint: null,
      storedProductVersion: null,
      storedProductVersionState: 'unavailable',
    },
  };
}

export function classifyBackendStoreFailure(
  error: unknown,
  current: StoreFormatDescription,
): BackendStoreFailureClassification {
  const cause = error instanceof Error ? error.message : String(error);
  const primaryErrorNumber = errorNumber(error, 0) & 0xff;
  if (primaryErrorNumber === SQLITE_BUSY || primaryErrorNumber === SQLITE_LOCKED) {
    return { kind: 'reset', classification: unavailableStoreClassification(current) };
  }
  if (primaryErrorNumber === SQLITE_CORRUPT || primaryErrorNumber === SQLITE_NOTADB) {
    return corruptBackendStoreFailure(current);
  }
  if (/database (?:table )?is locked/iu.test(cause)) {
    return { kind: 'reset', classification: unavailableStoreClassification(current) };
  }
  if (/file is not a database|database disk image is malformed|malformed database schema/iu.test(cause)) {
    return corruptBackendStoreFailure(current);
  }
  return { kind: 'unclassified', cause };
}

export function documentedBackendStoreClassificationFailure(
  runtime: Pick<Runtime, 'flavor'>,
  dbFile: string,
  failure: Extract<BackendStoreFailureClassification, { readonly kind: 'unclassified' }>,
): ReturnType<typeof documentedCoralSetupError> {
  return documentedCoralSetupError({
    code: 'store_open_unclassified',
    path: dbFile,
    flavor: runtime.flavor,
    cause: failure.cause,
  });
}
