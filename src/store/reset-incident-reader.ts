import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_REPORT_HASH_BYTES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  projectStoreResetPublicReport,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_INCIDENT_SCHEMA_VERSION,
  STORE_RESET_MANIFEST_FILE_NAME,
  StoreResetManifestDecodeError,
  type StoreResetIncidentLocalReport,
  type StoreResetPolicyCause,
  type StoreResetPublicReport,
  type StoreResetReason,
} from './reset-incident.js';
import {
  sameStoreResetInspectionIdentity,
  type StoreResetFileDescriptor,
  type StoreResetInspectionFs,
  type StoreResetInspectionStat,
} from './reset-incident-inspection-fs.js';

export type LegacyStoreResetIncidentListEntry = Readonly<{
  source: 'legacy-quarantine';
  incidentId: string;
  state: 'ready' | 'malformed' | 'unsupported' | 'build_mismatch' | 'unsafe' | 'unavailable';
  resetAt: string | null;
  reason: StoreResetReason | null;
  resetPolicyCause: StoreResetPolicyCause | null;
  fileCount: number | null;
  bytes: number | null;
}>;

export type LegacyStoreResetIncidentListResult = Readonly<{
  incidents: readonly LegacyStoreResetIncidentListEntry[];
  truncated: boolean;
}>;

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
  let result: Uint8Array | null = null;
  let failure: StoreResetIncidentReadError | null = null;
  try {
    descriptor = fs.open(path, fs.openFlags.readOnly);
    const opened = fs.fstat(descriptor);
    if (opened.kind !== 'file' || !sameStoreResetInspectionIdentity(before, opened)) {
      throw new StoreResetIncidentReadError('unsafe');
    }
    if (opened.size > BigInt(maxBytes)) throw new StoreResetIncidentReadError('unavailable');
    const buffer = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.read(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read <= 0 || read > buffer.length - offset) throw new StoreResetIncidentReadError('unavailable');
      offset += read;
    }
    if (fs.read(descriptor, new Uint8Array(1), 0, 1, offset) !== 0) {
      throw new StoreResetIncidentReadError('unavailable');
    }
    const after = fs.lstat(path);
    if (after === null || !sameStoreResetInspectionIdentity(opened, after)) {
      throw new StoreResetIncidentReadError('unsafe');
    }
    result = buffer;
  } catch (error: unknown) {
    failure = error instanceof StoreResetIncidentReadError ? error : new StoreResetIncidentReadError('unavailable');
  }
  if (descriptor !== null) {
    try {
      fs.close(descriptor);
    } catch {
      failure ??= new StoreResetIncidentReadError('unavailable');
    }
  }
  if (failure !== null) throw failure;
  if (result === null) throw new StoreResetIncidentReadError('unavailable');
  return result;
}

function buildMatches(
  manifest: ReturnType<typeof parseStoreResetIncidentManifest>,
  expected: StrictBundleManifest,
): boolean {
  return (
    manifest.build.version === expected.version &&
    manifest.build.buildSetId === expected.buildSetId &&
    manifest.build.backendBundleHash === expected.bundleHash &&
    manifest.build.flavor === expected.flavor &&
    manifest.expectedFingerprint === expected.storeFormatFingerprint
  );
}

function legacyDirectoryBytes(fs: StoreResetInspectionFs, root: string): number | null {
  let total = 0;
  let cursor: unknown = null;
  try {
    cursor = fs.openDirectory(root);
    let count = 0;
    while (true) {
      const entry = fs.readDirectory(cursor);
      if (entry === null) return total;
      count += 1;
      if (count > MAX_INCIDENT_DIR_ENTRIES) return null;
      const stat = fs.lstat(join(root, entry.name));
      if (stat === null || stat.kind !== 'file' || stat.size > BigInt(Number.MAX_SAFE_INTEGER - total)) return null;
      total += Number(stat.size);
    }
  } catch {
    return null;
  } finally {
    if (cursor !== null) fs.closeDirectory(cursor);
  }
}

