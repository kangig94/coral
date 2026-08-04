import { createUseCurrentBackendRouting, type BackendRoutingResult } from '../infra/backend-routing.js';
import type { ForeignTargetValidator } from '../infra/handoff-target.js';
import { classifyActiveStoreSelection, type ActiveStoreSelection } from './active-store-selection.js';

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
