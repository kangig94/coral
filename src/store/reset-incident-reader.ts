import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_REPORT_HASH_BYTES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  projectStoreResetPublicReport,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_INCIDENT_SCHEMA_VERSION,
  type STORE_RESET_RETAINED_INCIDENT_SCHEMA_VERSION,
  STORE_RESET_MANIFEST_FILE_NAME,
  StoreResetManifestDecodeError,
  type StoreResetIncidentLocalReport,
  type StoreResetIncidentManifest,
  type StoreResetPolicyCause,
  type StoreResetReason,
  type StoreResetPublicReport,
} from './reset-incident.js';
import {
  MAX_RESET_RETENTION_LEDGER_BYTES,
  parseStoreResetRetentionLedger,
  STORE_RESET_RETENTION_LEDGER_FILE_NAME,
  type PreservationMechanism,
  type PreservedRetention,
  type StoreResetRetentionLedger,
} from './reset-retention.js';
import {
  sameStoreResetInspectionIdentity,
  type StoreResetFileDescriptor,
  type StoreResetInspectionFs,
  type StoreResetInspectionStat,
} from './reset-incident-inspection-fs.js';
import type { StoreResetIncidentDiagnosticRunner } from './reset-incident-diagnostic.js';

type StoreResetIncidentListBase =
  | {
      readonly incidentId: string;
      readonly state: 'ready';
      readonly resetAt: string;
      readonly reason: StoreResetReason;
      readonly schemaVersion:
        | typeof STORE_RESET_RETAINED_INCIDENT_SCHEMA_VERSION
        | typeof STORE_RESET_INCIDENT_SCHEMA_VERSION;
      readonly resetPolicyCause: StoreResetPolicyCause | null;
      readonly fileCount: number;
    }
  | {
      readonly incidentId: string;
      readonly state: 'malformed' | 'unsupported' | 'build_mismatch' | 'unsafe' | 'unavailable';
      readonly resetAt: null;
      readonly reason: null;
      readonly schemaVersion: null;
      readonly resetPolicyCause: null;
      readonly fileCount: null;
    };

export type StoreResetIncidentListEntry = StoreResetIncidentListBase & {
  readonly retention:
    | (PreservedRetention & {
        readonly preservation: PreservationMechanism | 'unknown';
        readonly resumeLeftActive: boolean;
        readonly parked: readonly string[];
      })
    | { readonly slot: 'unknown' };
  readonly storedProductVersion: string | null | 'unknown';
  readonly evidenceBytes: number | 'unknown';
};

export type StoreResetIncidentListResult = {
  readonly incidents: readonly StoreResetIncidentListEntry[];
  readonly truncated: boolean;
  readonly discarded: StoreResetRetentionLedger['discarded'];
};

export type StoreResetIncidentReportFailure =
  | 'invalid_id'
  | 'not_found'
  | 'malformed'
  | 'unsupported'
  | 'build_mismatch'
  | 'unsafe'
  | 'unavailable';

export type StoreResetIncidentReportResult =
  | { readonly ok: true; readonly report: StoreResetPublicReport }
  | { readonly ok: false; readonly state: StoreResetIncidentReportFailure };

class StoreResetIncidentReadError extends Error {
  readonly state: 'unsafe' | 'unavailable';

  constructor(state: 'unsafe' | 'unavailable') {
    super('Store reset incident could not be read safely.');
    this.name = 'StoreResetIncidentReadError';
    this.state = state;
  }
}

