import { join } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import { readBoundedAdjacentManifest, strictBundleManifestSchema } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import type { ForeignTargetValidator, InvalidTargetEvidence, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { StorageBigIntStat } from '../infra/port-types.js';
import type { StorageActuator } from '../infra/storage-actuator.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import {
  ActiveStoreCoordinationWriteError,
  ACTIVE_STORE_SELECTION_VERSION,
  ACTIVE_STORE_TRANSITION_VERSION,
  classifyActiveStoreSelection,
  classifyActiveStoreSelectionV1,
  encodeActiveStoreSelection,
  publishActiveStoreSelection,
  publishActiveStoreTransition,
  type readActiveStoreSelectionForCoordination,
  readActiveStoreSelectionForSettlement,
  readActiveStoreTransitionForSettlement,
  readActiveStoreTransitionV1ForSettlement,
  resolveActiveStoreSelectionV1,
  resolveActiveStoreRecordPaths,
  type ActiveStoreRecordReadFailureCode,
  type ActiveStoreSelection,
  type ActiveStoreTransition,
  type ActiveStoreTransitionEvidence,
  type ActiveStoreTransitionFailureCode,
} from './active-store-selection.js';
import type { Database } from './db.js';
import { settleStoreEpoch, type ResolvedStoreEpoch } from './epoch.js';
import type { StoreFormatDescription } from './format-fingerprint.js';
import {
  formatLegacyGenerationIgnoredNotice,
  inspectGenerationReadiness,
  tryAcquireGenerationAdoptionLock,
  type GenerationAdoptionLockLease,
} from './generation-mutation-coordination.js';

export type ActiveStoreSelectionProtocolResult =
  | ({ readonly kind: 'opened' } & ActiveStoreSettlement)
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget };

export type ActiveStoreSettlement = Readonly<{
  db: Database;
  store: ResolvedStoreEpoch;
  invalidTargetEvidence: InvalidTargetEvidence | null;
}>;

export type ActiveStoreSelectionStartupDependencies = Readonly<{
  kind: 'startup';
  validateSelectedTarget: ForeignTargetValidator;
}>;

export type ActiveStoreSelectionOperatorDependencies = Readonly<{
  kind: 'operator';
  validateSelectedTarget: ForeignTargetValidator;
}>;

export type ActiveStoreSelectionProtocolDependencies =
  | ActiveStoreSelectionStartupDependencies
  | ActiveStoreSelectionOperatorDependencies;

export type ActiveStoreSelectionProtocolOptions = {
  readonly path?: string;
  readonly startupBusyTimeoutMs?: number;
  readonly steadyStateBusyTimeoutMs?: number;
  readonly storeFormat: StoreFormatDescription;
  readonly currentSelection: ActiveStoreSelection;
  readonly dependencies: ActiveStoreSelectionProtocolDependencies;
};

type ActiveStoreCoordinationRecord = 'selection' | 'transition';
type ActiveStoreCoordinationFailureCode = ActiveStoreRecordReadFailureCode;
type RetainedTransitionEvidence = Readonly<{
  evidencePath: string;
  evidenceByteLength: number | null;
  sourceIdentity: StorageBigIntStat;
}>;

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

function retainActiveStoreTransition(
  runtime: Runtime,
  actuator: StorageActuator,
  transitionFile = resolveActiveStoreRecordPaths(runtime).transitionFile,
): RetainedTransitionEvidence | null {
  let sourceIdentity: StorageBigIntStat;
  try {
    sourceIdentity = runtime.storage.lstatSync(transitionFile, { bigint: true });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const { coordinationRoot } = resolveActiveStoreRecordPaths(runtime);
  const retainedRoot = join(coordinationRoot, 'retained-active-store-transitions');
  const evidencePath = join(retainedRoot, `${runtime.ids.uuid()}.json`);
  actuator.makeDirectory(retainedRoot, { recursive: true, mode: 0o700 });
  actuator.rename(transitionFile, evidencePath);
  const retainedSynced = actuator.syncDirectory(retainedRoot);
  const sourceSynced = actuator.syncDirectory(coordinationRoot);
  if (!retainedSynced || !sourceSynced) {
    refuseActiveStoreCoordination(
      runtime,
      'transition',
      'record_unavailable',
      `Failed to durably retain active-store transition at '${evidencePath}'.`,
    );
  }
  return {
    evidencePath,
    evidenceByteLength: sourceIdentity.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sourceIdentity.size) : null,
    sourceIdentity,
  };
}

function retainInvalidSelectionRecovery(
  runtime: Runtime,
  transition: ActiveStoreTransition,
  actuator: StorageActuator,
): void {
  if (transition.evidence.kind !== 'valid-target-invalid' && transition.evidence.kind !== 'selection-malformed') {
    return;
  }
  const retained = retainActiveStoreTransition(runtime, actuator);
  if (retained === null) return;
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
      currentVersion: transition.currentManifest.version,
      currentBuildSetId: transition.currentManifest.buildSetId,
    },
    'warn',
  );
}

