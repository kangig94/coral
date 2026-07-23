import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveStrictBundleIdentity, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { composeCoralPaths } from '../infra/path/index.js';
import { createNodeStoreResetDiagnosticSupervisor } from '../infra/store-reset-diagnostic-supervisor.js';
import { createStoreResetInspectionFs } from '../infra/store-reset-inspection-fs.js';
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
  STORE_RESET_QUARANTINE_DIRECTORY,
  type StoreResetIncidentListResult,
  type StoreResetPublicReport,
} from '../store/reset-incident.js';
import { StoreResetCliError } from './errors.js';

export interface StoreResetCliDependencies {
  resolveIdentity(): { readonly ok: true; readonly manifest: StrictBundleManifest } | { readonly ok: false };
  createInspectionFs(): StoreResetInspectionFs;
  createDiagnosticRunner(): StoreResetIncidentDiagnosticRunner;
  quarantineRoot(manifest: StrictBundleManifest): string;
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
    quarantineRoot: (manifest) =>
      join(composeCoralPaths(manifest.flavor).store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY),
  };
}

export function createStoreResetCommandOperations(shutdownSignal?: AbortSignal): {
  readonly list: () => StoreResetIncidentListResult;
  readonly report: (incidentId: string) => Promise<StoreResetPublicReport>;
} {
  return {
    list: () => listStoreResetIncidentsLocal(defaultDependencies(shutdownSignal)),
    report: (incidentId) => reportStoreResetIncidentLocal(incidentId, defaultDependencies(shutdownSignal)),
  };
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
  dependencies: StoreResetCliDependencies = defaultDependencies(),
): StoreResetIncidentListResult {
  const manifest = requireCurrentBuild(dependencies);
  try {
    return readStoreResetIncidentList({
      fs: dependencies.createInspectionFs(),
      quarantineRoot: dependencies.quarantineRoot(manifest),
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
      quarantineRoot: dependencies.quarantineRoot(manifest),
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
