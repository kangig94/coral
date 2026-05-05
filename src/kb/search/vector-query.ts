import type { Backed, KbRuntime } from '../contract.js';
import { KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY } from '../capability/constants.js';
import type { RetrievalRole, VectorRetrieval } from './contract.js';

const BUILTIN_VECTOR_ROLE_DESCRIPTOR = {
  id: 'vector',
  label: 'Vector (Semantic)',
  tags: ['semantic'],
  phase: 'retrieval-source',
  provides: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  requires: [KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY],
} as const satisfies RetrievalRole['descriptor'];

export function createBuiltinVectorRole(rt: KbRuntime): RetrievalRole {
  return {
    id: BUILTIN_VECTOR_ROLE_DESCRIPTOR.id,
    descriptor: BUILTIN_VECTOR_ROLE_DESCRIPTOR,
    async search(ctx) {
      const queryVector = Array.from(await ctx.embedding());
      return {
        hits: (
          await rt.capabilityRegistry
            .runtimeView()
            .read<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY)
            .read()
            .search(queryVector, ctx.topK, ctx.scope)
        ).hits,
      };
    },
  };
}
