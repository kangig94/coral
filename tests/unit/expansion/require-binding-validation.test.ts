import { describe, expect, it } from 'vitest';

import { validateRequireBindings } from '#src/expansion/require-binding-validation.js';
import type { EngineManifest } from '#src/expansion/contract.js';
import {
  canonicalizeCapabilityName,
  type KbCapabilityDescriptor,
  type KbCapabilityName,
} from '#src/kb/capability/contract.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';

const VENDOR_CACHE = canonicalizeCapabilityName('vendor.cache');
const VENDOR_QUEUE = canonicalizeCapabilityName('vendor.queue');

const cacheDescriptor = {
  name: VENDOR_CACHE,
  label: 'Vendor Cache',
  namespace: 'external',
} as const satisfies KbCapabilityDescriptor;

function consumer(binding: KbCapabilityName = VENDOR_CACHE): EngineManifest {
  return {
    id: 'consumer',
    version: '0.0.0',
    specifier: '#tests/consumer/expansion.js',
    tier: 'installed',
    description: 'consumer',
    onboarding: [{ kind: 'require-binding', binding }],
  };
}

describe('require-binding validation', () => {
  it('accepts require-binding for a registered capability', () => {
    const registry = createCapabilityRegistry();
    registry.registerManifest(cacheDescriptor, 'provider');

    expect(() => validateRequireBindings([consumer()], registry.catalogView())).not.toThrow();
  });

  it('rejects unregistered require-binding capabilities', () => {
    const registry = createCapabilityRegistry();

    try {
      validateRequireBindings([consumer(VENDOR_QUEUE)], registry.catalogView());
      throw new Error('expected unknown require-binding to throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'require_binding_unknown',
        context: {
          expansion: 'consumer',
          name: 'vendor.queue',
        },
      });
    }
  });

  it('validates catalog declaration independently of bound state', () => {
    const registry = createCapabilityRegistry();
    registry.registerManifest(cacheDescriptor, 'provider');

    expect(registry.runtimeView().status(VENDOR_CACHE)).toMatchObject({ declared: true, bound: false });
    expect(() => validateRequireBindings([consumer()], registry.catalogView())).not.toThrow();
  });
});
