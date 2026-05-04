import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { BUNDLED_ENGINES } from '#src/expansion/bundled.js';
import { engineManifestSchema, parseEngineManifest, parseEngineManifests } from '#src/expansion/manifest-schema.js';

const validDescriptor = {
  id: 'dummy',
  label: 'Dummy Test Role',
  tags: ['lexical'],
  phase: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  provides: 'retrieval-source',
} as const;

const validManifest = {
  id: 'dummy-engine',
  version: '0.0.0',
  specifier: '#tests/fixtures/dummy-retrieval-role/expansion.js',
  tier: 'installed',
  description: 'dummy engine',
  provides: { retrievalRoles: [validDescriptor] },
} as const;

describe('engine manifest schema ingress', () => {
  it('accepts valid provides descriptors', () => {
    expect(engineManifestSchema.parse(validManifest)).toEqual(validManifest);
    expect(parseEngineManifest(validManifest)).toEqual(validManifest);
  });

  it('rejects invalid descriptors in custom manifest ingress', () => {
    expect(() =>
      parseEngineManifest({
        ...validManifest,
        provides: {
          retrievalRoles: [
            {
              ...validDescriptor,
              phase: 'reranker',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('rejects invalid descriptors in bundled manifest ingress', () => {
    expect(() =>
      parseEngineManifests([
        {
          ...validManifest,
          tier: 'bundled',
          provides: {
            retrievalRoles: [
              {
                ...validDescriptor,
                supportsScopes: ['notes', 'invalid-scope'],
              },
            ],
          },
        },
      ]),
    ).toThrow();
  });

  it('accepts open capability names in descriptor requirements and rejects malformed names', () => {
    expect(
      engineManifestSchema.parse({
        ...validManifest,
        provides: {
          retrievalRoles: [
            {
              ...validDescriptor,
              requires: ['vendor.cache'],
            },
          ],
        },
      }).provides?.retrievalRoles?.[0]?.requires,
    ).toEqual(['vendor.cache']);

    try {
      engineManifestSchema.parse({
        ...validManifest,
        provides: {
          retrievalRoles: [
            {
              ...validDescriptor,
              requires: ['KB.UNKNOWN'],
            },
          ],
        },
      });
      throw new Error('expected engineManifestSchema.parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      const issuePaths = (error as ZodError).issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('provides.retrievalRoles.0.requires.0');
    }
  });

  it('rejects the Stage 1 flat provides array shape', () => {
    expect(() =>
      parseEngineManifest({
        ...validManifest,
        provides: [validDescriptor],
      }),
    ).toThrow();
  });

  it('rejects external manifest declarations in the reserved kb namespace', () => {
    expect(() =>
      parseEngineManifest({
        ...validManifest,
        provides: {
          capabilities: [{ name: 'kb.cache' }],
        },
      }),
    ).toThrow();
  });

  it('keeps the production bundled engine catalog parseable', () => {
    expect(parseEngineManifests(BUNDLED_ENGINES)).toEqual(BUNDLED_ENGINES);
  });
});
