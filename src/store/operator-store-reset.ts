import { basename, dirname, join, resolve } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { resolveRunningBundleDir, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import {
  discardCurrentStoreEpoch,
  resolveCurrentStore,
  resolveCurrentStoreEpoch,
  sweepStoreEpochs,
  type StoreEpoch,
} from './epoch.js';
import type { StoreFormatDescription } from './format-fingerprint.js';
import { acquireGenerationAdoptionLock, resolveGenerationBoundaryPaths } from './generation-mutation-coordination.js';
import { observeStorePath } from './path-observation.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from './reset-incident.js';

export type StoreResetTarget = 'legacy' | 'gen2';
export type StoreResetReleaseTarget = 'current' | 'gen2';

export type StoreResetTargetPaths = {
  readonly target: StoreResetTarget;
  readonly baseDir: string;
  readonly storeDbPath: string;
  readonly dbDir: string;
  readonly quarantineRoot: string;
  readonly socketPath: string;
};

export interface StoreResetSocketGuard {
  release(): Promise<void>;
}

export type StoreResetSocketGuardOperation =
  | Readonly<{ kind: 'discard'; target: 'gen2' }>
  | Readonly<{
      kind: 'release';
      target: StoreResetReleaseTarget;
      epoch: StoreEpoch;
    }>;

export type StoreResetDiscardResult = {
  readonly kind: 'discarded';
  readonly target: 'gen2';
  readonly flavor: BuildFlavor;
  readonly baseDir: string;
  readonly storeDbPath: string;
  readonly previousEpoch: StoreEpoch | null;
  readonly currentEpoch: StoreEpoch;
};

export type StoreResetDiscardDecision = StoreResetDiscardResult;

export type StoreResetReleasePresentation =
  | { readonly kind: 'released'; readonly epoch: StoreEpoch; readonly target: 'gen2'; readonly flavor: BuildFlavor }
  | { readonly kind: 'current'; readonly epoch: StoreEpoch; readonly target: 'gen2'; readonly flavor: BuildFlavor }
  | { readonly kind: 'absent'; readonly epoch: StoreEpoch; readonly target: 'gen2'; readonly flavor: BuildFlavor }
  | {
      readonly kind:
        | 'release-metadata-unobservable'
        | 'release-holder-live'
        | 'release-holder-unobservable'
        | 'release-holder-cleanup-failed'
        | 'release-deletion-failed'
        | 'release-lock-release-failed'
        | 'release-pre-deletion-durability-sync-failed'
        | 'release-absent-durability-sync-failed'
        | 'release-durability-sync-failed';
      readonly epoch: StoreEpoch;
      readonly target: 'gen2';
      readonly flavor: BuildFlavor;
    };

export type AcquireStoreResetSocketGuard = (
  paths: StoreResetTargetPaths,
  runtime: Runtime,
  operation: StoreResetSocketGuardOperation,
) => Promise<StoreResetSocketGuard>;

export type StoreResetDiscardOptions =
  | { readonly target: 'legacy'; readonly runtime: Runtime }
  | {
      readonly target: 'gen2';
      readonly runtime: Runtime;
      readonly build: StrictBundleManifest;
      readonly storeFormat: StoreFormatDescription;
      readonly acquireSocketGuard: AcquireStoreResetSocketGuard;
      readonly currentBundleDir?: string;
    };

export function resolveStoreResetTargetPaths(
  runtime: Pick<Runtime, 'env' | 'flavor' | 'paths' | 'storage'>,
  target: StoreResetTarget,
): StoreResetTargetPaths {
  const boundary = resolveGenerationBoundaryPaths(runtime);
  if (target === 'gen2') {
    const { dbDir } = runtime.paths.coral.store;
    return {
      target,
      baseDir: boundary.baseDir,
      storeDbPath: resolveCurrentStore(runtime).path,
      dbDir,
      quarantineRoot: join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY),
      socketPath: runtime.paths.coral.coordinator.socketPath,
    };
  }

  const storeDbPath = join(boundary.legacyFlavorRoot, 'store', 'store.db');
  const runDirectory = join(boundary.baseDir, basename(runtime.paths.coral.coordinator.runDir));
  return {
    target,
    baseDir: boundary.baseDir,
    storeDbPath,
    dbDir: dirname(storeDbPath),
    quarantineRoot: join(dirname(storeDbPath), STORE_RESET_QUARANTINE_DIRECTORY),
    socketPath: socketPathForRunDir(runDirectory, runtime.flavor, { platform: runtime.env.platform() }),
  };
}

