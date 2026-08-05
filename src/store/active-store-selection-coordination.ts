import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import type { ForeignTargetValidator, InvalidTargetEvidence, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { StorageBigIntStat } from '../infra/port-types.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import {
  classifyActiveStoreSelection,
  clearActiveStoreTransition,
  encodeActiveStoreSelection,
  publishActiveStoreSelection,
  publishActiveStoreTransition,
  readActiveStoreSelection,
  readActiveStoreTransition,
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
  corruptBackendStoreClassificationFromFailure,
  documentedBackendStoreClassificationFailure,
  publishClassifiedBackendStoreResetIncident,
  refuseIncompatibleBackendStore,
  resolveBackendStoreFileSet,
  resumeAutomaticBackendStoreResetIncident,
  resumeBackendStoreResetIncidentForOperator,
  retainBackendStoreResetEvidence,
  STEADY_STATE_BUSY_TIMEOUT_MS,
  type BackendStoreFileSet,
  type BackendStoreResetAuthority,
  type BackendStoreResetIncident,
  type BackendStoreResetLockLease,
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
} from './generation-mutation-coordination.js';

const RETAINED_ACTIVE_STORE_TRANSITION_DIRECTORY = 'retained-active-store-transitions';
const ACTIVE_STORE_TRANSITION_EVIDENCE_SUFFIX = '.active-store-transition.v1.json';

export type ActiveStoreSelectionProtocolResult =
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget };

export type ActiveStoreSelectionRecoveryLease = Readonly<{
  assertOwned(): void;
  release(): void;
}>;

export type ActiveStoreSelectionRecoveryOutcome = Readonly<{
  incident: BackendStoreResetIncident | null;
  resumed: boolean;
}>;

export type ActiveStoreSelectionStartupDependencies = Readonly<{
  kind: 'startup';
  validateSelectedTarget: ForeignTargetValidator;
  recordInvalidTargetRecovery?: (evidence: InvalidTargetEvidence) => void;
}>;

export type ActiveStoreSelectionOperatorDependencies = Readonly<{
  kind: 'operator';
  validateSelectedTarget: ForeignTargetValidator;
  classifyStore?: typeof classifyStoreFile;
  openStore?: typeof openStoreDatabase;
  recordAudit?: typeof writeAuditEvent;
  acquireStoreRecoveryLease?: () => Promise<ActiveStoreSelectionRecoveryLease>;
  openPreparedStore?: (adoption: GenerationAdoptionLockLease) => Database;
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

function createActiveStoreTransition(
  runtime: Runtime,
  currentSelection: ActiveStoreSelection,
  evidence: ActiveStoreTransitionEvidence,
): ActiveStoreTransition {
  return {
    version: 1,
    transitionId: runtime.ids.uuid(),
    kind: 'selection-recovery',
    evidence,
    currentManifest: currentSelection.manifest,
    currentBundleDir: currentSelection.bundleDir,
  };
}

function transitionMatchesCurrent(transition: ActiveStoreTransition, currentSelection: ActiveStoreSelection): boolean {
  const transitionSelection: ActiveStoreSelection = {
    version: 1,
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
  const classify = options.dependencies.kind === 'operator' ? options.dependencies.classifyStore : undefined;
  try {
    return (classify ?? classifyStoreFile)(files.dbFile, runtime.storage, options.storeFormat);
  } catch (error: unknown) {
    const corruptClassification = corruptBackendStoreClassificationFromFailure(error, options.storeFormat);
    if (corruptClassification === null) throw documentedBackendStoreClassificationFailure(runtime, files, error);
    return corruptClassification;
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
        executablePathSha256: null,
        executableSha256: null,
      },
    },
  };
}

function recordAuditFor(options: ActiveStoreSelectionProtocolOptions): typeof writeAuditEvent {
  return options.dependencies.kind === 'operator'
    ? (options.dependencies.recordAudit ?? writeAuditEvent)
    : writeAuditEvent;
}

