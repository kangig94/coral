import type { ForeignTargetValidator, InvalidTargetEvidence, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { Runtime } from '../runtime/ports.js';
import {
  coordinateActiveStoreSelection,
  type ActiveStoreSelectionProtocolOptions,
} from './active-store-selection-coordination.js';
import type { Database } from './db.js';
import type { StoreEpoch } from './epoch.js';

type OpenedStartupBackendStore = Readonly<{
  db: Database;
  epoch: StoreEpoch;
  path: string;
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
      epoch: result.epoch,
      path: result.path,
    };
  }
  return { kind: 'open', db: result.db, epoch: result.epoch, path: result.path };
}