function readBoundedFileBytes(
  fs: StoreResetInspectionFs,
  path: string,
  before: StoreResetInspectionStat,
  maxBytes: number,
): Uint8Array {
  let descriptor: StoreResetFileDescriptor | null = null;
  let closeFailed = false;
  let contents: Uint8Array | null = null;
  let failure: StoreResetIncidentReadError | null = null;
  try {
    descriptor = fs.open(path, fs.openFlags.readOnly);
    const opened = fs.fstat(descriptor);
    if (opened.kind !== 'file' || !sameStoreResetInspectionIdentity(before, opened)) {
      throw new StoreResetIncidentReadError('unsafe');
    }

    if (opened.size > BigInt(maxBytes)) {
      throw new StoreResetIncidentReadError('unavailable');
    }
    const expectedBytes = Number(opened.size);
    const buffer = new Uint8Array(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const read = fs.read(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read < 0 || read > buffer.length - offset) {
        throw new StoreResetIncidentReadError('unavailable');
      }
      if (read === 0) {
        throw new StoreResetIncidentReadError('unavailable');
      }
      offset += read;
    }
    const eofProbe = new Uint8Array(1);
    if (fs.read(descriptor, eofProbe, 0, 1, offset) !== 0) {
      throw new StoreResetIncidentReadError('unavailable');
    }
    const after = fs.lstat(path);
    if (after === null || !sameStoreResetInspectionIdentity(opened, after)) {
      throw new StoreResetIncidentReadError('unsafe');
    }
    contents = buffer;
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentReadError) {
      failure = error;
    } else {
      failure = new StoreResetIncidentReadError('unavailable');
    }
  } finally {
    if (descriptor !== null) {
      try {
        fs.close(descriptor);
      } catch {
        closeFailed = true;
      }
    }
  }
  if (closeFailed) {
    throw new StoreResetIncidentReadError('unavailable');
  }
  if (failure !== null) {
    throw failure;
  }
  if (contents === null) {
    throw new StoreResetIncidentReadError('unavailable');
  }
  return contents;
}

function buildMatches(manifest: StoreResetIncidentManifest, expected: StrictBundleManifest): boolean {
  return (
    manifest.build.version === expected.version &&
    manifest.build.buildSetId === expected.buildSetId &&
    manifest.build.backendBundleHash === expected.bundleHash &&
    manifest.build.flavor === expected.flavor &&
    manifest.expectedFingerprint === expected.storeFormatFingerprint
  );
}

function listRetention(
  incidentId: string,
  ledger: StoreResetRetentionLedger | null,
): Pick<StoreResetIncidentListEntry, 'retention' | 'storedProductVersion' | 'evidenceBytes'> {
  const retained =
    ledger?.preserved?.incidentId === incidentId
      ? { incident: ledger.preserved, retention: { slot: 'claimed' as const } }
      : ledger?.excess?.latest.incidentId === incidentId
        ? { incident: ledger.excess.latest, retention: ledger.excess.latest }
        : null;
  if (retained === null) {
    return { retention: { slot: 'unknown' }, storedProductVersion: 'unknown', evidenceBytes: 'unknown' };
  }
  return {
    retention: {
      ...retained.retention,
      preservation: retained.incident.preservation ?? 'unknown',
      resumeLeftActive: retained.incident.resumeLeftActive,
      parked: retained.incident.parked ?? [],
    },
    storedProductVersion:
      retained.incident.storedProductVersion === undefined ? 'unknown' : retained.incident.storedProductVersion,
    evidenceBytes: retained.incident.evidenceBytes,
  };
}

function unavailableEntry(
  incidentId: string,
  state: Exclude<StoreResetIncidentListEntry['state'], 'ready'>,
  ledger: StoreResetRetentionLedger | null,
): StoreResetIncidentListEntry {
  return {
    incidentId,
    state,
    resetAt: null,
    reason: null,
    schemaVersion: null,
    resetPolicyCause: null,
    fileCount: null,
    ...listRetention(incidentId, ledger),
  };
}

function readListEntry(
  fs: StoreResetInspectionFs,
  root: string,
  incidentId: string,
  expectedBuild: StrictBundleManifest,
  ledger: StoreResetRetentionLedger | null,
): StoreResetIncidentListEntry {
  const incidentPath = join(root, incidentId);
  const incidentStat = fs.lstat(incidentPath);
  if (incidentStat === null || incidentStat.kind !== 'directory') {
    return unavailableEntry(incidentId, incidentStat?.kind === 'symbolic-link' ? 'unsafe' : 'malformed', ledger);
  }

  const manifestPath = join(incidentPath, STORE_RESET_MANIFEST_FILE_NAME);
  const manifestStat = fs.lstat(manifestPath);
  if (manifestStat === null) {
    return unavailableEntry(incidentId, 'malformed', ledger);
  }
  if (manifestStat.kind !== 'file') {
    return unavailableEntry(incidentId, manifestStat.kind === 'symbolic-link' ? 'unsafe' : 'malformed', ledger);
  }

  try {
    const manifest = parseStoreResetIncidentManifest(
      readBoundedFileBytes(fs, manifestPath, manifestStat, MAX_RESET_MANIFEST_BYTES),
    );
    if (manifest.incidentId !== incidentId) {
      return unavailableEntry(incidentId, 'malformed', ledger);
    }
    if (!buildMatches(manifest, expectedBuild)) {
      return unavailableEntry(incidentId, 'build_mismatch', ledger);
    }
    return {
      incidentId,
      state: 'ready',
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      schemaVersion: manifest.schemaVersion,
      resetPolicyCause:
        manifest.schemaVersion === STORE_RESET_INCIDENT_SCHEMA_VERSION ? manifest.resetPolicyCause : null,
      fileCount: manifest.files.length,
      ...listRetention(incidentId, ledger),
    };
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentReadError) {
      return unavailableEntry(incidentId, error.state, ledger);
    }
    if (error instanceof StoreResetManifestDecodeError) {
      return unavailableEntry(
        incidentId,
        error.code === 'manifest_invalid_schema' ? 'unsupported' : 'malformed',
        ledger,
      );
    }
    return unavailableEntry(incidentId, 'unavailable', ledger);
  }
}

