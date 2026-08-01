import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { classifyStoreFile, openStoreDatabase, type Database } from './db.js';
import {
  isStoreFormatFingerprint,
  type StoreFormatClassification,
  type StoreFormatDescription,
  type StoreFormatFingerprint,
} from './format-fingerprint.js';
import { formatLegacyForeignGenerationNotice, inspectGenerationReadiness } from './generation-mutation-coordination.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_REPORT_HASH_BYTES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_QUARANTINE_DIRECTORY,
  STORE_RESET_STAGING_DIRECTORY,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentFile,
  type StoreResetIncidentManifestV2,
} from './reset-incident.js';

const STORE_FORMAT_SIDECAR_SUFFIX = '.format';
const STEADY_STATE_BUSY_TIMEOUT_MS = 5_000;

const BACKEND_STORE_RESET_AUTHORITY_BRAND: unique symbol = Symbol('BackendStoreResetAuthority');

type ResettableStoreFormatClassification =
  | { readonly kind: 'missing'; readonly current: StoreFormatFingerprint }
  | { readonly kind: 'mismatch'; readonly current: StoreFormatFingerprint; readonly stored: string };

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

type BackendStorePathOptions = {
  readonly path?: string;
  readonly busyTimeoutMs?: number;
  readonly storeFormat: StoreFormatDescription;
};

type BackendStoreResetAuthorityOptions = BackendStorePathOptions & {
  readonly namespace: string;
  readonly build: StrictBundleManifest;
};

type OpenOrResetBackendStoreOptions = BackendStorePathOptions & {
  readonly startupBusyTimeoutMs?: number;
  readonly steadyStateBusyTimeoutMs?: number;
};

type StoreFileSet = {
  readonly dbDir: string;
  readonly dbFile: string;
  readonly walFile: string;
  readonly shmFile: string;
  readonly formatFile: string;
};

type StoreFileCandidate = {
  readonly source: string;
  readonly name: StoreResetEvidenceFileName;
};

export type BackendStoreResetIncident = {
  readonly incidentId: string;
  readonly resetAt: string;
  readonly reason: 'missing' | 'mismatch';
  readonly fileCount: number;
};

function resolveStoreDbPath(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions): string {
  if (options.path === ':memory:') {
    return ':memory:';
  }
  return resolve(options.path ?? runtime.paths.coral.store.dbFile);
}