function retainActiveStoreTransition(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
): ReturnType<typeof retainBackendStoreResetEvidence> {
  const files = resolveBackendStoreFileSet(runtime, options);
  const transitionFile = resolveActiveStoreRecordPaths(runtime).transitionFile;
  try {
    return retainBackendStoreResetEvidence(
      runtime,
      files,
      transitionFile,
      RETAINED_ACTIVE_STORE_TRANSITION_DIRECTORY,
      `${runtime.ids.uuid()}${ACTIVE_STORE_TRANSITION_EVIDENCE_SUFFIX}`,
    );
  } catch (error: unknown) {
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
): StorageBigIntStat | undefined {
  if (transition.evidence.kind !== 'valid-target-invalid' && transition.evidence.kind !== 'selection-malformed') {
    return undefined;
  }
  const retained = retainActiveStoreTransition(runtime, options);
  recordAuditFor(options)(
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
  return retained.sourceIdentity;
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
): BackendStoreResetIncident | undefined {
  if (classification.kind === 'older-incompatible' || classification.kind === 'corrupt-or-unsupported') {
    const incident = publishClassifiedBackendStoreResetIncident(runtime, authority, files, classification, resetLock);
    if (incident === undefined) {
      throw documentedCoralSetupError({
        code: 'store_reset_quarantine_failed',
        reason: 'classified_evidence_missing',
        flavor: runtime.flavor,
      });
    }
    return incident;
  }
  if (classification.kind === 'newer-incompatible') {
    const incident =
      transition === null
        ? undefined
        : publishClassifiedBackendStoreResetIncident(
            runtime,
            authority,
            files,
            classification,
            resetLock,
            resetPolicyForTransition(transition),
          );
    if (incident === undefined) {
      throw documentedCoralSetupError({
        code: 'store_reset_quarantine_failed',
        reason: 'classified_evidence_missing',
        flavor: runtime.flavor,
      });
    }
    return incident;
  }
  refuseIncompatibleBackendStore(runtime, files, classification);
  return undefined;
}

function openProtocolStore(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  files: BackendStoreFileSet,
): Database {
  const open = options.dependencies.kind === 'operator' ? options.dependencies.openStore : undefined;
  const db = (open ?? openStoreDatabase)({
    path: files.dbFile,
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
): Database {
  const files = resolveBackendStoreFileSet(runtime, options);
  inspectCurrentGeneration(runtime, options);
  let resetLock: BackendStoreResetLockLease | null = acquireBackendStoreResetLock(runtime, files, adoption);
  try {
    const resumed =
      options.dependencies.kind === 'operator'
        ? resumeBackendStoreResetIncidentForOperator(runtime, files, resetLock)
        : resumeAutomaticBackendStoreResetIncident(runtime, authority, files, resetLock);
    const classification = classifyStoreForProtocol(runtime, files, options);
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
      publishActiveStoreTransition(runtime, transition);
    }

    if (transition?.evidence.kind === 'valid-target-invalid' && options.dependencies.kind === 'startup') {
      options.dependencies.recordInvalidTargetRecovery?.(transition.evidence.invalidTargetEvidence);
    }
    const published = authorizeClassifiedStore(runtime, authority, files, classification, transition, resetLock);
    const openPreparedStore =
      options.dependencies.kind === 'operator' ? options.dependencies.openPreparedStore : undefined;
    let db: Database;
    if (openPreparedStore === undefined) {
      db = openProtocolStore(runtime, options, files);
    } else {
      resetLock.release();
      resetLock = null;
      adoption.assertOwned();
      db = openPreparedStore(adoption);
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
        const retainedIdentity = retainInvalidSelectionRecovery(runtime, options, transition);
        clearActiveStoreTransition(runtime, retainedIdentity);
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
  const recoveryLease =
    options.dependencies.kind === 'operator' ? await options.dependencies.acquireStoreRecoveryLease?.() : undefined;
  try {
    adoption.assertOwned();
    recoveryLease?.assertOwned();
    return recoverActiveStoreTransition(runtime, authority, options, transition, adoption);
  } finally {
    recoveryLease?.release();
  }
}

function refuseActiveStoreCoordination(
  runtime: Runtime,
  record: ActiveStoreCoordinationRecord,
  failureCode: ActiveStoreCoordinationFailureCode,
): never {
  const paths = resolveActiveStoreRecordPaths(runtime);
  throw documentedCoralSetupError({
    code: 'active_store_coordination_invalid',
    record,
    failureCode,
    coordinationRoot: paths.coordinationRoot,
    recordPath: record === 'selection' ? paths.selectionFile : paths.transitionFile,
  });
}

function supersedeActiveStoreTransition(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  failureCode:
    | ActiveStoreTransitionFailureCode
    | 'transition_current_build_mismatch'
    | 'record_changed'
    | 'record_unavailable',
): void {
  const retained = retainActiveStoreTransition(runtime, options);
  clearActiveStoreTransition(runtime, retained.sourceIdentity);
  recordAuditFor(options)(
    'active-store-transition-superseded',
    {
      failureCode,
      evidencePath: retained.evidencePath,
      evidenceByteLength: retained.evidenceByteLength,
      evidenceSha256: retained.evidenceSha256,
      currentVersion: options.currentSelection.manifest.version,
      currentBuildSetId: options.currentSelection.manifest.buildSetId,
    },
    'warn',
  );
}

function transitionForSelectionEvidence(
  runtime: Runtime,
  currentSelection: ActiveStoreSelection,
  selection: ReturnType<typeof readActiveStoreSelection>,
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
    const transitionRead = readActiveStoreTransition(runtime);
    if (transitionRead.kind === 'valid') {
      if (transitionMatchesCurrent(transitionRead.transition, options.currentSelection)) {
        publishActiveStoreSelection(runtime, options.currentSelection);
        return {
          kind: 'opened',
          db: await recoverActiveStoreSelection(runtime, authority, options, transitionRead.transition, adoption),
        };
      }
      supersedeActiveStoreTransition(runtime, options, 'transition_current_build_mismatch');
    } else if (transitionRead.kind === 'malformed') {
      supersedeActiveStoreTransition(runtime, options, transitionRead.failureCode);
    } else if (transitionRead.kind === 'rejected') {
      if (transitionRead.failureCode === 'record_changed' || transitionRead.failureCode === 'record_unavailable') {
        supersedeActiveStoreTransition(runtime, options, transitionRead.failureCode);
      } else {
        refuseActiveStoreCoordination(runtime, 'transition', transitionRead.failureCode);
      }
    }

    const selection = readActiveStoreSelection(runtime);
    if (selection.kind === 'rejected') {
      refuseActiveStoreCoordination(runtime, 'selection', selection.failureCode);
    }
    if (selection.kind === 'absent' || selection.kind === 'malformed') {
      const transition = transitionForSelectionEvidence(runtime, options.currentSelection, selection);
      publishActiveStoreTransition(runtime, transition);
      publishActiveStoreSelection(runtime, options.currentSelection);
      return {
        kind: 'opened',
        db: await recoverActiveStoreSelection(runtime, authority, options, transition, adoption),
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
      publishActiveStoreTransition(runtime, transition);
      publishActiveStoreSelection(runtime, options.currentSelection);
      return {
        kind: 'opened',
        db: await recoverActiveStoreSelection(runtime, authority, options, transition, adoption),
      };
    }

    if (relation !== 'exact') {
      publishActiveStoreSelection(runtime, options.currentSelection);
    }
    return { kind: 'opened', db: await recoverActiveStoreSelection(runtime, authority, options, null, adoption) };
  } finally {
    adoption();
  }
}