function compareEntries(left: StoreResetIncidentListEntry, right: StoreResetIncidentListEntry): number {
  if (left.resetAt !== null && right.resetAt !== null && left.resetAt !== right.resetAt) {
    return right.resetAt.localeCompare(left.resetAt);
  }
  if (left.resetAt !== null) return -1;
  if (right.resetAt !== null) return 1;
  return left.incidentId.localeCompare(right.incidentId);
}

export function listStoreResetIncidents(options: {
  readonly fs: StoreResetInspectionFs;
  readonly quarantineRoot: string;
  readonly expectedBuild: StrictBundleManifest;
}): StoreResetIncidentListResult {
  const rootStat = options.fs.lstat(options.quarantineRoot);
  if (rootStat === null) {
    return { incidents: [], truncated: false, discarded: null };
  }
  if (rootStat.kind !== 'directory') {
    throw new StoreResetIncidentReadError(rootStat.kind === 'symbolic-link' ? 'unsafe' : 'unavailable');
  }

  let ledger: StoreResetRetentionLedger | null = null;
  const ledgerPath = join(options.quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
  const ledgerStat = options.fs.lstat(ledgerPath);
  if (ledgerStat?.kind === 'file') {
    try {
      ledger = parseStoreResetRetentionLedger(
        Buffer.from(
          readBoundedFileBytes(options.fs, ledgerPath, ledgerStat, MAX_RESET_RETENTION_LEDGER_BYTES),
        ).toString('utf-8'),
      );
    } catch {
      ledger = null;
    }
  }

  const incidentIds: string[] = [];
  let cursor: unknown = null;
  let closeFailed = false;
  let truncated = false;
  try {
    cursor = options.fs.openDirectory(options.quarantineRoot);
    let consumed = 0;
    while (true) {
      const entry = options.fs.readDirectory(cursor);
      if (entry === null) {
        break;
      }
      consumed += 1;
      if (consumed > MAX_INCIDENT_ROOT_ENTRIES) {
        truncated = true;
        break;
      }
      if (isCanonicalStoreResetIncidentId(entry.name)) {
        incidentIds.push(entry.name);
      }
    }
  } finally {
    if (cursor !== null) {
      try {
        options.fs.closeDirectory(cursor);
      } catch {
        closeFailed = true;
      }
    }
  }
  if (closeFailed) {
    throw new StoreResetIncidentReadError('unavailable');
  }

  return {
    incidents: incidentIds
      .map((incidentId) => readListEntry(options.fs, options.quarantineRoot, incidentId, options.expectedBuild, ledger))
      .sort(compareEntries),
    truncated,
    discarded: ledger?.discarded ?? null,
  };
}

function isContained(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

function readIncidentDirectoryNames(fs: StoreResetInspectionFs, incidentPath: string): readonly string[] {
  const names: string[] = [];
  let cursor: unknown = null;
  let closeFailed = false;
  try {
    cursor = fs.openDirectory(incidentPath);
    while (true) {
      const entry = fs.readDirectory(cursor);
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_INCIDENT_DIR_ENTRIES) {
        throw new StoreResetIncidentReadError('unsafe');
      }
    }
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentReadError) throw error;
    throw new StoreResetIncidentReadError('unavailable');
  } finally {
    if (cursor !== null) {
      try {
        fs.closeDirectory(cursor);
      } catch {
        closeFailed = true;
      }
    }
  }
  if (closeFailed) {
    throw new StoreResetIncidentReadError('unavailable');
  }
  return names;
}