function legacyListEntry(
  fs: StoreResetInspectionFs,
  root: string,
  incidentId: string,
  expectedBuild: StrictBundleManifest,
): LegacyStoreResetIncidentListEntry {
  const base = { source: 'legacy-quarantine' as const, incidentId };
  const incidentPath = join(root, incidentId);
  const incidentStat = fs.lstat(incidentPath);
  if (incidentStat?.kind !== 'directory') {
    return {
      ...base,
      state: incidentStat?.kind === 'symbolic-link' ? 'unsafe' : 'malformed',
      resetAt: null,
      reason: null,
      resetPolicyCause: null,
      fileCount: null,
      bytes: null,
    };
  }
  const bytes = legacyDirectoryBytes(fs, incidentPath);
  const manifestPath = join(incidentPath, STORE_RESET_MANIFEST_FILE_NAME);
  const manifestStat = fs.lstat(manifestPath);
  if (manifestStat?.kind !== 'file') {
    return {
      ...base,
      state: manifestStat?.kind === 'symbolic-link' ? 'unsafe' : 'malformed',
      resetAt: null,
      reason: null,
      resetPolicyCause: null,
      fileCount: null,
      bytes,
    };
  }
  try {
    const manifest = parseStoreResetIncidentManifest(
      readBoundedFileBytes(fs, manifestPath, manifestStat, MAX_RESET_MANIFEST_BYTES),
    );
    if (manifest.incidentId !== incidentId) throw new StoreResetManifestDecodeError('manifest_invalid_schema');
    return {
      ...base,
      state: buildMatches(manifest, expectedBuild) ? 'ready' : 'build_mismatch',
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      resetPolicyCause:
        manifest.schemaVersion === STORE_RESET_INCIDENT_SCHEMA_VERSION ? manifest.resetPolicyCause : null,
      fileCount: manifest.files.length,
      bytes,
    };
  } catch (error: unknown) {
    return {
      ...base,
      state:
        error instanceof StoreResetIncidentReadError
          ? error.state
          : error instanceof StoreResetManifestDecodeError && error.code === 'manifest_invalid_schema'
            ? 'unsupported'
            : 'malformed',
      resetAt: null,
      reason: null,
      resetPolicyCause: null,
      fileCount: null,
      bytes,
    };
  }
}

export function listLegacyStoreResetIncidents(options: {
  readonly fs: StoreResetInspectionFs;
  readonly quarantineRoot: string;
  readonly expectedBuild: StrictBundleManifest;
}): LegacyStoreResetIncidentListResult {
  const root = options.fs.lstat(options.quarantineRoot);
  if (root === null) return { incidents: [], truncated: false };
  if (root.kind !== 'directory') {
    throw new StoreResetIncidentReadError(root.kind === 'symbolic-link' ? 'unsafe' : 'unavailable');
  }
  const ids: string[] = [];
  let cursor: unknown = null;
  let truncated = false;
  try {
    cursor = options.fs.openDirectory(options.quarantineRoot);
    let consumed = 0;
    while (true) {
      const entry = options.fs.readDirectory(cursor);
      if (entry === null) break;
      consumed += 1;
      if (consumed > MAX_INCIDENT_ROOT_ENTRIES) {
        truncated = true;
        break;
      }
      if (isCanonicalStoreResetIncidentId(entry.name)) ids.push(entry.name);
    }
  } finally {
    if (cursor !== null) options.fs.closeDirectory(cursor);
  }
  return {
    incidents: ids.map((id) => legacyListEntry(options.fs, options.quarantineRoot, id, options.expectedBuild)),
    truncated,
  };
}

function isContained(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

function readIncidentDirectoryNames(fs: StoreResetInspectionFs, incidentPath: string): readonly string[] {
  const names: string[] = [];
  let cursor: unknown = null;
  try {
    cursor = fs.openDirectory(incidentPath);
    while (true) {
      const entry = fs.readDirectory(cursor);
      if (entry === null) return names;
      names.push(entry.name);
      if (names.length > MAX_INCIDENT_DIR_ENTRIES) throw new StoreResetIncidentReadError('unsafe');
    }
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentReadError) throw error;
    throw new StoreResetIncidentReadError('unavailable');
  } finally {
    if (cursor !== null) optionsSafeClose(fs, cursor);
  }
}