function resolveStoreFileSet(runtime: Pick<Runtime, 'paths'>, options: BackendStorePathOptions): StoreFileSet {
  if (options.path === undefined) {
    const store = runtime.paths.coral.store;
    return {
      dbDir: store.dbDir,
      dbFile: store.dbFile,
      walFile: store.walFile,
      shmFile: store.shmFile,
      formatFile: `${store.dbFile}${STORE_FORMAT_SIDECAR_SUFFIX}`,
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

function assertResetAuthority(
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

function storedFingerprint(classification: ResettableStoreFormatClassification): string | null {
  return classification.kind === 'mismatch' && isStoreFormatFingerprint(classification.stored)
    ? classification.stored
    : null;
}

function resettableStoreFormatClassification(
  classification: StoreFormatClassification,
): ResettableStoreFormatClassification | null {
  if (
    classification.kind === 'absent' ||
    classification.kind === 'fresh' ||
    classification.kind === 'compatible' ||
    classification.kind === 'legacy-adoptable'
  ) {
    return null;
  }
  const storedFingerprint = classification.storedFingerprint;
  if (isStoreFormatFingerprint(storedFingerprint)) {
    return {
      kind: 'mismatch',
      current: classification.currentFingerprint,
      stored: storedFingerprint,
    };
  }
  return { kind: 'missing', current: classification.currentFingerprint };
}

function sameFileIdentity(left: StorageBigIntStat, right: StorageBigIntStat): boolean {
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
): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (total < expectedSize) {
    const requested = Math.min(buffer.length, expectedSize - total);
    const bytesRead = storage.readSync(descriptor, buffer, 0, requested, null);
    if (bytesRead <= 0 || bytesRead > requested) {
      throw new Error('Store-reset evidence read failed.');
    }
    consume?.(buffer, bytesRead);
    total += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (storage.readSync(descriptor, buffer, 0, 1, null) !== 0) {
    throw new Error('Store-reset evidence grew during reading.');
  }
  return hash.digest('hex');
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

function describeCandidate(
  storage: StoragePort,
  candidate: StoreFileCandidate,
  remainingBudget: number,
): StoreResetIncidentFile {
  const pathBefore = stablePathStat(storage, candidate.source);
  if (
    !pathBefore.isFile() ||
    pathBefore.size < 0n ||
    pathBefore.size > BigInt(remainingBudget) ||
    pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Store-reset evidence exceeds the bounded hashing budget.');
  }

  const descriptor = storage.openSync(candidate.source, 'r');
  let digest: string;
  let closeFailure: unknown = null;
  try {
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(pathBefore, opened)) {
      throw new Error('Store-reset evidence identity changed before hashing.');
    }
    const expectedSize = Number(opened.size);
    digest = hashExactDescriptor(storage, descriptor, expectedSize);
    const openedAfter = storage.fstatSync(descriptor, { bigint: true });
    const pathAfter = stablePathStat(storage, candidate.source);
    if (!sameFileIdentity(opened, openedAfter) || !sameFileIdentity(opened, pathAfter)) {
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

function copyCandidateForPublication(
  storage: StoragePort,
  candidate: StoreFileCandidate,
  destination: string,
  remainingBudget: number,
): StoreResetIncidentFile {
  const pathBefore = stablePathStat(storage, candidate.source);
  if (
    !pathBefore.isFile() ||
    pathBefore.size < 0n ||
    pathBefore.size > BigInt(remainingBudget) ||
    pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Store-reset evidence exceeds the bounded publication budget.');
  }

  let sourceDescriptor: number | null = null;
  let destinationDescriptor: number | null = null;
  let closeFailure = false;
  let result: StoreResetIncidentFile | null = null;
  try {
    sourceDescriptor = storage.openSync(candidate.source, 'r');
    const sourceOpened = storage.fstatSync(sourceDescriptor, { bigint: true });
    if (!sourceOpened.isFile() || !sameFileIdentity(pathBefore, sourceOpened)) {
      throw new Error('Store-reset evidence identity changed before publication.');
    }
    const openedDestination = storage.openSync(destination, 'wx', 0o600);
    destinationDescriptor = openedDestination;

    const expectedSize = Number(sourceOpened.size);
    const digest = hashExactDescriptor(storage, sourceDescriptor, expectedSize, (buffer, length) => {
      writeExactDescriptor(storage, openedDestination, buffer, length);
    });
    const sourceAfter = storage.fstatSync(sourceDescriptor, { bigint: true });
    const sourcePathAfter = stablePathStat(storage, candidate.source);
    if (!sameFileIdentity(sourceOpened, sourceAfter) || !sameFileIdentity(sourceOpened, sourcePathAfter)) {
      throw new Error('Store-reset evidence identity changed during publication.');
    }

    storage.fdatasyncSync(destinationDescriptor);
    const destinationOpened = storage.fstatSync(destinationDescriptor, { bigint: true });
    if (!destinationOpened.isFile() || destinationOpened.size !== sourceOpened.size) {
      throw new Error('Published store-reset evidence has an unexpected size.');
    }
    result = {
      name: candidate.name,
      sizeBytes: expectedSize,
      mtimeMs: Number(sourceOpened.mtimeNs / 1_000_000n),
      sha256: digest,
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
    destinationAfter.size !== BigInt(result.sizeBytes) ||
    !evidenceMatches(storage, { source: destination, name: candidate.name }, result)
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
    if (!sameFileIdentity(pathBefore, opened)) {
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
    if (!sameFileIdentity(opened, openedAfter) || !sameFileIdentity(opened, pathAfter)) {
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

function assertQuarantineRoot(storage: StoragePort, root: string): void {
  const stat = storage.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Store reset quarantine root is not a directory.');
  }
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

function assertContainedDirectory(storage: StoragePort, parent: string, child: string): StorageBigIntStat {
  const link = storage.lstatSync(child);
  const stat = storage.statSync(child, { bigint: true });
  if (!link.isDirectory() || link.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Interrupted store-reset staging entry is not a directory.');
  }
  const expected = resolve(storage.realpathSync(parent), child.slice(parent.length + 1));
  if (resolve(storage.realpathSync(child)) !== expected) {
    throw new Error('Interrupted store-reset staging directory escapes its parent.');
  }
  return stat;
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

function candidateForEvidence(files: StoreFileSet, name: StoreResetEvidenceFileName): StoreFileCandidate {
  const source =
    name === 'store.db'
      ? files.dbFile
      : name === 'store.db-wal'
        ? files.walFile
        : name === 'store.db-shm'
          ? files.shmFile
          : files.formatFile;
  return { source, name };
}

function evidenceMatches(
  storage: StoragePort,
  candidate: StoreFileCandidate,
  expected: StoreResetIncidentFile,
): boolean {
  if (!storage.existsSync(candidate.source)) return false;
  const actual = describeCandidate(storage, candidate, MAX_REPORT_HASH_BYTES);
  return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256;
}

function validateStagingEntries(
  storage: StoragePort,
  stagingDirectory: string,
  manifest: StoreResetIncidentManifestV2,
  requireComplete: boolean,
): void {
  const read = storage.readDirectoryBoundedSync(stagingDirectory, MAX_INCIDENT_DIR_ENTRIES);
  if (read.overflow) {
    throw new Error('Interrupted store-reset staging directory exceeds its entry limit.');
  }
  const expected = new Set<string>([STORE_RESET_MANIFEST_FILE_NAME, ...manifest.files.map((file) => file.name)]);
  if (read.entries.some((entry) => !expected.has(entry))) {
    throw new Error('Interrupted store-reset publication contains unexpected content.');
  }
  if (requireComplete && read.entries.length !== expected.size) {
    throw new Error('Interrupted store-reset publication is incomplete.');
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

function reconcileCommittedEvidence(
  storage: StoragePort,
  files: StoreFileSet,
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
  manifest: StoreResetIncidentManifestV2,
): void {
  let remainingBudget = MAX_REPORT_HASH_BYTES;
  for (const expected of manifest.files) {
    if (expected.sizeBytes > remainingBudget) {
      throw new Error('Interrupted store-reset publication exceeds the cumulative evidence budget.');
    }
    const active = candidateForEvidence(files, expected.name);
    const staged = { source: join(stagingDirectory, expected.name), name: expected.name };
    if (!evidenceMatches(storage, staged, expected)) {
      throw new Error('Interrupted store-reset publication evidence is missing or changed.');
    }
    if (storage.existsSync(active.source)) {
      if (!evidenceMatches(storage, active, expected)) {
        throw new Error('Interrupted store-reset publication has conflicting active and staged evidence.');
      }
      requireSameDirectory(storage, stagingDirectory, stagingIdentity);
      storage.unlinkSync(active.source);
      requireDirectorySync(storage, files.dbDir);
    }
    remainingBudget -= expected.sizeBytes;
  }

  const recordedNames = new Set(manifest.files.map((file) => file.name));
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    if (!recordedNames.has(name) && storage.existsSync(candidateForEvidence(files, name).source)) {
      throw new Error('Interrupted store-reset publication found unrecorded active evidence.');
    }
  }
}

function resumeInterruptedIncident(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: StoreFileSet,
): { readonly incident: BackendStoreResetIncident; readonly manifest: StoreResetIncidentManifestV2 } | null {
  const interrupted = detectInterruptedIncident(runtime, files);
  if (interrupted === null) return null;
  if (interrupted.manifest === null) {
    discardUncommittedStaging(runtime.storage, interrupted.stagingDirectory, interrupted.stagingRoot);
    return null;
  }

  const { manifest, quarantineRoot, stagingDirectory, stagingIdentity, stagingRoot } = interrupted;
  reconcileCommittedEvidence(runtime.storage, files, stagingDirectory, stagingIdentity, manifest);

  validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
  requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
  runtime.storage.renameSync(stagingDirectory, join(quarantineRoot, manifest.incidentId));
  requireDirectorySync(runtime.storage, quarantineRoot, stagingRoot);
  return {
    incident: {
      incidentId: manifest.incidentId,
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      fileCount: manifest.files.length,
    },
    manifest,
  };
}

type InterruptedIncident = {
  readonly incidentId: string;
  readonly manifest: StoreResetIncidentManifestV2 | null;
  readonly quarantineRoot: string;
  readonly stagingDirectory: string;
  readonly stagingIdentity: StorageBigIntStat;
  readonly stagingRoot: string;
};

function detectInterruptedIncident(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: StoreFileSet,
): InterruptedIncident | null {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  if (!runtime.storage.existsSync(quarantineRoot)) return null;
  assertQuarantineRoot(runtime.storage, quarantineRoot);
  const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
  if (!runtime.storage.existsSync(stagingRoot)) return null;
  assertPrivateDirectory(runtime.storage, stagingRoot, runtime.env.platform());
  const stagingRead = runtime.storage.readDirectoryBoundedSync(stagingRoot, 1);
  if (stagingRead.overflow) throw new Error('Multiple interrupted store-reset publications exist.');
  const stagingNames = stagingRead.entries.filter(isCanonicalStoreResetIncidentId);
  if (stagingNames.length !== stagingRead.entries.length) {
    throw new Error('Unexpected entry exists in the store-reset staging directory.');
  }
  if (stagingNames.length === 0) return null;

  const stagingName = stagingNames[0];
  const stagingDirectory = join(stagingRoot, stagingName);
  const stagingIdentity = assertContainedDirectory(runtime.storage, stagingRoot, stagingDirectory);
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
  const manifest = parseStoreResetIncidentManifest(readManifestBounded(runtime.storage, manifestPath));
  if (manifest.incidentId !== stagingName) {
    throw new Error('Interrupted store-reset publication identity does not match its directory.');
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

function activeEvidenceCandidates(storage: StoragePort, files: StoreFileSet): StoreFileCandidate[] {
  return STORE_RESET_EVIDENCE_FILE_NAMES.map((name) => candidateForEvidence(files, name)).filter((candidate) =>
    storage.existsSync(candidate.source),
  );
}

function copyIncidentEvidence(
  storage: StoragePort,
  candidates: readonly StoreFileCandidate[],
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
): StoreResetIncidentFile[] {
  let remainingBudget = MAX_REPORT_HASH_BYTES;
  return candidates.map((candidate) => {
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    const described = copyCandidateForPublication(
      storage,
      candidate,
      join(stagingDirectory, candidate.name),
      remainingBudget,
    );
    remainingBudget -= described.sizeBytes;
    return described;
  });
}

function removeCommittedActiveEvidence(
  storage: StoragePort,
  files: StoreFileSet,
  candidates: readonly StoreFileCandidate[],
  manifestFiles: readonly StoreResetIncidentFile[],
  stagingDirectory: string,
  stagingIdentity: StorageBigIntStat,
  markStarted: () => void,
): void {
  for (const [index, candidate] of candidates.entries()) {
    const expected = manifestFiles[index];
    if (expected === undefined || !evidenceMatches(storage, candidate, expected)) {
      throw new Error('Store-reset evidence changed before active removal.');
    }
    requireSameDirectory(storage, stagingDirectory, stagingIdentity);
    markStarted();
    storage.unlinkSync(candidate.source);
    requireDirectorySync(storage, files.dbDir);
  }
}

function createIncidentManifest(
  runtime: Pick<Runtime, 'env'>,
  authority: BackendStoreResetAuthority,
  classification: ResettableStoreFormatClassification,
  incidentId: string,
  resetAt: string,
  files: readonly StoreResetIncidentFile[],
): StoreResetIncidentManifestV2 {
  return {
    schemaVersion: 2,
    incidentId,
    resetAt,
    reason: classification.kind,
    storedFingerprint: storedFingerprint(classification),
    expectedFingerprint: classification.current,
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
}

function recordIncidentAudit(manifest: StoreResetIncidentManifestV2): void {
  writeAuditEvent(
    'store_reset_quarantine',
    {
      incidentId: manifest.incidentId,
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      storedFingerprint: manifest.storedFingerprint,
      expectedFingerprint: manifest.expectedFingerprint,
      version: manifest.build.version,
      buildSetId: manifest.build.buildSetId,
      flavor: manifest.build.flavor,
      acquiredViaHandoff: manifest.handoff.acquiredViaHandoff,
      fileCount: manifest.files.length,
    },
    'warn',
  );
}

function publishIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: StoreFileSet,
  classification: ResettableStoreFormatClassification,
): BackendStoreResetIncident | undefined {
  const candidates = activeEvidenceCandidates(runtime.storage, files);
  if (candidates.length === 0) {
    return undefined;
  }

  const incidentId = runtime.ids.uuid();
  const resetAt = new Date(runtime.time.now()).toISOString();
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
  const stagingDirectory = join(stagingRoot, incidentId);
  const finalDirectory = join(quarantineRoot, incidentId);
  let activeRemovalStarted = false;

  try {
    ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
    ensurePrivateDirectory(runtime.storage, stagingRoot, runtime.env.platform());
    requireDirectorySync(runtime.storage, quarantineRoot);
    runtime.storage.mkdirSync(stagingDirectory);
    if (runtime.env.platform() !== 'win32') {
      runtime.storage.chmodSync(stagingDirectory, 0o700);
    }
    requireDirectorySync(runtime.storage, stagingRoot, files.dbDir);
    const stagingIdentity = assertContainedDirectory(runtime.storage, stagingRoot, stagingDirectory);

    const manifestFiles = copyIncidentEvidence(runtime.storage, candidates, stagingDirectory, stagingIdentity);
    requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
    requireDirectorySync(runtime.storage, stagingDirectory);
    const manifest = createIncidentManifest(runtime, authority, classification, incidentId, resetAt, manifestFiles);
    const published = runtime.storage.writeAtomicDurableSync(
      join(stagingDirectory, STORE_RESET_MANIFEST_FILE_NAME),
      serializeStoreResetIncidentManifest(manifest),
      { encoding: 'utf-8', mode: 0o600 },
    );
    if (!published) {
      throw new Error('Store reset incident manifest could not be published durably.');
    }
    requireDirectorySync(runtime.storage, stagingDirectory);
    removeCommittedActiveEvidence(
      runtime.storage,
      files,
      candidates,
      manifestFiles,
      stagingDirectory,
      stagingIdentity,
      () => {
        activeRemovalStarted = true;
      },
    );
    validateStagingEntries(runtime.storage, stagingDirectory, manifest, true);
    requireSameDirectory(runtime.storage, stagingDirectory, stagingIdentity);
    runtime.storage.renameSync(stagingDirectory, finalDirectory);
    requireDirectorySync(runtime.storage, quarantineRoot, stagingRoot);

    recordIncidentAudit(manifest);
    return {
      incidentId,
      resetAt,
      reason: classification.kind,
      fileCount: manifestFiles.length,
    };
  } catch (error: unknown) {
    if (!activeRemovalStarted) {
      runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
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

export function resumeInterruptedBackendStoreResetIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage'>,
  authority: BackendStoreResetAuthority,
  options: BackendStorePathOptions,
): BackendStoreResetIncident | null {
  assertResetAuthority(runtime, authority, options);
  const files = resolveStoreFileSet(runtime, options);
  if (files.dbFile === ':memory:') {
    throw new Error('Store reset requires a real filesystem store path.');
  }
  return resumeInterruptedIncident(runtime, files)?.incident ?? null;
}

export function publishBackendStoreResetIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  options: BackendStorePathOptions,
): BackendStoreResetIncident | undefined {
  assertResetAuthority(runtime, authority, options);
  const files = resolveStoreFileSet(runtime, options);
  if (files.dbFile === ':memory:') {
    throw new Error('Store reset requires a real filesystem store path.');
  }
  const classification = classifyStoreFile(files.dbFile, runtime.storage, options.storeFormat);
  const resettableClassification = resettableStoreFormatClassification(classification);
  return resettableClassification === null
    ? undefined
    : publishIncident(runtime, authority, files, resettableClassification);
}

function refuseInterruptedIncident(runtime: Pick<Runtime, 'env' | 'flavor' | 'storage'>, files: StoreFileSet): void {
  let interrupted: InterruptedIncident | null;
  try {
    interrupted = detectInterruptedIncident(runtime, files);
  } catch (error: unknown) {
    throw documentedCoralSetupError({
      code: 'store_reset_quarantine_failed',
      reason: 'interrupted',
      flavor: runtime.flavor,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (interrupted !== null) {
    throw documentedCoralSetupError({
      code: 'store_reset_quarantine_failed',
      reason: 'interrupted',
      flavor: runtime.flavor,
      incidentId: interrupted.incidentId,
    });
  }
}

function refuseIncompatibleStore(
  runtime: Pick<Runtime, 'flavor'>,
  files: StoreFileSet,
  classification: StoreFormatClassification,
): void {
  const context = {
    path: files.dbFile,
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

export function openOrResetBackendStoreDb(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  options: OpenOrResetBackendStoreOptions,
): Database {
  const files = resolveStoreFileSet(runtime, options);
  const startupBusyTimeoutMs = options.startupBusyTimeoutMs ?? options.busyTimeoutMs;
  const steadyStateBusyTimeoutMs = options.steadyStateBusyTimeoutMs ?? STEADY_STATE_BUSY_TIMEOUT_MS;
  if (files.dbFile === ':memory:') {
    throw new Error('openOrResetBackendStoreDb requires a real filesystem store path.');
  }

  assertResetAuthority(runtime, authority, options);
  if (options.path === undefined) {
    const readiness = inspectGenerationReadiness(runtime, options.storeFormat);
    switch (readiness.kind) {
      case 'generated-ready':
      case 'no-legacy':
        break;
      case 'legacy-foreign':
        backendLog.warn(formatLegacyForeignGenerationNotice(readiness));
        break;
      case 'legacy-adoptable':
        throw documentedCoralSetupError({
          code: 'legacy_adoption_required',
          flavor: runtime.flavor,
          legacyPath: readiness.legacyPath,
        });
      default:
        assertNever(readiness);
    }
  }
  runtime.storage.mkdirSync(files.dbDir, { recursive: true });

  let releaseLock: (() => void) | null = null;
  try {
    const lockPath = join(files.dbDir, 'store.db.reset.lock');
    try {
      releaseLock = acquireDirectoryLockSync(lockPath, 250);
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

    refuseInterruptedIncident(runtime, files);

    let classification: StoreFormatClassification;
    try {
      classification = classifyStoreFile(files.dbFile, runtime.storage, options.storeFormat);
    } catch (error: unknown) {
      throw documentedCoralSetupError({
        code: 'store_corrupt_or_unsupported',
        path: files.dbFile,
        flavor: runtime.flavor,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    refuseIncompatibleStore(runtime, files, classification);

    const db = openStoreDatabase({
      path: files.dbFile,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      busyTimeoutMs: startupBusyTimeoutMs,
    });
    db.exec(`PRAGMA busy_timeout = ${steadyStateBusyTimeoutMs}`);
    return db;
  } finally {
    releaseLock?.();
  }
}
