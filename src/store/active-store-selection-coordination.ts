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
  assertBackendStoreResetAuthority,
  classifyBackendStoreFailure,
  documentedBackendStoreClassificationFailure,
  hasPendingBackendStoreResetIncident,
  publishClassifiedBackendStoreResetIncident,
  refuseIncompatibleBackendStore,
  resolveBackendStoreFileSet,
  resumeAutomaticBackendStoreResetIncident,
  resumeBackendStoreResetIncidentForOperator,
  retainTransitionFileInStoreResetQuarantine,
  STEADY_STATE_BUSY_TIMEOUT_MS,
  type BackendStoreFileSet,
  type BackendStoreResetAuthority,
  type BackendStoreResetIncident,
  type BackendStoreResetLockLease,
  type WriterExclusion,
  type NewerStoreResetPolicy,
  type OpenOrResetBackendStoreOptions,
} from './backend-store-reset.js';
import { classifyStoreFile, openStoreDatabase, type Database } from './db.js';
import type { StoreFormatClassification } from './format-fingerprint.js';
import {
  acquireGenerationAdoptionLock,
  formatLegacyGenerationIgnoredNotice,
  inspectGenerationReadiness,
  type GenerationAdoptionLockLease,
  type GenerationMaintenanceLease,
} from './generation-mutation-coordination.js';

export type ActiveStoreSelectionProtocolResult =
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget };

export type ActiveStoreSelectionRecoveryOutcome = Readonly<{
  incident: BackendStoreResetIncident | null;
  resumed: boolean;
}>;

export type ActiveStoreSelectionStartupDependencies = Readonly<{
  kind: 'startup';
  validateSelectedTarget: ForeignTargetValidator;
  acquireWriterExclusion: () => Promise<WriterExclusion>;
  recordInvalidTargetRecovery?: (evidence: InvalidTargetEvidence) => void;
}>;

