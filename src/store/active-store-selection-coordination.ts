import { join } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import {
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import type { ForeignTargetValidator, InvalidTargetEvidence, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { StorageBigIntStat } from '../infra/port-types.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import {
  ActiveStoreCoordinationWriteError,
  ACTIVE_STORE_SELECTION_VERSION,
  ACTIVE_STORE_TRANSITION_VERSION,
  classifyActiveStoreSelection,
  classifyActiveStoreSelectionV1,
  clearActiveStoreTransition,
  clearActiveStoreTransitionV1,
  encodeActiveStoreSelection,
  publishActiveStoreSelection,
  publishActiveStoreTransition,
  readActiveStoreSelectionForCoordination,
  readActiveStoreTransition,
  readActiveStoreTransitionV1,
  resolveActiveStoreSelectionV1,
  resolveActiveStoreRecordPaths,
  type ActiveStoreRecordReadFailureCode,
  type ActiveStoreSelection,
  type ActiveStoreTransition,
  type ActiveStoreTransitionEvidence,
  type ActiveStoreTransitionFailureCode,
  type NewerStoreEvidence,
} from './active-store-selection.js';
import {
  acquireBackendStoreResetLock,
  attemptBackendStoreClaim,
  assertBackendStoreResetAuthority,
  classifyBackendStoreFailure,
  documentedBackendStoreClassificationFailure,
  hasPendingBackendStoreResetIncident,
  publishClassifiedBackendStoreResetIncident,
  mintBackendStoreForClaim,
  resolveBackendStoreFileSet,
  resumeAutomaticBackendStoreResetIncident,
  resumeBackendStoreResetIncidentForOperator,
  retainTransitionFileInStoreResetQuarantine,
  stageBackendStoreClassification,
  STEADY_STATE_BUSY_TIMEOUT_MS,
  type BackendStoreFileSet,
  type BackendStoreResetAuthority,
  type BackendStoreResetIncident,
  type BackendStoreResetLockLease,
  type StoreSettlementEpoch,
  type WriterExclusion,
  type NewerStoreResetPolicy,
  type OpenOrResetBackendStoreOptions,
} from './backend-store-reset.js';
import { classifyStoreFile, refuseLegacyStore, type Database } from './db.js';
import type { StoreFormatClassification } from './format-fingerprint.js';
import {
  acquireGenerationAdoptionLock,
  formatLegacyGenerationIgnoredNotice,
  inspectGenerationReadiness,
  type GenerationAdoptionLockLease,
  type GenerationMaintenanceLease,
} from './generation-mutation-coordination.js';
import {
  isCanonicalStoreResetIncidentId,
  STORE_RESET_INCIDENT_SCHEMA_VERSION,
  STORE_RESET_QUARANTINE_DIRECTORY,
} from './reset-incident.js';
import { discoverStoreResetParkedRecords, resolveStoreResetRetentionSlot } from './reset-retention.js';

export type ActiveStoreSelectionProtocolResult =
  | ({ readonly kind: 'opened' } & ActiveStoreSettlement)
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget };

export type ActiveStoreSettlement = Readonly<{
  db: Database;
  survivor: ActiveStoreSettlementSurvivor;
  epochs: readonly StoreSettlementEpoch[];
  invalidTargetEvidence: InvalidTargetEvidence | null;
}>;

export type ActiveStoreSettlementSurvivor =
  | { readonly kind: 'incident'; readonly incident: BackendStoreResetIncident; readonly resumed: boolean }
  | { readonly kind: 'parking'; readonly parkingId: string }
  | { readonly kind: 'none' };

