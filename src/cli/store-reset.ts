import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { resolveStrictBundleIdentity, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { createNodeStoreResetDiagnosticSupervisor } from '../infra/store-reset-diagnostic-supervisor.js';
import { createStoreResetInspectionFs } from '../infra/store-reset-inspection-fs.js';
import { createRealRuntime } from '../runtime/real.js';
import { CoralSetupError } from '../runtime/errors.js';
import {
  discardStoreReset,
  releaseStoreReset,
  resolveStoreResetTargetPaths,
  type StoreResetDiscardDecision,
  type StoreResetReleasePresentation,
  type StoreResetReleaseTarget,
  type StoreResetTarget,
} from '../store/operator-store-reset.js';
import {
  createStoreResetIncidentDiagnosticRunner,
  diagnoseStoreDatabaseCopy,
  prepareStoreReportTempRoot,
  type StoreResetIncidentDiagnosticRunner,
  type StoreResetDiagnosticStatus,
} from '../store/reset-incident-diagnostic.js';
import type { StoreResetInspectionFs } from '../store/reset-incident-inspection-fs.js';
import {
  listLegacyStoreResetIncidents,
  readStoreResetIncidentReport,
  type LegacyStoreResetIncidentListEntry,
  type StoreResetIncidentReportResult,
} from '../store/reset-incident-reader.js';
import {
  acquireStoreEpochInspectionLock,
  listStoreEpochHolders,
  listStoreEpochResidues,
  listStoreEpochs,
  type ResolvedStoreEpoch,
  type StoreEpochHolderListEntry,
  type StoreEpochListEntry,
  type StoreEpochResidueListEntry,
} from '../store/epoch.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_SQLITE_DIAGNOSTIC_BYTES,
  type StoreResetPublicReport,
} from '../store/reset-incident.js';
import { currentCoralStoreFormat } from '../store-format.js';
import { StoreResetCliError } from './errors.js';
import { acquireStoreResetSocketGuard } from './store-reset-socket.js';

export interface StoreResetCliDependencies {
  resolveIdentity(): { readonly ok: true; readonly manifest: StrictBundleManifest } | { readonly ok: false };
  createInspectionFs(): StoreResetInspectionFs;
  createDiagnosticRunner(): StoreResetIncidentDiagnosticRunner;
  diagnoseEpoch(store: ResolvedStoreEpoch): Promise<StoreResetDiagnosticStatus>;
  quarantineRoot(manifest: StrictBundleManifest, target: StoreResetTarget): string;
  runtime?(manifest: StrictBundleManifest): ReturnType<typeof createRealRuntime>;
}

export type StoreResetListResult = Readonly<{
  epochs: readonly StoreEpochListEntry[];
  holders: readonly StoreEpochHolderListEntry[];
  residues: readonly StoreEpochResidueListEntry[];
  legacyIncidents: readonly LegacyStoreResetIncidentListEntry[];
  truncated: boolean;
}>;

export type StoreResetReportResult =
  | Readonly<{
      kind: 'epoch';
      epoch: StoreEpochListEntry;
      diagnostic: StoreResetDiagnosticStatus;
    }>
  | Readonly<{ kind: 'legacy'; report: StoreResetPublicReport }>;

function defaultDependencies(shutdownSignal?: AbortSignal): StoreResetCliDependencies {
  return {
    resolveIdentity: () => resolveStrictBundleIdentity(),
    createInspectionFs: createStoreResetInspectionFs,
    createDiagnosticRunner: () =>
      createStoreResetIncidentDiagnosticRunner({
        tempRoot: prepareStoreReportTempRoot(tmpdir()),
        platform: process.platform,
        executable: process.execPath,
        supervisor: createNodeStoreResetDiagnosticSupervisor({ signal: shutdownSignal }),
      }),
    diagnoseEpoch: (store) =>
      diagnoseStoreDatabaseCopy({
        fs: createStoreResetInspectionFs(),
        sourceDirectory: dirname(store.path),
        tempRoot: prepareStoreReportTempRoot(tmpdir()),
        platform: process.platform,
        executable: process.execPath,
        supervisor: createNodeStoreResetDiagnosticSupervisor({ signal: shutdownSignal }),
      }),
    quarantineRoot: (manifest, target) => {
      const runtime = createRealRuntime(manifest.flavor);
      return resolveStoreResetTargetPaths(runtime, target).quarantineRoot;
    },
    runtime: (manifest) => createRealRuntime(manifest.flavor),
  };
}

