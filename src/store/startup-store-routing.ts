import { createUseCurrentBackendRouting, type BackendRoutingResult } from '../infra/backend-routing.js';
import type { ForeignTargetValidator } from '../infra/handoff-target.js';
import { classifyActiveStoreSelection, type ActiveStoreSelection } from './active-store-selection.js';
import {
  coordinateActiveStoreSelection,
  type ActiveStoreSelectionProtocolOptions,
  type BackendStoreResetAuthority,
} from './backend-store-reset.js';
import type { Database } from './db.js';
import type { Runtime } from '../runtime/ports.js';

export type ActiveStoreSelectionRoutingInput = Readonly<{
  selected: ActiveStoreSelection;
  current: ActiveStoreSelection;
  validateForeignTarget: ForeignTargetValidator;
}>;

export function routeActiveStoreSelection(input: ActiveStoreSelectionRoutingInput): BackendRoutingResult {
  const relation = classifyActiveStoreSelection(input.selected, input.current);
  if (relation !== 'selected-newer') {
    return createUseCurrentBackendRouting({ source: 'current-build' });
  }

  const validation = input.validateForeignTarget(input.selected.bundleDir, input.selected.manifest);
  if (validation.kind === 'invalid') {
    return { kind: 'reset-newer-invalid', evidence: validation.evidence };
  }
  return { kind: 'handoff', target: validation.target, source: 'active-selection' };
}

export type StartupBackendStoreRoutingResult =
  | { readonly kind: 'open'; readonly db: Database }
  | Extract<BackendRoutingResult, { readonly kind: 'handoff' }>
  | (Extract<BackendRoutingResult, { readonly kind: 'reset-newer-invalid' }> & { readonly db: Database });

export type RouteOrOpenBackendStoreAtStartupInput = Readonly<{
  runtime: Runtime;
  authority: BackendStoreResetAuthority;
  options: ActiveStoreSelectionProtocolOptions;
  validateForeignTarget: ForeignTargetValidator;
}>;

export async function routeOrOpenBackendStoreAtStartup(
  input: RouteOrOpenBackendStoreAtStartupInput,
): Promise<StartupBackendStoreRoutingResult> {
  let invalidTargetEvidence:
    | Extract<BackendRoutingResult, { readonly kind: 'reset-newer-invalid' }>['evidence']
    | null = null;
  const dependencies = input.options.dependencies;
  const result = await coordinateActiveStoreSelection(input.runtime, input.authority, {
    ...input.options,
    dependencies: {
      ...dependencies,
      validateSelectedTarget: input.validateForeignTarget,
      recordInvalidTargetRecovery: (evidence) => {
        invalidTargetEvidence = evidence;
        dependencies?.recordInvalidTargetRecovery?.(evidence);
      },
    },
  });

  if (result.kind === 'handoff') {
    return { kind: 'handoff', target: result.target, source: 'active-selection' };
  }
  if (invalidTargetEvidence !== null) {
    return { kind: 'reset-newer-invalid', evidence: invalidTargetEvidence, db: result.db };
  }
  return { kind: 'open', db: result.db };
}
