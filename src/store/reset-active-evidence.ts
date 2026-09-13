import { join } from 'node:path';

import { isNoEntryError } from '../infra/fs-errors.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import {
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_PARKED_SIDECAR_FILE_NAME,
  type StoreResetEvidenceFileName,
} from './reset-incident.js';
import type { StoreResetParkedEntry } from './reset-retention.js';

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

export type ParkedActiveEvidence = Readonly<{
  evidence: ActiveEvidence;
  ownership: 'ours' | 'other';
  entry: StoreResetParkedEntry;
}>;

export type ActiveEvidencePark =
  | { readonly kind: 'parked'; readonly parked: ParkedActiveEvidence }
  | { readonly kind: 'absent' }
  | { readonly kind: 'occupied' };

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

function parkedEntry(
  storage: StoragePort,
  path: string,
  name: StoreResetEvidenceFileName,
  stat: StorageBigIntStat,
): StoreResetParkedEntry {
  const link = storage.lstatSync(path);
  const kind = link.isSymbolicLink()
    ? 'symbolic-link'
    : stat.isFile()
      ? 'regular-file'
      : stat.isDirectory()
        ? 'directory'
        : 'other';
  const sizeBytes = stat.size >= 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stat.size) : null;
  return { name, kind, sizeBytes };
}

export function enumerateActiveEvidence(storage: StoragePort, files: ActiveEvidenceFileSet): readonly ActiveEvidence[] {
  const evidence: ActiveEvidence[] = [];
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    try {
      const path = candidateForEvidence(files, name);
      const link = storage.lstatSync(path);
      const stat = storage.lstatSync(path, { bigint: true });
      if (link.isSymbolicLink()) continue;
      if (!link.isFile() || !stat.isFile()) continue;
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

export function parkActiveEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  evidence: ActiveEvidence,
  parkingDirectory: string,
): ActiveEvidencePark {
  const destination = parkedPath(parkingDirectory, evidence);
  try {
    storage.lstatSync(destination);
    return { kind: 'occupied' };
  } catch (error: unknown) {
    if (!isNoEntryError(error)) throw error;
  }

  try {
    storage.lstatSync(join(parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME));
    storage.renameSync(candidateForEvidence(files, evidence.name), destination);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return { kind: 'absent' };
    throw error;
  }

  const parked = storage.lstatSync(destination, { bigint: true });
  const entry = parkedEntry(storage, destination, evidence.name, parked);
  const regular = entry.kind === 'regular-file' && entry.sizeBytes !== null;
  return {
    kind: 'parked',
    parked: {
      evidence: regular
        ? {
            ...evidence,
            sizeBytes: entry.sizeBytes,
            mtimeMs: Number(parked.mtimeNs / 1_000_000n),
          }
        : evidence,
      ownership: regular && sameIdentity(evidence.identity, parked) ? 'ours' : 'other',
      entry,
    },
  };
}

export type ClaimedParkedEvidence = Readonly<{
  name: StoreResetEvidenceFileName;
  identity: ActiveEvidenceIdentity;
  entry: StoreResetParkedEntry;
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
      const stat = storage.lstatSync(destination, { bigint: true });
      parked.push({
        name,
        identity: { dev: stat.dev, ino: stat.ino },
        entry: parkedEntry(storage, destination, name, stat),
      });
      continue;
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
    try {
      storage.lstatSync(join(parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME));
      storage.renameSync(candidateForEvidence(files, name), destination);
    } catch (error: unknown) {
      if (isNoEntryError(error)) continue;
      throw error;
    }
    const stat = storage.lstatSync(destination, { bigint: true });
    parked.push({
      name,
      identity: { dev: stat.dev, ino: stat.ino },
      entry: parkedEntry(storage, destination, name, stat),
    });
  }
  return parked;
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

export type ActiveNameIdentityDecision =
  | { readonly kind: 'same' }
  | { readonly kind: 'different' }
  | { readonly kind: 'undeterminable'; readonly error: unknown };

export function activeNameHasIdentity(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  name: StoreResetEvidenceFileName,
  identity: ActiveEvidenceIdentity,
): ActiveNameIdentityDecision {
  try {
    const stat = storage.lstatSync(candidateForEvidence(files, name), { bigint: true });
    return stat.isFile() && sameIdentity(identity, stat) ? { kind: 'same' } : { kind: 'different' };
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'different' } : { kind: 'undeterminable', error };
  }
}

export function readParkedEvidence(
  storage: StoragePort,
  parkingDirectory: string,
  expected: readonly ExpectedActiveEvidence[],
): { readonly kind: 'read'; readonly parked: readonly ParkedActiveEvidence[] } | { readonly kind: 'unexpected' } {
  const byName = new Map(expected.map((item) => [item.name, item.identity]));
  const parked: ParkedActiveEvidence[] = [];
  for (const name of STORE_RESET_EVIDENCE_FILE_NAMES) {
    const path = join(parkingDirectory, name);
    let stat: StorageBigIntStat;
    try {
      stat = storage.lstatSync(path, { bigint: true });
    } catch (error: unknown) {
      if (isNoEntryError(error)) continue;
      throw error;
    }
    const entry = parkedEntry(storage, path, name, stat);
    const identity = byName.get(name);
    if (identity === undefined) return { kind: 'unexpected' };
    parked.push({
      evidence: {
        name,
        identity,
        sizeBytes: entry.sizeBytes ?? 0,
        mtimeMs: entry.kind === 'regular-file' ? Number(stat.mtimeNs / 1_000_000n) : 0,
      },
      ownership: entry.kind === 'regular-file' && sameIdentity(identity, stat) ? 'ours' : 'other',
      entry,
    });
  }
  return { kind: 'read', parked };
}

export function describeParkedEntries(
  storage: StoragePort,
  parkingDirectory: string,
  names: readonly StoreResetEvidenceFileName[],
): readonly StoreResetParkedEntry[] {
  return names.map((name) => {
    const path = join(parkingDirectory, name);
    return parkedEntry(storage, path, name, storage.lstatSync(path, { bigint: true }));
  });
}

export function dropParkedEvidence(storage: StoragePort, parkingDirectory: string, parked: ParkedActiveEvidence): void {
  storage.unlinkSync(parkedPath(parkingDirectory, parked.evidence));
}

export function restoreParkedEvidence(
  storage: StoragePort,
  files: ActiveEvidenceFileSet,
  parkingDirectory: string,
  parked: ParkedActiveEvidence,
): ActiveEvidenceRestore {
  if (parked.entry.kind !== 'regular-file') return { kind: 'kept', code: 'NON_REGULAR' };
  try {
    storage.linkSync(parkedPath(parkingDirectory, parked.evidence), candidateForEvidence(files, parked.evidence.name));
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'EEXIST' || code === 'EXDEV' || code === 'EPERM' || code === 'EOPNOTSUPP') {
      return { kind: 'kept', code };
    }
    throw error;
  }
  storage.unlinkSync(parkedPath(parkingDirectory, parked.evidence));
  return { kind: 'restored' };
}
