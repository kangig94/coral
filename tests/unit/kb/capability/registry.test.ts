import { describe, expect, it } from 'vitest';

import { canonicalizeCapabilityName, type KbCapabilityDescriptor } from '#src/kb/capability/contract.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';

function descriptor(raw: string, label = 'Vendor Cache'): KbCapabilityDescriptor {
  const name = canonicalizeCapabilityName(raw);
  return {
    name,
    label,
    namespace: name.startsWith('kb.') ? 'kb' : 'external',
  };
}

describe('KbCapabilityRegistry', () => {
  it('rejects external manifest declarations in the reserved kb namespace', () => {
    const registry = createCapabilityRegistry();

    try {
      registry.registerManifest(descriptor('kb.cache'), 'external-provider');
      throw new Error('expected reserved namespace declaration to throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'capability_namespace_reserved',
        context: { name: 'kb.cache', declaredByManifest: 'external-provider' },
      });
    }
  });
});
