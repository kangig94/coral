import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { isRecord } from '../infra/json.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { validateProductVersion } from '../infra/product-version.js';
import type { ActiveEvidence } from './reset-active-evidence.js';
import {
  isCanonicalStoreResetIncidentId,
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
  type StoreResetPolicyCause,
} from './reset-incident.js';

export const STORE_RESET_RETENTION_LEDGER_VERSION = 1 as const;
export const STORE_RESET_RETENTION_LEDGER_FILE_NAME = `store-reset-retention.v${STORE_RESET_RETENTION_LEDGER_VERSION}.json`;
export const MAX_RESET_RETENTION_LEDGER_BYTES = 64 * 1024;
export const STORE_RESET_PARKED_SIDECAR_VERSION = 1 as const;
export const MAX_RESET_PARKED_SIDECAR_BYTES = 64 * 1024;

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
      kind: 'discard';
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
  phase: 'in-flight' | 'terminal';
  cause: 'publication' | 'discard' | 'intruder' | 'residual';
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

export type PreservedRetention =
  | { readonly slot: 'claimed' }
  | {
      readonly slot: 'excess';
      readonly holder: string;
      readonly lineage: 'unrelated' | 'undeterminable';
    };

export type DiscardReceipt = Readonly<{
  resetAt: string;
  resetPolicyCause: StoreResetPolicyCause;
  evidenceBytes: number;
  deferredTo: string;
}>;

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
  outcome:
    | Readonly<{
        kind: 'preserve';
        incident: StoreResetRetentionIncident;
        retention: PreservedRetention;
      }>
    | Readonly<{ kind: 'discard'; receipt: DiscardReceipt }>;
}>;

