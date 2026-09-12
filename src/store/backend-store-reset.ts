import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import { errorNumber } from '../infra/error-number.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import { compareProductVersions, validateProductVersion } from '../infra/product-version.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { ACTIVE_STORE_TRANSITION_VERSION } from './active-store-selection.js';
import {
  enumerateActiveEvidence,
  linkActiveEvidence,
  observeActiveEvidence,
  openActiveEvidence,
  removeActiveEvidence,
  type ActiveEvidence,
  type ActiveEvidenceFileSet,
  type ActiveEvidenceObservation,
  type StableSource,
} from './reset-active-evidence.js';
import { classifyStoreFile, openStoreDatabase, type Database } from './db.js';
import {
  isStoreFormatFingerprint,
  type StoreFormatClassification,
  type StoreFormatDescription,
  type StoreFormatFingerprint,
} from './format-fingerprint.js';
import {
  formatLegacyGenerationIgnoredNotice,
  acquireGenerationMaintenanceLease,
  inspectGenerationReadiness,
  type GenerationAdoptionLockLease,
  type GenerationMaintenanceLease,
} from './generation-mutation-coordination.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_ACTIVE_STORE_TRANSITION_BYTES,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_INCIDENT_SCHEMA_VERSION,
  STORE_RESET_MANIFEST_FILE_NAME,
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
  recordStoreResetDiscarded,
  recordStoreResetPending,
  recordStoreResetPreserved,
  recordStoreResetResumeLeftActive,
  resolveStoreResetRetentionSlot,
  type DiscardReceipt,
  type PreservationMechanism,
  type PreservedRetention,
  type StoreResetRetentionLedger,
  type StoreResetRetentionIncident,
  type StoreResetRetentionPending,
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
      readonly reason: 'writer-live' | 'writer-unobservable' | 'lock-timeout' | 'not-attempted';
      readonly blockers: string | null;
    };

export type IncidentPublication =
  | {
      readonly kind: 'preserved';
      readonly incident: BackendStoreResetIncident;
      readonly preservation: PreservationMechanism;
      readonly retention: PreservedRetention;
      readonly leftActive: readonly StoreResetEvidenceFileName[];
    }
  | {
      readonly kind: 'discarded';
      readonly receipt: DiscardReceipt;
      readonly leftActive: readonly StoreResetEvidenceFileName[];
    }
  | { readonly kind: 'no-evidence'; readonly leftActive: readonly StoreResetEvidenceFileName[] };

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
      throw new Error('Store-reset evidence identity changed before hashing.');
    }
    const expectedSize = Number(opened.size);
    const hashed = hashExactDescriptor(storage, descriptor, expectedSize);
    if (hashed.bytesConsumed !== expectedSize || hashed.overrun) {
      throw new Error('Store-reset evidence changed size during hashing.');
    }
    digest = hashed.sha256;
    const openedAfter = storage.fstatSync(descriptor, { bigint: true });
    const pathAfter = stablePathStat(storage, candidate.source);
    if (!sameEvidenceFileStat(opened, openedAfter) || !sameEvidenceFileStat(opened, pathAfter)) {
      throw new Error('Store-reset evidence identity changed during hashing.');
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
  const sourceIdentity = source.evidence.identity;
  let destinationDescriptor: number | null = null;
  let closeFailure = false;
  let result: PublishedEvidenceCopy<StoreResetEvidenceFileName> | null = null;
  try {
    const openedDestination = storage.openSync(destination, 'wx', 0o600);
    destinationDescriptor = openedDestination;
    const expectedSize = Number(sourceIdentity.size);
    const hashed = hashExactDescriptor(storage, source.descriptor, expectedSize, (buffer, length) => {
      writeExactDescriptor(storage, openedDestination, buffer, length);
    });
    const sourceAfter = storage.fstatSync(source.descriptor, { bigint: true });
    const observation = source.reobserve();
    const coherence =
      !hashed.overrun &&
      hashed.bytesConsumed === expectedSize &&
      sameEvidenceFileStat(sourceIdentity, sourceAfter) &&
      observation.kind === 'stable'
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
        mtimeMs: Number(sourceIdentity.mtimeNs / 1_000_000n),
        sha256: hashed.sha256,
      },
      sourceIdentity,
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

function requireDirectorySync(storage: StoragePort, ...directories: readonly string[]): void {
  for (const directory of new Set(directories)) {
    if (!storage.syncDirectoryDurableSync(directory)) {
      throw new Error('Store-reset directory metadata could not be synchronized.');
    }
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
  const read = storage.readDirectoryBoundedSync(stagingDirectory, MAX_INCIDENT_DIR_ENTRIES);
  if (read.overflow) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_ambiguous');
  }
  const expected = new Set<string>([STORE_RESET_MANIFEST_FILE_NAME, ...manifest.files.map((file) => file.name)]);
  if (read.entries.some((entry) => !expected.has(entry))) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_foreign');
  }
  if (requireComplete && read.entries.length !== expected.size) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_malformed');
  }
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

function reconcileCommittedEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
  manifest: StoreResetIncidentManifest,
): readonly StoreResetEvidenceFileName[] {
  const observations: Array<{
    name: StoreResetEvidenceFileName;
    observation: ActiveEvidenceObservation;
  }> = [];
  for (const expected of manifest.files) {
    const staged = { source: join(stagingDirectory, expected.name), name: expected.name };
    const integrity = stagedEvidenceIntegrity(storage, staged, expected);
    switch (integrity.kind) {
      case 'intact': {
        const stagedIdentity = stablePathStat(storage, staged.source);
        observations.push({
          name: expected.name,
          observation: observeActiveEvidence(storage, files, expected.name, {
            kind: 'content',
            stagedIdentity,
            expected,
          }),
        });
        break;
      }
      case 'corrupt':
        throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched');
      case 'undeterminable':
        throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched', new Error(integrity.cause));
      default:
        assertNever(integrity);
    }
  }

  const leftActive: StoreResetEvidenceFileName[] = [];
  for (const { name, observation } of observations) {
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    const removal = removeActiveEvidence(storage, files, name, observation);
    switch (removal.kind) {
      case 'removed':
        requireDirectorySync(storage, files.dbDir);
        break;
      case 'absent':
        break;
      case 'left':
        leftActive.push(name);
        break;
      default:
        assertNever(removal);
    }
  }

  const recordedNames = new Set(manifest.files.map((file) => file.name));
  let currentEvidence: readonly ActiveEvidence[];
  try {
    currentEvidence = enumerateActiveEvidence(storage, files);
  } catch (error: unknown) {
    throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched', error);
  }
  for (const evidence of currentEvidence) {
    if (!recordedNames.has(evidence.name)) {
      throw new InterruptedStoreResetRefusal('store_reset_interrupted_mismatched');
    }
  }
  return leftActive;
}

function resumeInterruptedIncident(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: BackendStoreFileSet,
  authorizeCommittedManifest?: (manifest: StoreResetIncidentManifest) => void,
): {
  readonly incident: BackendStoreResetIncident;
  readonly manifest: StoreResetIncidentManifest;
  readonly leftActive: readonly StoreResetEvidenceFileName[];
} | null {
  const interrupted = detectInterruptedIncident(runtime, files);
  if (interrupted === null) return null;
  if (interrupted.manifest === null) {
    discardUncommittedStaging(runtime.storage, interrupted.stagingDirectory, interrupted.stagingRoot);
    return null;
  }

  const { manifest, quarantineRoot, stagingDirectory, stagingIdentity, stagingRoot } = interrupted;
  authorizeCommittedManifest?.(manifest);
  const leftActive = reconcileCommittedEvidence(runtime.storage, files, stagingDirectory, stagingIdentity, manifest);

  validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
  requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
  runtime.storage.renameSync(stagingDirectory, join(quarantineRoot, manifest.incidentId));
  requireDirectorySync(runtime.storage, quarantineRoot, stagingRoot);
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
  if (!runtime.storage.existsSync(stagingRoot)) return null;
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
  if (stagingNames.length === 0) return null;

  const stagingName = stagingNames[0];
  const stagingDirectory = join(stagingRoot, stagingName);
  let stagingIdentity: StorageBigIntStat;
  try {
    stagingIdentity = assertContainedDirectory(runtime.storage, stagingRoot, stagingDirectory);
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
  };
}

