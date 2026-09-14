import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { isRecord } from '../infra/json.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { validateProductVersion } from '../infra/product-version.js';
import type { SettlementAuthority } from './settlement-authority.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  STORE_RESET_EVIDENCE_FILE_NAMES,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_IN_FLIGHT_DIRECTORY,
  STORE_RESET_PARKED_DIRECTORY,
  STORE_RESET_PARKED_SIDECAR_FILE_NAME,
  STORE_RESET_STAGING_DIRECTORY,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentManifest,
} from './reset-incident.js';

type SettlementHeld = SettlementAuthority;

export const STORE_RESET_RETENTION_LEDGER_VERSION = 1 as const;
export const STORE_RESET_RETENTION_LEDGER_FILE_NAME = `store-reset-retention.v${STORE_RESET_RETENTION_LEDGER_VERSION}.json`;
export const MAX_RESET_RETENTION_LEDGER_BYTES = 64 * 1024;
export const STORE_RESET_PARKED_SIDECAR_VERSION = 1 as const;
export const MAX_RESET_PARKED_SIDECAR_BYTES = 64 * 1024;
const STORE_RESET_ROTATION_SURVIVOR_SUFFIX = '.rotation-survivor';
const STORE_RESET_ROTATION_RETIRED_SUFFIX = '.rotation-retired';

export type StoreResetParkedClassificationKind =
  | 'absent'
  | 'fresh'
  | 'compatible'
  | 'legacy-adoptable'
  | 'older-incompatible'
  | 'newer-incompatible'
  | 'corrupt-or-unsupported';

export type StoreResetParkedEntry = Readonly<{
  name: StoreResetEvidenceFileName;
  kind: 'regular-file' | 'directory' | 'symbolic-link' | 'other';
  sizeBytes: number | null;
}>;

export type StoreResetParkingTransaction =
  | Readonly<{
      kind: 'publication';
      incidentId: string;
      identities: readonly StoreResetPendingIdentity[];
    }>
  | Readonly<{
      kind: 'claim';
      names: readonly StoreResetEvidenceFileName[];
    }>;

export type StoreResetParkedRecord = Readonly<{
  version: typeof STORE_RESET_PARKED_SIDECAR_VERSION;
  parkingId: string;
  parkedAt: string;
  parkingOrder?: string;
  phase: 'in-flight' | 'terminal';
  cause: 'publication' | 'intruder' | 'residual';
  incidentId: string | null;
  names: readonly StoreResetEvidenceFileName[];
  entries: readonly StoreResetParkedEntry[];
  transaction: StoreResetParkingTransaction | null;
  classification: StoreResetParkedClassificationKind | null;
}>;

export type StoreResetParkedDiscoveryEntry = Readonly<{
  parkingId: string;
  coordinate: string;
  state: 'parked' | 'malformed' | 'unsafe' | 'unavailable';
  record: StoreResetParkedRecord | null;
}>;

export type StoreResetParkedDiscovery = Readonly<{
  entries: readonly StoreResetParkedDiscoveryEntry[];
  truncated: boolean;
}>;

export type PreservationMechanism =
  | { readonly kind: 'linked'; readonly coherence: 'coherent' | 'torn' }
  | {
      readonly kind: 'copied';
      readonly cause: {
        readonly kind: 'link-unsupported';
        readonly errno: 'EXDEV' | 'EMLINK' | 'EPERM' | 'EOPNOTSUPP' | 'other';
        readonly code: string;
      };
      readonly coherence: 'coherent' | 'torn';
    }
  | {
      readonly kind: 'copied';
      readonly cause: {
        readonly kind: 'exclusion-unproven';
        readonly reason: 'writer-live' | 'writer-unobservable' | 'lock-timeout';
      };
      readonly coherence: 'coherent' | 'torn';
    };

export type StoreResetRetentionIncident = Readonly<{
  incidentId: string;
  resetAt: string;
  evidenceBytes: number;
  storedProductVersion?: string | null;
  preservation?: PreservationMechanism;
  resumeLeftActive: boolean;
}>;

export type StoreResetPendingIdentity = Readonly<{
  name: StoreResetEvidenceFileName;
  dev: string;
  ino: string;
}>;

export type StoreResetRetentionPending = Readonly<{
  resetAt: string;
  identities: readonly StoreResetPendingIdentity[];
  outcome: Readonly<{
    kind: 'preserve';
    incident: StoreResetRetentionIncident;
  }>;
}>;

type StoreResetRetentionSurvivor = Readonly<{ kind: 'incident' | 'parking'; id: string }>;

export type StoreResetRetentionRotation =
  | {
      readonly kind: 'complete';
      readonly survivor: StoreResetRetentionSurvivor;
    }
  | {
      readonly kind: 'incomplete';
      readonly survivor: StoreResetRetentionSurvivor;
      readonly cause: string;
    };

export type StoreResetIncompleteRotation = Extract<StoreResetRetentionRotation, { readonly kind: 'incomplete' }>;

export type StoreResetRetentionLedger = Readonly<{
  version: typeof STORE_RESET_RETENTION_LEDGER_VERSION;
  pending: StoreResetRetentionPending | null;
  preserved: StoreResetRetentionIncident | null;
  rotation: StoreResetIncompleteRotation | null;
}>;

export type StoreResetRetentionSlot =
  | { readonly kind: 'vacant'; readonly ledger: StoreResetRetentionLedger }
  | {
      readonly kind: 'held';
      readonly ledger: StoreResetRetentionLedger;
      readonly holder: StoreResetRetentionIncident;
      readonly manifest: StoreResetIncidentManifest | null;
    };

export type StoreResetReleaseResult =
  | {
      readonly kind: 'released';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: number | null;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'not-holder';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: number | null;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'parked';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: number | null;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'released-with-unverified-parking';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: null;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'not-holder-with-unverified-parking';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: null;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'parked-unverified';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: null;
      readonly parkingEvidenceBytes: null;
      readonly clearedPreservedSlot: boolean;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'partially-released';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: number | null;
      readonly parkingState: 'absent' | 'present' | 'undeterminable';
      readonly incidentState: 'absent' | 'present' | 'undeterminable';
      readonly parkingDeletionDurability: StoreResetDeletionDurability;
      readonly incidentDeletionDurability: StoreResetDeletionDurability;
      readonly cause: string;
    }
  | { readonly kind: 'absent'; readonly incidentId: string }
  | { readonly kind: 'staged'; readonly incidentId: string }
  | { readonly kind: 'in-flight'; readonly incidentId: string }
  | { readonly kind: 'unsafe'; readonly incidentId: string }
  | { readonly kind: 'undeterminable'; readonly incidentId: string };

export type StoreResetReleasePresentation = StoreResetReleaseResult & {
  readonly target: 'gen2';
  readonly flavor: BuildFlavor;
};

