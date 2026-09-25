import type { ForeignTargetValidator, InvalidTargetEvidence, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { Runtime } from '../runtime/ports.js';
import {
  coordinateActiveStoreSelection,
  type ActiveStoreSelectionProtocolOptions,
} from './active-store-selection-coordination.js';
import { classifyStoreFile, type Database } from './db.js';
import {
  observeResolvedStoreEpoch,
  observeResolvedStoreEpochKey,
  openExactStoreEpoch,
  resolveProvenStoreEpochAtPath,
  type ExactStoreEpochOpen,
  type ResolvedStoreEpoch,
  type StoreEpochOptions,
} from './epoch.js';

type OpenedStartupBackendStore = Readonly<{
  db: Database;
  store: ResolvedStoreEpoch;
}>;

export type StartupBackendStoreRoutingResult =
  | ({ readonly kind: 'open' } & OpenedStartupBackendStore)
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget; readonly source: 'active-selection' }
  | ({ readonly kind: 'reset-newer-invalid'; readonly evidence: InvalidTargetEvidence } & OpenedStartupBackendStore);

export type StartupActiveStoreSelectionOptions = Omit<ActiveStoreSelectionProtocolOptions, 'dependencies'> & {
  readonly dependencies?: never;
};

export type RouteOrOpenBackendStoreAtStartupInput = Readonly<{
  runtime: Runtime;
  options: StartupActiveStoreSelectionOptions;
  validateForeignTarget: ForeignTargetValidator;
}>;

export type CommittedBackendStorePreparation =
  | Readonly<{ kind: 'prepared'; store: ResolvedStoreEpoch }>
  | Readonly<{ kind: 'holding'; reason: 'epoch-unproven' | 'format-incompatible' | 'probe-failed' }>;

export function prepareCommittedBackendStoreAtStartup(
  runtime: Runtime,
  options: Omit<StoreEpochOptions, 'path'> & { readonly path?: never },
  epochKey: string,
): CommittedBackendStorePreparation {
  const expected = observeResolvedStoreEpoch(runtime, epochKey);
  if (expected === undefined) return { kind: 'holding', reason: 'epoch-unproven' };
  try {
    if (
      runtime.storage.realpathSync(runtime.paths.coral.store.dbDir) !==
      (expected.canonicalStoreRoot ?? expected.storeRoot)
    ) {
      return { kind: 'holding', reason: 'epoch-unproven' };
    }
    const proven = resolveProvenStoreEpochAtPath(runtime.storage, expected.storeRoot, expected.path);
    const addressed =
      proven === null
        ? null
        : {
            ...proven,
            ...(expected.lineageKey === undefined ? {} : { lineageKey: expected.lineageKey }),
            ...(expected.canonicalStoreRoot === undefined ? {} : { canonicalStoreRoot: expected.canonicalStoreRoot }),
          };
    if (addressed === null || observeResolvedStoreEpochKey(runtime, addressed) !== epochKey) {
      return { kind: 'holding', reason: 'epoch-unproven' };
    }
    const classification = classifyStoreFile(addressed.path, runtime.storage, options.storeFormat);
    return classification.kind === 'compatible'
      ? { kind: 'prepared', store: addressed }
      : { kind: 'holding', reason: 'format-incompatible' };
  } catch {
    return { kind: 'holding', reason: 'probe-failed' };
  }
}

export function openCommittedBackendStoreAtStartup(
  runtime: Runtime,
  options: Omit<StoreEpochOptions, 'path'> & { readonly path?: never },
  expected: ResolvedStoreEpoch,
): ExactStoreEpochOpen {
  return openExactStoreEpoch(runtime, options, expected);
}

export async function routeOrOpenBackendStoreAtStartup(
  input: RouteOrOpenBackendStoreAtStartupInput,
): Promise<StartupBackendStoreRoutingResult> {
  const result = await coordinateActiveStoreSelection(input.runtime, {
    ...input.options,
    dependencies: {
      kind: 'startup',
      validateSelectedTarget: input.validateForeignTarget,
    },
  });

  if (result.kind === 'handoff') {
    return { kind: 'handoff', target: result.target, source: 'active-selection' };
  }
  if (result.invalidTargetEvidence !== null) {
    return {
      kind: 'reset-newer-invalid',
      evidence: result.invalidTargetEvidence,
      db: result.db,
      store: result.store,
    };
  }
  return { kind: 'open', db: result.db, store: result.store };
}