export function hasPendingBackendStoreResetIncident(
  runtime: Pick<Runtime, 'storage'>,
  files: BackendStoreFileSet,
): boolean {
  const stagingRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY, STORE_RESET_STAGING_DIRECTORY);
  if (!runtime.storage.existsSync(stagingRoot)) return false;
  const read = runtime.storage.readDirectoryBoundedSync(stagingRoot, 1);
  return read.overflow || read.entries.length > 0;
}

type PublishedIncidentEvidence = Readonly<{
  published: readonly Readonly<{ active: ActiveEvidence; file: StoreResetIncidentFile }>[];
  coherence: 'coherent' | 'torn' | 'unproven';
  leftActive: readonly StoreResetEvidenceFileName[];
}>;

class StoreResetLinkUnavailable extends Error {
  readonly code: string;

  constructor(error: unknown) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    super(`Store-reset evidence could not be linked (${code}).`, { cause: error });
    this.name = 'StoreResetLinkUnavailable';
    this.code = code;
  }
}

function removeStagedEvidence(
  storage: StoragePort,
  evidence: readonly ActiveEvidence[],
  stagingDirectory: string,
): void {
  for (const active of evidence) {
    storage.rmSync(join(stagingDirectory, active.name), { force: true });
  }
}

function linkIncidentEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  activeEvidence: readonly ActiveEvidence[],
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
): PublishedIncidentEvidence {
  const published: Array<{ active: ActiveEvidence; file: StoreResetIncidentFile }> = [];
  const leftActive: StoreResetEvidenceFileName[] = [];
  for (const active of activeEvidence) {
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    const source = openActiveEvidence(storage, files, active);
    const destination = join(stagingDirectory, active.name);
    let linked: ReturnType<typeof linkActiveEvidence>;
    try {
      linked = linkActiveEvidence(storage, files, active, destination);
    } finally {
      source.close();
    }
    switch (linked.kind) {
      case 'linked':
        published.push({ active, file: describeCandidate(storage, { source: destination, name: active.name }, null) });
        break;
      case 'absent':
        leftActive.push(active.name);
        break;
      case 'changed':
        storage.rmSync(destination, { force: true });
        leftActive.push(active.name);
        break;
      case 'unavailable':
        throw new StoreResetLinkUnavailable(Object.assign(new Error(linked.code), { code: linked.code }));
      default:
        assertNever(linked);
    }
  }
  return { published, coherence: leftActive.length === 0 ? 'coherent' : 'torn', leftActive };
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
  const published = activeEvidence.map((active) => {
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    const source = openActiveEvidence(storage, files, active);
    const copied = copyActiveEvidenceForPublication(storage, source, join(stagingDirectory, active.name));
    if (copied.coherence === 'torn') coherence = 'torn';
    return { active, file: copied.evidence };
  });
  return { published, coherence, leftActive: [] };
}

function removeCommittedActiveEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  evidence: PublishedIncidentEvidence,
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
  markStarted: () => void,
): {
  readonly coherence: PublishedIncidentEvidence['coherence'];
  readonly leftActive: readonly StoreResetEvidenceFileName[];
} {
  let coherence = evidence.coherence;
  const leftActive = [...evidence.leftActive];
  for (const { active } of evidence.published) {
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    const observation = observeActiveEvidence(storage, files, active, {
      kind: 'identity',
      identity: active.identity,
    });
    if (observation.kind === 'same-inode' || observation.kind === 'distinct-matching') markStarted();
    const removal = removeActiveEvidence(storage, files, active, observation);
    if (removal.kind === 'removed') {
      requireDirectorySync(storage, files.dbDir);
      continue;
    }
    if (removal.kind === 'left') leftActive.push(active.name);
    coherence = 'torn';
  }
  return { coherence, leftActive };
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

function recordIncidentAudit(
  manifest: StoreResetIncidentManifest,
  preservation: PreservationMechanism,
  retention: PreservedRetention,
): void {
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
      retention,
    },
    'warn',
  );
}

