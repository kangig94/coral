import type { KbRuntime } from '../contract.js';
import type { KbSearchScope } from '../entry-types.js';
import { serializeCoralSetupError } from '../../runtime/errors.js';
import type { RetrievalRole, VectorRetrievalHit, VectorRetrievalResult } from './contract.js';
import type { SearchResponseWarnings } from './text-retrieval.js';

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

type BuiltinVectorBindingName = (typeof BUILTIN_VECTOR_ROLE_DESCRIPTOR.requires)[number];

function isBuiltinVectorBindingName(binding: string): binding is BuiltinVectorBindingName {
  return BUILTIN_VECTOR_ROLE_DESCRIPTOR.requires.includes(binding as BuiltinVectorBindingName);
}

async function embedQueryForVectorSearch(rt: KbRuntime, rawQuery: string): Promise<number[]> {
  const embedding = rt.embedding.read().read();
  return Array.from(await embedding.embedQuery(rawQuery));
}

export async function searchExplicitVectorResults(
  rt: KbRuntime,
  rawQuery: string,
  topK: number,
  scope: KbSearchScope,
): Promise<{ hits: VectorRetrievalHit[]; responseWarnings: SearchResponseWarnings; fallbackToText: boolean }> {
  let queryVector: number[];
  try {
    queryVector = await embedQueryForVectorSearch(rt, rawQuery);
  } catch (error) {
    if (serializeCoralSetupError(error)?.code === 'binding_empty') {
      throw error;
    }
    return {
      hits: [],
      responseWarnings: {
        warning: 'KB vector query embedding is unavailable.',
      },
      fallbackToText: true,
    };
  }

  try {
    return {
      hits: (await rt.vector.read().read().search(queryVector, topK, scope)).hits,
      responseWarnings: {},
      fallbackToText: false,
    };
  } catch (error) {
    const setupError = serializeCoralSetupError(error);
    const binding = setupError?.context?.binding;
    if (setupError?.code === 'binding_empty' && typeof binding === 'string' && isBuiltinVectorBindingName(binding)) {
      throw error;
    }
    return {
      hits: [],
      responseWarnings: {
        warning: 'KB vector search is unavailable for this query.',
      },
      fallbackToText: true,
    };
  }
}

export function createBuiltinVectorRole(rt: KbRuntime): RetrievalRole {
  return {
    id: BUILTIN_VECTOR_ROLE_DESCRIPTOR.id,
    descriptor: BUILTIN_VECTOR_ROLE_DESCRIPTOR,
    async search(ctx) {
      const embedding = rt.embedding.read().read();
      const queryVector = Array.from(await embedding.embedQuery(ctx.rawQuery));
      return {
        hits: (await rt.vector.read().read().search(queryVector, ctx.topK, ctx.scope)).hits,
      };
    },
  };
}