export type ActiveStoreSelectionOperatorDependencies = Readonly<{
  kind: 'operator';
  validateSelectedTarget: ForeignTargetValidator;
  acquireStoreRecoveryLease?: () => Promise<GenerationMaintenanceLease>;
  openPreparedStore?: (adoption: GenerationAdoptionLockLease, writerExclusion: WriterExclusion) => Database;
  recordRecoveryOutcome?: (outcome: ActiveStoreSelectionRecoveryOutcome) => void;
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
): StoreFormatClassification {
  const { dbFile } = files;
  try {
    return classifyStoreFile(dbFile, runtime.storage, options.storeFormat);
  } catch (error: unknown) {
    const failure = classifyBackendStoreFailure(error, options.storeFormat);
    switch (failure.kind) {
      case 'corrupt-or-unsupported':
        return failure.classification;
      case 'unavailable':
      case 'unclassified':
        throw documentedBackendStoreClassificationFailure(runtime, dbFile, failure);
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

function authorizeClassifiedStore(
  runtime: Runtime,
  authority: BackendStoreResetAuthority,
  files: BackendStoreFileSet,
  classification: StoreFormatClassification,
  transition: ActiveStoreTransition | null,
  resetLock: BackendStoreResetLockLease,
  writerExclusion: WriterExclusion | undefined,
): BackendStoreResetIncident | undefined {
  const exclusion = writerExclusion ?? { kind: 'unproven', reason: 'not-attempted', blockers: null };
  if (classification.kind === 'older-incompatible' || classification.kind === 'corrupt-or-unsupported') {
    const publication = publishClassifiedBackendStoreResetIncident(
      runtime,
      authority,
      files,
      classification,
      resetLock,
      exclusion,
    );
    switch (publication.kind) {
      case 'preserved':
        return publication.incident;
      case 'discarded':
      case 'no-evidence':
        return undefined;
      default:
        return assertNever(publication);
    }
  }
  if (classification.kind === 'newer-incompatible') {
    const publication =
      transition === null
        ? ({ kind: 'no-evidence', leftActive: [] } as const)
        : publishClassifiedBackendStoreResetIncident(
            runtime,
            authority,
            files,
            classification,
            resetLock,
            exclusion,
            resetPolicyForTransition(transition),
          );
    switch (publication.kind) {
      case 'preserved':
        return publication.incident;
      case 'discarded':
      case 'no-evidence':
        return undefined;
      default:
        return assertNever(publication);
    }
  }
  const { dbFile } = files;
  refuseIncompatibleBackendStore(runtime, dbFile, classification);
  return undefined;
}

function openProtocolStore(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  files: BackendStoreFileSet,
): Database {
  const { dbFile } = files;
  const db = openStoreDatabase({
    path: dbFile,
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    flavor: runtime.flavor,
    busyTimeoutMs: options.startupBusyTimeoutMs ?? options.busyTimeoutMs,
  });
  db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? STEADY_STATE_BUSY_TIMEOUT_MS}`);
  return db;
}

function recoverActiveStoreTransition(
  runtime: Runtime,
  authority: BackendStoreResetAuthority,
  options: ActiveStoreSelectionProtocolOptions,
  initialTransition: ActiveStoreTransition | null,
  adoption: GenerationAdoptionLockLease,
  writerExclusion: WriterExclusion | undefined,
  initialClassification: StoreFormatClassification | null,
): Database {
  const files = resolveBackendStoreFileSet(runtime, options);
  let resetLock: BackendStoreResetLockLease | null = acquireBackendStoreResetLock(runtime, files, adoption);
  try {
    const resumed =
      options.dependencies.kind === 'operator'
        ? resumeBackendStoreResetIncidentForOperator(runtime, files, resetLock)
        : resumeAutomaticBackendStoreResetIncident(runtime, authority, files, resetLock);
    const classification =
      resumed === null && initialClassification !== null && writerExclusion === undefined
        ? initialClassification
        : classifyStoreForProtocol(runtime, files, options);
    let transition = initialTransition;
    if (classification.kind === 'newer-incompatible') {
      const evidence = newerStoreEvidence(classification);
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

    if (transition?.evidence.kind === 'valid-target-invalid' && options.dependencies.kind === 'startup') {
      options.dependencies.recordInvalidTargetRecovery?.(transition.evidence.invalidTargetEvidence);
    }
    const published = authorizeClassifiedStore(
      runtime,
      authority,
      files,
      classification,
      transition,
      resetLock,
      writerExclusion,
    );
    const openPreparedStore =
      options.dependencies.kind === 'operator' ? options.dependencies.openPreparedStore : undefined;
    let db: Database;
    if (openPreparedStore === undefined) {
      db = openProtocolStore(runtime, options, files);
    } else {
      resetLock.release();
      resetLock = null;
      adoption.assertOwned();
      db = openPreparedStore(
        adoption,
        writerExclusion ?? { kind: 'unproven', reason: 'not-attempted', blockers: null },
      );
    }
    try {
      if (options.dependencies.kind === 'operator') {
        options.dependencies.recordRecoveryOutcome?.({
          incident: resumed ?? published ?? null,
          resumed: resumed !== null,
        });
      }
      if (transition !== null) {
        // The live transition is cleared only after its invalid-selection basis has been copied into the
        // reset-quarantine durability boundary. Coordinator logging is deliberately not evidence authority.
        const clearEvidence = retainInvalidSelectionRecovery(runtime, options, transition, adoption);
        if (clearEvidence.kind === 'clear') {
          clearActiveStoreTransition(runtime, clearEvidence.sourceIdentity);
        }
      }
      return db;
    } catch (error: unknown) {
      db.close();
      throw error;
    }
  } finally {
    resetLock?.release();
  }
}

async function recoverActiveStoreSelection(
  runtime: Runtime,
  authority: BackendStoreResetAuthority,
  options: ActiveStoreSelectionProtocolOptions,
  transition: ActiveStoreTransition | null,
  adoption: GenerationAdoptionLockLease,
): Promise<Database> {
  inspectCurrentGeneration(runtime, options);
  const files = resolveBackendStoreFileSet(runtime, options);
  let initialClassification: StoreFormatClassification | null = null;
  let writerExclusion: WriterExclusion | undefined;
  if (options.dependencies.kind === 'operator') {
    const recoveryLease = await options.dependencies.acquireStoreRecoveryLease?.();
    if (recoveryLease !== undefined) writerExclusion = { kind: 'proven', lease: recoveryLease };
  } else {
    const pending = hasPendingBackendStoreResetIncident(runtime, files);
    if (!pending) initialClassification = classifyStoreForProtocol(runtime, files, options);
    const classificationNeedsReset =
      initialClassification?.kind === 'older-incompatible' ||
      initialClassification?.kind === 'corrupt-or-unsupported' ||
      initialClassification?.kind === 'newer-incompatible';
    if (pending || classificationNeedsReset) {
      writerExclusion = await options.dependencies.acquireWriterExclusion();
    }
  }
  try {
    adoption.assertOwned();
    if (writerExclusion?.kind === 'proven') writerExclusion.lease.assertOwned();
    return recoverActiveStoreTransition(
      runtime,
      authority,
      options,
      transition,
      adoption,
      writerExclusion,
      initialClassification,
    );
  } finally {
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
    db: await recoverActiveStoreSelection(runtime, authority, options, transition, adoption),
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
          db: await recoverActiveStoreSelection(runtime, authority, options, transitionRead.transition, adoption),
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
        db: await recoverActiveStoreSelection(runtime, authority, options, null, adoption),
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
    return { kind: 'opened', db: await recoverActiveStoreSelection(runtime, authority, options, null, adoption) };
  } finally {
    adoption();
  }
}