export function discardStoreReset(
  options: Extract<StoreResetDiscardOptions, { readonly target: 'gen2' }>,
): Promise<StoreResetDiscardDecision>;
export function discardStoreReset(
  options: Extract<StoreResetDiscardOptions, { readonly target: 'legacy' }>,
): Promise<never>;
export async function discardStoreReset(options: StoreResetDiscardOptions): Promise<StoreResetDiscardDecision> {
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

  const entrypoint = process.argv[1];
  const pluginRoot = entrypoint === undefined ? options.runtime.env.cwd() : dirname(dirname(resolve(entrypoint)));
  if ((options.currentBundleDir ?? resolveRunningBundleDir(pluginRoot)) === null) {
    throw documentedCoralSetupError({ code: 'startup_bundle_unresolvable', pluginRoot });
  }
  const paths = resolveStoreResetTargetPaths(options.runtime, 'gen2');
  const socket = await options.acquireSocketGuard(paths, options.runtime, { kind: 'discard', target: 'gen2' });
  try {
    const adoption = await acquireGenerationAdoptionLock(options.runtime);
    try {
      const previousEpoch =
        observeStorePath(options.runtime.storage, paths.dbDir) === 'present'
          ? resolveCurrentStoreEpoch(options.runtime.storage, paths.dbDir)
          : null;
      const settled = discardCurrentStoreEpoch(options.runtime, {
        storeFormat: options.storeFormat,
        build: options.build,
      });
      settled.db.close();
      return {
        kind: 'discarded',
        target: 'gen2',
        flavor: options.runtime.flavor,
        baseDir: paths.baseDir,
        storeDbPath: settled.store.path,
        previousEpoch,
        currentEpoch: settled.store.epoch,
      };
    } finally {
      adoption();
    }
  } finally {
    await socket.release();
  }
}

export async function releaseStoreReset(options: {
  readonly target: StoreResetReleaseTarget;
  readonly runtime: Runtime;
  readonly epoch: StoreEpoch;
  readonly acquireSocketGuard: AcquireStoreResetSocketGuard;
}): Promise<StoreResetReleasePresentation> {
  const paths = resolveStoreResetTargetPaths(options.runtime, 'gen2');
  const socket = await options.acquireSocketGuard(paths, options.runtime, {
    kind: 'release',
    target: options.target,
    epoch: options.epoch,
  });
  try {
    const adoption = await acquireGenerationAdoptionLock(options.runtime);
    try {
      const base = { epoch: options.epoch, target: 'gen2' as const, flavor: options.runtime.flavor };
      const result = sweepStoreEpochs(options.runtime, paths.dbDir, null, {
        releaseEpoch: options.epoch,
        assertOwned: adoption.assertOwned,
      });
      if (result === 'absent') return { kind: 'absent', ...base };
      if (result === 'current') return { kind: 'current', ...base };
      if (result === 'complete') return { kind: 'released', ...base };
      if (result === 'unobservable-metadata') return { kind: 'release-metadata-unobservable', ...base };
      if (result === 'live-holder') return { kind: 'release-holder-live', ...base };
      if (result === 'unobservable-holder') return { kind: 'release-holder-unobservable', ...base };
      if (result === 'holder-cleanup-failed') return { kind: 'release-holder-cleanup-failed', ...base };
      if (result === 'deletion-failed') return { kind: 'release-deletion-failed', ...base };
      if (result === 'lock-release-failed') return { kind: 'release-lock-release-failed', ...base };
      if (result === 'pre-deletion-durability-sync-failed') {
        return { kind: 'release-pre-deletion-durability-sync-failed', ...base };
      }
      if (result === 'absent-durability-sync-failed') {
        return { kind: 'release-absent-durability-sync-failed', ...base };
      }
      return { kind: 'release-durability-sync-failed', ...base };
    } finally {
      adoption();
    }
  } finally {
    await socket.release();
  }
}