function inspectCurrentGeneration(runtime: Runtime, options: ActiveStoreSelectionProtocolOptions): void {
  if (options.path !== undefined) return;
  const readiness = inspectGenerationReadiness(runtime);
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

async function settleActiveStore(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
  initialTransition: ActiveStoreTransition | null,
  adoption: GenerationAdoptionLockLease | null,
): Promise<ActiveStoreSettlement> {
  inspectCurrentGeneration(runtime, options);
  const settled = settleStoreEpoch(runtime, {
    path: options.path,
    storeFormat: options.storeFormat,
    build: options.currentSelection.manifest,
    startupBusyTimeoutMs: options.startupBusyTimeoutMs,
    steadyStateBusyTimeoutMs: options.steadyStateBusyTimeoutMs,
  });
  try {
    if (initialTransition !== null && adoption !== null) {
      retainInvalidSelectionRecovery(runtime, initialTransition, adoption.actuator);
    }
    return {
      ...settled,
      invalidTargetEvidence:
        initialTransition?.evidence.kind === 'valid-target-invalid'
          ? initialTransition.evidence.invalidTargetEvidence
          : null,
    };
  } catch (error: unknown) {
    settled.db.close();
    throw error;
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
function publishSelectionOrRefuse(runtime: Runtime, selection: ActiveStoreSelection, actuator: StorageActuator): void {
  try {
    publishActiveStoreSelection(runtime, selection, actuator);
  } catch (error: unknown) {
    refuseActiveStoreCoordination(
      runtime,
      'selection',
      coordinationWriteFailureCode(error),
      error instanceof Error ? error.message : 'Active-store selection publish failed with a non-Error value.',
    );
  }
}

function publishTransitionOrRefuse(
  runtime: Runtime,
  transition: ActiveStoreTransition,
  actuator: StorageActuator,
): void {
  try {
    publishActiveStoreTransition(runtime, transition, actuator);
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
  const retained = retainActiveStoreTransition(runtime, adoption.actuator, transitionFile);
  writeAuditEvent(
    'active-store-transition-superseded',
    {
      failureCode,
      ...(retained === null
        ? {}
        : {
            evidencePath: retained.evidencePath,
            evidenceByteLength: retained.evidenceByteLength,
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
  options: ActiveStoreSelectionProtocolOptions,
  transition: ActiveStoreTransition,
  adoption: GenerationAdoptionLockLease,
): Promise<Extract<ActiveStoreSelectionProtocolResult, { kind: 'opened' }>> {
  publishTransitionOrRefuse(runtime, transition, adoption.actuator);
  publishSelectionOrRefuse(runtime, options.currentSelection, adoption.actuator);
  return {
    kind: 'opened',
    ...(await settleActiveStore(runtime, options, transition, adoption)),
  };
}

export async function coordinateActiveStoreSelection(
  runtime: Runtime,
  options: ActiveStoreSelectionProtocolOptions,
): Promise<ActiveStoreSelectionProtocolResult> {
  if (options.path === ':memory:') {
    throw new Error('Active-store selection coordination requires a real filesystem store path.');
  }
  encodeActiveStoreSelection(options.currentSelection);
  const adoption = await tryAcquireGenerationAdoptionLock(runtime);
  if (adoption === null) {
    return { kind: 'opened', ...(await settleActiveStore(runtime, options, null, null)) };
  }
  try {
    adoption.assertOwned();
    const transitionV1Read = readActiveStoreTransitionV1ForSettlement(runtime, adoption.actuator);
    if (transitionV1Read.kind === 'legacy') {
      supersedeActiveStoreTransition(runtime, options, adoption, 'transition_current_build_mismatch', 'v1');
    } else if (transitionV1Read.kind === 'rejected') {
      if (transitionV1Read.failureCode === 'record_changed' || transitionV1Read.failureCode === 'record_unavailable') {
        supersedeActiveStoreTransition(runtime, options, adoption, transitionV1Read.failureCode, 'v1');
      } else {
        refuseActiveStoreCoordination(runtime, 'transition', transitionV1Read.failureCode);
      }
    }
    const transitionRead = readActiveStoreTransitionForSettlement(runtime, adoption.actuator);
    if (transitionRead.kind === 'valid') {
      if (transitionMatchesCurrent(transitionRead.transition, options.currentSelection)) {
        publishSelectionOrRefuse(runtime, options.currentSelection, adoption.actuator);
        return {
          kind: 'opened',
          ...(await settleActiveStore(runtime, options, transitionRead.transition, adoption)),
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

    const selection = readActiveStoreSelectionForSettlement(runtime, adoption.actuator);
    if (selection.kind === 'rejected') {
      refuseActiveStoreCoordination(runtime, 'selection', selection.failureCode);
    }
    if (selection.kind === 'absent' || selection.kind === 'malformed') {
      const transition = transitionForSelectionEvidence(runtime, options.currentSelection, selection);
      return await recoverCurrentSelectionFromEvidence(runtime, options, transition, adoption);
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
        return await recoverCurrentSelectionFromEvidence(runtime, options, transition, adoption);
      }
      publishSelectionOrRefuse(runtime, options.currentSelection, adoption.actuator);
      return {
        kind: 'opened',
        ...(await settleActiveStore(runtime, options, null, adoption)),
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
      return await recoverCurrentSelectionFromEvidence(runtime, options, transition, adoption);
    }

    if (relation !== 'exact') {
      publishSelectionOrRefuse(runtime, options.currentSelection, adoption.actuator);
    }
    return { kind: 'opened', ...(await settleActiveStore(runtime, options, null, adoption)) };
  } finally {
    adoption();
  }
}
