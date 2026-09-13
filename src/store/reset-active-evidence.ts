import { join } from 'node:path';

import { isNoEntryError } from '../infra/fs-errors.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import {
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_PARKED_SIDECAR_FILE_NAME,
  type StoreResetEvidenceFileName,
} from './reset-incident.js';

export type ActiveEvidenceFileSet = Readonly<{
  dbFile: string;
  walFile: string;
  shmFile: string;
  formatFile: string;
}>;

export type ActiveEvidenceIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

export type ActiveEvidence = Readonly<{
  name: StoreResetEvidenceFileName;
  identity: ActiveEvidenceIdentity;
  sizeBytes: number;
  mtimeMs: number;
}>;

export type StableSource = Readonly<{
  evidence: ActiveEvidence;
  descriptor: number;
  openedStat: StorageBigIntStat;
  sizeBytes: number;
  mtimeMs: number;
  close(): void;
}>;

export type ActiveEvidenceOpen =
  | { readonly kind: 'opened'; readonly source: StableSource }
  | { readonly kind: 'absent' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'undeterminable'; readonly cause: string };

export type ActiveEvidenceLink =
  | { readonly kind: 'linked' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'unavailable'; readonly code: string };

export type ParkedActiveEvidence = Readonly<{
  evidence: ActiveEvidence;
  ownership: 'ours' | 'other';
}>;

export type ActiveEvidencePark =
  | { readonly kind: 'parked'; readonly parked: ParkedActiveEvidence }
  | { readonly kind: 'absent' };

export type ActiveEvidenceRestore = { readonly kind: 'restored' } | { readonly kind: 'kept'; readonly code: string };

export type ExpectedActiveEvidence = Readonly<{
  name: StoreResetEvidenceFileName;
  identity: ActiveEvidenceIdentity;
}>;

function candidateForEvidence(files: ActiveEvidenceFileSet, name: StoreResetEvidenceFileName): string {
  return name === 'store.db'
    ? files.dbFile
    : name === 'store.db-wal'
      ? files.walFile
      : name === 'store.db-shm'
        ? files.shmFile
        : files.formatFile;
}

function parkedPath(parkingDirectory: string, evidence: ActiveEvidence): string {
  return join(parkingDirectory, evidence.name);
}

function errorCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
}

function sameIdentity(left: ActiveEvidenceIdentity, right: ActiveEvidenceIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function enumerateActiveEvidence(storage: StoragePort, files: ActiveEvidenceFileSet): readonly ActiveEvidence[] {
  const evidence: ActiveEvidence[] = [];
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    try {
      const path = candidateForEvidence(files, name);
      const link = storage.lstatSync(path);
      const stat = storage.lstatSync(path, { bigint: true });
      if (!link.isFile() || link.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Store-reset evidence is not a regular file.');
      }
      if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Store-reset evidence cannot be represented safely.');
      }
      evidence.push({
        name,
        identity: { dev: stat.dev, ino: stat.ino },
        sizeBytes: Number(stat.size),
        mtimeMs: Number(stat.mtimeNs / 1_000_000n),
      });
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
): ActiveEvidenceOpen {
  let descriptor: number;
  try {
    descriptor = storage.openSync(candidateForEvidence(files, evidence.name), 'r');
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'undeterminable', cause: errorCause(error) };
  }

  try {
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(evidence.identity, opened)) {
      storage.closeSync(descriptor);
      return { kind: 'changed' };
    }
    if (opened.size < 0n || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      storage.closeSync(descriptor);
      return { kind: 'undeterminable', cause: 'Store-reset evidence cannot be represented safely.' };
    }

    let closed = false;
    return {
      kind: 'opened',
      source: {
        evidence,
        descriptor,
        openedStat: opened,
        sizeBytes: Number(opened.size),
        mtimeMs: Number(opened.mtimeNs / 1_000_000n),
        close: () => {
          if (closed) return;
          storage.closeSync(descriptor);
          closed = true;
        },
      },
    };
  } catch (error: unknown) {
    try {
      storage.closeSync(descriptor);
    } catch {
      // The observation failure remains authoritative.
    }
    return { kind: 'undeterminable', cause: errorCause(error) };
  }
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
    return { kind: 'unavailable', code: errorCode(error) };
  }

  const destinationStat = storage.lstatSync(destination, { bigint: true });
  return destinationStat.isFile() && sameIdentity(evidence.identity, destinationStat)
    ? { kind: 'linked' }
    : { kind: 'changed' };
}