function hashEvidenceFile(options: {
  readonly fs: StoreResetInspectionFs;
  readonly path: string;
  readonly expectedHash: string;
  readonly expectedSize: number;
  readonly remainingBudget: number;
}): {
  readonly status: StoreResetIncidentLocalReport['fileVerification'][number]['status'];
  readonly consumed: number;
} {
  const before = options.fs.lstat(options.path);
  if (before === null) {
    return { status: 'missing', consumed: 0 };
  }
  if (before.kind !== 'file') {
    throw new StoreResetIncidentReadError(before.kind === 'symbolic-link' ? 'unsafe' : 'unavailable');
  }
  if (before.size > BigInt(options.remainingBudget)) {
    return { status: 'unavailable_limit', consumed: 0 };
  }

  let descriptor: StoreResetFileDescriptor | null = null;
  let closeFailed = false;
  let failure: StoreResetIncidentReadError | null = null;
  let digest: string | null = null;
  let consumed = 0;
  try {
    descriptor = options.fs.open(options.path, options.fs.openFlags.readOnly);
    const opened = options.fs.fstat(descriptor);
    if (opened.kind !== 'file' || !sameStoreResetInspectionIdentity(before, opened)) {
      throw new StoreResetIncidentReadError('unsafe');
    }

    const hash = createHash('sha256');
    const buffer = new Uint8Array(64 * 1024);
    const expectedBytes = Number(opened.size);
    while (consumed < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - consumed);
      const read = options.fs.read(descriptor, buffer, 0, requested, consumed);
      if (read <= 0 || read > requested) {
        throw new StoreResetIncidentReadError('unavailable');
      }
      consumed += read;
      hash.update(buffer.subarray(0, read));
    }
    if (options.fs.read(descriptor, buffer, 0, 1, consumed) !== 0) {
      throw new StoreResetIncidentReadError('unavailable');
    }
    const after = options.fs.lstat(options.path);
    if (after === null || !sameStoreResetInspectionIdentity(opened, after)) {
      throw new StoreResetIncidentReadError('unsafe');
    }
    digest = hash.digest('hex');
  } catch (error: unknown) {
    failure = error instanceof StoreResetIncidentReadError ? error : new StoreResetIncidentReadError('unavailable');
  } finally {
    if (descriptor !== null) {
      try {
        options.fs.close(descriptor);
      } catch {
        closeFailed = true;
      }
    }
  }
  if (closeFailed) throw new StoreResetIncidentReadError('unavailable');
  if (failure !== null) throw failure;
  if (digest === null) throw new StoreResetIncidentReadError('unavailable');
  return {
    status: consumed === options.expectedSize && digest === options.expectedHash ? 'match' : 'mismatch',
    consumed,
  };
}

