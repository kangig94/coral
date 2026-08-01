import { basename, dirname, join } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { acquireDirectoryLockSync, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import {
  createBackendStoreResetAuthority,
  openOrResetBackendStoreDb,
  publishBackendStoreResetIncident,
  resumeInterruptedBackendStoreResetIncident,
  type BackendStoreResetIncident,
} from './backend-store-reset.js';
import {
  acquireGenerationAdoptionLease,
  acquireGenerationMaintenanceLease,
  resolveGenerationBoundaryPaths,
  type GenerationMaintenanceLease,
} from './generation-mutation-coordination.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from './reset-incident.js';
import type { StoreFormatDescription } from './format-fingerprint.js';

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

export type StoreResetDiscardOptions =
  | {
      readonly target: 'legacy';
      readonly runtime: Runtime;
    }
  | {
      readonly target: 'gen2';
      readonly runtime: Runtime;
      readonly build: StrictBundleManifest;
      readonly storeFormat: StoreFormatDescription;
      readonly acquireSocketGuard: AcquireStoreResetSocketGuard;
      readonly maintenanceTimeoutMs?: number;
    };

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

function acquireStoreResetLock(runtime: Runtime, paths: StoreResetTargetPaths): () => void {
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
 * Destructive operator service used while the coordinator is deliberately
 * offline. It owns generation targeting and the socket → adoption →
 * maintenance → reset-lock acquisition order.
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
  const socket = await options.acquireSocketGuard(paths, options.runtime.flavor);
  try {
    return await discardGeneratedStore(options, paths);
  } finally {
    await socket.release();
  }
}