function finalStoreResetSurvivor(
  runtime: Pick<Runtime, 'storage'>,
  files: BackendStoreFileSet,
  candidate: ActiveStoreSettlementSurvivor,
): ActiveStoreSettlementSurvivor {
  const quarantineRoot = join(files.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const parking = discoverStoreResetParkedRecords(runtime.storage, quarantineRoot).entries.find(
    (entry) => isCanonicalStoreResetIncidentId(entry.coordinate) && entry.record?.phase === 'terminal',
  );
  if (parking !== undefined) return { kind: 'parking', parkingId: parking.coordinate };
  const slot = resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot);
  if (slot.kind === 'held' && slot.manifest !== null) {
    const manifest = slot.manifest;
    return {
      kind: 'incident',
      incident: {
        incidentId: manifest.incidentId,
        resetAt: manifest.resetAt,
        reason: manifest.reason,
        schemaVersion: manifest.schemaVersion,
        resetPolicyCause:
          manifest.schemaVersion === STORE_RESET_INCIDENT_SCHEMA_VERSION ? manifest.resetPolicyCause : null,
        fileCount: manifest.files.length,
      },
      resumed:
        candidate.kind === 'incident' && candidate.incident.incidentId === manifest.incidentId && candidate.resumed,
    };
  }
  if (
    candidate.kind === 'incident' &&
    runtime.storage.existsSync(join(quarantineRoot, candidate.incident.incidentId))
  ) {
    return candidate;
  }
  return { kind: 'none' };
}

export type ActiveStoreSelectionStartupDependencies = Readonly<{
  kind: 'startup';
  validateSelectedTarget: ForeignTargetValidator;
  acquireWriterExclusion: () => Promise<WriterExclusion>;
}>;

export type ActiveStoreSelectionOperatorDependencies = Readonly<{
  kind: 'operator';
  validateSelectedTarget: ForeignTargetValidator;
  acquireStoreRecoveryLease?: () => Promise<GenerationMaintenanceLease>;
}>;

export type ActiveStoreSelectionProtocolDependencies =
  | ActiveStoreSelectionStartupDependencies
  | ActiveStoreSelectionOperatorDependencies;

export type ActiveStoreSelectionProtocolOptions = OpenOrResetBackendStoreOptions & {
  readonly currentSelection: ActiveStoreSelection;
  readonly dependencies: ActiveStoreSelectionProtocolDependencies;
};

type ActiveStoreCoordinationRecord = 'selection' | 'transition';
type ActiveStoreCoordinationFailureCode = ActiveStoreRecordReadFailureCode;
type ActiveStoreTransitionClearEvidence =
  | { readonly kind: 'clear'; readonly sourceIdentity?: StorageBigIntStat }
  | { readonly kind: 'source-missing' };

function createActiveStoreTransition(
  runtime: Runtime,
  currentSelection: ActiveStoreSelection,
  evidence: ActiveStoreTransitionEvidence,
): ActiveStoreTransition {
  return {
    version: ACTIVE_STORE_TRANSITION_VERSION,
    transitionId: runtime.ids.uuid(),
    kind: 'selection-recovery',
    evidence,
    currentManifest: currentSelection.manifest,
    currentBundleDir: currentSelection.bundleDir,
  };
}

function transitionMatchesCurrent(transition: ActiveStoreTransition, currentSelection: ActiveStoreSelection): boolean {
  const transitionSelection: ActiveStoreSelection = {
    version: ACTIVE_STORE_SELECTION_VERSION,
    manifest: transition.currentManifest,
    bundleDir: transition.currentBundleDir,
    activeStoreFingerprint: transition.currentManifest.storeFormatFingerprint,
  };
  return classifyActiveStoreSelection(transitionSelection, currentSelection) === 'exact';
}

function classifyStoreForProtocol(
  runtime: Runtime,
  files: BackendStoreFileSet,
  options: ActiveStoreSelectionProtocolOptions,
  reportedPath?: string,
): StoreFormatClassification {
  const { dbFile } = files;
  try {
    return classifyStoreFile(dbFile, runtime.storage, options.storeFormat);
  } catch (error: unknown) {
    try {
      const entry = runtime.storage.lstatSync(dbFile);
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        return {
          kind: 'corrupt-or-unsupported',
          currentFingerprint: options.storeFormat.fingerprint,
          currentProductVersion: options.storeFormat.productVersion,
          storedFingerprint: null,
          storedProductVersion: null,
          storedProductVersionState: 'unavailable',
        };
      }
    } catch {
      // Preserve the classifier's original failure when the path cannot be inspected safely.
    }
    const failure = classifyBackendStoreFailure(error, options.storeFormat);
    switch (failure.kind) {
      case 'corrupt-or-unsupported':
        return failure.classification;
      case 'unavailable':
      case 'unclassified':
        throw documentedBackendStoreClassificationFailure(runtime, reportedPath ?? dbFile, failure);
      default:
        return assertNever(failure);
    }
  }
}