type StoreResetDeletionDurability = 'not-required' | 'not-attempted' | 'proven' | 'unproven';

function emptyLedger(): StoreResetRetentionLedger {
  return {
    version: STORE_RESET_RETENTION_LEDGER_VERSION,
    pending: null,
    preserved: null,
    rotation: null,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function preservationMechanism(value: unknown): PreservationMechanism | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'linked') {
    const coherence = value.coherence;
    return coherence === 'coherent' || coherence === 'torn' ? { kind: 'linked', coherence } : null;
  }
  if (value.kind !== 'copied' || !isRecord(value.cause)) return null;
  const coherence = value.coherence;
  if (coherence !== 'coherent' && coherence !== 'torn') return null;
  if (value.cause.kind === 'exclusion-unproven') {
    const reason = value.cause.reason;
    if (reason !== 'writer-live' && reason !== 'writer-unobservable' && reason !== 'lock-timeout') {
      return null;
    }
    return { kind: 'copied', cause: { kind: 'exclusion-unproven', reason }, coherence };
  }
  if (value.cause.kind !== 'link-unsupported' || typeof value.cause.code !== 'string') return null;
  const errno = value.cause.errno;
  if (errno !== 'EXDEV' && errno !== 'EMLINK' && errno !== 'EPERM' && errno !== 'EOPNOTSUPP' && errno !== 'other') {
    return null;
  }
  return {
    kind: 'copied',
    cause: { kind: 'link-unsupported', errno, code: value.cause.code },
    coherence,
  };
}

function retentionIncident(value: unknown): StoreResetRetentionIncident | null {
  if (
    !isRecord(value) ||
    typeof value.incidentId !== 'string' ||
    !isCanonicalStoreResetIncidentId(value.incidentId) ||
    typeof value.resetAt !== 'string' ||
    !isNonNegativeInteger(value.evidenceBytes) ||
    typeof value.resumeLeftActive !== 'boolean'
  ) {
    return null;
  }
  const storedProductVersion =
    typeof value.storedProductVersion === 'string' ? validateProductVersion(value.storedProductVersion) : null;
  if (
    value.storedProductVersion !== undefined &&
    value.storedProductVersion !== null &&
    storedProductVersion === null
  ) {
    return null;
  }
  const preservation = value.preservation === undefined ? undefined : preservationMechanism(value.preservation);
  if (value.preservation !== undefined && preservation === null) return null;
  return {
    incidentId: value.incidentId,
    resetAt: value.resetAt,
    evidenceBytes: value.evidenceBytes,
    ...(value.storedProductVersion === undefined ? {} : { storedProductVersion }),
    ...(preservation === null || preservation === undefined ? {} : { preservation }),
    resumeLeftActive: value.resumeLeftActive,
  };
}

function pendingIdentity(value: unknown): StoreResetPendingIdentity | null {
  if (
    !isRecord(value) ||
    !STORE_RESET_EVIDENCE_FILE_NAMES.includes(value.name as StoreResetEvidenceFileName) ||
    typeof value.dev !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.dev) ||
    typeof value.ino !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.ino)
  ) {
    return null;
  }
  return { name: value.name as StoreResetEvidenceFileName, dev: value.dev, ino: value.ino };
}

function parkingTransaction(value: unknown): StoreResetParkingTransaction | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'claim') {
    if (
      !Array.isArray(value.names) ||
      value.names.some((name) => !STORE_RESET_EVIDENCE_FILE_NAMES.includes(name as StoreResetEvidenceFileName)) ||
      new Set(value.names).size !== value.names.length
    ) {
      return null;
    }
    return { kind: 'claim', names: value.names as StoreResetEvidenceFileName[] };
  }
  if (value.kind !== 'publication' || !Array.isArray(value.identities)) return null;
  const identities = value.identities.map(pendingIdentity);
  if (
    identities.some((identity) => identity === null) ||
    new Set(identities.map((identity) => identity?.name)).size !== identities.length
  ) {
    return null;
  }
  if (typeof value.incidentId !== 'string' || !isCanonicalStoreResetIncidentId(value.incidentId)) {
    return null;
  }
  return {
    kind: 'publication',
    incidentId: value.incidentId,
    identities: identities as StoreResetPendingIdentity[],
  };
}

function parkedEntry(value: unknown): StoreResetParkedEntry | null {
  if (
    !isRecord(value) ||
    !STORE_RESET_EVIDENCE_FILE_NAMES.includes(value.name as StoreResetEvidenceFileName) ||
    (value.kind !== 'regular-file' &&
      value.kind !== 'directory' &&
      value.kind !== 'symbolic-link' &&
      value.kind !== 'other') ||
    (value.sizeBytes !== null && !isNonNegativeInteger(value.sizeBytes))
  ) {
    return null;
  }
  return {
    name: value.name as StoreResetEvidenceFileName,
    kind: value.kind,
    sizeBytes: value.sizeBytes,
  };
}

function retentionPending(value: unknown): StoreResetRetentionPending | null {
  if (!isRecord(value) || typeof value.resetAt !== 'string' || !Array.isArray(value.identities)) return null;
  const identities = value.identities.map(pendingIdentity);
  if (identities.some((identity) => identity === null)) return null;
  const present = identities as StoreResetPendingIdentity[];
  if (new Set(present.map((identity) => identity.name)).size !== present.length || !isRecord(value.outcome)) {
    return null;
  }
  if (value.outcome.kind !== 'preserve') return null;
  const incident = retentionIncident(value.outcome.incident);
  return incident === null
    ? null
    : {
        resetAt: value.resetAt,
        identities: present,
        outcome: { kind: 'preserve', incident },
      };
}

function incompleteRotation(value: unknown): StoreResetIncompleteRotation | null {
  if (!isRecord(value) || value.kind !== 'incomplete' || typeof value.cause !== 'string') return null;
  const survivor = value.survivor;
  if (
    !isRecord(survivor) ||
    (survivor.kind !== 'incident' && survivor.kind !== 'parking') ||
    typeof survivor.id !== 'string' ||
    !isCanonicalStoreResetIncidentId(survivor.id)
  ) {
    return null;
  }
  return { kind: 'incomplete', survivor: { kind: survivor.kind, id: survivor.id }, cause: value.cause };
}

export function parseStoreResetRetentionLedger(text: string): StoreResetRetentionLedger | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== STORE_RESET_RETENTION_LEDGER_VERSION) return null;

  const pending = value.pending === undefined || value.pending === null ? null : retentionPending(value.pending);
  if (value.pending !== undefined && value.pending !== null && pending === null) return null;

  const preserved = value.preserved === null ? null : retentionIncident(value.preserved);
  if (value.preserved !== null && preserved === null) return null;

  const rotation = value.rotation === undefined || value.rotation === null ? null : incompleteRotation(value.rotation);
  if (value.rotation !== undefined && value.rotation !== null && rotation === null) return null;

  return { version: STORE_RESET_RETENTION_LEDGER_VERSION, pending, preserved, rotation };
}

