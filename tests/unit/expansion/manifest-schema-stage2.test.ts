import { describe, expect, expectTypeOf, it } from 'vitest';
import { ZodError } from 'zod';

import { engineManifestSchema, parseEngineManifest } from '#src/expansion/manifest-schema.js';
import type { KbCapabilityName } from '#src/kb/capability/contract.js';

const roleDescriptor = {
  id: 'stage2-role',
  label: 'Stage 2 Role',
  tags: ['semantic'],
  phase: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  requires: ['vendor.cache'],
  provides: 'retrieval-source',
} as const;

const baseManifest = {
  id: 'stage2-engine',
  version: '0.0.0',
  specifier: '#tests/stage2-engine/expansion.js',
  tier: 'installed',
  description: 'Stage 2 engine manifest',
} as const;

describe('engine manifest schema Stage 2 capability surface', () => {
  it('accepts sibling provides collections', () => {
    const parsed = engineManifestSchema.parse({
      ...baseManifest,
      provides: {
        retrievalRoles: [roleDescriptor],
        capabilities: [{ name: 'vendor.cache', label: 'Vendor Cache' }],
      },
    });

    expect(parsed.provides?.retrievalRoles?.[0]?.label).toBe('Stage 2 Role');
    expect(parsed.provides?.capabilities?.[0]).toEqual({
      name: 'vendor.cache',
      label: 'Vendor Cache',
      namespace: 'external',
    });
  });

  it('rejects the Stage 1 flat provides array shape', () => {
    expect(() =>
      parseEngineManifest({
        ...baseManifest,
        provides: [roleDescriptor],
      }),
    ).toThrow(ZodError);
  });

  it('canonicalizes raw fills strings to branded capability names', () => {
    const parsed = parseEngineManifest({
      ...baseManifest,
      fills: ['vendor.cache'],
    });

    expect(parsed.fills).toEqual(['vendor.cache']);
    expectTypeOf(parsed.fills?.[0]).toMatchTypeOf<KbCapabilityName | undefined>();
  });

  it('canonicalizes onboarding require-binding strings to branded capability names', () => {
    const parsed = parseEngineManifest({
      ...baseManifest,
      onboarding: [{ kind: 'require-binding', binding: 'vendor.cache' }],
    });

    expect(parsed.onboarding?.[0]).toEqual({ kind: 'require-binding', binding: 'vendor.cache' });
    if (parsed.onboarding?.[0]?.kind === 'require-binding') {
      expectTypeOf(parsed.onboarding[0].binding).toMatchTypeOf<KbCapabilityName>();
    }
  });

  it('rejects external manifests that declare capabilities in the reserved kb namespace', () => {
    expect(() =>
      parseEngineManifest({
        ...baseManifest,
        provides: {
          capabilities: [{ name: 'kb.cache' }],
        },
      }),
    ).toThrow(ZodError);
  });
});
