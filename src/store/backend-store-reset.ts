import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import type { StoragePort } from '../infra/port-types.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { classifyStoreFormat, openStoreDatabase, type Database, type StoreFormatClassification } from './db.js';
import type { StoreFormatDescription, StoreFormatFingerprint } from './format-fingerprint.js';
import {
  isCanonicalStoreResetIncidentId,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_QUARANTINE_DIRECTORY,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentFile,
  type StoreResetIncidentManifestV2,
} from './reset-incident.js';

const STORE_FORMAT_SIDECAR_SUFFIX = '.format';
const STEADY_STATE_BUSY_TIMEOUT_MS = 5_000;
const QUARANTINE_RENAME_BACKOFF_MS = [0, 10, 25, 50, 100] as const;
const quarantineRenameWaitState = new Int32Array(new SharedArrayBuffer(4));
const STORE_FORMAT_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const BACKEND_STORE_RESET_AUTHORITY_BRAND: unique symbol = Symbol('BackendStoreResetAuthority');

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

function storedFingerprint(
  classification: Exclude<StoreFormatClassification, { kind: 'fresh' | 'current' }>,
): string | null {
  return classification.kind === 'mismatch' && STORE_FORMAT_FINGERPRINT_PATTERN.test(classification.stored)
    ? classification.stored
    : null;
}

function fileDigestSha256(storage: StoragePort, path: string): string {
  const descriptor = storage.openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = storage.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    storage.closeSync(descriptor);
  }
}

function describeCandidate(storage: StoragePort, candidate: StoreFileCandidate): StoreResetIncidentFile {
  const stat = storage.statSync(candidate.source);
  return {
    name: candidate.name,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: fileDigestSha256(storage, candidate.source),
  };
}

function isBusyRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

function waitForQuarantineRenameRetry(ms: number): void {
  if (ms > 0) {
    Atomics.wait(quarantineRenameWaitState, 0, 0, ms);
  }
}

function renameStoreFileForQuarantine(storage: StoragePort, source: string, destination: string): void {
  for (let attempt = 0; attempt <= QUARANTINE_RENAME_BACKOFF_MS.length; attempt++) {
    try {
      storage.renameSync(source, destination);
      return;
    } catch (error: unknown) {
      if (!isBusyRenameError(error) || attempt === QUARANTINE_RENAME_BACKOFF_MS.length) {
        throw error;
      }
      waitForQuarantineRenameRetry(QUARANTINE_RENAME_BACKOFF_MS[attempt]);
    }
  }
}

function ensureQuarantineRoot(storage: StoragePort, root: string, platform: string): void {
  if (storage.existsSync(root)) {
    const stat = storage.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Store reset quarantine root is not a directory.');
    }
    return;
  }
  storage.mkdirSync(root);
  if (platform !== 'win32') {
    storage.chmodSync(root, 0o700);
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
  const actual = describeCandidate(storage, candidate);
  return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256;
}

