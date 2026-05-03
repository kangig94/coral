import type { EngineManifest } from '#src/expansion/contract.js';
import { canonicalizeCapabilityName, type KbCapabilityDescriptor } from '#src/kb/capability/contract.js';

export const DUMMY_CACHE_CAPABILITY = canonicalizeCapabilityName('vendor.cache');

export const dummyCacheCapabilityDescriptor = {
  name: DUMMY_CACHE_CAPABILITY,
  label: 'Vendor Cache',
  typeTag: 'test-cache',
  namespace: 'external',
} as const satisfies KbCapabilityDescriptor;

export const dummyCapabilityProviderManifest = {
  id: 'dummy-capability-provider',
  version: '0.0.0',
  specifier: '#tests/fixtures/dummy-capability-engine/expansion.js',
  tier: 'installed',
  description: 'Dummy capability provider fixture.',
  fills: [DUMMY_CACHE_CAPABILITY],
  provides: { capabilities: [dummyCacheCapabilityDescriptor] },
} as const satisfies EngineManifest;

export const dummyCapabilityConsumerManifest = {
  id: 'dummy-capability-consumer',
  version: '0.0.0',
  specifier: '#tests/fixtures/dummy-capability-engine/expansion.js',
  tier: 'installed',
  description: 'Dummy capability consumer fixture.',
  onboarding: [{ kind: 'require-binding', binding: DUMMY_CACHE_CAPABILITY }],
} as const satisfies EngineManifest;
