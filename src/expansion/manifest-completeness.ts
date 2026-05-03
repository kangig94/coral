import type { KbCapabilityRegistry } from '../kb/capability/contract.js';
import type { RoleRegistry } from '../kb/search/contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { EngineManifest } from './contract.js';

export function validateManifestCompleteness(
  manifest: EngineManifest,
  roleRegistry: RoleRegistry,
  _capabilityRegistry?: KbCapabilityRegistry,
): void {
  const declared = new Set((manifest.provides?.retrievalRoles ?? []).map((descriptor) => descriptor.id));
  const registered = new Set(roleRegistry.list().map((record) => record.descriptor.id));
  const missing = [...declared].filter((id) => !registered.has(id));

  if (missing.length > 0) {
    throw documentedCoralSetupError('role_descriptor_unregistered', {
      expansion: manifest.id,
      missing: missing.join(', '),
    });
  }
}
