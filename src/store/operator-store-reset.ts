import { basename, dirname, join, resolve } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { resolveRunningBundleDir, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import type { ForeignTargetValidator, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import { socketPathForRunDir } from '../infra/path/index.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { ACTIVE_STORE_SELECTION_VERSION } from './active-store-selection.js';
import {
  coordinateActiveStoreSelection,
  type ActiveStoreSelectionRecoveryOutcome,
} from './active-store-selection-coordination.js';
import {
  createBackendStoreResetAuthority,
  openOrResetBackendStoreDb,
  type BackendStoreResetIncident,
} from './backend-store-reset.js';
import {
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
  /** Present so the decision below is discriminated — a caller must not reach for incident fields on a handoff. */
  readonly kind: 'discarded';
  readonly target: 'gen2';
  readonly flavor: BuildFlavor;
  readonly baseDir: string;
  readonly storeDbPath: string;
  readonly incident: BackendStoreResetIncident | null;
  readonly resumed: boolean;
};

export type StoreResetDiscardDecision =
  | StoreResetDiscardResult
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget; readonly source: 'active-selection' };

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
      readonly currentBundleDir?: string;
      /**
       * Injected, never imported: the validator lives in the coordinator's handoff runner, and reaching for it
       * from `src/store` would invert the layering and pull coordinator, transport and every domain into one
       * import cycle. The caller that already sits above both supplies it.
       */
      readonly validateSelectedTarget: ForeignTargetValidator;
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
      uid: process.getuid?.() ?? 0,
    }),
  };
}

async function discardGeneratedStore(
  options: Extract<StoreResetDiscardOptions, { readonly target: 'gen2' }>,
  paths: StoreResetTargetPaths,
): Promise<StoreResetDiscardDecision> {
  const entrypoint = process.argv[1];
  const pluginRoot = entrypoint === undefined ? options.runtime.env.cwd() : dirname(dirname(resolve(entrypoint)));
  const currentBundleDir = options.currentBundleDir ?? resolveRunningBundleDir(pluginRoot);
  if (currentBundleDir === null) {
    throw documentedCoralSetupError({ code: 'startup_bundle_unresolvable', pluginRoot });
  }
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
  let recovery: ActiveStoreSelectionRecoveryOutcome = { incident: null, resumed: false };
  const selectionResult = await coordinateActiveStoreSelection(options.runtime, authority, {
    path: paths.storeDbPath,
    storeFormat: options.storeFormat,
    currentSelection: {
      version: ACTIVE_STORE_SELECTION_VERSION,
      manifest: options.build,
      bundleDir: currentBundleDir,
      activeStoreFingerprint: options.build.storeFormatFingerprint,
    },
    dependencies: {
      kind: 'operator',
      validateSelectedTarget: options.validateSelectedTarget,
      acquireStoreRecoveryLease: async () => {
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
        return maintenance;
      },
      openPreparedStore: (adoption) =>
        openOrResetBackendStoreDb(options.runtime, authority, adoption, {
          path: paths.storeDbPath,
          storeFormat: options.storeFormat,
        }),
      recordRecoveryOutcome: (outcome) => {
        recovery = outcome;
      },
    },
  });
  if (selectionResult.kind === 'handoff') {
    return { kind: 'handoff', target: selectionResult.target, source: 'active-selection' };
  }
  selectionResult.db.close();
  return {
    kind: 'discarded',
    target: 'gen2',
    flavor: options.runtime.flavor,
    baseDir: paths.baseDir,
    storeDbPath: paths.storeDbPath,
    incident: recovery.incident,
    resumed: recovery.resumed,
  };
}

/**
 * Destructive operator service used while the coordinator is deliberately
 * offline. It owns generation targeting and the socket → adoption →
 * maintenance → reset-lock acquisition order.
 */
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

  const paths = resolveStoreResetTargetPaths(options.runtime, options.target);
  const socket = await options.acquireSocketGuard(paths, options.runtime.flavor);
  try {
    return await discardGeneratedStore(options, paths);
  } finally {
    await socket.release();
  }
}
