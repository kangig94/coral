import { describe, expect, it } from 'vitest';

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
  provides: [validDescriptor],
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
        provides: [
          {
            ...validDescriptor,
            phase: 'reranker',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects invalid descriptors in bundled manifest ingress', () => {
    expect(() =>
      parseEngineManifests([
        {
          ...validManifest,
          tier: 'bundled',
          provides: [
            {
              ...validDescriptor,
              supportsScopes: ['notes', 'invalid-scope'],
            },
          ],
        },
      ]),
    ).toThrow();
  });

  it('keeps the production bundled engine catalog parseable', () => {
    expect(parseEngineManifests(BUNDLED_ENGINES)).toEqual(BUNDLED_ENGINES);
  });
});
