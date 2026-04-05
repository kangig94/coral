import { describe, expect, it } from 'vitest';
import { consolidateEntityGraph, resolveCanonicalEntityId } from '../entity-consolidation.js';
import type { EntityConsolidationDelta } from '../entity-consolidation.js';
import type { EntityGraph } from '../types.js';

function emptyGraph(): EntityGraph {
  return {
    entityMeta: {},
    relationships: [],
  };
}

describe('entity-consolidation', () => {
  it('merges normalized and pluralized entities, exports aliases, and rewires relationships to canonical ids', () => {
    const existingGraph: EntityGraph = {
      entityMeta: {
        'cuda-runtime-api': {
          type: 'technology',
          description: 'The CUDA runtime API.',
          aliases: ['cuda'],
        },
        'gpu-device-memory': {
          type: 'component',
          description: 'GPU device memory buffers.',
        },
      },
      relationships: [
        {
          source: 'cuda',
          target: 'gpu-device-memory',
          type: 'enables',
          description: 'CUDA uses device memory.',
          evidence: ['note:1'],
        },
      ],
    };
    const delta: EntityConsolidationDelta = {
      entities: [
        {
          name: 'CUDA Runtime APIs',
          type: 'technology',
          description: 'The CUDA runtime API for runtime-side device work.',
          aliases: ['cuda-runtime-interface'],
        },
        {
          name: 'gpu-device-memories',
          type: 'component',
          description: 'GPU device memory allocations.',
        },
      ],
      relationships: [
        {
          source: 'cuda-runtime-interface',
          target: 'gpu-device-memories',
          type: 'enables',
          description: 'The runtime API manages device memory.',
          evidence: ['note:2', 'note:2', 'note:3'],
        },
      ],
    };

    const result = consolidateEntityGraph(existingGraph, delta);

    expect(result.canonicalGraph.entityMeta).toEqual({
      'cuda-runtime-api': {
        type: 'technology',
        description: 'The CUDA runtime API for runtime-side device work. The CUDA runtime API.',
        aliases: ['cuda', 'cuda-runtime-apis', 'cuda-runtime-interface'],
      },
      'gpu-device-memory': {
        type: 'component',
        description: 'GPU device memory allocations. GPU device memory buffers.',
        aliases: ['gpu-device-memories'],
      },
    });
    expect(result.canonicalGraph.relationships).toEqual([
      {
        source: 'cuda-runtime-api',
        target: 'gpu-device-memory',
        type: 'enables',
        description: 'The runtime API manages device memory. CUDA uses device memory.',
        evidence: ['note:1', 'note:2', 'note:3'],
      },
    ]);
    expect(result.replacementMap['cuda']).toBe('cuda-runtime-api');
    expect(result.replacementMap['cuda-runtime-apis']).toBe('cuda-runtime-api');
    expect(result.replacementMap['gpu-device-memories']).toBe('gpu-device-memory');
    expect(resolveCanonicalEntityId('CUDA_RUNTIME_APIS', result.replacementMap)).toBe('cuda-runtime-api');
  });

  it('preserves sparse but valid entities while dropping malformed entities and invalid relationships', () => {
    const result = consolidateEntityGraph(emptyGraph(), {
      entities: [
        {
          name: 'rare-entity',
          type: 'concept',
          description: 'A sparse but valid entity should survive.',
        },
        {
          name: 'bad entity',
          type: 'concept',
          description: '',
        },
        {
          name: 'bad@entity',
          type: 'concept',
          description: 'Invalid id syntax should be dropped.',
        },
        {
          name: 'invalid-type-entity',
          type: 'invalid-type' as never,
          description: 'Invalid types should be dropped.',
        },
      ],
      relationships: [
        {
          source: 'rare-entity',
          target: 'rare-entity',
          type: 'enables',
          description: 'Self loops should be dropped.',
          evidence: ['note:1'],
        },
        {
          source: 'rare-entity',
          target: 'missing-entity',
          type: 'enables',
          description: 'Relationships to missing endpoints should be dropped.',
          evidence: ['note:2'],
        },
      ],
    });

    expect(result.canonicalGraph.entityMeta).toEqual({
      'rare-entity': {
        type: 'concept',
        description: 'A sparse but valid entity should survive.',
      },
    });
    expect(result.canonicalGraph.relationships).toEqual([]);
    expect(result.replacementMap['rare-entity']).toBe('rare-entity');
  });

  it('folds duplicate canonical ids and canonical-vs-legacy alias conflicts into one deterministic replacement map', () => {
    const result = consolidateEntityGraph(
      {
        entityMeta: {
          'graphql-resolver': {
            type: 'component',
            description: 'A GraphQL resolver component.',
            aliases: ['resolver'],
          },
        },
        relationships: [
          {
            source: 'graphql-resolvers',
            target: 'resolver-caching',
            type: 'requires',
            description: 'Resolvers require caching.',
            evidence: ['note:1'],
          },
        ],
      },
      {
        entities: [
          {
            name: 'graphql-resolvers',
            type: 'component',
            description: 'GraphQL resolvers.',
            aliases: ['graphql-resolver'],
          },
          {
            name: 'resolver-caching',
            type: 'pattern',
            description: 'Caching resolvers.',
            aliases: ['resolver-cache'],
          },
        ],
        relationships: [
          {
            source: 'resolver',
            target: 'resolver-cache',
            type: 'requires',
            description: 'Legacy aliases should rewire cleanly.',
            evidence: ['note:2', 'note:2'],
          },
        ],
      },
    );

    expect(result.canonicalGraph.entityMeta).toEqual({
      'graphql-resolver': {
        type: 'component',
        description: 'A GraphQL resolver component. GraphQL resolvers.',
        aliases: ['graphql-resolvers', 'resolver'],
      },
      'resolver-caching': {
        type: 'pattern',
        description: 'Caching resolvers.',
        aliases: ['resolver-cache'],
      },
    });
    expect(result.canonicalGraph.relationships).toEqual([
      {
        source: 'graphql-resolver',
        target: 'resolver-caching',
        type: 'requires',
        description: 'Legacy aliases should rewire cleanly. Resolvers require caching.',
        evidence: ['note:1', 'note:2'],
      },
    ]);
    expect(result.replacementMap['graphql-resolvers']).toBe('graphql-resolver');
    expect(result.replacementMap['resolver']).toBe('graphql-resolver');
    expect(result.replacementMap['resolver-cache']).toBe('resolver-caching');
  });
});