async function diagnoseHeldEpoch(
  runtime: ReturnType<typeof createRealRuntime>,
  store: ResolvedStoreEpoch,
  dependencies: StoreResetCliDependencies,
): Promise<StoreResetDiagnosticStatus> {
  const lease = acquireStoreEpochInspectionLock(runtime, store);
  if (lease === null) return { integrity: 'unavailable', termination: 'not_started', cleanup: 'not_required' };
  try {
    try {
      return await dependencies.diagnoseEpoch(store);
    } catch {
      return { integrity: 'unavailable', termination: 'not_started', cleanup: 'cleanup_unavailable' };
    }
  } finally {
    lease();
  }
}

export function createStoreResetCommandOperations(shutdownSignal?: AbortSignal): {
  readonly list: (target: StoreResetTarget) => StoreResetListResult;
  readonly report: (target: StoreResetTarget, reference: string) => Promise<StoreResetReportResult>;
  readonly discard: (target: StoreResetTarget, flavor: BuildFlavor) => Promise<StoreResetDiscardDecision>;
  readonly release: (
    target: StoreResetReleaseTarget,
    flavor: BuildFlavor,
    epoch: string,
  ) => Promise<StoreResetReleasePresentation>;
} {
  const dependencies = defaultDependencies(shutdownSignal);
  return {
    list: (target) => listStoreResetIncidentsLocal(target, dependencies),
    report: (target, reference) => reportStoreResetLocal(target, reference, dependencies),
    discard: discardStoreResetLocal,
    release: releaseStoreResetLocal,
  };
}

export function releaseStoreResetLocal(
  target: StoreResetReleaseTarget,
  flavor: BuildFlavor,
  epoch: string,
): Promise<StoreResetReleasePresentation> {
  if (!/^[1-9]\d*$/.test(epoch)) {
    throw new StoreResetCliError('invalid_store_reset_release_incident_id');
  }
  return releaseStoreReset({
    target,
    runtime: createRealRuntime(flavor),
    epoch,
    acquireSocketGuard: acquireStoreResetSocketGuard,
  });
}

