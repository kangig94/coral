import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { resolveStrictBundleIdentity, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { createNodeStoreResetDiagnosticSupervisor } from '../infra/store-reset-diagnostic-supervisor.js';
import { createStoreResetInspectionFs } from '../infra/store-reset-inspection-fs.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import {
  createBackendStoreResetAuthority,
  openOrResetBackendStoreDb,
  publishBackendStoreResetIncident,
  resumeInterruptedBackendStoreResetIncident,
  type BackendStoreResetIncident,
} from '../store/backend-store-reset.js';
import {
  acquireGenerationAdoptionLease,
  acquireGenerationMaintenanceLease,
  resolveGenerationBoundaryPaths,
  type GenerationMaintenanceLease,
} from '../store/generation-mutation-coordination.js';
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
import { currentCoralStoreFormat } from '../store-format.js';
import type { StoreFormatDescription } from '../store/format-fingerprint.js';
import { bindSocket } from '../transport/ipc/server.js';
import { StoreResetCliError } from './errors.js';

export type StoreResetTarget = 'legacy' | 'gen2';

export type StoreResetTargetPaths = {
  readonly target: StoreResetTarget;
  readonly baseDir: string;
  readonly storeDbPath: string;
  readonly quarantineRoot: string;
  readonly socketPath: string;
};

export interface StoreResetSocketGuard {
  release(): Promise<void>;
}

export type StoreResetDiscardResult = {
  readonly target: 'gen2';
  readonly flavor: BuildFlavor;
  readonly baseDir: string;
  readonly storeDbPath: string;
  readonly incident: BackendStoreResetIncident | null;
  readonly resumed: boolean;
};

type AcquireStoreResetSocketGuard = (
  paths: StoreResetTargetPaths,
  flavor: BuildFlavor,
) => Promise<StoreResetSocketGuard>;

type StoreResetDiscardOptions =
  | {
      readonly target: 'legacy';
      readonly runtime: Runtime;
    }
  | {
      readonly target: 'gen2';
      readonly runtime: Runtime;
      readonly build: StrictBundleManifest;
      readonly storeFormat: StoreFormatDescription;
      readonly acquireSocketGuard?: AcquireStoreResetSocketGuard;
      readonly maintenanceTimeoutMs?: number;
    };

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

export function resolveStoreResetTargetPaths(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'paths'>,
  target: StoreResetTarget,
): StoreResetTargetPaths {
  const boundary = resolveGenerationBoundaryPaths(runtime);
  if (target === 'gen2') {
    return {
      target,
      baseDir: boundary.baseDir,
      storeDbPath: runtime.paths.coral.store.dbFile,
      quarantineRoot: join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY),
      socketPath: runtime.paths.coral.coordinator.socketPath,
    };
  }

  const storeDbPath = join(boundary.legacyFlavorRoot, 'store', 'store.db');
  const runDirectory = join(boundary.baseDir, basename(runtime.paths.coral.coordinator.runDir));
  return {
    target,
    baseDir: boundary.baseDir,
    storeDbPath,
    quarantineRoot: join(dirname(storeDbPath), STORE_RESET_QUARANTINE_DIRECTORY),
    socketPath: socketPathForRunDir(runDirectory, runtime.flavor, {
      platform: runtime.env.platform(),
      tempDirectory: runtime.env.get('TMPDIR') ?? runtime.env.tmpdir(),
    }),
  };
}