function resumeInterruptedIncident(
  runtime: Pick<Runtime, 'env' | 'storage'>,
  files: StoreFileSet,
): { readonly incident: BackendStoreResetIncident; readonly manifest: StoreResetIncidentManifestV2 } | null {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  if (!runtime.storage.existsSync(quarantineRoot)) return null;
  ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
  const stagingNames = runtime.storage
    .readdirSync(quarantineRoot)
    .filter((name) => name.endsWith('.tmp') && isCanonicalStoreResetIncidentId(name.slice(0, -4)));
  if (stagingNames.length === 0) return null;
  if (stagingNames.length !== 1) throw new Error('Multiple interrupted store-reset publications exist.');

  const stagingName = stagingNames[0];
  const stagingDirectory = join(quarantineRoot, stagingName);
  const manifestPath = join(stagingDirectory, STORE_RESET_MANIFEST_FILE_NAME);
  if (!runtime.storage.existsSync(manifestPath)) {
    const entries = runtime.storage.readdirSync(stagingDirectory);
    if (!entries.some((name) => STORE_RESET_EVIDENCE_FILE_NAMES.includes(name as StoreResetEvidenceFileName))) {
      runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
      requireDirectorySync(runtime.storage, quarantineRoot);
      return null;
    }
    throw new Error('Interrupted store-reset publication moved evidence without a durable manifest.');
  }
  const manifest = parseStoreResetIncidentManifest(Buffer.from(runtime.storage.readFileSync(manifestPath, 'utf-8')));
  if (`${manifest.incidentId}.tmp` !== stagingName) {
    throw new Error('Interrupted store-reset publication identity does not match its directory.');
  }

  for (const expected of manifest.files) {
    const active = candidateForEvidence(files, expected.name);
    const staged = { source: join(stagingDirectory, expected.name), name: expected.name };
    if (evidenceMatches(runtime.storage, staged, expected)) {
      if (runtime.storage.existsSync(active.source)) {
        throw new Error('Interrupted store-reset publication has both active and staged evidence.');
      }
      continue;
    }
    if (!evidenceMatches(runtime.storage, active, expected)) {
      throw new Error('Interrupted store-reset publication evidence is missing or changed.');
    }
    renameStoreFileForQuarantine(runtime.storage, active.source, staged.source);
    requireDirectorySync(runtime.storage, files.dbDir, stagingDirectory);
  }
  const recordedNames = new Set(manifest.files.map((file) => file.name));
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    if (!recordedNames.has(name) && runtime.storage.existsSync(candidateForEvidence(files, name).source)) {
      throw new Error('Interrupted store-reset publication found unrecorded active evidence.');
    }
  }

  runtime.storage.renameSync(stagingDirectory, join(quarantineRoot, manifest.incidentId));
  requireDirectorySync(runtime.storage, quarantineRoot);
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

