import { basename, dirname, join, resolve } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { resolveRunningBundleDir, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import {
  discardCurrentStoreEpoch,
  epochDirectory,
  epochPath,
  resolveCurrentStoreEpoch,
  resolveCurrentStorePath,
  sweepStoreEpochs,
} from './epoch.js';
import type { StoreFormatDescription } from './format-fingerprint.js';
import { acquireGenerationAdoptionLock, resolveGenerationBoundaryPaths } from './generation-mutation-coordination.js';
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

export type StoreResetDiscardResult = {
  readonly kind: 'discarded';
  readonly target: 'gen2';
  readonly flavor: BuildFlavor;
  readonly baseDir: string;
  readonly storeDbPath: string;
  readonly previousEpoch: number;
  readonly currentEpoch: number;
};

export type StoreResetDiscardDecision = StoreResetDiscardResult;

export type StoreResetReleasePresentation =
  | { readonly kind: 'released'; readonly epoch: number; readonly target: 'gen2'; readonly flavor: BuildFlavor }
  | { readonly kind: 'current'; readonly epoch: number; readonly target: 'gen2'; readonly flavor: BuildFlavor }
  | { readonly kind: 'absent'; readonly epoch: number; readonly target: 'gen2'; readonly flavor: BuildFlavor }
  | {
      readonly kind: 'release-unproven';
      readonly epoch: number;
      readonly target: 'gen2';
      readonly flavor: BuildFlavor;
    };

type AcquireStoreResetSocketGuard = (paths: StoreResetTargetPaths, runtime: Runtime) => Promise<StoreResetSocketGuard>;

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
      storeDbPath: resolveCurrentStorePath(runtime),
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
  const socket = await options.acquireSocketGuard(paths, options.runtime);
  const adoption = await acquireGenerationAdoptionLock(options.runtime);
  try {
    const previousEpoch = resolveCurrentStoreEpoch(options.runtime.storage, paths.dbDir);
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
      storeDbPath: settled.path,
      previousEpoch,
      currentEpoch: settled.epoch,
    };
  } finally {
    adoption();
    await socket.release();
  }
}

export async function releaseStoreReset(options: {
  readonly target: StoreResetReleaseTarget;
  readonly runtime: Runtime;
  readonly epoch: number;
}): Promise<StoreResetReleasePresentation> {
  const paths = resolveStoreResetTargetPaths(options.runtime, 'gen2');
  const adoption = await acquireGenerationAdoptionLock(options.runtime);
  try {
    const base = { epoch: options.epoch, target: 'gen2' as const, flavor: options.runtime.flavor };
    const coordinate = options.epoch === 0 ? epochPath(paths.dbDir, 0) : epochDirectory(paths.dbDir, options.epoch);
    if (!options.runtime.storage.existsSync(coordinate)) {
      return { kind: 'absent', ...base };
    }
    const current = resolveCurrentStoreEpoch(options.runtime.storage, paths.dbDir);
    adoption.assertOwned();
    if (options.epoch === current) return { kind: 'current', ...base };
    const complete = sweepStoreEpochs(options.runtime, paths.dbDir, current, {
      releaseEpoch: options.epoch,
      assertOwned: adoption.assertOwned,
    });
    return { kind: complete ? 'released' : 'release-unproven', ...base };
  } finally {
    adoption();
  }
}