function optionsSafeClose(fs: StoreResetInspectionFs, cursor: unknown): void {
  try {
    fs.closeDirectory(cursor);
  } catch {
    throw new StoreResetIncidentReadError('unavailable');
  }
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
  if (before === null) return { status: 'missing', consumed: 0 };
  if (before.kind !== 'file') {
    throw new StoreResetIncidentReadError(before.kind === 'symbolic-link' ? 'unsafe' : 'unavailable');
  }
  if (before.size > BigInt(options.remainingBudget)) return { status: 'unavailable_limit', consumed: 0 };
  const descriptor = options.fs.open(options.path, options.fs.openFlags.readOnly);
  try {
    const opened = options.fs.fstat(descriptor);
    if (opened.kind !== 'file' || !sameStoreResetInspectionIdentity(before, opened)) {
      throw new StoreResetIncidentReadError('unsafe');
    }
    const hash = createHash('sha256');
    const buffer = new Uint8Array(64 * 1024);
    let consumed = 0;
    while (consumed < Number(opened.size)) {
      const requested = Math.min(buffer.length, Number(opened.size) - consumed);
      const read = options.fs.read(descriptor, buffer, 0, requested, consumed);
      if (read <= 0 || read > requested) throw new StoreResetIncidentReadError('unavailable');
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
    return {
      status: consumed === options.expectedSize && hash.digest('hex') === options.expectedHash ? 'match' : 'mismatch',
      consumed,
    };
  } finally {
    options.fs.close(descriptor);
  }
}

export async function readStoreResetIncidentReport(options: {
  readonly fs: StoreResetInspectionFs;
  readonly quarantineRoot: string;
  readonly incidentId: string;
  readonly expectedBuild: StrictBundleManifest;
}): Promise<StoreResetIncidentReportResult> {
  if (!isCanonicalStoreResetIncidentId(options.incidentId)) return { ok: false, state: 'invalid_id' };
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
      return { ok: false, state: incidentStat.kind === 'symbolic-link' ? 'unsafe' : 'unavailable' };
    }
    const incidentRealPath = options.fs.realpath(incidentPath);
    if (!isContained(rootRealPath, incidentRealPath)) return { ok: false, state: 'unsafe' };
    const names = readIncidentDirectoryNames(options.fs, incidentPath);
    const allowedNames = new Set<string>([STORE_RESET_MANIFEST_FILE_NAME, ...STORE_RESET_EVIDENCE_FILE_NAMES]);
    if (names.some((name) => !allowedNames.has(name))) return { ok: false, state: 'unsafe' };
    const manifestPath = join(incidentPath, STORE_RESET_MANIFEST_FILE_NAME);
    const manifestStat = options.fs.lstat(manifestPath);
    if (manifestStat === null) return { ok: false, state: 'malformed' };
    if (manifestStat.kind !== 'file') {
      return { ok: false, state: manifestStat.kind === 'symbolic-link' ? 'unsafe' : 'malformed' };
    }
    if (!isContained(incidentRealPath, options.fs.realpath(manifestPath))) return { ok: false, state: 'unsafe' };
    const manifest = parseStoreResetIncidentManifest(
      readBoundedFileBytes(options.fs, manifestPath, manifestStat, MAX_RESET_MANIFEST_BYTES),
    );
    if (manifest.incidentId !== options.incidentId) return { ok: false, state: 'malformed' };
    if (!buildMatches(manifest, options.expectedBuild)) return { ok: false, state: 'build_mismatch' };
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
    const local: StoreResetIncidentLocalReport = { manifest, fileVerification };
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
    if (error instanceof StoreResetIncidentReadError) return { ok: false, state: error.state };
    if (error instanceof StoreResetManifestDecodeError) {
      return { ok: false, state: error.code === 'manifest_invalid_schema' ? 'unsupported' : 'malformed' };
    }
    return { ok: false, state: 'unavailable' };
  }
}