function publishIncident(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'ids' | 'storage' | 'time'>,
  authority: BackendStoreResetAuthority,
  files: StoreFileSet,
  classification: Exclude<StoreFormatClassification, { kind: 'fresh' | 'current' }>,
): BackendStoreResetIncident | undefined {
  const candidates: StoreFileCandidate[] = [
    { source: files.dbFile, name: STORE_RESET_EVIDENCE_FILE_NAMES[0] },
    { source: files.walFile, name: STORE_RESET_EVIDENCE_FILE_NAMES[1] },
    { source: files.shmFile, name: STORE_RESET_EVIDENCE_FILE_NAMES[2] },
    { source: files.formatFile, name: STORE_RESET_EVIDENCE_FILE_NAMES[3] },
  ].filter((entry) => runtime.storage.existsSync(entry.source));
  if (candidates.length === 0) {
    return undefined;
  }

  const incidentId = runtime.ids.uuid();
  const resetAt = new Date(runtime.time.now()).toISOString();
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const stagingDirectory = join(quarantineRoot, `${incidentId}.tmp`);
  const finalDirectory = join(quarantineRoot, incidentId);
  let destructiveMoveStarted = false;

  try {
    ensureQuarantineRoot(runtime.storage, quarantineRoot, runtime.env.platform());
    runtime.storage.mkdirSync(stagingDirectory);
    if (runtime.env.platform() !== 'win32') {
      runtime.storage.chmodSync(stagingDirectory, 0o700);
    }
    requireDirectorySync(runtime.storage, files.dbDir, quarantineRoot);

    const manifestFiles = candidates.map((candidate) => describeCandidate(runtime.storage, candidate));
    const manifest: StoreResetIncidentManifestV2 = {
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
      files: manifestFiles,
    };
    const published = runtime.storage.writeAtomicDurableSync(
      join(stagingDirectory, STORE_RESET_MANIFEST_FILE_NAME),
      serializeStoreResetIncidentManifest(manifest),
      { encoding: 'utf-8', mode: 0o600 },
    );
    if (!published) {
      throw new Error('Store reset incident manifest already exists.');
    }
    for (const candidate of candidates) {
      destructiveMoveStarted = true;
      renameStoreFileForQuarantine(runtime.storage, candidate.source, join(stagingDirectory, candidate.name));
      requireDirectorySync(runtime.storage, files.dbDir, stagingDirectory);
    }
    runtime.storage.renameSync(stagingDirectory, finalDirectory);
    requireDirectorySync(runtime.storage, quarantineRoot);

    writeAuditEvent(
      'store_reset_quarantine',
      {
        incidentId,
        resetAt,
        reason: classification.kind,
        storedFingerprint: storedFingerprint(classification),
        expectedFingerprint: classification.current,
        version: authority.version,
        buildSetId: authority.buildSetId,
        flavor: authority.flavor,
        acquiredViaHandoff: authority.acquiredViaHandoff,
        fileCount: manifestFiles.length,
      },
      'warn',
    );
    return {
      incidentId,
      resetAt,
      reason: classification.kind,
      fileCount: manifestFiles.length,
    };
  } catch (error: unknown) {
    if (!destructiveMoveStarted) {
      runtime.storage.rmSync(stagingDirectory, { recursive: true, force: true });
      try {
        requireDirectorySync(runtime.storage, quarantineRoot);
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

function warnBackendStoreReset(
  classification: Exclude<StoreFormatClassification, { kind: 'fresh' | 'current' }>,
  incident: BackendStoreResetIncident | undefined,
): void {
  backendLog.warn(
    `Backend store format mismatch (stored fingerprint ${storedFingerprint(classification) ?? 'missing'}, ` +
      `expected ${classification.current}); resetting backend store. ` +
      'Active Coral history/state is unavailable in the new store; ' +
      'KB Markdown is unaffected. ' +
      (incident === undefined
        ? ''
        : `Incident ${incident.incidentId} was recorded. If this reset was unexpected, run ` +
          `coral-cli backend store-reset report ${incident.incidentId}.`),
  );
}

function classifyStoreFile(
  path: string,
  storage: Pick<StoragePort, 'existsSync'>,
  storeFormat: StoreFormatDescription,
): StoreFormatClassification {
  if (path !== ':memory:' && !storage.existsSync(path)) {
    return { kind: 'fresh' };
  }
  const db = new DatabaseSync(path, { readOnly: true }) as unknown as Database;
  try {
    return classifyStoreFormat(db, storeFormat.fingerprint);
  } finally {
    db.close();
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

    let resumed: ReturnType<typeof resumeInterruptedIncident>;
    try {
      resumed = resumeInterruptedIncident(runtime, files);
    } catch (error: unknown) {
      throw documentedCoralSetupError({
        code: 'store_reset_quarantine_failed',
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (resumed !== null) {
      const classification =
        resumed.manifest.reason === 'missing'
          ? ({
              kind: 'missing',
              current: resumed.manifest.expectedFingerprint as StoreFormatFingerprint,
            } as const)
          : ({
              kind: 'mismatch',
              current: resumed.manifest.expectedFingerprint as StoreFormatFingerprint,
              stored: resumed.manifest.storedFingerprint ?? 'missing',
            } as const);
      warnBackendStoreReset(classification, resumed.incident);
    }

    const classification = classifyStoreFile(files.dbFile, runtime.storage, options.storeFormat);
    if (classification.kind === 'missing' || classification.kind === 'mismatch') {
      const incident = publishIncident(runtime, authority, files, classification);
      warnBackendStoreReset(classification, incident);
    }

    const db = openStoreDatabase({
      path: files.dbFile,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      busyTimeoutMs: startupBusyTimeoutMs,
    });
    db.exec(`PRAGMA busy_timeout = ${steadyStateBusyTimeoutMs}`);
    return db;
  } finally {
    releaseLock?.();
  }
}