export type StoreResetRetentionLedger = Readonly<{
  version: typeof STORE_RESET_RETENTION_LEDGER_VERSION;
  pending: StoreResetRetentionPending | null;
  preserved: StoreResetRetentionIncident | null;
  excess: Readonly<{
    count: number;
    evidenceBytes: number;
    latest: StoreResetRetentionIncident & Extract<PreservedRetention, { readonly slot: 'excess' }>;
  }> | null;
  discarded: Readonly<{
    count: number;
    evidenceBytes: number;
    latest: DiscardReceipt;
  }> | null;
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
      readonly kind: 'partially-released';
      readonly incidentId: string;
      readonly incidentEvidenceBytes: number | null;
      readonly parkingEvidenceBytes: number | null;
      readonly parkingState: 'absent' | 'present' | 'undeterminable';
      readonly incidentState: 'absent' | 'present' | 'undeterminable';
      readonly durability: 'proven' | 'unproven';
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

function emptyLedger(): StoreResetRetentionLedger {
  return {
    version: STORE_RESET_RETENTION_LEDGER_VERSION,
    pending: null,
    preserved: null,
    excess: null,
    discarded: null,
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

function preservedRetention(value: unknown): PreservedRetention | null {
  if (!isRecord(value)) return null;
  if (value.slot === 'claimed') return { slot: 'claimed' };
  if (
    value.slot !== 'excess' ||
    typeof value.holder !== 'string' ||
    !isCanonicalStoreResetIncidentId(value.holder) ||
    (value.lineage !== 'unrelated' && value.lineage !== 'undeterminable')
  ) {
    return null;
  }
  return { slot: 'excess', holder: value.holder, lineage: value.lineage };
}

function discardReceipt(value: unknown): DiscardReceipt | null {
  if (
    !isRecord(value) ||
    typeof value.resetAt !== 'string' ||
    !isNonNegativeInteger(value.evidenceBytes) ||
    typeof value.deferredTo !== 'string' ||
    !isCanonicalStoreResetIncidentId(value.deferredTo) ||
    (value.resetPolicyCause !== 'older-incompatible' &&
      value.resetPolicyCause !== 'corrupt-or-unsupported' &&
      value.resetPolicyCause !== 'newer-incompatible-invalid-target')
  ) {
    return null;
  }
  return {
    resetAt: value.resetAt,
    resetPolicyCause: value.resetPolicyCause,
    evidenceBytes: value.evidenceBytes,
    deferredTo: value.deferredTo,
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
  if ((value.kind !== 'publication' && value.kind !== 'discard') || !Array.isArray(value.identities)) return null;
  const identities = value.identities.map(pendingIdentity);
  if (
    identities.some((identity) => identity === null) ||
    new Set(identities.map((identity) => identity?.name)).size !== identities.length
  ) {
    return null;
  }
  if (value.kind === 'discard') {
    return { kind: 'discard', identities: identities as StoreResetPendingIdentity[] };
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
  if (value.outcome.kind === 'discard') {
    const receipt = discardReceipt(value.outcome.receipt);
    return receipt === null
      ? null
      : {
          resetAt: value.resetAt,
          identities: present,
          outcome: { kind: 'discard', receipt },
        };
  }
  if (value.outcome.kind !== 'preserve') return null;
  const incident = retentionIncident(value.outcome.incident);
  const retention = preservedRetention(value.outcome.retention);
  return incident === null || retention === null
    ? null
    : {
        resetAt: value.resetAt,
        identities: present,
        outcome: { kind: 'preserve', incident, retention },
      };
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

  let excess: StoreResetRetentionLedger['excess'] = null;
  if (value.excess !== null) {
    if (
      !isRecord(value.excess) ||
      !isNonNegativeInteger(value.excess.count) ||
      !isNonNegativeInteger(value.excess.evidenceBytes)
    ) {
      return null;
    }
    const incident = retentionIncident(value.excess.latest);
    const retention = preservedRetention(value.excess.latest);
    if (incident === null || retention?.slot !== 'excess') return null;
    excess = {
      count: value.excess.count,
      evidenceBytes: value.excess.evidenceBytes,
      latest: { ...incident, ...retention },
    };
  }

  let discarded: StoreResetRetentionLedger['discarded'] = null;
  if (value.discarded !== null) {
    if (
      !isRecord(value.discarded) ||
      !isNonNegativeInteger(value.discarded.count) ||
      !isNonNegativeInteger(value.discarded.evidenceBytes)
    ) {
      return null;
    }
    const latest = discardReceipt(value.discarded.latest);
    if (latest === null) return null;
    discarded = { count: value.discarded.count, evidenceBytes: value.discarded.evidenceBytes, latest };
  }

  return { version: STORE_RESET_RETENTION_LEDGER_VERSION, pending, preserved, excess, discarded };
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
    (value.phase !== 'in-flight' && value.phase !== 'terminal') ||
    (value.cause !== 'publication' &&
      value.cause !== 'discard' &&
      value.cause !== 'intruder' &&
      value.cause !== 'residual') ||
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
      : transaction.kind === 'discard'
        ? value.cause === 'discard' && value.incidentId === null
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
  coordinate: string = record.parkingId,
): void {
  const parkingDirectory = join(parkingRoot, coordinate);
  assertContainedDirectory(storage, parkingRoot, parkingDirectory);
  const written = storage.writeAtomicDurableSync(
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
      const record = readStoreResetParkedRecord(storage, parkingRoot, parkingId);
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

function writeLedger(storage: StoragePort, quarantineRoot: string, ledger: StoreResetRetentionLedger): boolean {
  try {
    const written = storage.writeAtomicDurableSync(
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

function writeRequiredLedger(storage: StoragePort, quarantineRoot: string, ledger: StoreResetRetentionLedger): void {
  if (!writeLedger(storage, quarantineRoot, ledger)) {
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
  retention: PreservedRetention,
): StoreResetRetentionLedger {
  if (retention.slot === 'claimed') return { ...ledger, pending: null, preserved: incident };
  return {
    ...ledger,
    pending: null,
    excess: {
      count: (ledger.excess?.count ?? 0) + 1,
      evidenceBytes: (ledger.excess?.evidenceBytes ?? 0) + incident.evidenceBytes,
      latest: { ...incident, ...retention },
    },
  };
}

function withDiscardedOutcome(ledger: StoreResetRetentionLedger, receipt: DiscardReceipt): StoreResetRetentionLedger {
  return {
    ...ledger,
    pending: null,
    discarded: {
      count: (ledger.discarded?.count ?? 0) + 1,
      evidenceBytes: (ledger.discarded?.evidenceBytes ?? 0) + receipt.evidenceBytes,
      latest: receipt,
    },
  };
}

function reconcilePending(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  activeEvidence: readonly ActiveEvidence[] | undefined,
): StoreResetRetentionLedger {
  const pending = ledger.pending;
  if (pending === null) return ledger;
  if (pending.outcome.kind === 'discard') {
    if (activeEvidence === undefined) return ledger;
    const current = new Map(activeEvidence.map((evidence) => [evidence.name, evidence.identity]));
    const fulfilled = pending.identities.every((identity) => {
      const observed = current.get(identity.name);
      return observed === undefined || observed.dev !== BigInt(identity.dev) || observed.ino !== BigInt(identity.ino);
    });
    if (!fulfilled) return ledger;
    const reconciled = withDiscardedOutcome(ledger, pending.outcome.receipt);
    writeLedger(storage, quarantineRoot, reconciled);
    return reconciled;
  }

  const incidentId = pending.outcome.incident.incidentId;
  const committed = readCommittedManifest(storage, quarantineRoot, incidentId);
  if (committed !== null) {
    const reconciled = withPreservedOutcome(ledger, pending.outcome.incident, pending.outcome.retention);
    writeLedger(storage, quarantineRoot, reconciled);
    return reconciled;
  }
  const finalPresence = pathPresence(storage, join(quarantineRoot, incidentId));
  const stagingPresence = pathPresence(storage, join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY, incidentId));
  if (finalPresence === 'absent' && stagingPresence === 'absent') {
    const cleared = { ...ledger, pending: null };
    writeLedger(storage, quarantineRoot, cleared);
    return cleared;
  }
  return ledger;
}

export function settleStoreResetPending(storage: StoragePort, quarantineRoot: string): void {
  reconcilePending(
    storage,
    quarantineRoot,
    readStoreResetRetentionLedger(storage, quarantineRoot) ?? emptyLedger(),
    [],
  );
}

export function resolveStoreResetRetentionSlot(
  storage: StoragePort,
  quarantineRoot: string,
  activeEvidence?: readonly ActiveEvidence[],
): StoreResetRetentionSlot {
  const ledger = reconcilePending(
    storage,
    quarantineRoot,
    readStoreResetRetentionLedger(storage, quarantineRoot) ?? emptyLedger(),
    activeEvidence,
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
  writeLedger(storage, quarantineRoot, adopted);
  return { kind: 'held', ledger: adopted, holder, manifest };
}

export function recordStoreResetPreserved(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  incident: StoreResetRetentionIncident,
  retention: PreservedRetention,
): void {
  writeLedger(storage, quarantineRoot, withPreservedOutcome(ledger, incident, retention));
}

export function recordStoreResetDiscarded(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  receipt: DiscardReceipt,
): void {
  writeLedger(storage, quarantineRoot, withDiscardedOutcome(ledger, receipt));
}

export function recordStoreResetPending(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  pending: StoreResetRetentionPending,
): StoreResetRetentionLedger {
  const next = { ...ledger, pending };
  writeRequiredLedger(storage, quarantineRoot, next);
  return next;
}

export function clearStoreResetPending(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
): void {
  if (ledger.pending !== null) writeLedger(storage, quarantineRoot, { ...ledger, pending: null });
}

export function recordStoreResetResumeLeftActive(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  incidentId: string,
  names: readonly StoreResetEvidenceFileName[],
): void {
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
  writeLedger(storage, quarantineRoot, {
    ...ledger,
    preserved: ledger.preserved === null ? null : update(ledger.preserved),
    excess:
      ledger.excess === null
        ? null
        : { ...ledger.excess, latest: { ...ledger.excess.latest, ...update(ledger.excess.latest) } },
  });
}

export function releaseStoreResetIncident(
  storage: StoragePort,
  quarantineRoot: string,
  incidentId: string,
): StoreResetReleaseResult {
  if (!isCanonicalStoreResetIncidentId(incidentId)) return { kind: 'absent', incidentId };
  const rootPresence = pathPresence(storage, quarantineRoot);
  if (rootPresence === 'absent') return { kind: 'absent', incidentId };
  if (rootPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  try {
    assertQuarantineRoot(storage, quarantineRoot);
  } catch (error: unknown) {
    return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
  }
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
  let parkedRecord: StoreResetParkedRecord | null = null;
  if (parkingPresence === 'absent') {
    const inFlightPath = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
    const inFlightPresence = pathPresence(storage, inFlightPath);
    if (inFlightPresence === 'present') {
      try {
        assertContainedDirectory(storage, quarantineRoot, parkingRoot);
        assertContainedDirectory(storage, parkingRoot, inFlightPath);
        const inFlight = readStoreResetParkedRecord(storage, parkingRoot, incidentId, STORE_RESET_IN_FLIGHT_DIRECTORY);
        if (inFlight === null) return { kind: 'undeterminable', incidentId };
        if (inFlight?.parkingId === incidentId || inFlight?.incidentId === incidentId) {
          parkingPath = inFlightPath;
          parkingPresence = 'present';
          parkedRecord = inFlight;
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
    try {
      assertContainedDirectory(storage, quarantineRoot, parkingRoot);
      assertContainedDirectory(storage, parkingRoot, parkingPath);
    } catch (error: unknown) {
      return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
    }
  }
  parkedRecord ??= parkingPresence === 'present' ? readStoreResetParkedRecord(storage, parkingRoot, incidentId) : null;
  if (parkingPresence === 'present' && parkedRecord === null) return { kind: 'undeterminable', incidentId };
  if (parkedRecord?.phase === 'in-flight') return { kind: 'in-flight', incidentId };
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
  const manifest = incidentPresence === 'present' ? readCommittedManifest(storage, quarantineRoot, incidentId) : null;

  const slot = resolveStoreResetRetentionSlot(storage, quarantineRoot);
  const holder = slot.kind === 'held' && slot.holder.incidentId === incidentId;
  const parkedEvidenceBytes =
    parkingPresence === 'present'
      ? STORE_RESET_EVIDENCE_FILE_NAMES.reduce((total, name) => {
          try {
            const stat = storage.lstatSync(join(parkingPath, name), { bigint: true });
            return stat.isFile() && stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? total + Number(stat.size) : total;
          } catch {
            return total;
          }
        }, 0)
      : null;
  const incidentEvidenceBytes = manifest?.files.reduce((total, file) => total + file.sizeBytes, 0) ?? null;
  const parkingEvidenceBytes = parkedEvidenceBytes;
  const incomplete = (error: unknown, durable = false): StoreResetReleaseResult => ({
    kind: 'partially-released',
    incidentId,
    incidentEvidenceBytes,
    parkingEvidenceBytes,
    parkingState: pathPresence(storage, parkingPath),
    incidentState: pathPresence(storage, incidentPath),
    durability: durable ? 'proven' : 'unproven',
    cause: error instanceof Error ? error.message : String(error),
  });
  if (parkingPresence === 'present') {
    try {
      storage.rmSync(parkingPath, { recursive: true });
    } catch (error: unknown) {
      return incomplete(error);
    }
  }
  let parkingDurable = parkingPresence === 'absent';
  if (parkingPresence === 'present') {
    try {
      parkingDurable = storage.syncDirectoryDurableSync(parkingRoot);
    } catch {
      parkingDurable = false;
    }
  }
  if (incidentPresence === 'present') {
    try {
      storage.rmSync(incidentPath, { recursive: true });
    } catch (error: unknown) {
      return incomplete(error, parkingDurable);
    }
  }
  let quarantineDurable: boolean;
  try {
    quarantineDurable = storage.syncDirectoryDurableSync(quarantineRoot);
  } catch {
    quarantineDurable = false;
  }
  const durability = quarantineDurable && parkingDurable ? 'proven' : 'unproven';
  const clearsHolder = slot.kind === 'held' && slot.holder.incidentId === incidentId;
  const clearsPending =
    slot.ledger.pending?.outcome.kind === 'preserve' && slot.ledger.pending.outcome.incident.incidentId === incidentId;
  if (clearsHolder || clearsPending) {
    try {
      writeLedger(storage, quarantineRoot, {
        ...slot.ledger,
        ...(clearsHolder ? { preserved: null } : {}),
        ...(clearsPending ? { pending: null } : {}),
      });
    } catch (error: unknown) {
      return incomplete(error);
    }
  }
  if (holder) {
    return {
      kind: 'released',
      incidentId,
      incidentEvidenceBytes: incidentEvidenceBytes ?? slot.holder.evidenceBytes,
      parkingEvidenceBytes,
      durability,
    };
  }
  if (incidentPresence === 'absent' && parkedRecord?.phase === 'terminal') {
    return { kind: 'parked', incidentId, incidentEvidenceBytes, parkingEvidenceBytes, durability };
  }
  return { kind: 'not-holder', incidentId, incidentEvidenceBytes, parkingEvidenceBytes, durability };
}
