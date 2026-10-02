import { describe, expect, it } from 'vitest';

import { canonicalizeCapabilityName, type KbCapabilityDescriptor } from '#src/kb/capability/contract.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';
import { KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import { createScope } from '#src/infra/disposable-scope.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';

function descriptor(raw: string, label = 'Vendor Cache'): KbCapabilityDescriptor {
  const name = canonicalizeCapabilityName(raw);
  return {
    name,
    label,
    namespace: name.startsWith('kb.') ? 'kb' : 'external',
  };
}

describe('KbCapabilityRegistry', () => {
  it('registers builtins and manifest declarations and unregisters only matching manifest declarations', () => {
    const registry = createCapabilityRegistry();
    const builtin = descriptor('kb.vector', 'Vector');
    const external = descriptor('vendor.cache');

    registry.registerBuiltin(builtin, createRuntimeBinding(KB_VECTOR_CAPABILITY));
    registry.registerManifest(external, 'vendor-provider');

    expect(
      registry
        .catalogView()
        .listDescriptors()
        .map((entry) => entry.name),
    ).toEqual(['kb.vector', 'vendor.cache']);
    expect(registry.unregisterManifest(external.name, 'other-provider')).toBe(false);
    expect(registry.unregisterManifest(external.name, 'vendor-provider')).toBe(true);
    expect(registry.catalogView().hasDescriptor(external.name)).toBe(false);
    expect(registry.unregisterManifest(builtin.name, 'vendor-provider')).toBe(false);
  });

  it('rejects duplicate capability names deterministically', () => {
    const registry = createCapabilityRegistry();
    const external = descriptor('vendor.cache');

    registry.registerManifest(external, 'first-provider');

    try {
      registry.registerManifest(external, 'second-provider');
      throw new Error('expected duplicate registration to throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'capability_name_occupied',
        context: { name: 'vendor.cache' },
      });
    }
  });

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

  it('separates declaration lifecycle from bound-value lifecycle and reports status', () => {
    const registry = createCapabilityRegistry();
    const cache = descriptor('vendor.cache');
    const scope = createScope();

    registry.registerManifest(cache, 'vendor-provider');

    expect(registry.runtimeView().status(cache.name)).toEqual({
      name: cache.name,
      namespace: 'external',
      declared: true,
      bound: false,
      declaredByManifest: 'vendor-provider',
    });

    registry.runtimeView().bind(cache.name, { read: () => 'cached' }, scope, 'vendor-provider');

    expect(registry.runtimeView().status(cache.name)).toEqual({
      name: cache.name,
      namespace: 'external',
      declared: true,
      bound: true,
      heldBy: 'vendor-provider',
      declaredByManifest: 'vendor-provider',
    });

    scope[Symbol.dispose]();

    expect(registry.runtimeView().status(cache.name)).toEqual({
      name: cache.name,
      namespace: 'external',
      declared: true,
      bound: false,
      declaredByManifest: 'vendor-provider',
    });
    expect(registry.catalogView().hasDescriptor(cache.name)).toBe(true);
  });
});