export async function readStoreResetIncidentReport(options: {
  readonly fs: StoreResetInspectionFs;
  readonly quarantineRoot: string;
  readonly incidentId: string;
  readonly expectedBuild: StrictBundleManifest;
  readonly diagnose?: StoreResetIncidentDiagnosticRunner;
}): Promise<StoreResetIncidentReportResult> {
  if (!isCanonicalStoreResetIncidentId(options.incidentId)) {
    return { ok: false, state: 'invalid_id' };
  }

  try {
    const rootStat = options.fs.lstat(options.quarantineRoot);
    if (rootStat === null) return { ok: false, state: 'not_found' };
    if (rootStat.kind !== 'directory') {
      return { ok: false, state: rootStat.kind === 'symbolic-link' ? 'unsafe' : 'unavailable' };
    }
    const rootRealPath = options.fs.realpath(options.quarantineRoot);
    const incidentPath = join(options.quarantineRoot, options.incidentId);
    const incidentStat = options.fs.lstat(incidentPath);
    if (incidentStat === null) return { ok: false, state: 'not_found' };
    if (incidentStat.kind !== 'directory') {
      return {
        ok: false,
        state: incidentStat.kind === 'symbolic-link' ? 'unsafe' : 'unavailable',
      };
    }
    const incidentRealPath = options.fs.realpath(incidentPath);
    if (!isContained(rootRealPath, incidentRealPath)) {
      return { ok: false, state: 'unsafe' };
    }

    const names = readIncidentDirectoryNames(options.fs, incidentPath);
    const allowedNames = new Set<string>([STORE_RESET_MANIFEST_FILE_NAME, ...STORE_RESET_EVIDENCE_FILE_NAMES]);
    if (names.some((name) => !allowedNames.has(name))) {
      return { ok: false, state: 'unsafe' };
    }

    const manifestPath = join(incidentPath, STORE_RESET_MANIFEST_FILE_NAME);
    const manifestStat = options.fs.lstat(manifestPath);
    if (manifestStat === null) return { ok: false, state: 'malformed' };
    if (manifestStat.kind !== 'file') {
      return {
        ok: false,
        state: manifestStat.kind === 'symbolic-link' ? 'unsafe' : 'malformed',
      };
    }
    const manifestRealPath = options.fs.realpath(manifestPath);
    if (!isContained(incidentRealPath, manifestRealPath)) {
      return { ok: false, state: 'unsafe' };
    }

    const manifest = parseStoreResetIncidentManifest(
      readBoundedFileBytes(options.fs, manifestPath, manifestStat, MAX_RESET_MANIFEST_BYTES),
    );
    if (manifest.incidentId !== options.incidentId) return { ok: false, state: 'malformed' };
    if (!buildMatches(manifest, options.expectedBuild)) {
      return { ok: false, state: 'build_mismatch' };
    }
    const recordedNames = new Set(manifest.files.map((file) => file.name));
    if (
      names.some(
        (name) =>
          name !== STORE_RESET_MANIFEST_FILE_NAME &&
          STORE_RESET_EVIDENCE_FILE_NAMES.includes(name as (typeof STORE_RESET_EVIDENCE_FILE_NAMES)[number]) &&
          !recordedNames.has(name as (typeof STORE_RESET_EVIDENCE_FILE_NAMES)[number]),
      )
    ) {
      return { ok: false, state: 'unsafe' };
    }

    let remainingBudget = MAX_REPORT_HASH_BYTES;
    let remainingDeclaredBudget = MAX_REPORT_HASH_BYTES;
    const fileVerification: StoreResetIncidentLocalReport['fileVerification'][number][] = [];
    for (const file of manifest.files) {
      if (file.sizeBytes > remainingDeclaredBudget) {
        fileVerification.push({ name: file.name, status: 'unavailable_limit' });
        continue;
      }
      remainingDeclaredBudget -= file.sizeBytes;
      const evidencePath = join(incidentPath, file.name);
      const evidenceRealPath = options.fs.lstat(evidencePath) === null ? null : options.fs.realpath(evidencePath);
      if (evidenceRealPath !== null && !isContained(incidentRealPath, evidenceRealPath)) {
        return { ok: false, state: 'unsafe' };
      }
      const result = hashEvidenceFile({
        fs: options.fs,
        path: evidencePath,
        expectedHash: file.sha256,
        expectedSize: file.sizeBytes,
        remainingBudget,
      });
      remainingBudget -= result.consumed;
      fileVerification.push({ name: file.name, status: result.status });
    }

    const diagnostic =
      options.diagnose === undefined
        ? {
            integrity: 'unavailable' as const,
            termination: 'not_started' as const,
            cleanup: 'not_required' as const,
          }
        : await options.diagnose({
            fs: options.fs,
            incidentPath,
            manifest,
          });
    const local: StoreResetIncidentLocalReport = {
      manifest,
      fileVerification,
      diagnostic,
    };
    const incidentAfter = options.fs.lstat(incidentPath);
    const rootAfter = options.fs.lstat(options.quarantineRoot);
    if (
      incidentAfter === null ||
      rootAfter === null ||
      !sameStoreResetInspectionIdentity(incidentStat, incidentAfter) ||
      !sameStoreResetInspectionIdentity(rootStat, rootAfter)
    ) {
      return { ok: false, state: 'unsafe' };
    }
    return { ok: true, report: projectStoreResetPublicReport(local) };
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentReadError) {
      return { ok: false, state: error.state };
    }
    if (error instanceof StoreResetManifestDecodeError) {
      return {
        ok: false,
        state: error.code === 'manifest_invalid_schema' ? 'unsupported' : 'malformed',
      };
    }
    return { ok: false, state: 'unavailable' };
  }
}
