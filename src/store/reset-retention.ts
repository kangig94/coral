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
  STORE_RESET_PARKED_DIRECTORY,
  STORE_RESET_STAGING_DIRECTORY,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentManifest,
  type StoreResetPolicyCause,
} from './reset-incident.js';

export const STORE_RESET_RETENTION_LEDGER_VERSION = 1 as const;
export const STORE_RESET_RETENTION_LEDGER_FILE_NAME = `store-reset-retention.v${STORE_RESET_RETENTION_LEDGER_VERSION}.json`;
export const MAX_RESET_RETENTION_LEDGER_BYTES = 64 * 1024;

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
  parked?: readonly StoreResetEvidenceFileName[];
  resumeLeftActive: boolean;
}>;

export type StoreResetPendingIdentity = Readonly<{
  name: StoreResetEvidenceFileName;
  dev: string;
  ino: string;
}>;

export type StoreResetRetentionPending = Readonly<{
  resetAt: string;
  parkingId?: string;
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
      readonly evidenceBytes: number | null;
      readonly durability: 'proven' | 'unproven';
    }
  | {
      readonly kind: 'not-holder';
      readonly incidentId: string;
      readonly evidenceBytes: number | null;
      readonly durability: 'proven' | 'unproven';
    }
  | { readonly kind: 'absent'; readonly incidentId: string }
  | { readonly kind: 'staged'; readonly incidentId: string }
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
  const parked = value.parked === undefined ? undefined : value.parked;
  if (
    parked !== undefined &&
    (!Array.isArray(parked) ||
      parked.some((name) => !STORE_RESET_EVIDENCE_FILE_NAMES.includes(name as StoreResetEvidenceFileName)) ||
      new Set(parked).size !== parked.length)
  ) {
    return null;
  }
  return {
    incidentId: value.incidentId,
    resetAt: value.resetAt,
    evidenceBytes: value.evidenceBytes,
    ...(value.storedProductVersion === undefined ? {} : { storedProductVersion }),
    ...(preservation === null || preservation === undefined ? {} : { preservation }),
    ...(parked === undefined ? {} : { parked: parked as StoreResetEvidenceFileName[] }),
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

function retentionPending(value: unknown): StoreResetRetentionPending | null {
  if (!isRecord(value) || typeof value.resetAt !== 'string' || !Array.isArray(value.identities)) return null;
  const identities = value.identities.map(pendingIdentity);
  if (identities.some((identity) => identity === null)) return null;
  const present = identities as StoreResetPendingIdentity[];
  const parkingId = value.parkingId === undefined ? undefined : value.parkingId;
  if (parkingId !== undefined && (typeof parkingId !== 'string' || !isCanonicalStoreResetIncidentId(parkingId))) {
    return null;
  }
  if (new Set(present.map((identity) => identity.name)).size !== present.length || !isRecord(value.outcome)) {
    return null;
  }
  if (value.outcome.kind === 'discard') {
    const receipt = discardReceipt(value.outcome.receipt);
    return receipt === null
      ? null
      : {
          resetAt: value.resetAt,
          ...(parkingId === undefined ? {} : { parkingId }),
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
        ...(parkingId === undefined ? {} : { parkingId }),
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
  if (pending.parkingId !== undefined) {
    const parkingPresence = pathPresence(
      storage,
      join(quarantineRoot, STORE_RESET_PARKED_DIRECTORY, pending.parkingId),
    );
    if (parkingPresence !== 'absent') return ledger;
  }
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
  parked: readonly StoreResetEvidenceFileName[] = [],
): void {
  if (names.length === 0 && parked.length === 0) return;
  const update = (incident: StoreResetRetentionIncident): StoreResetRetentionIncident =>
    incident.incidentId === incidentId
      ? {
          ...incident,
          resumeLeftActive: true,
          parked,
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
  const parkingPath = join(parkingRoot, incidentId);
  const parkingPresence = pathPresence(storage, parkingPath);
  if (parkingPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  if (parkingPresence === 'present') {
    try {
      assertContainedDirectory(storage, quarantineRoot, parkingRoot);
      assertContainedDirectory(storage, parkingRoot, parkingPath);
    } catch (error: unknown) {
      return { kind: error instanceof UnsafeStoreResetPath ? 'unsafe' : 'undeterminable', incidentId };
    }
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
  const manifest = incidentPresence === 'present' ? readCommittedManifest(storage, quarantineRoot, incidentId) : null;

  const slot = resolveStoreResetRetentionSlot(storage, quarantineRoot);
  const holder = slot.kind === 'held' && slot.holder.incidentId === incidentId;
  const evidenceBytes = manifest?.files.reduce((total, file) => total + file.sizeBytes, 0) ?? null;
  if (incidentPresence === 'present') storage.rmSync(incidentPath, { recursive: true });
  if (parkingPresence === 'present') storage.rmSync(parkingPath, { recursive: true });
  const quarantineDurable = storage.syncDirectoryDurableSync(quarantineRoot);
  const parkingDurable = parkingPresence === 'absent' || storage.syncDirectoryDurableSync(parkingRoot);
  const durability = quarantineDurable && parkingDurable ? 'proven' : 'unproven';
  const clearsHolder = slot.kind === 'held' && slot.holder.incidentId === incidentId;
  const clearsPending = slot.ledger.pending?.parkingId === incidentId;
  if (clearsHolder || clearsPending) {
    writeLedger(storage, quarantineRoot, {
      ...slot.ledger,
      ...(clearsHolder ? { preserved: null } : {}),
      ...(clearsPending ? { pending: null } : {}),
    });
  }
  if (holder) {
    return {
      kind: 'released',
      incidentId,
      evidenceBytes: evidenceBytes ?? slot.holder.evidenceBytes,
      durability,
    };
  }
  return { kind: 'not-holder', incidentId, evidenceBytes, durability };
}
