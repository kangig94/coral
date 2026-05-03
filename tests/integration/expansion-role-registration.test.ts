import { describe, expect, it } from 'vitest';

import { validateManifestCompleteness } from '#src/expansion/manifest-completeness.js';
import { createScope } from '#src/expansion/scope.js';
import { searchKb } from '#src/kb/ops/search.js';
import type { Backed, EmbeddingService } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import { KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import dummyExpansion from '#tests/fixtures/dummy-retrieval-role/expansion.js';
import dummyManifest from '#tests/fixtures/dummy-retrieval-role/manifest.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

describe('expansion retrieval role registration integration', () => {
  it('joins a manifest-declared external role into hybrid search after host registration', async () => {
    const { kb, makeHost } = createTestRuntime();
    kb.writeIndex({
      entries: {
        'note:dummy-test-role': {
          kind: 'note',
          slug: 'dummy-test-role',
          title: 'Dummy Test Role Hit',
          tags: ['dummy'],
          principles: [],
          source: [],
          createdAt: '2026-05-03',
          updatedAt: '2026-05-03',
        },
      },
      principles: {},
      entityMeta: {},
      relationships: [],
    });

    const bindingScope = createScope();
    const embedding: Backed<EmbeddingService> = {
      read: () => ({
        async embedDocuments(texts) {
          return texts.map(() => new Float32Array([0]));
        },
        async embedQuery() {
          return new Float32Array([0]);
        },
      }),
      consumer: { id: 'integration-embedding', kind: 'stateless', registrationKind: 'stateless' },
    };
    const vector: Backed<VectorRetrieval> = {
      read: () => ({
        async search() {
          return { hits: [] };
        },
      }),
      consumer: { id: 'integration-vector', kind: 'stateless', registrationKind: 'stateless' },
    };
    kb.capabilityRegistry.runtimeView().bind(KB_EMBEDDING_CAPABILITY, embedding, bindingScope, 'integration-embedding');
    kb.capabilityRegistry.runtimeView().bind(KB_VECTOR_CAPABILITY, vector, bindingScope, 'integration-vector');

    const expansionScope = createScope();
    const host = makeHost(dummyManifest, expansionScope);
    await dummyExpansion(host);
    validateManifestCompleteness(dummyManifest, kb.roleRegistry, kb.capabilityRegistry);

    const response = await searchKb(kb, 'dummy external role', 5, 'all', 'hybrid');
    const dummyResult = response.results.find((result) => result.note === 'dummy-test-role');

    expect(response.mode).toBe('hybrid');
    expect(dummyResult).toBeDefined();
    expect(dummyResult?.evidence).toContainEqual({
      roleId: 'dummy',
      label: 'Dummy Test Role',
      rank: 1,
      weight: 1,
      contribution: 1 / 61,
    });
    expect(kb.roleRegistry.list().some((record) => record.descriptor.id === 'dummy')).toBe(true);
  });
});