function isCanonicalEpoch(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

export function discardStoreResetLocal(
  target: StoreResetTarget,
  flavor: BuildFlavor,
): Promise<StoreResetDiscardDecision> {
  const runtime = createRealRuntime(flavor);
  if (target === 'legacy') return discardStoreReset({ target, runtime });
  const identity = resolveStrictBundleIdentity();
  if (!identity.ok || identity.manifest.flavor !== flavor) {
    throw new StoreResetCliError('store_reset_build_mismatch');
  }
  return discardStoreReset({
    target,
    runtime,
    build: identity.manifest,
    storeFormat: currentCoralStoreFormat(),
    acquireSocketGuard: acquireStoreResetSocketGuard,
  });
}

function requireCurrentBuild(dependencies: StoreResetCliDependencies): StrictBundleManifest {
  const identity = dependencies.resolveIdentity();
  if (!identity.ok) throw new StoreResetCliError('store_reset_build_mismatch');
  return identity.manifest;
}

function mapReportFailure(result: Exclude<StoreResetIncidentReportResult, { readonly ok: true }>): never {
  if (result.state === 'invalid_id') throw new StoreResetCliError('invalid_store_reset_incident_id');
  if (result.state === 'not_found') throw new StoreResetCliError('store_reset_incident_not_found');
  if (result.state === 'build_mismatch') throw new StoreResetCliError('store_reset_incident_build_mismatch');
  throw new StoreResetCliError('store_reset_reporting_failed');
}

export function listStoreResetIncidentsLocal(
  target: StoreResetTarget,
  dependencies: StoreResetCliDependencies = defaultDependencies(),
): StoreResetListResult {
  const manifest = requireCurrentBuild(dependencies);
  try {
    const legacy = listLegacyStoreResetIncidents({
      fs: dependencies.createInspectionFs(),
      quarantineRoot: dependencies.quarantineRoot(manifest, target),
      expectedBuild: manifest,
    });
    const runtime = dependencies.runtime?.(manifest) ?? createRealRuntime(manifest.flavor);
    return {
      epochs: target === 'legacy' ? [] : listStoreEpochs(runtime),
      holders: target === 'legacy' ? [] : listStoreEpochHolders(runtime),
      residues: target === 'legacy' ? [] : listStoreEpochResidues(runtime),
      legacyIncidents: legacy.incidents,
      truncated: legacy.truncated,
    };
  } catch (error: unknown) {
    if (error instanceof StoreResetCliError) throw error;
    throw new StoreResetCliError('store_reset_reporting_failed');
  }
}

export async function reportStoreResetIncidentLocal(
  target: StoreResetTarget,
  incidentId: string,
  dependencies: StoreResetCliDependencies = defaultDependencies(),
): Promise<StoreResetPublicReport> {
  if (!isCanonicalStoreResetIncidentId(incidentId)) {
    throw new StoreResetCliError('invalid_store_reset_incident_id');
  }
  const manifest = requireCurrentBuild(dependencies);
  let result: StoreResetIncidentReportResult;
  try {
    result = await readStoreResetIncidentReport({
      fs: dependencies.createInspectionFs(),
      quarantineRoot: dependencies.quarantineRoot(manifest, target),
      incidentId,
      expectedBuild: manifest,
      diagnose: dependencies.createDiagnosticRunner(),
    });
  } catch {
    throw new StoreResetCliError('store_reset_reporting_failed');
  }
  if (!result.ok) return mapReportFailure(result);
  return result.report;
}

export async function reportStoreResetLocal(
  target: StoreResetTarget,
  reference: string,
  dependencies: StoreResetCliDependencies = defaultDependencies(),
): Promise<StoreResetReportResult> {
  if (target === 'gen2' && isCanonicalEpoch(reference)) {
    const manifest = requireCurrentBuild(dependencies);
    const runtime = dependencies.runtime?.(manifest) ?? createRealRuntime(manifest.flavor);
    const epoch = listStoreEpochs(runtime).find((candidate) => candidate.epoch === reference);
    if (epoch === undefined) throw new StoreResetCliError('store_reset_incident_not_found');
    const diagnostic =
      epoch.resolved === null || epoch.bytes === null || epoch.bytes > MAX_SQLITE_DIAGNOSTIC_BYTES
        ? ({ integrity: 'unavailable', termination: 'not_started', cleanup: 'not_required' } as const)
        : await diagnoseHeldEpoch(runtime, epoch.resolved, dependencies);
    return { kind: 'epoch', epoch, diagnostic };
  }
  if (!isCanonicalStoreResetIncidentId(reference)) {
    throw new StoreResetCliError('invalid_store_reset_incident_id');
  }
  return {
    kind: 'legacy',
    report: await reportStoreResetIncidentLocal(target, reference, dependencies),
  };
}

export function boundStoreResetCliError(error: unknown): StoreResetCliError | CoralSetupError {
  return error instanceof StoreResetCliError || error instanceof CoralSetupError
    ? error
    : new StoreResetCliError('store_reset_reporting_failed');
}

export function boundStoreResetReleaseCliError(error: unknown): StoreResetCliError | CoralSetupError {
  return error instanceof StoreResetCliError || error instanceof CoralSetupError
    ? error
    : new StoreResetCliError('store_reset_release_failed');
}