export function readStoreResetRetentionLedger(
  storage: StoragePort,
  quarantineRoot: string,
): StoreResetRetentionLedger | null {
  const path = join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
  if (!storage.existsSync(path)) return null;
  try {
    const link = storage.lstatSync(path);
    const stat = storage.statSync(path, { bigint: true });
    if (
      !link.isFile() ||
      link.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > BigInt(MAX_RESET_RETENTION_LEDGER_BYTES)
    ) {
      return null;
    }
    return parseStoreResetRetentionLedger(storage.readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function parkedClassificationKind(value: unknown): StoreResetParkedClassificationKind | null {
  return value === 'absent' ||
    value === 'fresh' ||
    value === 'compatible' ||
    value === 'legacy-adoptable' ||
    value === 'older-incompatible' ||
    value === 'newer-incompatible' ||
    value === 'corrupt-or-unsupported'
    ? value
    : null;
}

export function parseStoreResetParkedRecord(text: string): StoreResetParkedRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== STORE_RESET_PARKED_SIDECAR_VERSION ||
    typeof value.parkingId !== 'string' ||
    !isCanonicalStoreResetIncidentId(value.parkingId) ||
    typeof value.parkedAt !== 'string' ||
    /[\r\n]/u.test(value.parkedAt) ||
    (value.parkingOrder !== undefined &&
      (typeof value.parkingOrder !== 'string' || !/^[1-9]\d*$/u.test(value.parkingOrder))) ||
    (value.phase !== 'in-flight' && value.phase !== 'terminal') ||
    (value.cause !== 'publication' && value.cause !== 'intruder' && value.cause !== 'residual') ||
    (value.incidentId !== null &&
      (typeof value.incidentId !== 'string' || !isCanonicalStoreResetIncidentId(value.incidentId))) ||
    !Array.isArray(value.names) ||
    value.names.some((name) => !STORE_RESET_EVIDENCE_FILE_NAMES.includes(name as StoreResetEvidenceFileName)) ||
    new Set(value.names).size !== value.names.length ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }
  const entries = value.entries.map(parkedEntry);
  if (entries.some((entry) => entry === null) || new Set(entries.map((entry) => entry?.name)).size !== entries.length) {
    return null;
  }
  const transaction = value.transaction === null ? null : parkingTransaction(value.transaction);
  const transactionMatchesRecord =
    transaction === null ||
    (transaction.kind === 'publication'
      ? value.cause === 'publication' && value.incidentId === transaction.incidentId
      : value.cause === 'residual' && value.incidentId === null);
  if (
    (value.transaction !== null && transaction === null) ||
    (value.phase === 'in-flight') !== (transaction !== null) ||
    !transactionMatchesRecord ||
    (value.phase === 'in-flight' && (value.names.length > 0 || entries.length > 0)) ||
    (value.phase === 'terminal' && value.names.length !== entries.length) ||
    (value.phase === 'terminal' && value.names.some((name, index) => name !== entries[index]?.name))
  ) {
    return null;
  }
  const classification = value.classification === null ? null : parkedClassificationKind(value.classification);
  if (value.classification !== null && classification === null) return null;
  return {
    version: STORE_RESET_PARKED_SIDECAR_VERSION,
    parkingId: value.parkingId,
    parkedAt: value.parkedAt,
    ...(value.parkingOrder === undefined ? {} : { parkingOrder: value.parkingOrder }),
    phase: value.phase,
    cause: value.cause,
    incidentId: value.incidentId,
    names: value.names as StoreResetEvidenceFileName[],
    entries: entries as StoreResetParkedEntry[],
    transaction,
    classification,
  };
}

export function writeStoreResetParkedRecord(
  storage: StoragePort,
  parkingRoot: string,
  record: StoreResetParkedRecord,
  held: SettlementHeld,
  coordinate: string = record.parkingId,
): void {
  held.hold();
  const parkingDirectory = join(parkingRoot, coordinate);
  assertContainedDirectory(storage, parkingRoot, parkingDirectory);
  const written = held.actuator.writeWholeFileDurable(
    join(parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME),
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );
  if (!written) throw new Error('Store-reset parking sidecar could not be published durably.');
}

export function readStoreResetParkedRecord(
  storage: StoragePort,
  parkingRoot: string,
  parkingId: string,
  coordinate: string = parkingId,
): StoreResetParkedRecord | null {
  const parkingDirectory = join(parkingRoot, coordinate);
  assertContainedDirectory(storage, parkingRoot, parkingDirectory);
  const sidecarPath = join(parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME);
  try {
    const link = storage.lstatSync(sidecarPath);
    const stat = storage.statSync(sidecarPath, { bigint: true });
    if (
      !link.isFile() ||
      link.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > BigInt(MAX_RESET_PARKED_SIDECAR_BYTES)
    ) {
      return null;
    }
    const record = parseStoreResetParkedRecord(storage.readFileSync(sidecarPath, 'utf-8'));
    return coordinate === STORE_RESET_IN_FLIGHT_DIRECTORY || record?.parkingId === parkingId ? record : null;
  } catch {
    return null;
  }
}

export function discoverStoreResetParkedRecords(
  storage: StoragePort,
  quarantineRoot: string,
): StoreResetParkedDiscovery {
  const rootPresence = pathPresence(storage, quarantineRoot);
  if (rootPresence === 'absent') return { entries: [], truncated: false };
  assertQuarantineRoot(storage, quarantineRoot);
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const parkingPresence = pathPresence(storage, parkingRoot);
  if (parkingPresence === 'absent') return { entries: [], truncated: false };
  assertContainedDirectory(storage, quarantineRoot, parkingRoot);
  const read = storage.readDirectoryBoundedSync(parkingRoot, MAX_INCIDENT_ROOT_ENTRIES + 1);
  const entries: StoreResetParkedDiscoveryEntry[] = [];
  if (pathPresence(storage, join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY)) === 'present') {
    try {
      const record = readStoreResetParkedRecord(
        storage,
        parkingRoot,
        STORE_RESET_IN_FLIGHT_DIRECTORY,
        STORE_RESET_IN_FLIGHT_DIRECTORY,
      );
      entries.push({
        parkingId: record?.parkingId ?? STORE_RESET_IN_FLIGHT_DIRECTORY,
        coordinate: STORE_RESET_IN_FLIGHT_DIRECTORY,
        state: record === null ? 'malformed' : 'parked',
        record,
      });
    } catch (error: unknown) {
      entries.push({
        parkingId: STORE_RESET_IN_FLIGHT_DIRECTORY,
        coordinate: STORE_RESET_IN_FLIGHT_DIRECTORY,
        state: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'unavailable',
        record: null,
      });
    }
  }
  const terminalIds = read.entries.filter(isCanonicalStoreResetIncidentId);
  for (const parkingId of terminalIds.slice(0, MAX_INCIDENT_ROOT_ENTRIES)) {
    try {
      const record = readStoreResetParkedRecord(storage, parkingRoot, parkingId, parkingId);
      entries.push({ parkingId, coordinate: parkingId, state: record === null ? 'malformed' : 'parked', record });
    } catch (error: unknown) {
      entries.push({
        parkingId,
        coordinate: parkingId,
        state: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'unavailable',
        record: null,
      });
    }
  }
  return { entries, truncated: read.overflow || terminalIds.length > MAX_INCIDENT_ROOT_ENTRIES };
}

