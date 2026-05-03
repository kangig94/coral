import type { KbRuntime } from '../contract.js';
import type { RetrievalRole, VectorRetrievalResult } from './contract.js';

export const EMPTY_VECTOR_RETRIEVAL_RESULT: VectorRetrievalResult = { hits: [] };

const BUILTIN_VECTOR_ROLE_DESCRIPTOR = {
  id: 'vector',
  label: 'Vector (Semantic)',
  tags: ['semantic'],
  phase: 'retrieval-source',
  provides: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  requires: ['kb.embedding', 'kb.vector'],
} as const satisfies RetrievalRole['descriptor'];

export function createBuiltinVectorRole(rt: KbRuntime): RetrievalRole {
  return {
    id: BUILTIN_VECTOR_ROLE_DESCRIPTOR.id,
    descriptor: BUILTIN_VECTOR_ROLE_DESCRIPTOR,
    async search(ctx) {
      const queryVector = Array.from(await ctx.embedding());
      return {
        hits: (await rt.vector.read().read().search(queryVector, ctx.topK, ctx.scope)).hits,
      };
    },
  };
}
