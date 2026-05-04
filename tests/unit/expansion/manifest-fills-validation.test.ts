import { describe, expect, it } from 'vitest';

import { initializeCapabilityCatalog, validateManifestFills } from '#src/expansion/manifest-fills-validation.js';
import type { EngineManifest } from '#src/expansion/contract.js';
import { canonicalizeCapabilityName, type KbCapabilityDescriptor } from '#src/kb/capability/contract.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';

const VENDOR_CACHE = canonicalizeCapabilityName('vendor.cache');
const VENDOR_QUEUE = canonicalizeCapabilityName('vendor.queue');

const cacheDescriptor = {
  name: VENDOR_CACHE,
  label: 'Vendor Cache',
  namespace: 'external',
} as const satisfies KbCapabilityDescriptor;

function manifest(overrides: Partial<EngineManifest> = {}): EngineManifest {
  return {
    id: 'consumer',
    version: '0.0.0',
    specifier: '#tests/consumer/expansion.js',
    tier: 'installed',
    description: 'consumer',
    ...overrides,
  };
}

describe('manifest fills validation', () => {
  it('accepts fills declared by a different manifest in the same two-pass catalog', () => {
    const registry = createCapabilityRegistry();
    const provider = manifest({
      id: 'provider',
      provides: { capabilities: [cacheDescriptor] },
    });
    const consumer = manifest({
      id: 'consumer',
      fills: [VENDOR_CACHE],
    });

    expect(() => initializeCapabilityCatalog(registry, [provider, consumer], [])).not.toThrow();
  });

  it('accepts fills that are already registered', () => {
    const registry = createCapabilityRegistry();

    registry.registerManifest(cacheDescriptor, 'provider');

    expect(() => validateManifestFills(manifest({ fills: [VENDOR_CACHE] }), registry.catalogView())).not.toThrow();
  });

  it('accepts fills declared by the same manifest', () => {
    const registry = createCapabilityRegistry();
    const provider = manifest({
      id: 'provider',
      fills: [VENDOR_CACHE],
      provides: { capabilities: [cacheDescriptor] },
    });

    expect(() => initializeCapabilityCatalog(registry, [provider], [])).not.toThrow();
  });

  it('rejects unknown fills as capability_fill_unknown', () => {
    const registry = createCapabilityRegistry();

    try {
      validateManifestFills(manifest({ fills: [VENDOR_QUEUE] }), registry.catalogView());
      throw new Error('expected unknown fill to throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'capability_fill_unknown',
        context: {
          expansion: 'consumer',
          name: 'vendor.queue',
        },
      });
    }
  });
});