export function nextStoreResetParkingOrder(storage: StoragePort, quarantineRoot: string): string {
  const discovered = discoverStoreResetParkedRecords(storage, quarantineRoot);
  const latest = discovered.entries.reduce((highest, entry) => {
    const order = entry.record?.parkingOrder;
    return order === undefined ? highest : highest > BigInt(order) ? highest : BigInt(order);
  }, 0n);
  return String(latest + 1n);
}

function writeLedger(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): boolean {
  try {
    const written = held.actuator.writeWholeFileDurable(
      join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME),
      `${JSON.stringify(ledger)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
    if (written) return true;
    writeAuditEvent('store_reset_retention_ledger_write_failed', { cause: 'durable-write-rejected' }, 'warn');
  } catch (error: unknown) {
    writeAuditEvent(
      'store_reset_retention_ledger_write_failed',
      { cause: error instanceof Error ? error.message : String(error) },
      'warn',
    );
  }
  return false;
}

function writeRequiredLedger(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): void {
  if (!writeLedger(storage, quarantineRoot, ledger, held)) {
    throw new Error('Store-reset pending retention promise could not be published durably.');
  }
}

function pathPresence(storage: StoragePort, path: string): 'present' | 'absent' | 'undeterminable' {
  try {
    storage.lstatSync(path);
    return 'present';
  } catch (error: unknown) {
    return isNoEntryError(error) ? 'absent' : 'undeterminable';
  }
}

class UnsafeStoreResetPath extends Error {}

export function assertQuarantineRoot(storage: StoragePort, root: string): StorageBigIntStat {
  const link = storage.lstatSync(root);
  const stat = storage.statSync(root, { bigint: true });
  if (!link.isDirectory() || link.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeStoreResetPath('Store reset quarantine root is not a directory.');
  }
  return stat;
}

export function assertContainedDirectory(storage: StoragePort, parent: string, child: string): StorageBigIntStat {
  const link = storage.lstatSync(child);
  const stat = storage.statSync(child, { bigint: true });
  if (!link.isDirectory() || link.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeStoreResetPath('Store-reset entry is not a directory.');
  }
  const parentReal = resolve(storage.realpathSync(parent));
  const childReal = resolve(storage.realpathSync(child));
  const fromParent = relative(parentReal, childReal);
  if (fromParent === '' || isAbsolute(fromParent) || fromParent === '..' || fromParent.startsWith(`..${sep}`)) {
    throw new UnsafeStoreResetPath('Store-reset directory escapes its parent.');
  }
  return stat;
}

function readCommittedManifest(
  storage: StoragePort,
  quarantineRoot: string,
  incidentId: string,
): StoreResetIncidentManifest | null {
  try {
    const directory = join(quarantineRoot, incidentId);
    const directoryLink = storage.lstatSync(directory);
    if (!directoryLink.isDirectory() || directoryLink.isSymbolicLink()) return null;
    const path = join(directory, STORE_RESET_MANIFEST_FILE_NAME);
    const link = storage.lstatSync(path);
    const stat = storage.statSync(path, { bigint: true });
    if (!link.isFile() || link.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(MAX_RESET_MANIFEST_BYTES)) {
      return null;
    }
    const manifest = parseStoreResetIncidentManifest(Buffer.from(storage.readFileSync(path, 'utf-8')));
    return manifest.incidentId === incidentId ? manifest : null;
  } catch {
    return null;
  }
}

function incidentFromManifest(manifest: StoreResetIncidentManifest): StoreResetRetentionIncident {
  return {
    incidentId: manifest.incidentId,
    resetAt: manifest.resetAt,
    evidenceBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    resumeLeftActive: false,
  };
}

function withPreservedOutcome(
  ledger: StoreResetRetentionLedger,
  incident: StoreResetRetentionIncident,
): StoreResetRetentionLedger {
  return { ...ledger, pending: null, preserved: incident, rotation: null };
}

export function retainOnlyStoreResetPreservedCopy(
  storage: StoragePort,
  quarantineRoot: string,
  survivor: Readonly<{ kind: 'incident' | 'parking'; id: string }>,
  held: SettlementHeld,
): StoreResetRetentionRotation {
  held.hold();
  const incomplete = (cause: unknown): StoreResetRetentionRotation => ({
    kind: 'incomplete',
    survivor,
    cause: cause instanceof Error ? cause.message : String(cause),
  });
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const survivorRoot = survivor.kind === 'incident' ? quarantineRoot : parkingRoot;
  const survivorPath = join(survivorRoot, survivor.id);
  const guardedSurvivorPath = `${survivorPath}${STORE_RESET_ROTATION_SURVIVOR_SUFFIX}`;
  const restoreGuardedSurvivor = (): void => {
    if (pathPresence(storage, guardedSurvivorPath) !== 'present') return;
    if (pathPresence(storage, survivorPath) === 'absent') {
      held.actuator.rename(guardedSurvivorPath, survivorPath);
    }
  };
  try {
    restoreGuardedSurvivor();
  } catch (error: unknown) {
    return incomplete(error);
  }
  let survivorIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  try {
    if (survivor.kind === 'parking') assertContainedDirectory(storage, quarantineRoot, parkingRoot);
    const survivorStat = assertContainedDirectory(storage, survivorRoot, survivorPath);
    survivorIdentity = { dev: survivorStat.dev, ino: survivorStat.ino };
    if (!held.actuator.syncDirectory(survivorRoot)) {
      return incomplete('The new store-reset survivor could not be synchronized durably.');
    }
  } catch (error: unknown) {
    return incomplete(error);
  }
  const survivorStillOwnsIdentity = (): boolean => {
    try {
      const link = storage.lstatSync(survivorPath);
      const stat = storage.statSync(survivorPath, { bigint: true });
      return (
        link.isDirectory() &&
        !link.isSymbolicLink() &&
        stat.isDirectory() &&
        stat.dev === survivorIdentity.dev &&
        stat.ino === survivorIdentity.ino
      );
    } catch {
      return false;
    }
  };
  const survivorChangedCause =
    'The chosen store-reset survivor disappeared or changed before superseded-coordinate removal.';
  const survivorChanged = () => incomplete(survivorChangedCause);

  try {
    held.actuator.rename(survivorPath, guardedSurvivorPath);
    if (!held.actuator.syncDirectory(survivorRoot)) {
      restoreGuardedSurvivor();
      return incomplete('The guarded store-reset survivor could not be synchronized durably.');
    }
  } catch (error: unknown) {
    try {
      restoreGuardedSurvivor();
    } catch {
      // The guarded coordinate remains recoverable by the next reconciliation.
    }
    return incomplete(error);
  }

  const guardedSurvivorStillOwnsIdentity = (): boolean => {
    try {
      const link = storage.lstatSync(guardedSurvivorPath);
      const stat = storage.statSync(guardedSurvivorPath, { bigint: true });
      return (
        link.isDirectory() &&
        !link.isSymbolicLink() &&
        stat.isDirectory() &&
        stat.dev === survivorIdentity.dev &&
        stat.ino === survivorIdentity.ino
      );
    } catch {
      return false;
    }
  };

  const failAndRestore = (cause: unknown): StoreResetRetentionRotation => {
    try {
      restoreGuardedSurvivor();
    } catch (restoreError: unknown) {
      return incomplete(restoreError);
    }
    return incomplete(cause);
  };

  for (const parent of [quarantineRoot, parkingRoot]) {
    try {
      if (parent === parkingRoot) {
        if (pathPresence(storage, parkingRoot) === 'absent') continue;
        assertContainedDirectory(storage, quarantineRoot, parkingRoot);
      }
    } catch (error: unknown) {
      return failAndRestore(error);
    }
    let readLimit = MAX_INCIDENT_ROOT_ENTRIES;
    while (true) {
      let read: ReturnType<StoragePort['readDirectoryBoundedSync']>;
      try {
        read = storage.readDirectoryBoundedSync(parent, readLimit);
      } catch (error: unknown) {
        return failAndRestore(error);
      }
      let removed = false;
      let restoredRetiredCoordinate = false;
      for (const candidateId of read.entries) {
        if (candidateId.endsWith(STORE_RESET_ROTATION_RETIRED_SUFFIX)) {
          const originalId = candidateId.slice(0, -STORE_RESET_ROTATION_RETIRED_SUFFIX.length);
          if (!isCanonicalStoreResetIncidentId(originalId)) continue;
          const retiredPath = join(parent, candidateId);
          const originalPath = join(parent, originalId);
          try {
            if (pathPresence(storage, originalPath) !== 'absent') {
              return failAndRestore('A retired store-reset coordinate collided with its original name.');
            }
            held.actuator.rename(retiredPath, originalPath);
            restoredRetiredCoordinate = true;
          } catch (error: unknown) {
            return failAndRestore(error);
          }
          continue;
        }
        if (!isCanonicalStoreResetIncidentId(candidateId) || (parent === survivorRoot && candidateId === survivor.id)) {
          continue;
        }
        const candidatePath = join(parent, candidateId);
        const retiredPath = `${candidatePath}${STORE_RESET_ROTATION_RETIRED_SUFFIX}`;
        held.hold();
        let containedDirectory = false;
        try {
          assertContainedDirectory(storage, parent, candidatePath);
          containedDirectory = true;
        } catch (error: unknown) {
          if (error instanceof UnsafeStoreResetPath) {
            try {
              const link = storage.lstatSync(candidatePath);
              if (link.isDirectory() && !link.isSymbolicLink()) return failAndRestore(error);
              held.actuator.rename(candidatePath, retiredPath);
            } catch (removalError: unknown) {
              if (!isNoEntryError(removalError)) return failAndRestore(removalError);
              continue;
            }
          } else if (isNoEntryError(error)) {
            continue;
          } else {
            return failAndRestore(error);
          }
        }
        if (containedDirectory) {
          try {
            held.actuator.rename(candidatePath, retiredPath);
          } catch (error: unknown) {
            if (isNoEntryError(error)) continue;
            return failAndRestore(error);
          }
        }
        try {
          if (!held.actuator.syncDirectory(parent)) {
            held.actuator.rename(retiredPath, candidatePath);
            return failAndRestore('A superseded store-reset coordinate retirement could not be synchronized durably.');
          }
          if (!guardedSurvivorStillOwnsIdentity()) {
            held.actuator.rename(retiredPath, candidatePath);
            return failAndRestore(survivorChangedCause);
          }
          const retired = storage.lstatSync(retiredPath);
          if (retired.isDirectory() && !retired.isSymbolicLink()) {
            held.actuator.remove(retiredPath, { recursive: true, force: true });
          } else {
            held.actuator.unlink(retiredPath);
          }
          removed = true;
          if (!guardedSurvivorStillOwnsIdentity()) return failAndRestore(survivorChangedCause);
        } catch (error: unknown) {
          try {
            if (pathPresence(storage, retiredPath) === 'present' && pathPresence(storage, candidatePath) === 'absent') {
              held.actuator.rename(retiredPath, candidatePath);
            }
          } catch {
            // The retired coordinate remains named for the next reconciliation.
          }
          return failAndRestore(error);
        }
      }
      if (removed && !held.actuator.syncDirectory(parent)) return failAndRestore('Superseded removal was not durable.');
      if (restoredRetiredCoordinate) {
        readLimit = MAX_INCIDENT_ROOT_ENTRIES;
        continue;
      }
      if (!read.overflow) break;
      if (removed) {
        readLimit = MAX_INCIDENT_ROOT_ENTRIES;
        continue;
      }
      const widerLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(readLimit + 1, readLimit * 2));
      if (widerLimit === readLimit) break;
      readLimit = widerLimit;
    }
  }
  if (!guardedSurvivorStillOwnsIdentity()) return failAndRestore(survivorChangedCause);
  try {
    held.actuator.rename(guardedSurvivorPath, survivorPath);
  } catch (error: unknown) {
    return failAndRestore(error);
  }
  if (!survivorStillOwnsIdentity()) return survivorChanged();
  return { kind: 'complete', survivor };
}

export function recordStoreResetParked(
  storage: StoragePort,
  quarantineRoot: string,
  parkingId: string,
  held: SettlementHeld,
): StoreResetRetentionRotation {
  const rotation = retainOnlyStoreResetPreservedCopy(storage, quarantineRoot, { kind: 'parking', id: parkingId }, held);
  const ledger = readStoreResetRetentionLedger(storage, quarantineRoot) ?? emptyLedger();
  writeLedger(
    storage,
    quarantineRoot,
    {
      ...ledger,
      pending: null,
      preserved: null,
      rotation: rotation.kind === 'incomplete' ? rotation : null,
    },
    held,
  );
  return rotation;
}

function reconcilePending(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): StoreResetRetentionLedger {
  const pending = ledger.pending;
  if (pending === null) return ledger;

  const incidentId = pending.outcome.incident.incidentId;
  const committed = readCommittedManifest(storage, quarantineRoot, incidentId);
  if (committed !== null) {
    const rotation = retainOnlyStoreResetPreservedCopy(
      storage,
      quarantineRoot,
      { kind: 'incident', id: incidentId },
      held,
    );
    if (rotation.kind === 'incomplete') {
      const incomplete = { ...ledger, rotation };
      writeLedger(storage, quarantineRoot, incomplete, held);
      return incomplete;
    }
    const reconciled = withPreservedOutcome(ledger, pending.outcome.incident);
    writeLedger(storage, quarantineRoot, reconciled, held);
    return reconciled;
  }
  const finalPresence = pathPresence(storage, join(quarantineRoot, incidentId));
  const stagingPresence = pathPresence(storage, join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY, incidentId));
  if (finalPresence === 'absent' && stagingPresence === 'absent') {
    const cleared = { ...ledger, pending: null };
    writeLedger(storage, quarantineRoot, cleared, held);
    return cleared;
  }
  return ledger;
}

function availableRotationRecoveryId(storage: StoragePort, parent: string, originalId: string): string | null {
  for (let suffix = 0; suffix < 256; suffix += 1) {
    const candidateId = `${originalId.slice(0, -2)}${suffix.toString(16).padStart(2, '0')}`;
    if (candidateId !== originalId && pathPresence(storage, join(parent, candidateId)) === 'absent') return candidateId;
  }
  return null;
}

function recoverInterruptedRotation(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): boolean {
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const knownSurvivors = [
    ledger.rotation?.survivor,
    ledger.pending === null ? undefined : { kind: 'incident' as const, id: ledger.pending.outcome.incident.incidentId },
    ledger.preserved === null ? undefined : { kind: 'incident' as const, id: ledger.preserved.incidentId },
  ].filter((survivor): survivor is StoreResetRetentionSurvivor => survivor !== undefined);
  const moveToVisibleCoordinate = (parent: string, temporaryPath: string, originalId: string): boolean => {
    const temporaryPresence = pathPresence(storage, temporaryPath);
    if (temporaryPresence === 'undeterminable') return false;
    if (temporaryPresence === 'absent') return true;
    const originalPath = join(parent, originalId);
    const targetId =
      pathPresence(storage, originalPath) === 'absent'
        ? originalId
        : availableRotationRecoveryId(storage, parent, originalId);
    if (targetId === null) return false;
    held.actuator.rename(temporaryPath, join(parent, targetId));
    return held.actuator.syncDirectory(parent);
  };

  try {
    for (const survivor of knownSurvivors) {
      const parent = survivor.kind === 'incident' ? quarantineRoot : parkingRoot;
      const survivorPath = join(parent, survivor.id);
      if (!moveToVisibleCoordinate(parent, `${survivorPath}${STORE_RESET_ROTATION_SURVIVOR_SUFFIX}`, survivor.id)) {
        return false;
      }
    }
    for (const parent of [quarantineRoot, parkingRoot]) {
      const parentPresence = pathPresence(storage, parent);
      if (parentPresence === 'undeterminable') return false;
      if (parentPresence === 'absent') continue;
      let limit = MAX_INCIDENT_ROOT_ENTRIES;
      while (true) {
        const read = storage.readDirectoryBoundedSync(parent, limit);
        for (const name of read.entries) {
          if (!name.endsWith(STORE_RESET_ROTATION_RETIRED_SUFFIX)) continue;
          const originalId = name.slice(0, -STORE_RESET_ROTATION_RETIRED_SUFFIX.length);
          if (!isCanonicalStoreResetIncidentId(originalId)) continue;
          if (!moveToVisibleCoordinate(parent, join(parent, name), originalId)) return false;
        }
        if (!read.overflow) break;
        const widerLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(limit + 1, limit * 2));
        if (widerLimit === limit) return false;
        limit = widerLimit;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function deriveIncompleteRotation(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
): StoreResetRetentionLedger {
  if (ledger.pending !== null || ledger.rotation === null) return ledger;
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  const coordinates: StoreResetRetentionSurvivor[] = [];
  for (const [kind, parent] of [
    ['incident', quarantineRoot],
    ['parking', parkingRoot],
  ] as const) {
    const parentPresence = pathPresence(storage, parent);
    if (parentPresence === 'undeterminable') return ledger;
    if (parentPresence === 'absent') continue;
    let limit = MAX_INCIDENT_ROOT_ENTRIES;
    while (true) {
      const read = storage.readDirectoryBoundedSync(parent, limit);
      for (const id of read.entries) {
        if (!isCanonicalStoreResetIncidentId(id)) continue;
        const coordinatePresence = pathPresence(storage, join(parent, id));
        if (coordinatePresence === 'undeterminable') return ledger;
        if (coordinatePresence === 'present') coordinates.push({ kind, id });
      }
      if (!read.overflow) break;
      const widerLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(limit + 1, limit * 2));
      if (widerLimit === limit) break;
      limit = widerLimit;
      coordinates.length = 0;
    }
  }
  const remaining = [
    ...new Map(coordinates.map((coordinate) => [`${coordinate.kind}:${coordinate.id}`, coordinate])).values(),
  ];
  let reconciled: StoreResetRetentionLedger;
  if (remaining.length <= 1) {
    const coordinate = remaining[0];
    const preserved =
      coordinate?.kind === 'incident'
        ? ledger.preserved?.incidentId === coordinate.id
          ? ledger.preserved
          : (() => {
              const manifest = readCommittedManifest(storage, quarantineRoot, coordinate.id);
              return manifest === null ? null : incidentFromManifest(manifest);
            })()
        : null;
    reconciled = { ...ledger, preserved, rotation: null };
  } else {
    const survivor =
      remaining.find(
        (coordinate) =>
          coordinate.kind === ledger.rotation?.survivor.kind && coordinate.id === ledger.rotation.survivor.id,
      ) ?? remaining[0];
    reconciled = {
      ...ledger,
      rotation: {
        kind: 'incomplete',
        survivor,
        cause: ledger.rotation.cause,
      },
    };
  }
  return reconciled;
}

function reconcileIncompleteRotation(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): StoreResetRetentionLedger {
  const reconciled = deriveIncompleteRotation(storage, quarantineRoot, ledger);
  if (reconciled !== ledger) writeLedger(storage, quarantineRoot, reconciled, held);
  return reconciled;
}

function reconcileRetention(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): StoreResetRetentionLedger {
  if (!recoverInterruptedRotation(storage, quarantineRoot, ledger, held)) return ledger;
  return reconcileIncompleteRotation(
    storage,
    quarantineRoot,
    reconcilePending(storage, quarantineRoot, ledger, held),
    held,
  );
}

export function settleStoreResetPending(storage: StoragePort, quarantineRoot: string, held: SettlementHeld): void {
  reconcileRetention(
    storage,
    quarantineRoot,
    readStoreResetRetentionLedger(storage, quarantineRoot) ?? emptyLedger(),
    held,
  );
}

export function resolveStoreResetRetentionSlot(
  storage: StoragePort,
  quarantineRoot: string,
  held: SettlementHeld,
): StoreResetRetentionSlot {
  const ledger = reconcileRetention(
    storage,
    quarantineRoot,
    readStoreResetRetentionLedger(storage, quarantineRoot) ?? emptyLedger(),
    held,
  );
  if (ledger.preserved !== null) {
    const holderPath = join(quarantineRoot, ledger.preserved.incidentId);
    // Any result except proven absence must keep the slot held; uncertainty cannot authorize replacement.
    if (pathPresence(storage, holderPath) !== 'absent') {
      return {
        kind: 'held',
        ledger,
        holder: ledger.preserved,
        manifest: readCommittedManifest(storage, quarantineRoot, ledger.preserved.incidentId),
      };
    }
  }

  if (!storage.existsSync(quarantineRoot)) return { kind: 'vacant', ledger };
  const read = storage.readDirectoryBoundedSync(quarantineRoot, MAX_INCIDENT_ROOT_ENTRIES);
  const manifests = read.entries
    .filter(isCanonicalStoreResetIncidentId)
    .map((incidentId) => readCommittedManifest(storage, quarantineRoot, incidentId))
    .filter((manifest): manifest is StoreResetIncidentManifest => manifest !== null);
  // Adoption requires one complete candidate set; truncation or several manifests cannot authorize a guess.
  if (read.overflow || manifests.length !== 1) return { kind: 'vacant', ledger: { ...ledger, preserved: null } };

  const manifest = manifests[0];
  const holder = incidentFromManifest(manifest);
  const adopted = { ...ledger, preserved: holder };
  writeLedger(storage, quarantineRoot, adopted, held);
  return { kind: 'held', ledger: adopted, holder, manifest };
}

export function recordStoreResetPreserved(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  incident: StoreResetRetentionIncident,
  held: SettlementHeld,
): StoreResetRetentionRotation {
  const rotation = retainOnlyStoreResetPreservedCopy(
    storage,
    quarantineRoot,
    {
      kind: 'incident',
      id: incident.incidentId,
    },
    held,
  );
  writeLedger(
    storage,
    quarantineRoot,
    rotation.kind === 'incomplete' ? { ...ledger, rotation } : withPreservedOutcome(ledger, incident),
    held,
  );
  return rotation;
}

export function recordStoreResetPending(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  pending: StoreResetRetentionPending,
  held: SettlementHeld,
): StoreResetRetentionLedger {
  held.hold();
  const next = { ...ledger, pending };
  writeRequiredLedger(storage, quarantineRoot, next, held);
  return next;
}

export function clearStoreResetPending(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  held: SettlementHeld,
): void {
  held.hold();
  if (ledger.pending !== null) writeLedger(storage, quarantineRoot, { ...ledger, pending: null }, held);
}

export function recordStoreResetResumeLeftActive(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  incidentId: string,
  names: readonly StoreResetEvidenceFileName[],
  held: SettlementHeld,
): void {
  held.hold();
  if (names.length === 0) return;
  const update = (incident: StoreResetRetentionIncident): StoreResetRetentionIncident =>
    incident.incidentId === incidentId
      ? {
          ...incident,
          resumeLeftActive: true,
          ...(incident.preservation === undefined
            ? {}
            : // Unresolved active evidence means a resumed publication can no longer certify coherence.
              { preservation: { ...incident.preservation, coherence: 'torn' as const } }),
        }
      : incident;
  writeLedger(
    storage,
    quarantineRoot,
    {
      ...ledger,
      preserved: ledger.preserved === null ? null : update(ledger.preserved),
    },
    held,
  );
}

function directoryEvidenceBytes(storage: StoragePort, root: string, excludedRootEntry: string): number | null {
  const directories = [root];
  let total = 0;
  let entries = 0;
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    let read: ReturnType<StoragePort['readDirectoryBoundedSync']>;
    try {
      read = storage.readDirectoryBoundedSync(directory, MAX_INCIDENT_DIR_ENTRIES + 1);
    } catch {
      return null;
    }
    if (read.overflow) return null;
    for (const name of read.entries) {
      entries += 1;
      if (entries > MAX_INCIDENT_ROOT_ENTRIES * MAX_INCIDENT_DIR_ENTRIES) return null;
      const path = join(directory, name);
      try {
        const link = storage.lstatSync(path);
        if (link.isSymbolicLink()) continue;
        if (link.isDirectory()) {
          directories.push(path);
          continue;
        }
        if (!link.isFile() || (directory === root && name === excludedRootEntry)) {
          continue;
        }
        const stat = storage.lstatSync(path, { bigint: true });
        if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER - total)) return null;
        total += Number(stat.size);
      } catch {
        return null;
      }
    }
  }
  return total;
}

function parkingDirectoryEvidenceBytes(storage: StoragePort, parkingDirectory: string): number | null {
  return directoryEvidenceBytes(storage, parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME);
}

function incidentDirectoryEvidenceBytes(storage: StoragePort, incidentDirectory: string): number | null {
  return directoryEvidenceBytes(storage, incidentDirectory, STORE_RESET_MANIFEST_FILE_NAME);
}

export function releaseStoreResetIncident(
  storage: StoragePort,
  quarantineRoot: string,
  incidentId: string,
  held: SettlementHeld,
): StoreResetReleaseResult {
  held.hold();
  if (incidentId === STORE_RESET_IN_FLIGHT_DIRECTORY) return { kind: 'undeterminable', incidentId };
  if (!isCanonicalStoreResetIncidentId(incidentId)) return { kind: 'absent', incidentId };
  const rootPresence = pathPresence(storage, quarantineRoot);
  if (rootPresence === 'absent') return { kind: 'absent', incidentId };
  if (rootPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  try {
    assertQuarantineRoot(storage, quarantineRoot);
  } catch (error: unknown) {
    return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
  }
  const ledgerPath = join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
  const ledgerPresence = pathPresence(storage, ledgerPath);
  if (ledgerPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  const ledgerRead = readStoreResetRetentionLedger(storage, quarantineRoot);
  if (ledgerPresence === 'present' && ledgerRead === null) return { kind: 'undeterminable', incidentId };
  const ledgerBeforeRecovery = ledgerRead ?? emptyLedger();
  const ledger = recoverInterruptedRotation(storage, quarantineRoot, ledgerBeforeRecovery, held)
    ? reconcileIncompleteRotation(storage, quarantineRoot, ledgerBeforeRecovery, held)
    : ledgerBeforeRecovery;
  const stagingPath = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY, incidentId);
  const stagingPresence = pathPresence(storage, stagingPath);
  if (stagingPresence === 'present') {
    try {
      const stagingRoot = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY);
      assertContainedDirectory(storage, quarantineRoot, stagingRoot);
      assertContainedDirectory(storage, stagingRoot, stagingPath);
      return { kind: 'staged', incidentId };
    } catch (error: unknown) {
      return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
    }
  }
  if (stagingPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  const parkingRoot = join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY);
  let parkingPath = join(parkingRoot, incidentId);
  let parkingPresence = pathPresence(storage, parkingPath);
  let parkingRecord: StoreResetParkedRecord | null = null;
  let parkingRecordVerified = true;
  if (parkingPresence === 'absent') {
    const inFlightPath = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
    const inFlightPresence = pathPresence(storage, inFlightPath);
    if (inFlightPresence === 'present') {
      try {
        assertContainedDirectory(storage, quarantineRoot, parkingRoot);
        assertContainedDirectory(storage, parkingRoot, inFlightPath);
        const inFlight = readStoreResetParkedRecord(storage, parkingRoot, incidentId, STORE_RESET_IN_FLIGHT_DIRECTORY);
        if (inFlight === null) return { kind: 'undeterminable', incidentId };
        if (inFlight.parkingId === incidentId || inFlight.incidentId === incidentId) {
          parkingPath = inFlightPath;
          parkingPresence = 'present';
          parkingRecord = inFlight;
        }
      } catch (error: unknown) {
        return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
      }
    } else if (inFlightPresence === 'undeterminable') {
      return { kind: 'undeterminable', incidentId };
    }
  }
  if (parkingPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  if (parkingPresence === 'present') {
    held.hold();
    try {
      assertContainedDirectory(storage, quarantineRoot, parkingRoot);
      assertContainedDirectory(storage, parkingRoot, parkingPath);
      parkingRecord ??= readStoreResetParkedRecord(storage, parkingRoot, incidentId, incidentId);
    } catch (error: unknown) {
      return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
    }
    parkingRecordVerified = parkingRecord !== null;
    if (parkingRecord?.phase === 'in-flight') return { kind: 'in-flight', incidentId };
  }
  const incidentPath = join(quarantineRoot, incidentId);
  const incidentPresence = pathPresence(storage, incidentPath);
  if (incidentPresence === 'absent' && parkingPresence === 'absent') return { kind: 'absent', incidentId };
  if (incidentPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  if (incidentPresence === 'present') {
    try {
      assertContainedDirectory(storage, quarantineRoot, incidentPath);
    } catch (error: unknown) {
      return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
    }
  }
  const holder = incidentPresence === 'present' && ledger.preserved?.incidentId === incidentId;
  const parkedEvidenceBytes =
    parkingPresence === 'present' && parkingRecordVerified ? parkingDirectoryEvidenceBytes(storage, parkingPath) : null;
  const incidentEvidenceBytes =
    incidentPresence === 'present' ? incidentDirectoryEvidenceBytes(storage, incidentPath) : null;
  const parkingEvidenceBytes = parkedEvidenceBytes;
  let parkingDeletionDurability: StoreResetDeletionDurability =
    parkingPresence === 'present' ? 'unproven' : 'not-required';
  let incidentDeletionDurability: StoreResetDeletionDurability =
    incidentPresence === 'present' ? 'not-attempted' : 'not-required';
  const incomplete = (error: unknown): StoreResetReleaseResult => ({
    kind: 'partially-released',
    incidentId,
    incidentEvidenceBytes,
    parkingEvidenceBytes,
    parkingState: pathPresence(storage, parkingPath),
    incidentState: pathPresence(storage, incidentPath),
    parkingDeletionDurability,
    incidentDeletionDurability,
    cause: error instanceof Error ? error.message : String(error),
  });
  if (parkingPresence === 'present') {
    held.hold();
    try {
      held.actuator.remove(parkingPath, { recursive: true });
    } catch (error: unknown) {
      return incomplete(error);
    }
  }
  let parkingDurable = parkingPresence === 'absent';
  if (parkingPresence === 'present') {
    try {
      parkingDurable = held.actuator.syncDirectory(parkingRoot);
    } catch {
      parkingDurable = false;
    }
    parkingDeletionDurability = parkingDurable ? 'proven' : 'unproven';
  }
  if (incidentPresence === 'present') {
    incidentDeletionDurability = 'unproven';
    held.hold();
    try {
      held.actuator.remove(incidentPath, { recursive: true });
    } catch (error: unknown) {
      return incomplete(error);
    }
  }
  let quarantineDurable: boolean;
  held.hold();
  try {
    quarantineDurable = held.actuator.syncDirectory(quarantineRoot);
  } catch {
    quarantineDurable = false;
  }
  if (incidentPresence === 'present') {
    incidentDeletionDurability = quarantineDurable ? 'proven' : 'unproven';
  }
  const durability = quarantineDurable && parkingDurable ? 'proven' : 'unproven';
  const clearsHolder = holder;
  const clearsPending = ledger.pending?.outcome.incident.incidentId === incidentId;
  const clearsRotation = ledger.rotation?.survivor.id === incidentId;
  if (clearsHolder || clearsPending || clearsRotation) {
    held.hold();
    const releasedLedger = {
      ...ledger,
      ...(clearsHolder ? { preserved: null } : {}),
      ...(clearsPending ? { pending: null } : {}),
    };
    const written = writeLedger(
      storage,
      quarantineRoot,
      clearsRotation ? deriveIncompleteRotation(storage, quarantineRoot, releasedLedger) : releasedLedger,
      held,
    );
    if (!written) {
      return incomplete(new Error('Store-reset retention ledger could not be updated durably.'));
    }
  }
  if (parkingPresence === 'present' && !parkingRecordVerified) {
    if (incidentPresence === 'present' && holder) {
      return {
        kind: 'released-with-unverified-parking',
        incidentId,
        incidentEvidenceBytes,
        parkingEvidenceBytes: null,
        durability,
      };
    }
    if (incidentPresence === 'present') {
      return {
        kind: 'not-holder-with-unverified-parking',
        incidentId,
        incidentEvidenceBytes,
        parkingEvidenceBytes: null,
        durability,
      };
    }
    return {
      kind: 'parked-unverified',
      incidentId,
      incidentEvidenceBytes: null,
      parkingEvidenceBytes: null,
      clearedPreservedSlot: clearsHolder,
      durability,
    };
  }
  if (holder) {
    return {
      kind: 'released',
      incidentId,
      incidentEvidenceBytes,
      parkingEvidenceBytes,
      durability,
    };
  }
  if (incidentPresence === 'absent' && parkingPresence === 'present') {
    return { kind: 'parked', incidentId, incidentEvidenceBytes, parkingEvidenceBytes, durability };
  }
  return { kind: 'not-holder', incidentId, incidentEvidenceBytes, parkingEvidenceBytes, durability };
}