async function closeSocketGuard(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function acquireStoreResetSocketGuard(
  paths: StoreResetTargetPaths,
  flavor: BuildFlavor,
): Promise<StoreResetSocketGuard> {
  const server = createServer();
  const binding = await bindSocket(server, paths.socketPath);
  if (binding.kind === 'incumbent') {
    throw documentedCoralSetupError({
      code: 'store_reset_lock_contended',
      holder: `${paths.target} coordinator socket`,
      socketPath: paths.socketPath,
      target: paths.target,
      flavor,
      baseDir: paths.baseDir,
    });
  }
  return { release: () => closeSocketGuard(server) };
}

function acquireStoreResetLock(runtime: Runtime, paths: StoreResetTargetPaths) {
  const dbDir = dirname(paths.storeDbPath);
  runtime.storage.mkdirSync(dbDir, { recursive: true });
  const lockPath = join(dbDir, 'store.db.reset.lock');
  try {
    return acquireDirectoryLockSync(lockPath, 250);
  } catch (error: unknown) {
    if (isDirectoryLockTimeoutError(error)) {
      throw documentedCoralSetupError({
        code: 'store_reset_lock_contended',
        lockPath,
        dbDir,
        target: paths.target,
        flavor: runtime.flavor,
        baseDir: paths.baseDir,
      });
    }
    throw error;
  }
}

async function discardGeneratedStore(
  options: Extract<StoreResetDiscardOptions, { readonly target: 'gen2' }>,
  paths: StoreResetTargetPaths,
): Promise<StoreResetDiscardResult> {
  const adoption = await acquireGenerationAdoptionLease(options.runtime, options.storeFormat);
  try {
    let maintenance: GenerationMaintenanceLease;
    try {
      maintenance = await acquireGenerationMaintenanceLease(options.runtime, options.maintenanceTimeoutMs);
    } catch (error: unknown) {
      if (error instanceof CoralSetupError && error.code === 'legacy_source_not_quiescent') {
        throw documentedCoralSetupError({
          code: 'legacy_source_not_quiescent',
          operation: 'store-reset',
          holder: error.context?.holder,
          flavor: options.runtime.flavor,
          baseDir: paths.baseDir,
        });
      }
      throw error;
    }
    try {
      adoption.assertOwned();
      maintenance.assertOwned();

      const authority = createBackendStoreResetAuthority(
        options.runtime,
        { acquiredViaHandoff: false },
        {
          path: paths.storeDbPath,
          namespace: 'store-reset-operator',
          storeFormat: options.storeFormat,
          build: options.build,
        },
      );
      let resumed: BackendStoreResetIncident | null;
      let published: BackendStoreResetIncident | undefined;
      const releaseReset = acquireStoreResetLock(options.runtime, paths);
      try {
        resumed = resumeInterruptedBackendStoreResetIncident(options.runtime, authority, {
          path: paths.storeDbPath,
          storeFormat: options.storeFormat,
        });
        published = publishBackendStoreResetIncident(options.runtime, authority, {
          path: paths.storeDbPath,
          storeFormat: options.storeFormat,
        });
      } finally {
        releaseReset();
      }

      const db = openOrResetBackendStoreDb(options.runtime, authority, {
        path: paths.storeDbPath,
        storeFormat: options.storeFormat,
      });
      db.close();
      return {
        target: 'gen2',
        flavor: options.runtime.flavor,
        baseDir: paths.baseDir,
        storeDbPath: paths.storeDbPath,
        incident: resumed ?? published ?? null,
        resumed: resumed !== null,
      };
    } finally {
      maintenance.release();
    }
  } finally {
    adoption.release();
  }
}

/**
 * Documented exception to the CLI policy that mutating commands go through
 * IPC: store reset must remain reachable while the daemon refuses to boot.
 */
export async function discardStoreReset(options: StoreResetDiscardOptions): Promise<StoreResetDiscardResult> {
  if (options.target === 'legacy') {
    throw documentedCoralSetupError({
      code: 'legacy_foreign_generation',
      operation: 'discard',
      legacyPath: options.runtime.paths.coral.generation.legacyDataRoot,
      version: null,
      flavor: options.runtime.flavor,
      baseDir: dirname(options.runtime.paths.coral.generation.root),
    });
  }

  const paths = resolveStoreResetTargetPaths(options.runtime, options.target);
  const socket = await (options.acquireSocketGuard ?? acquireStoreResetSocketGuard)(paths, options.runtime.flavor);
  try {
    return await discardGeneratedStore(options, paths);
  } finally {
    await socket.release();
  }
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
