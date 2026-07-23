import { join } from 'node:path';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import {
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  StoreResetManifestDecodeError,
  type StoreResetIncidentListEntry,
  type StoreResetIncidentListResult,
  type StoreResetIncidentManifestV2,
} from './reset-incident.js';
import type {
  StoreResetFileDescriptor,
  StoreResetInspectionFs,
  StoreResetInspectionStat,
} from './reset-incident-inspection-fs.js';

const INCIDENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class StoreResetIncidentLimitError extends Error {
  constructor() {
    super('Store reset incident listing limit exceeded.');
    this.name = 'StoreResetIncidentLimitError';
  }
}

class StoreResetIncidentReadError extends Error {
  readonly state: 'unsafe' | 'unavailable';

  constructor(state: 'unsafe' | 'unavailable') {
    super('Store reset incident could not be read safely.');
    this.name = 'StoreResetIncidentReadError';
    this.state = state;
  }
}

function sameIdentity(left: StoreResetInspectionStat, right: StoreResetInspectionStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

function readManifestBytes(
  fs: StoreResetInspectionFs,
  manifestPath: string,
  before: StoreResetInspectionStat,
): Uint8Array {
  let descriptor: StoreResetFileDescriptor | null = null;
  let closeFailed = false;
  let contents: Uint8Array | null = null;
  let failure: StoreResetIncidentReadError | null = null;
  try {
    descriptor = fs.open(manifestPath, fs.openFlags.readOnly);
    const opened = fs.fstat(descriptor);
    if (opened.kind !== 'file' || !sameIdentity(before, opened)) {
      throw new StoreResetIncidentReadError('unsafe');
    }

    const buffer = new Uint8Array(MAX_RESET_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.read(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read < 0 || read > buffer.length - offset) {
        throw new StoreResetIncidentReadError('unavailable');
      }
      if (read === 0) {
        break;
      }
      offset += read;
    }
    const after = fs.lstat(manifestPath);
    if (after === null || !sameIdentity(opened, after)) {
      throw new StoreResetIncidentReadError('unsafe');
    }
    contents = buffer.slice(0, offset);
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

function buildMatches(manifest: StoreResetIncidentManifestV2, expected: StrictBundleManifest): boolean {
  return (
    manifest.build.version === expected.version &&
    manifest.build.buildSetId === expected.buildSetId &&
    manifest.build.backendBundleHash === expected.bundleHash &&
    manifest.build.flavor === expected.flavor &&
    manifest.expectedFingerprint === expected.storeFormatFingerprint
  );
}

function unavailableEntry(
  incidentId: string,
  state: Exclude<StoreResetIncidentListEntry['state'], 'ready'>,
): StoreResetIncidentListEntry {
  return {
    incidentId,
    state,
    resetAt: null,
    reason: null,
    fileCount: null,
  };
}

function readListEntry(
  fs: StoreResetInspectionFs,
  root: string,
  incidentId: string,
  expectedBuild: StrictBundleManifest,
): StoreResetIncidentListEntry {
  const incidentPath = join(root, incidentId);
  const incidentStat = fs.lstat(incidentPath);
  if (incidentStat === null || incidentStat.kind !== 'directory') {
    return unavailableEntry(incidentId, incidentStat?.kind === 'symbolic-link' ? 'unsafe' : 'malformed');
  }

  const manifestPath = join(incidentPath, STORE_RESET_MANIFEST_FILE_NAME);
  const manifestStat = fs.lstat(manifestPath);
  if (manifestStat === null) {
    return unavailableEntry(incidentId, 'malformed');
  }
  if (manifestStat.kind !== 'file') {
    return unavailableEntry(incidentId, manifestStat.kind === 'symbolic-link' ? 'unsafe' : 'malformed');
  }

  try {
    const manifest = parseStoreResetIncidentManifest(readManifestBytes(fs, manifestPath, manifestStat));
    if (manifest.incidentId !== incidentId) {
      return unavailableEntry(incidentId, 'malformed');
    }
    if (!buildMatches(manifest, expectedBuild)) {
      return unavailableEntry(incidentId, 'build_mismatch');
    }
    return {
      incidentId,
      state: 'ready',
      resetAt: manifest.resetAt,
      reason: manifest.reason,
      fileCount: manifest.files.length,
    };
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentReadError) {
      return unavailableEntry(incidentId, error.state);
    }
    if (error instanceof StoreResetManifestDecodeError) {
      return unavailableEntry(incidentId, error.code === 'manifest_invalid_schema' ? 'unsupported' : 'malformed');
    }
    return unavailableEntry(incidentId, 'unavailable');
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
    return { incidents: [] };
  }
  if (rootStat.kind !== 'directory') {
    throw new StoreResetIncidentReadError(rootStat.kind === 'symbolic-link' ? 'unsafe' : 'unavailable');
  }

  const incidentIds: string[] = [];
  let cursor: unknown = null;
  let closeFailed = false;
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
        throw new StoreResetIncidentLimitError();
      }
      if (INCIDENT_ID_PATTERN.test(entry.name)) {
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
      .map((incidentId) => readListEntry(options.fs, options.quarantineRoot, incidentId, options.expectedBuild))
      .sort(compareEntries),
  };
}
