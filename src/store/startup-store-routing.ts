import type { ForeignTargetValidator, InvalidTargetEvidence, ValidatedHandoffTarget } from '../infra/handoff-target.js';
import type { Runtime } from '../runtime/ports.js';
import {
  coordinateActiveStoreSelection,
  type ActiveStoreSelectionProtocolOptions,
} from './active-store-selection-coordination.js';
import { acquireBackendStoreWriterExclusion, type BackendStoreResetAuthority } from './backend-store-reset.js';
import type { Database } from './db.js';

const STARTUP_STORE_RESET_WRITER_EXCLUSION_TIMEOUT_MS = 5_000;

export type StartupBackendStoreRoutingResult =
  | { readonly kind: 'open'; readonly db: Database }
  | { readonly kind: 'handoff'; readonly target: ValidatedHandoffTarget; readonly source: 'active-selection' }
  | { readonly kind: 'reset-newer-invalid'; readonly evidence: InvalidTargetEvidence; readonly db: Database };

export type StartupActiveStoreSelectionOptions = Omit<ActiveStoreSelectionProtocolOptions, 'dependencies'> & {
  readonly dependencies?: never;
};

export type RouteOrOpenBackendStoreAtStartupInput = Readonly<{
  runtime: Runtime;
  authority: BackendStoreResetAuthority;
  options: StartupActiveStoreSelectionOptions;
  validateForeignTarget: ForeignTargetValidator;
}>;

export async function routeOrOpenBackendStoreAtStartup(
  input: RouteOrOpenBackendStoreAtStartupInput,
): Promise<StartupBackendStoreRoutingResult> {
  const result = await coordinateActiveStoreSelection(input.runtime, input.authority, {
    ...input.options,
    dependencies: {
      kind: 'startup',
      validateSelectedTarget: input.validateForeignTarget,
      acquireWriterExclusion: () =>
        acquireBackendStoreWriterExclusion(input.runtime, STARTUP_STORE_RESET_WRITER_EXCLUSION_TIMEOUT_MS),
    },
  });

  if (result.kind === 'handoff') {
    return { kind: 'handoff', target: result.target, source: 'active-selection' };
  }
  if (result.invalidTargetEvidence !== null) {
    return { kind: 'reset-newer-invalid', evidence: result.invalidTargetEvidence, db: result.db };
  }
  return { kind: 'open', db: result.db };
}
