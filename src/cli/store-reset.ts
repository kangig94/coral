import { tmpdir } from 'node:os';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { resolveStrictBundleIdentity, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { createNodeStoreResetDiagnosticSupervisor } from '../infra/store-reset-diagnostic-supervisor.js';
import { createStoreResetInspectionFs } from '../infra/store-reset-inspection-fs.js';
import { createRealRuntime } from '../runtime/real.js';
import {
  discardStoreReset,
  resolveStoreResetTargetPaths,
  type StoreResetDiscardResult,
  type StoreResetTarget,
} from '../store/operator-store-reset.js';
import {
  createStoreResetIncidentDiagnosticRunner,
  type StoreResetIncidentDiagnosticRunner,
} from '../store/reset-incident-diagnostic.js';
import type { StoreResetInspectionFs } from '../store/reset-incident-inspection-fs.js';
import {
  listStoreResetIncidents as readStoreResetIncidentList,
  readStoreResetIncidentReport,
  StoreResetIncidentLimitError,
  type StoreResetIncidentReportResult,
} from '../store/reset-incident-reader.js';
import {
  isCanonicalStoreResetIncidentId,
  type StoreResetIncidentListResult,
  type StoreResetPublicReport,
} from '../store/reset-incident.js';
import { currentCoralStoreFormat } from '../store-format.js';
import { StoreResetCliError } from './errors.js';
import { acquireStoreResetSocketGuard } from './store-reset-socket.js';

export interface StoreResetCliDependencies {
  resolveIdentity(): { readonly ok: true; readonly manifest: StrictBundleManifest } | { readonly ok: false };
  createInspectionFs(): StoreResetInspectionFs;
  createDiagnosticRunner(): StoreResetIncidentDiagnosticRunner;
  quarantineRoot(manifest: StrictBundleManifest, target: StoreResetTarget): string;
}

function defaultDependencies(shutdownSignal?: AbortSignal): StoreResetCliDependencies {
  return {
    resolveIdentity: () => resolveStrictBundleIdentity(),
    createInspectionFs: createStoreResetInspectionFs,
    createDiagnosticRunner: () =>
      createStoreResetIncidentDiagnosticRunner({
        tempRoot: tmpdir(),
        platform: process.platform,
        executable: process.execPath,
        supervisor: createNodeStoreResetDiagnosticSupervisor({ signal: shutdownSignal }),
      }),
    quarantineRoot: (manifest, target) => {
      const runtime = createRealRuntime(manifest.flavor);
      return resolveStoreResetTargetPaths(runtime, target).quarantineRoot;
    },
  };
}

export function createStoreResetCommandOperations(shutdownSignal?: AbortSignal): {
  readonly list: (target: StoreResetTarget) => StoreResetIncidentListResult;
  readonly report: (target: StoreResetTarget, incidentId: string) => Promise<StoreResetPublicReport>;
  readonly discard: (target: StoreResetTarget, flavor: BuildFlavor) => Promise<StoreResetDiscardResult>;
} {
  const dependencies = defaultDependencies(shutdownSignal);
  return {
    list: (target) => listStoreResetIncidentsLocal(target, dependencies),
    report: (target, incidentId) => reportStoreResetIncidentLocal(target, incidentId, dependencies),
    discard: discardStoreResetLocal,
  };
}

export function discardStoreResetLocal(
  target: StoreResetTarget,
  flavor: BuildFlavor,
): Promise<StoreResetDiscardResult> {
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
): StoreResetIncidentListResult {
  const manifest = requireCurrentBuild(dependencies);
  try {
    return readStoreResetIncidentList({
      fs: dependencies.createInspectionFs(),
      quarantineRoot: dependencies.quarantineRoot(manifest, target),
      expectedBuild: manifest,
    });
  } catch (error: unknown) {
    if (error instanceof StoreResetIncidentLimitError) {
      throw new StoreResetCliError('store_reset_incident_limit_exceeded');
    }
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

export function boundStoreResetCliError(error: unknown): StoreResetCliError {
  return error instanceof StoreResetCliError ? error : new StoreResetCliError('store_reset_reporting_failed');
}