export function parkActiveEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  evidence: ActiveEvidence,
  parkingDirectory: string,
): ActiveEvidencePark {
  const destination = parkedPath(parkingDirectory, evidence);
  try {
    storage.lstatSync(destination);
    throw new Error('Store-reset parking destination already exists.');
  } catch (error: unknown) {
    if (!isNoEntryError(error)) throw error;
  }

  try {
    storage.renameSync(candidateForEvidence(files, evidence.name), destination);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return { kind: 'absent' };
    throw error;
  }

  const parked = storage.lstatSync(destination, { bigint: true });
  if (!parked.isFile()) throw new Error('Parked store-reset evidence is not a regular file.');
  return {
    kind: 'parked',
    parked: {
      evidence: {
        ...evidence,
        sizeBytes: Number(parked.size),
        mtimeMs: Number(parked.mtimeNs / 1_000_000n),
      },
      ownership: sameIdentity(evidence.identity, parked) ? 'ours' : 'other',
    },
  };
}

export type ClaimedParkedEvidence = Readonly<{
  name: StoreResetEvidenceFileName;
  identity: ActiveEvidenceIdentity;
  sizeBytes: number;
}>;

export function parkCurrentEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  parkingDirectory: string,
): readonly ClaimedParkedEvidence[] {
  const parked: ClaimedParkedEvidence[] = [];
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    const destination = join(parkingDirectory, name);
    try {
      storage.renameSync(candidateForEvidence(files, name), destination);
    } catch (error: unknown) {
      if (isNoEntryError(error)) continue;
      throw error;
    }
    const stat = storage.lstatSync(destination, { bigint: true });
    if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Parked store-reset evidence is not a regular file.');
    }
    parked.push({ name, identity: { dev: stat.dev, ino: stat.ino }, sizeBytes: Number(stat.size) });
  }
  return parked;
}

export function activeEvidencePath(files: ActiveEvidenceFileSet, name: StoreResetEvidenceFileName): string {
  return candidateForEvidence(files, name);
}

export type ActiveNameClaim = { readonly kind: 'claimed' } | { readonly kind: 'occupied' };

export function linkOwnedEvidenceToActive(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  source: string,
  name: StoreResetEvidenceFileName,
): ActiveNameClaim {
  try {
    storage.linkSync(source, candidateForEvidence(files, name));
    return { kind: 'claimed' };
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') return { kind: 'occupied' };
    throw error;
  }
}

export function activeNameHasIdentity(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  name: StoreResetEvidenceFileName,
  identity: ActiveEvidenceIdentity,
): boolean {
  try {
    const stat = storage.lstatSync(candidateForEvidence(files, name), { bigint: true });
    return stat.isFile() && sameIdentity(identity, stat);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    return false;
  }
}

export function readParkedEvidence(
  storage: StoragePort,
  parkingDirectory: string,
  expected: readonly ExpectedActiveEvidence[],
): readonly ParkedActiveEvidence[] {
  const byName = new Map(expected.map((item) => [item.name, item.identity]));
  const read = storage.readDirectoryBoundedSync(parkingDirectory, STORE_RESET_EVIDENCE_FILE_NAMES.length + 1);
  const evidenceEntries = read.entries.filter((name) => name !== STORE_RESET_PARKED_SIDECAR_FILE_NAME);
  if (read.overflow || evidenceEntries.some((name) => !byName.has(name as StoreResetEvidenceFileName))) {
    throw new Error('Store-reset parking directory contains unexpected evidence.');
  }
  return evidenceEntries.map((entry) => {
    const name = entry as StoreResetEvidenceFileName;
    const stat = storage.lstatSync(join(parkingDirectory, name), { bigint: true });
    if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Parked store-reset evidence is not a regular file.');
    }
    const identity = byName.get(name);
    if (identity === undefined) throw new Error('Store-reset parking identity is unavailable.');
    return {
      evidence: {
        name,
        identity,
        sizeBytes: Number(stat.size),
        mtimeMs: Number(stat.mtimeNs / 1_000_000n),
      },
      ownership: sameIdentity(identity, stat) ? 'ours' : 'other',
    };
  });
}

function dropParkedPath(storage: StoragePort, parkingDirectory: string, evidence: ActiveEvidence): void {
  storage.unlinkSync(parkedPath(parkingDirectory, evidence));
}

export function dropParkedEvidence(storage: StoragePort, parkingDirectory: string, parked: ParkedActiveEvidence): void {
  dropParkedPath(storage, parkingDirectory, parked.evidence);
}

export function restoreParkedEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  parkingDirectory: string,
  parked: ParkedActiveEvidence,
): ActiveEvidenceRestore {
  try {
    storage.linkSync(parkedPath(parkingDirectory, parked.evidence), candidateForEvidence(files, parked.evidence.name));
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'EEXIST' || code === 'EXDEV' || code === 'EPERM' || code === 'EOPNOTSUPP') {
      return { kind: 'kept', code };
    }
    throw error;
  }
  dropParkedPath(storage, parkingDirectory, parked.evidence);
  return { kind: 'restored' };
}