function newerStoreEvidence(
  classification: Extract<StoreFormatClassification, { readonly kind: 'newer-incompatible' }>,
): NewerStoreEvidence {
  return {
    kind: 'newer-incompatible',
    currentFingerprint: classification.currentFingerprint,
    currentProductVersion: classification.currentProductVersion,
    storedFingerprint: classification.storedFingerprint,
    storedProductVersion: classification.storedProductVersion,
  };
}

function transitionWithNewerStoreEvidence(
  transition: ActiveStoreTransition,
  evidence: NewerStoreEvidence,
): ActiveStoreTransition {
  switch (transition.evidence.kind) {
    case 'valid-target-invalid':
    case 'selection-absent':
    case 'selection-malformed':
      return {
        ...transition,
        evidence: { ...transition.evidence, storeEvidence: evidence },
      };
    case 'current-selection-newer-store':
      return {
        ...transition,
        evidence: { ...transition.evidence, newerStoreEvidence: evidence },
      };
    default:
      return assertNever(transition.evidence);
  }
}

function selectedManifestForTransition(transition: ActiveStoreTransition): StrictBundleManifest | null {
  if (
    transition.evidence.kind === 'valid-target-invalid' ||
    transition.evidence.kind === 'current-selection-newer-store'
  ) {
    return transition.evidence.priorSelection.manifest;
  }
  return null;
}

function resetPolicyForTransition(transition: ActiveStoreTransition): NewerStoreResetPolicy {
  const selectedManifest = selectedManifestForTransition(transition);
  const validationCode =
    transition.evidence.kind === 'valid-target-invalid'
      ? transition.evidence.invalidTargetEvidence.failure
      : transition.evidence.kind === 'selection-malformed'
        ? transition.evidence.failureCode
        : transition.evidence.kind;
  return {
    cause: 'newer-incompatible-invalid-target',
    evidence: {
      validationFailure: { code: validationCode },
      observedTarget: {
        version: selectedManifest?.version ?? null,
        buildSetId: selectedManifest?.buildSetId ?? null,
        bundleHash: selectedManifest?.bundleHash ?? null,
        flavor: selectedManifest?.flavor ?? null,
        storeFormatFingerprint: selectedManifest?.storeFormatFingerprint ?? null,
      },
    },
  };
}

