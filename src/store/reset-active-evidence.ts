import { createHash } from 'node:crypto';

import { isNoEntryError } from '../infra/fs-errors.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import {
  STORE_RESET_EVIDENCE_FILE_NAMES,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentFile,
} from './reset-incident.js';

export type ActiveEvidenceFileSet = Readonly<{
  dbFile: string;
  walFile: string;
  shmFile: string;
  formatFile: string;
}>;

export type ActiveEvidence = Readonly<{
  name: StoreResetEvidenceFileName;
  identity: StorageBigIntStat;
}>;

export type StableSource = Readonly<{
  evidence: ActiveEvidence;
  descriptor: number;
  reobserve(): StableSourceObservation;
  close(): void;
}>;

export type StableSourceObservation =
  | { readonly kind: 'stable' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'undeterminable'; readonly cause: string };

export type ActiveEvidenceExpectation =
  | { readonly kind: 'identity'; readonly identity: StorageBigIntStat }
  | {
      readonly kind: 'content';
      readonly stagedIdentity: StorageBigIntStat;
      readonly expected: StoreResetIncidentFile;
    };

export type ActiveEvidenceObservation =
  | { readonly kind: 'same-inode'; readonly identity: { readonly dev: bigint; readonly ino: bigint } }
  | { readonly kind: 'distinct-matching' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unmatched' }
  | { readonly kind: 'undeterminable'; readonly cause: string };

export type ActiveEvidenceRemoval =
  | { readonly kind: 'removed' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'left' };

export type ActiveEvidenceLink =
  | { readonly kind: 'linked' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'unavailable'; readonly code: string };

function candidateForEvidence(files: ActiveEvidenceFileSet, name: StoreResetEvidenceFileName): string {
  return name === 'store.db'
    ? files.dbFile
    : name === 'store.db-wal'
      ? files.walFile
      : name === 'store.db-shm'
        ? files.shmFile
        : files.formatFile;
}

function errorCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeEvidenceStat(storage: StoragePort, path: string): StorageBigIntStat {
  const link = storage.lstatSync(path);
  const stat = storage.lstatSync(path, { bigint: true });
  if (!link.isFile() || link.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Store-reset evidence is not a regular file.');
  }
  return stat;
}

function sameEvidenceIdentity(left: StorageBigIntStat, right: StorageBigIntStat): boolean {
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

export function enumerateActiveEvidence(storage: StoragePort, files: ActiveEvidenceFileSet): readonly ActiveEvidence[] {
  const evidence: ActiveEvidence[] = [];
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    try {
      const identity = activeEvidenceStat(storage, candidateForEvidence(files, name));
      if (identity.size < 0n || identity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Store-reset evidence cannot be represented safely.');
      }
      evidence.push({ name, identity });
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
  }
  return evidence;
}

export function openActiveEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  evidence: ActiveEvidence,
): StableSource {
  const path = candidateForEvidence(files, evidence.name);
  const before = activeEvidenceStat(storage, path);
  if (!sameEvidenceIdentity(evidence.identity, before)) {
    throw new Error('Store-reset evidence identity changed before descriptor open.');
  }

  const descriptor = storage.openSync(path, 'r');
  let opened: StorageBigIntStat;
  try {
    opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameEvidenceIdentity(evidence.identity, opened)) {
      throw new Error('Store-reset evidence identity changed before publication.');
    }
  } catch (error: unknown) {
    try {
      storage.closeSync(descriptor);
    } catch {
      // The failed identity claim remains authoritative.
    }
    throw error;
  }

  let closed = false;
  return {
    evidence,
    descriptor,
    reobserve: () => {
      try {
        const current = activeEvidenceStat(storage, path);
        return sameEvidenceIdentity(opened, current) ? { kind: 'stable' } : { kind: 'changed' };
      } catch (error: unknown) {
        return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'undeterminable', cause: errorCause(error) };
      }
    },
    close: () => {
      if (closed) return;
      storage.closeSync(descriptor);
      closed = true;
    },
  };
}

export function linkActiveEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  evidence: ActiveEvidence,
  destination: string,
): ActiveEvidenceLink {
  try {
    storage.linkSync(candidateForEvidence(files, evidence.name), destination);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return { kind: 'absent' };
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    if (code === 'EXDEV' || code === 'EMLINK' || code === 'EPERM' || code === 'EOPNOTSUPP') {
      return { kind: 'unavailable', code };
    }
    throw error;
  }

  const destinationIdentity = activeEvidenceStat(storage, destination);
  return destinationIdentity.dev === evidence.identity.dev && destinationIdentity.ino === evidence.identity.ino
    ? { kind: 'linked' }
    : { kind: 'changed' };
}

function hashActiveContent(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  name: StoreResetEvidenceFileName,
  before: StorageBigIntStat,
): { readonly sha256: string; readonly bytes: number } | null {
  const descriptor = storage.openSync(candidateForEvidence(files, name), 'r');
  try {
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameEvidenceIdentity(before, opened) || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    const expectedBytes = Number(opened.size);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let consumed = 0;
    while (consumed < expectedBytes) {
      const read = storage.readSync(descriptor, buffer, 0, Math.min(buffer.length, expectedBytes - consumed), null);
      if (read <= 0) return null;
      consumed += read;
      hash.update(buffer.subarray(0, read));
    }
    if (storage.readSync(descriptor, buffer, 0, 1, null) !== 0) return null;
    const after = storage.fstatSync(descriptor, { bigint: true });
    return sameEvidenceIdentity(opened, after) ? { sha256: hash.digest('hex'), bytes: consumed } : null;
  } finally {
    storage.closeSync(descriptor);
  }
}

export function observeActiveEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  evidence: ActiveEvidence | StoreResetEvidenceFileName,
  expectation: ActiveEvidenceExpectation,
): ActiveEvidenceObservation {
  const name = typeof evidence === 'string' ? evidence : evidence.name;
  let active: StorageBigIntStat;
  try {
    active = activeEvidenceStat(storage, candidateForEvidence(files, name));
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'undeterminable', cause: errorCause(error) };
  }

  const expectedIdentity = expectation.kind === 'identity' ? expectation.identity : expectation.stagedIdentity;
  if (active.dev === expectedIdentity.dev && active.ino === expectedIdentity.ino) {
    return { kind: 'same-inode', identity: { dev: active.dev, ino: active.ino } };
  }
  if (expectation.kind === 'identity') return { kind: 'unmatched' };
  if (
    active.size !== BigInt(expectation.expected.sizeBytes) ||
    Number(active.mtimeNs / 1_000_000n) !== expectation.expected.mtimeMs
  ) {
    return { kind: 'unmatched' };
  }

  try {
    const content = hashActiveContent(storage, files, name, active);
    return content?.bytes === expectation.expected.sizeBytes && content.sha256 === expectation.expected.sha256
      ? { kind: 'distinct-matching' }
      : { kind: 'unmatched' };
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'undeterminable', cause: errorCause(error) };
  }
}

export function removeActiveEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  evidence: ActiveEvidence | StoreResetEvidenceFileName,
  observation: ActiveEvidenceObservation,
): ActiveEvidenceRemoval {
  if (observation.kind === 'absent') return { kind: 'absent' };
  if (observation.kind !== 'same-inode' && observation.kind !== 'distinct-matching') return { kind: 'left' };
  const name = typeof evidence === 'string' ? evidence : evidence.name;
  try {
    storage.unlinkSync(candidateForEvidence(files, name));
    return { kind: 'removed' };
  } catch (error: unknown) {
    if (isNoEntryError(error)) return { kind: 'absent' };
    throw error;
  }
}
