import { describe, expect, it } from 'vitest';
import {
  consolidateEntityGraph,
  resolveCanonicalEntityId,
  type EntityConsolidationDelta,
} from '#src/kb/curate/entity-consolidation.js';
import type { EntityGraph } from '#src/kb/entry-types.js';

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
});