function retainActiveStoreTransition(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  adoption: GenerationAdoptionLockLease,
  transitionFile = resolveActiveStoreRecordPaths(runtime).transitionFile,
): ReturnType<typeof retainTransitionFileInStoreResetQuarantine> | null {
  const files = resolveBackendStoreFileSet(runtime, options);
  try {
    return retainTransitionFileInStoreResetQuarantine(runtime, files, transitionFile, adoption);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      !runtime.storage.existsSync(transitionFile)
    ) {
      return null;
    }
    throw documentedCoralSetupError({
      code: 'store_reset_quarantine_failed',
      reason: 'active_store_transition_evidence',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function retainInvalidSelectionRecovery(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  transition: ActiveStoreTransition,
  adoption: GenerationAdoptionLockLease,
): ActiveStoreTransitionClearEvidence {
  if (transition.evidence.kind !== 'valid-target-invalid' && transition.evidence.kind !== 'selection-malformed') {
    return { kind: 'clear' };
  }
  const retained = retainActiveStoreTransition(runtime, options, adoption);
  if (retained === null) return { kind: 'source-missing' };
  writeAuditEvent(
    'invalid-selection-recovery',
    {
      transitionId: transition.transitionId,
      evidenceKind: transition.evidence.kind,
      failureCode:
        transition.evidence.kind === 'valid-target-invalid'
          ? transition.evidence.invalidTargetEvidence.failure
          : transition.evidence.failureCode,
      evidencePath: retained.evidencePath,
      evidenceByteLength: retained.evidenceByteLength,
      evidenceSha256: retained.evidenceSha256,
      currentVersion: transition.currentManifest.version,
      currentBuildSetId: transition.currentManifest.buildSetId,
    },
    'warn',
  );
  return { kind: 'clear', sourceIdentity: retained.sourceIdentity };
}

function inspectCurrentGeneration(runtime: Runtime, options: OpenOrResetBackendStoreOptions): void {
  if (options.path !== undefined) return;
  const readiness = inspectGenerationReadiness(runtime, options.storeFormat);
  switch (readiness.kind) {
    case 'generated-ready':
    case 'no-legacy':
      return;
    case 'legacy-ignored':
      backendLog.warn(formatLegacyGenerationIgnoredNotice(readiness));
      return;
    default:
      assertNever(readiness);
  }
}

async function acquireSettlementWriterExclusion(
  options: ActiveStoreSelectionProtocolOptions,
): Promise<WriterExclusion> {
  if (options.dependencies.kind === 'startup') return options.dependencies.acquireWriterExclusion();
  const recoveryLease = await options.dependencies.acquireStoreRecoveryLease?.();
  if (recoveryLease === undefined) {
    throw new Error('Operator store reset requires a recovery lease.');
  }
  return { kind: 'proven', lease: recoveryLease };
}

type MintedActiveStoreEpoch = Readonly<{
  evidence: ReturnType<typeof stageBackendStoreClassification>['evidence'];
  classification: StoreFormatClassification;
}>;

function mintActiveStoreEpoch(
  runtime: Runtime,
  files: BackendStoreFileSet,
  options: ActiveStoreSelectionProtocolOptions,
): MintedActiveStoreEpoch {
  const { dbFile } = files;
  const snapshot = stageBackendStoreClassification(runtime, files);
  try {
    return {
      evidence: snapshot.evidence,
      classification: classifyStoreForProtocol(runtime, { ...files, dbFile: snapshot.path }, options, dbFile),
    };
  } finally {
    snapshot.release();
  }
}

async function settleActiveStore(
  runtime: Runtime,
  authority: BackendStoreResetAuthority,
  options: ActiveStoreSelectionProtocolOptions,
  initialTransition: ActiveStoreTransition | null,
  adoption: GenerationAdoptionLockLease,
): Promise<ActiveStoreSettlement> {
  inspectCurrentGeneration(runtime, options);
  const files = resolveBackendStoreFileSet(runtime, options);
  const { dbFile } = files;
  const pending = hasPendingBackendStoreResetIncident(runtime, files);
  const initialClassification = classifyStoreForProtocol(runtime, files, options);
  if (initialClassification.kind === 'legacy-adoptable') {
    return refuseLegacyStore(dbFile, initialClassification, options.storeFormat, runtime.flavor);
  }
  const resetNeeded =
    pending ||
    initialClassification.kind === 'older-incompatible' ||
    initialClassification.kind === 'corrupt-or-unsupported' ||
    initialClassification.kind === 'newer-incompatible';
  let writerExclusion: WriterExclusion | undefined;
  if (pending || runtime.storage.existsSync(dbFile)) {
    writerExclusion = await acquireSettlementWriterExclusion(options);
  }
  let resetLock: BackendStoreResetLockLease | null = null;
  try {
    adoption.assertOwned();
    if (writerExclusion?.kind === 'proven') writerExclusion.lease.assertOwned();
    let resumed: BackendStoreResetIncident | null = null;
    const publicationWriterExclusion =
      writerExclusion ??
      ({
        kind: 'unproven',
        reason: 'writer-unobservable',
        blockers: 'active store appeared after the writer-exclusion probe',
      } satisfies WriterExclusion);
    let transition = initialTransition;
    let survivor: ActiveStoreSettlementSurvivor = { kind: 'none' };
    const epochs: StoreSettlementEpoch[] = [];
    if (resetNeeded) {
      resetLock = acquireBackendStoreResetLock(runtime, files, adoption);
      resumed =
        writerExclusion === undefined
          ? null
          : options.dependencies.kind === 'operator'
            ? resumeBackendStoreResetIncidentForOperator(runtime, files, options, resetLock, writerExclusion)
            : resumeAutomaticBackendStoreResetIncident(runtime, authority, files, options, resetLock, writerExclusion);
      if (resumed !== null) survivor = { kind: 'incident', incident: resumed, resumed: true };
      const activeEpoch = mintActiveStoreEpoch(runtime, files, options);
      switch (activeEpoch.classification.kind) {
        case 'legacy-adoptable':
          return refuseLegacyStore(dbFile, activeEpoch.classification, options.storeFormat, runtime.flavor);
        case 'older-incompatible':
        case 'corrupt-or-unsupported':
        case 'newer-incompatible': {
          if (activeEpoch.classification.kind === 'newer-incompatible') {
            const evidence = newerStoreEvidence(activeEpoch.classification);
            transition =
              transition === null
                ? createActiveStoreTransition(runtime, options.currentSelection, {
                    kind: 'current-selection-newer-store',
                    priorSelection: options.currentSelection,
                    newerStoreEvidence: evidence,
                  })
                : transitionWithNewerStoreEvidence(transition, evidence);
            publishTransitionOrRefuse(runtime, transition);
          }
          const publication = publishClassifiedBackendStoreResetIncident(
            runtime,
            authority,
            files,
            activeEpoch.evidence,
            activeEpoch.classification,
            resetLock,
            publicationWriterExclusion,
            activeEpoch.classification.kind === 'newer-incompatible' && transition !== null
              ? resetPolicyForTransition(transition)
              : undefined,
          );
          if (publication.kind === 'preserved') {
            survivor = { kind: 'incident', incident: publication.incident, resumed: false };
          }
          epochs.push({ kind: 'described', publication });
          break;
        }
        case 'absent':
        case 'fresh':
        case 'compatible':
          break;
        default:
          assertNever(activeEpoch.classification);
      }
    }

    const minted = mintBackendStoreForClaim(runtime, files, options);
    let db: Database;
    for (;;) {
      const attempt = attemptBackendStoreClaim(runtime, files, options, minted);
      epochs.push(...attempt.epochs);
      for (const epoch of attempt.epochs) {
        if (epoch.kind === 'described' && epoch.publication.kind === 'preserved') {
          survivor = { kind: 'incident', incident: epoch.publication.incident, resumed: false };
        }
        if (epoch.kind === 'parked') survivor = { kind: 'parking', parkingId: epoch.parkingId };
      }
      if (attempt.kind === 'retry') continue;
      db = attempt.db;
      break;
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? STEADY_STATE_BUSY_TIMEOUT_MS}`);
      if (transition !== null) {
        // The live transition is cleared only after its invalid-selection basis has been copied into the
        // reset-quarantine durability boundary. Coordinator logging is deliberately not evidence authority.
        const clearEvidence = retainInvalidSelectionRecovery(runtime, options, transition, adoption);
        if (clearEvidence.kind === 'clear') {
          clearActiveStoreTransition(runtime, clearEvidence.sourceIdentity);
        }
      }
      return {
        db,
        survivor: finalStoreResetSurvivor(runtime, files, survivor),
        epochs,
        invalidTargetEvidence:
          transition?.evidence.kind === 'valid-target-invalid' ? transition.evidence.invalidTargetEvidence : null,
      };
    } catch (error: unknown) {
      db.close();
      throw error;
    }
  } finally {
    resetLock?.release();
    if (writerExclusion?.kind === 'proven') writerExclusion.lease.release();
  }
}

function refuseActiveStoreCoordination(
  runtime: Runtime,
  record: ActiveStoreCoordinationRecord,
  failureCode: ActiveStoreCoordinationFailureCode,
  cause?: string,
): never {
  const paths = resolveActiveStoreRecordPaths(runtime);
  throw documentedCoralSetupError({
    code: 'active_store_coordination_invalid',
    record,
    failureCode,
    coordinationRoot: paths.coordinationRoot,
    recordPath: record === 'selection' ? paths.selectionFile : paths.transitionFile,
    ...(cause === undefined ? {} : { cause }),
  });
}

// Single source of truth for turning a thrown coordination-directory/record write failure into its documented
// failure code: read the typed `.code` off `ActiveStoreCoordinationWriteError` rather than matching on
// `error.message`, so a wording change to a thrown message can never silently change which code is reported.
function coordinationWriteFailureCode(error: unknown): ActiveStoreCoordinationFailureCode {
  return error instanceof ActiveStoreCoordinationWriteError ? error.code : 'record_unavailable';
}

// Coordination-directory creation and durable-write failures originate deep in active-store-selection.ts
// (`ensureActiveStoreCoordinationDirectory` / `publishActiveStoreRecord`); without this translation they would
// bubble up as unremediated `internal` errors instead of the documented `active_store_coordination_invalid` code.
function publishSelectionOrRefuse(runtime: Runtime, selection: ActiveStoreSelection): void {
  try {
    publishActiveStoreSelection(runtime, selection);
  } catch (error: unknown) {
    refuseActiveStoreCoordination(
      runtime,
      'selection',
      coordinationWriteFailureCode(error),
      error instanceof Error ? error.message : 'Active-store selection publish failed with a non-Error value.',
    );
  }
}

function publishTransitionOrRefuse(runtime: Runtime, transition: ActiveStoreTransition): void {
  try {
    publishActiveStoreTransition(runtime, transition);
  } catch (error: unknown) {
    refuseActiveStoreCoordination(
      runtime,
      'transition',
      coordinationWriteFailureCode(error),
      error instanceof Error ? error.message : 'Active-store transition publish failed with a non-Error value.',
    );
  }
}

function supersedeActiveStoreTransition(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  adoption: GenerationAdoptionLockLease,
  failureCode:
    | ActiveStoreTransitionFailureCode
    | 'transition_current_build_mismatch'
    | 'record_changed'
    | 'record_unavailable',
  generation: 'current' | 'v1' = 'current',
): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const transitionFile = generation === 'current' ? paths.transitionFile : paths.transitionV1File;
  const retained = retainActiveStoreTransition(runtime, options, adoption, transitionFile);
  if (retained !== null) {
    try {
      if (generation === 'current') {
        clearActiveStoreTransition(runtime, retained.sourceIdentity);
      } else {
        clearActiveStoreTransitionV1(runtime, retained.sourceIdentity);
      }
    } catch (error: unknown) {
      refuseActiveStoreCoordination(
        runtime,
        'transition',
        coordinationWriteFailureCode(error),
        error instanceof Error ? error.message : 'Active-store transition clear failed with a non-Error value.',
      );
    }
  }
  writeAuditEvent(
    'active-store-transition-superseded',
    {
      failureCode,
      ...(retained === null
        ? {}
        : {
            evidencePath: retained.evidencePath,
            evidenceByteLength: retained.evidenceByteLength,
            evidenceSha256: retained.evidenceSha256,
          }),
      currentVersion: options.currentSelection.manifest.version,
      currentBuildSetId: options.currentSelection.manifest.buildSetId,
    },
    'warn',
  );
}

function transitionForSelectionEvidence(
  runtime: Runtime,
  currentSelection: ActiveStoreSelection,
  selection: Exclude<ReturnType<typeof readActiveStoreSelectionForCoordination>, { readonly kind: 'v1' }>,
  invalidTarget?: InvalidTargetEvidence,
): ActiveStoreTransition {
  if (selection.kind === 'absent') {
    return createActiveStoreTransition(runtime, currentSelection, {
      kind: 'selection-absent',
      storeEvidence: { kind: 'pending-classification' },
    });
  }
  if (selection.kind === 'malformed') {
    return createActiveStoreTransition(runtime, currentSelection, {
      ...selection.evidence,
      storeEvidence: { kind: 'pending-classification' },
    });
  }
  if (selection.kind === 'valid' && invalidTarget !== undefined) {
    return createActiveStoreTransition(runtime, currentSelection, {
      kind: 'valid-target-invalid',
      priorSelection: selection.selection,
      invalidTargetEvidence: invalidTarget,
      storeEvidence: { kind: 'pending-classification' },
    });
  }
  throw new Error('Active-store transition evidence is incomplete.');
}

async function recoverCurrentSelectionFromEvidence(
  runtime: Runtime,
  authority: BackendStoreResetAuthority,
  options: ActiveStoreSelectionProtocolOptions,
  transition: ActiveStoreTransition,
  adoption: GenerationAdoptionLockLease,
): Promise<Extract<ActiveStoreSelectionProtocolResult, { kind: 'opened' }>> {
  publishTransitionOrRefuse(runtime, transition);
  publishSelectionOrRefuse(runtime, options.currentSelection);
  return {
    kind: 'opened',
    ...(await settleActiveStore(runtime, authority, options, transition, adoption)),
  };
}

export async function coordinateActiveStoreSelection(
  runtime: Runtime,
  authority: BackendStoreResetAuthority,
  options: ActiveStoreSelectionProtocolOptions,
): Promise<ActiveStoreSelectionProtocolResult> {
  if (options.path === ':memory:') {
    throw new Error('Active-store selection coordination requires a real filesystem store path.');
  }
  assertBackendStoreResetAuthority(runtime, authority, options);
  encodeActiveStoreSelection(options.currentSelection);
  const adoption = await acquireGenerationAdoptionLock(runtime);
  try {
    adoption.assertOwned();
    const transitionV1Read = readActiveStoreTransitionV1(runtime);
    if (transitionV1Read.kind === 'legacy') {
      supersedeActiveStoreTransition(runtime, options, adoption, 'transition_current_build_mismatch', 'v1');
    } else if (transitionV1Read.kind === 'rejected') {
      if (transitionV1Read.failureCode === 'record_changed' || transitionV1Read.failureCode === 'record_unavailable') {
        supersedeActiveStoreTransition(runtime, options, adoption, transitionV1Read.failureCode, 'v1');
      } else {
        refuseActiveStoreCoordination(runtime, 'transition', transitionV1Read.failureCode);
      }
    }
    const transitionRead = readActiveStoreTransition(runtime);
    if (transitionRead.kind === 'valid') {
      if (transitionMatchesCurrent(transitionRead.transition, options.currentSelection)) {
        publishSelectionOrRefuse(runtime, options.currentSelection);
        return {
          kind: 'opened',
          ...(await settleActiveStore(runtime, authority, options, transitionRead.transition, adoption)),
        };
      }
      supersedeActiveStoreTransition(runtime, options, adoption, 'transition_current_build_mismatch');
    } else if (transitionRead.kind === 'malformed') {
      supersedeActiveStoreTransition(runtime, options, adoption, transitionRead.failureCode);
    } else if (transitionRead.kind === 'rejected') {
      if (transitionRead.failureCode === 'record_changed' || transitionRead.failureCode === 'record_unavailable') {
        supersedeActiveStoreTransition(runtime, options, adoption, transitionRead.failureCode);
      } else {
        refuseActiveStoreCoordination(runtime, 'transition', transitionRead.failureCode);
      }
    }

    const selection = readActiveStoreSelectionForCoordination(runtime);
    if (selection.kind === 'rejected') {
      refuseActiveStoreCoordination(runtime, 'selection', selection.failureCode);
    }
    if (selection.kind === 'absent' || selection.kind === 'malformed') {
      const transition = transitionForSelectionEvidence(runtime, options.currentSelection, selection);
      return await recoverCurrentSelectionFromEvidence(runtime, authority, options, transition, adoption);
    }

    if (selection.kind === 'v1') {
      if (classifyActiveStoreSelectionV1(selection.selection, options.currentSelection) === 'selected-newer') {
        const adjacent = readBoundedAdjacentManifest(selection.selection.bundleDir);
        const parsed = adjacent.ok ? strictBundleManifestSchema.safeParse(adjacent.value) : null;
        const resolved = parsed?.success ? resolveActiveStoreSelectionV1(selection.selection, parsed.data) : null;
        if (resolved === null) {
          refuseActiveStoreCoordination(runtime, 'selection', 'record_incoherent');
        }
        const validation = options.dependencies.validateSelectedTarget(resolved.bundleDir, resolved.manifest);
        adoption.assertOwned();
        if (validation.kind === 'validated') {
          return { kind: 'handoff', target: validation.target };
        }
        const transition = transitionForSelectionEvidence(
          runtime,
          options.currentSelection,
          { kind: 'valid', selection: resolved },
          validation.evidence,
        );
        return await recoverCurrentSelectionFromEvidence(runtime, authority, options, transition, adoption);
      }
      publishSelectionOrRefuse(runtime, options.currentSelection);
      return {
        kind: 'opened',
        ...(await settleActiveStore(runtime, authority, options, null, adoption)),
      };
    }

    const relation = classifyActiveStoreSelection(selection.selection, options.currentSelection);
    if (relation === 'selected-newer') {
      const validation = options.dependencies.validateSelectedTarget(
        selection.selection.bundleDir,
        selection.selection.manifest,
      );
      adoption.assertOwned();
      if (validation.kind === 'validated') {
        return { kind: 'handoff', target: validation.target };
      }
      const transition = transitionForSelectionEvidence(
        runtime,
        options.currentSelection,
        selection,
        validation.evidence,
      );
      return await recoverCurrentSelectionFromEvidence(runtime, authority, options, transition, adoption);
    }

    if (relation !== 'exact') {
      publishSelectionOrRefuse(runtime, options.currentSelection);
    }
    return { kind: 'opened', ...(await settleActiveStore(runtime, authority, options, null, adoption)) };
  } finally {
    adoption();
  }
}
