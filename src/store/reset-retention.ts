import { join } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { isRecord } from '../infra/json.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import type { StoragePort } from '../infra/port-types.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_RESET_MANIFEST_BYTES,
  MAX_RESET_RETENTION_LEDGER_BYTES,
  parseStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_RETENTION_LEDGER_FILE_NAME,
  STORE_RESET_STAGING_DIRECTORY,
  type StoreResetEvidenceFileName,
  type StoreResetIncidentManifest,
  type StoreResetPolicyCause,
} from './reset-incident.js';

export type PreservationMechanism =
  | { readonly kind: 'linked' }
  | {
      readonly kind: 'copied';
      readonly cause:
        | {
            readonly kind: 'link-unsupported';
            readonly errno: 'EXDEV' | 'EMLINK' | 'EPERM' | 'EOPNOTSUPP' | 'other';
            readonly code: string;
          }
        | {
            readonly kind: 'exclusion-unproven';
            readonly reason: 'writer-live' | 'writer-unobservable' | 'lock-timeout' | 'not-attempted';
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

export type StoreResetRetentionLedger = Readonly<{
  version: 1;
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
  | { readonly kind: 'released'; readonly incidentId: string; readonly evidenceBytes: number | null }
  | { readonly kind: 'not-holder'; readonly incidentId: string; readonly evidenceBytes: number | null }
  | { readonly kind: 'absent'; readonly incidentId: string }
  | { readonly kind: 'staged'; readonly incidentId: string }
  | { readonly kind: 'undeterminable'; readonly incidentId: string };

export type StoreResetReleasePresentation = StoreResetReleaseResult & {
  readonly target: 'gen2';
  readonly flavor: BuildFlavor;
};

function emptyLedger(): StoreResetRetentionLedger {
  return { version: 1, preserved: null, excess: null, discarded: null };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function preservationMechanism(value: unknown): PreservationMechanism | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'linked') return { kind: 'linked' };
  if (value.kind !== 'copied' || !isRecord(value.cause)) return null;
  const coherence = value.coherence;
  if (coherence !== 'coherent' && coherence !== 'torn') return null;
  if (value.cause.kind === 'exclusion-unproven') {
    const reason = value.cause.reason;
    if (
      reason !== 'writer-live' &&
      reason !== 'writer-unobservable' &&
      reason !== 'lock-timeout' &&
      reason !== 'not-attempted'
    ) {
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
  if (
    value.storedProductVersion !== undefined &&
    value.storedProductVersion !== null &&
    typeof value.storedProductVersion !== 'string'
  ) {
    return null;
  }
  const preservation = value.preservation === undefined ? undefined : preservationMechanism(value.preservation);
  if (value.preservation !== undefined && preservation === null) return null;
  return {
    incidentId: value.incidentId,
    resetAt: value.resetAt,
    evidenceBytes: value.evidenceBytes,
    ...(value.storedProductVersion === undefined ? {} : { storedProductVersion: value.storedProductVersion }),
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

export function parseStoreResetRetentionLedger(text: string): StoreResetRetentionLedger | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;

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

  return { version: 1, preserved, excess, discarded };
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

function writeLedger(storage: StoragePort, quarantineRoot: string, ledger: StoreResetRetentionLedger): void {
  try {
    const written = storage.writeAtomicDurableSync(
      join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME),
      `${JSON.stringify(ledger)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
    if (written) return;
    writeAuditEvent('store_reset_retention_ledger_write_failed', { cause: 'durable-write-rejected' }, 'warn');
  } catch (error: unknown) {
    writeAuditEvent(
      'store_reset_retention_ledger_write_failed',
      { cause: error instanceof Error ? error.message : String(error) },
      'warn',
    );
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

export function resolveStoreResetRetentionSlot(storage: StoragePort, quarantineRoot: string): StoreResetRetentionSlot {
  const ledger = readStoreResetRetentionLedger(storage, quarantineRoot) ?? emptyLedger();
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
  if (retention.slot === 'claimed') {
    writeLedger(storage, quarantineRoot, { ...ledger, preserved: incident });
    return;
  }
  writeLedger(storage, quarantineRoot, {
    ...ledger,
    excess: {
      count: (ledger.excess?.count ?? 0) + 1,
      evidenceBytes: (ledger.excess?.evidenceBytes ?? 0) + incident.evidenceBytes,
      latest: { ...incident, ...retention },
    },
  });
}

export function recordStoreResetDiscarded(
  storage: StoragePort,
  quarantineRoot: string,
  ledger: StoreResetRetentionLedger,
  receipt: DiscardReceipt,
): void {
  writeLedger(storage, quarantineRoot, {
    ...ledger,
    discarded: {
      count: (ledger.discarded?.count ?? 0) + 1,
      evidenceBytes: (ledger.discarded?.evidenceBytes ?? 0) + receipt.evidenceBytes,
      latest: receipt,
    },
  });
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
          ...(incident.preservation?.kind === 'copied'
            ? // Unresolved active evidence means a resumed copy can no longer certify a coherent snapshot.
              { preservation: { ...incident.preservation, coherence: 'torn' as const } }
            : {}),
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
  const stagingPath = join(quarantineRoot, STORE_RESET_STAGING_DIRECTORY, incidentId);
  const stagingPresence = pathPresence(storage, stagingPath);
  if (stagingPresence === 'present') return { kind: 'staged', incidentId };
  if (stagingPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  const incidentPath = join(quarantineRoot, incidentId);
  const incidentPresence = pathPresence(storage, incidentPath);
  if (incidentPresence === 'absent') return { kind: 'absent', incidentId };
  if (incidentPresence === 'undeterminable') return { kind: 'undeterminable', incidentId };
  const manifest = readCommittedManifest(storage, quarantineRoot, incidentId);

  const slot = resolveStoreResetRetentionSlot(storage, quarantineRoot);
  const holder = slot.kind === 'held' && slot.holder.incidentId === incidentId;
  const evidenceBytes = manifest?.files.reduce((total, file) => total + file.sizeBytes, 0) ?? null;
  storage.rmSync(incidentPath, { recursive: true });
  if (!storage.syncDirectoryDurableSync(quarantineRoot)) {
    throw new Error('Store-reset release directory metadata could not be synchronized.');
  }
  if (holder) {
    if (manifest !== null) {
      writeLedger(storage, quarantineRoot, { ...slot.ledger, preserved: null });
    }
    return { kind: 'released', incidentId, evidenceBytes };
  }
  return { kind: 'not-holder', incidentId, evidenceBytes };
}