function lineageFromHolder(
  classification: BackendStoreResetClassification,
  holder: StoreResetIncidentManifest | null,
): 'descendant' | 'unrelated' | 'undeterminable' {
  if (holder === null) return 'undeterminable';
  if (storedFingerprint(classification) !== holder.expectedFingerprint) return 'unrelated';
  if (classification.storedProductVersion === null) return 'undeterminable';
  const storedProductVersion = validateProductVersion(classification.storedProductVersion);
  if (storedProductVersion === null) return 'undeterminable';
  return compareProductVersions(storedProductVersion, holder.build.version) >= 0 ? 'descendant' : 'unrelated';
}

function evidenceBytes(evidence: readonly ActiveEvidence[]): number {
  return evidence.reduce((total, active) => total + Number(active.identity.size), 0);
}

function discardIncidentEvidence(
  storage: StoragePort,
  files: BackendStoreFileSet,
  evidence: readonly ActiveEvidence[],
  markStarted: () => void,
): {
  readonly leftActive: readonly StoreResetEvidenceFileName[];
  readonly identitiesSettled: boolean;
} {
  const leftActive: StoreResetEvidenceFileName[] = [];
  let identitiesSettled = true;
  for (const active of evidence) {
    const observation = observeActiveEvidence(storage, files, active, {
      kind: 'identity',
      identity: active.identity,
    });
    if (observation.kind === 'undeterminable') identitiesSettled = false;
    if (observation.kind === 'same-inode' || observation.kind === 'distinct-matching') markStarted();
    const removal = removeActiveEvidence(storage, files, active, observation);
    if (removal.kind === 'removed') requireDirectorySync(storage, files.dbDir);
    if (removal.kind === 'left') leftActive.push(active.name);
  }
  return { leftActive, identitiesSettled };
}

function pendingIdentities(evidence: readonly ActiveEvidence[]): StoreResetRetentionPending['identities'] {
  return evidence.map((active) => ({
    name: active.name,
    dev: active.identity.dev.toString(),
    ino: active.identity.ino.toString(),
  }));
}

function unsupportedLinkCause(
  code: string,
): Extract<
  PreservationMechanism,
  { readonly kind: 'copied'; readonly cause: { readonly kind: 'link-unsupported' } }
>['cause'] {
  const errno = code === 'EXDEV' || code === 'EMLINK' || code === 'EPERM' || code === 'EOPNOTSUPP' ? code : 'other';
  return { kind: 'link-unsupported', errno, code };
}

function publishIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  classification: BackendStoreResetClassification,
  writerExclusion: WriterExclusion,
  newerStorePolicy?: NewerStoreResetPolicy,
): IncidentPublication {
  const incidentId = runtime.ids.uuid();
  const resetAt = new Date(runtime.time.now()).toISOString();
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
  const stagingDirectory = join(stagingRoot, incidentId);
  const finalDirectory = join(quarantineRoot, incidentId);
  let activeRemovalStarted = false;
  let pendingLedger: StoreResetRetentionLedger | null = null;

  try {
    const activeEvidence = enumerateActiveEvidence(runtime.storage, files);
    if (activeEvidence.length === 0) {
      return { kind: 'no-evidence', leftActive: [] };
    }

    ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
    const slot = resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot, activeEvidence);
    if (slot.kind === 'held') {
      const lineage = lineageFromHolder(classification, slot.manifest);
      if (lineage === 'descendant') {
        const receipt: DiscardReceipt = {
          resetAt,
          resetPolicyCause:
            classification.kind === 'newer-incompatible'
              ? (newerStorePolicy?.cause ?? 'newer-incompatible-invalid-target')
              : classification.kind,
          evidenceBytes: evidenceBytes(activeEvidence),
          deferredTo: slot.holder.incidentId,
        };
        pendingLedger = recordStoreResetPending(runtime.storage, quarantineRoot, slot.ledger, {
          resetAt,
          identities: pendingIdentities(activeEvidence),
          outcome: { kind: 'discard', receipt },
        });
        const discard = discardIncidentEvidence(runtime.storage, files, activeEvidence, () => {
          activeRemovalStarted = true;
        });
        if (discard.identitiesSettled) {
          recordStoreResetDiscarded(runtime.storage, quarantineRoot, pendingLedger, receipt);
          writeAuditEvent('store_reset_discarded', receipt, 'warn');
        }
        return { kind: 'discarded', receipt, leftActive: discard.leftActive };
      }
    }
    ensurePrivateDirectory(runtime.storage, stagingRoot, runtime.env.platform());
    requireDirectorySync(runtime.storage, quarantineRoot);
    runtime.storage.mkdirSync(stagingDirectory);
    if (runtime.env.platform() !== 'win32') {
      runtime.storage.chmodSync(stagingDirectory, 0o700);
    }
    requireDirectorySync(runtime.storage, stagingRoot, files.dbDir);
    const stagingIdentity = assertContainedDirectory(runtime.storage, stagingRoot, stagingDirectory);

    let preservation: PreservationMechanism;
    let publishedEvidence: PublishedIncidentEvidence;
    if (writerExclusion.kind === 'proven') {
      try {
        publishedEvidence = linkIncidentEvidence(
          runtime.storage,
          files,
          activeEvidence,
          stagingDirectory,
          stagingIdentity,
        );
        preservation = { kind: 'linked', coherence: publishedEvidence.coherence === 'torn' ? 'torn' : 'coherent' };
      } catch (error: unknown) {
        if (!(error instanceof StoreResetLinkUnavailable)) throw error;
        removeStagedEvidence(runtime.storage, activeEvidence, stagingDirectory);
        requireDirectorySync(runtime.storage, stagingDirectory);
        publishedEvidence = copyIncidentEvidence(
          runtime.storage,
          files,
          activeEvidence,
          stagingDirectory,
          stagingIdentity,
          'coherent',
        );
        preservation = {
          kind: 'copied',
          cause: unsupportedLinkCause(error.code),
          coherence: publishedEvidence.coherence === 'unproven' ? 'torn' : publishedEvidence.coherence,
        };
      }
    } else {
      publishedEvidence = copyIncidentEvidence(
        runtime.storage,
        files,
        activeEvidence,
        stagingDirectory,
        stagingIdentity,
        'unproven',
      );
      preservation = {
        kind: 'copied',
        cause: { kind: 'exclusion-unproven', reason: writerExclusion.reason },
        coherence: publishedEvidence.coherence === 'coherent' ? 'unproven' : publishedEvidence.coherence,
      };
    }
    const manifestFiles = publishedEvidence.published.map(({ file }) => file);
    if (manifestFiles.length === 0) {
      runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
      requireDirectorySync(runtime.storage, stagingRoot);
      return { kind: 'no-evidence', leftActive: publishedEvidence.leftActive };
    }
    requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
    requireDirectorySync(runtime.storage, stagingDirectory);
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
    const retention: PreservedRetention =
      slot.kind === 'vacant'
        ? { slot: 'claimed' }
        : {
            slot: 'excess',
            holder: slot.holder.incidentId,
            lineage: lineageFromHolder(classification, slot.manifest) === 'unrelated' ? 'unrelated' : 'undeterminable',
          };
    let retentionIncident: StoreResetRetentionIncident = {
      incidentId,
      resetAt,
      evidenceBytes: manifestFiles.reduce((total, file) => total + file.sizeBytes, 0),
      storedProductVersion: classification.storedProductVersion,
      preservation,
      resumeLeftActive: false,
    };
    pendingLedger = recordStoreResetPending(runtime.storage, quarantineRoot, slot.ledger, {
      resetAt,
      identities: pendingIdentities(activeEvidence),
      outcome: { kind: 'preserve', incident: retentionIncident, retention },
    });
    const removal = removeCommittedActiveEvidence(
      runtime.storage,
      files,
      publishedEvidence,
      stagingDirectory,
      stagingIdentity,
      () => {
        activeRemovalStarted = true;
      },
    );
    if (removal.coherence !== preservation.coherence) {
      preservation = { ...preservation, coherence: 'torn' };
      retentionIncident = { ...retentionIncident, preservation };
      pendingLedger = recordStoreResetPending(runtime.storage, quarantineRoot, pendingLedger, {
        resetAt,
        identities: pendingIdentities(activeEvidence),
        outcome: { kind: 'preserve', incident: retentionIncident, retention },
      });
    }
    validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
    requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
    runtime.storage.renameSync(stagingDirectory, finalDirectory);
    requireDirectorySync(runtime.storage, quarantineRoot, stagingRoot);
    recordStoreResetPreserved(runtime.storage, quarantineRoot, pendingLedger, retentionIncident, retention);

    recordIncidentAudit(manifest, preservation, retention);
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
      retention,
      leftActive: removal.leftActive,
    };
  } catch (error: unknown) {
    if (!activeRemovalStarted) {
      runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
      if (pendingLedger !== null) clearStoreResetPending(runtime.storage, quarantineRoot, pendingLedger);
      try {
        requireDirectorySync(runtime.storage, stagingRoot);
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

export function publishClassifiedBackendStoreResetIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  classification: BackendStoreResetClassification,
  resetLock: BackendStoreResetLockLease,
  writerExclusion: WriterExclusion,
  newerStorePolicy?: NewerStoreResetPolicy,
): IncidentPublication {
  resetLock.assertOwned();
  if (writerExclusion.kind === 'proven') writerExclusion.lease.assertOwned();
  return publishIncident(runtime, authority, files, classification, writerExclusion, newerStorePolicy);
}

export function resumeBackendStoreResetIncidentForOperator(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: BackendStoreFileSet,
  resetLock: BackendStoreResetLockLease,
): BackendStoreResetIncident | null {
  resetLock.assertOwned();
  return resumeInterruptedIncident(runtime, files)?.incident ?? null;
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

  // Publish through a same-directory staging path rather than writing evidencePath directly: this mirrors
  // copyIncidentEvidence's staging-then-rename commit, sized down to one file. copyPathCandidateForPublication's
  // own cleanup only runs when the copy throws, not when the process dies mid-write, so the durable
  // publication boundary has to be the rename below. A stale staging path from an earlier interrupted
  // attempt is known-incomplete by construction (nothing ever reads it before it is renamed into place);
  // discard it before writing fresh so copyPathCandidateForPublication's exclusive create does not refuse it.
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
  runtime: Pick<Runtime, 'env' | 'flavor' | 'storage'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  resetLock: BackendStoreResetLockLease,
): ReturnType<typeof resumeInterruptedIncident> {
  resetLock.assertOwned();
  try {
    return resumeInterruptedIncident(runtime, files, (manifest) => {
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
  runtime: Pick<Runtime, 'env' | 'flavor' | 'storage'>,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  resetLock: BackendStoreResetLockLease,
): BackendStoreResetIncident | null {
  return resumeAutomaticBackendStoreReset(runtime, authority, files, resetLock)?.incident ?? null;
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

export function refuseIncompatibleBackendStore(
  runtime: Pick<Runtime, 'flavor'>,
  dbFile: string,
  classification: StoreFormatClassification,
): void {
  const context = {
    path: dbFile,
    flavor: runtime.flavor,
    classification: classification.kind,
    ...('storedFingerprint' in classification ? { storedFingerprint: classification.storedFingerprint } : {}),
  };
  if (classification.kind === 'newer-incompatible') {
    throw documentedCoralSetupError({
      code: 'store_newer_incompatible',
      ...context,
      version: classification.storedProductVersion,
    });
  }
  if (classification.kind === 'older-incompatible') {
    throw documentedCoralSetupError({
      code: 'store_older_incompatible',
      ...context,
      version: classification.storedProductVersion,
    });
  }
  if (classification.kind === 'corrupt-or-unsupported') {
    throw documentedCoralSetupError({
      code: 'store_corrupt_or_unsupported',
      ...context,
    });
  }
  if (classification.kind === 'legacy-adoptable') {
    throw documentedCoralSetupError({
      code: 'store_schema_outdated',
      ...context,
    });
  }
}

type BackendStoreFailureClassification =
  | Readonly<{
      kind: 'corrupt-or-unsupported';
      classification: Extract<StoreFormatClassification, { readonly kind: 'corrupt-or-unsupported' }>;
    }>
  | Readonly<{ kind: 'unavailable'; cause: string }>
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
    return { kind: 'unavailable', cause };
  }
  if (primaryErrorNumber === SQLITE_CORRUPT || primaryErrorNumber === SQLITE_NOTADB) {
    return corruptBackendStoreFailure(current);
  }
  if (/database (?:table )?is locked/iu.test(cause)) {
    return { kind: 'unavailable', cause };
  }
  if (/file is not a database|database disk image is malformed|malformed database schema/iu.test(cause)) {
    return corruptBackendStoreFailure(current);
  }
  return { kind: 'unclassified', cause };
}

export function documentedBackendStoreClassificationFailure(
  runtime: Pick<Runtime, 'flavor'>,
  dbFile: string,
  failure: Extract<BackendStoreFailureClassification, { readonly kind: 'unavailable' | 'unclassified' }>,
): ReturnType<typeof documentedCoralSetupError> {
  return documentedCoralSetupError({
    code: failure.kind === 'unavailable' ? 'store_open_contended' : 'store_open_unclassified',
    path: dbFile,
    flavor: runtime.flavor,
    cause: failure.cause,
  });
}

export function openOrResetBackendStoreDb(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  adoption: GenerationAdoptionLockLease,
  writerExclusion: WriterExclusion,
  options: OpenOrResetBackendStoreOptions,
): Database {
  const files = resolveBackendStoreFileSet(runtime, options);
  const { dbFile } = files;
  const startupBusyTimeoutMs = options.startupBusyTimeoutMs ?? options.busyTimeoutMs;
  const steadyStateBusyTimeoutMs = options.steadyStateBusyTimeoutMs ?? STEADY_STATE_BUSY_TIMEOUT_MS;
  if (dbFile === ':memory:') {
    throw new Error('openOrResetBackendStoreDb requires a real filesystem store path.');
  }

  assertBackendStoreResetAuthority(runtime, authority, options);
  if (options.path === undefined) {
    const readiness = inspectGenerationReadiness(runtime, options.storeFormat);
    switch (readiness.kind) {
      case 'generated-ready':
      case 'no-legacy':
        break;
      case 'legacy-ignored':
        // Startup never depends on a previous generation.
        backendLog.warn(formatLegacyGenerationIgnoredNotice(readiness));
        break;
      default:
        assertNever(readiness);
    }
  }
  const resetLock = acquireBackendStoreResetLock(runtime, files, adoption);
  try {
    if (writerExclusion.kind === 'proven') writerExclusion.lease.assertOwned();
    resumeAutomaticBackendStoreReset(runtime, authority, files, resetLock);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let classification: StoreFormatClassification;
      try {
        classification = classifyStoreFile(dbFile, runtime.storage, options.storeFormat);
      } catch (error: unknown) {
        const failure = classifyBackendStoreFailure(error, options.storeFormat);
        switch (failure.kind) {
          case 'corrupt-or-unsupported':
            classification = failure.classification;
            break;
          case 'unavailable':
          case 'unclassified':
            throw documentedBackendStoreClassificationFailure(runtime, dbFile, failure);
          default:
            return assertNever(failure);
        }
      }
      if (classification.kind === 'older-incompatible' || classification.kind === 'corrupt-or-unsupported') {
        const publication = publishClassifiedBackendStoreResetIncident(
          runtime,
          authority,
          files,
          classification,
          resetLock,
          writerExclusion,
        );
        if (!publication.leftActive.includes('store.db')) break;
        if (attempt === 1) refuseIncompatibleBackendStore(runtime, dbFile, classification);
      } else {
        refuseIncompatibleBackendStore(runtime, dbFile, classification);
        break;
      }
    }

    const db = openStoreDatabase({
      path: dbFile,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: startupBusyTimeoutMs,
    });
    db.exec(`PRAGMA busy_timeout = ${steadyStateBusyTimeoutMs}`);
    return db;
  } finally {
    resetLock.release();
  }
}
