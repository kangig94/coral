import type { KbCapabilityCatalogView } from '../kb/capability/contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { EngineManifest } from './contract.js';

export function validateRequireBindings(
  manifests: readonly EngineManifest[],
  catalog: KbCapabilityCatalogView,
): void {
  for (const manifest of manifests) {
    for (const step of manifest.onboarding ?? []) {
      if (step.kind !== 'require-binding') {
        continue;
      }
      if (!catalog.hasDescriptor(step.binding)) {
        throw documentedCoralSetupError({
          code: 'require_binding_unknown',
          expansion: manifest.id,
          name: step.binding,
        });
      }
    }
  }
}
