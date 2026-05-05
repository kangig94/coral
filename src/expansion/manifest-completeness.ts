import type { KbCapabilityRegistry } from '../kb/capability/contract.js';
import type { RoleRegistry } from '../kb/search/contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { EngineManifest } from './contract.js';

export function validateManifestCompleteness(
  manifest: EngineManifest,
  roleRegistry: RoleRegistry,
  _capabilityRegistry?: KbCapabilityRegistry,
): void {
  const registered = new Set<string>();
  for (const record of roleRegistry.list()) {
    registered.add(record.descriptor.id);
  }

  const declared = new Set<string>();
  const missing: string[] = [];
  for (const descriptor of manifest.provides?.retrievalRoles ?? []) {
    if (declared.has(descriptor.id)) {
      continue;
    }
    declared.add(descriptor.id);
    if (!registered.has(descriptor.id)) {
      missing.push(descriptor.id);
    }
  }

  if (missing.length > 0) {
    throw documentedCoralSetupError('role_descriptor_unregistered', {
      expansion: manifest.id,
      missing: missing.join(', '),
    });
  }
}
