import type { KbRuntime } from '../contracts.js';
import type { KbSearchScope } from '../entry-types.js';
import type { VectorRetrievalHit, VectorRetrievalResult } from './contract.js';
import { createEmbeddingProvider } from './embedding.js';
import { createOramaBaseProjection } from './orama-backend.js';
import type { ResolvedVectorRoute } from './router.js';
import type { SearchResponseWarnings } from './text-retrieval.js';

export const EMPTY_VECTOR_RETRIEVAL_RESULT: VectorRetrievalResult = { hits: [] };

async function embedQueryForVectorSearch(rt: KbRuntime, rawQuery: string): Promise<number[] | null> {
  const provider = await createEmbeddingProvider(rt.runtimeDir);
  if (provider === null) {
    return null;
  }

  const queryVector = await provider.embedQuery(rawQuery);
  return Array.from(queryVector);
}

export async function searchExplicitVectorResults(
  rt: KbRuntime,
  rawQuery: string,
  topK: number,
  scope: KbSearchScope,
  vectorRoute: ResolvedVectorRoute,
  options: {
    allowNeedleFallbackToOrama: boolean;
  },
): Promise<{ hits: VectorRetrievalHit[]; responseWarnings: SearchResponseWarnings; fallbackToText: boolean }> {
  const responseWarnings: SearchResponseWarnings =
    vectorRoute.warning === undefined ? {} : { warning: vectorRoute.warning };
  let queryVector: number[] | null;
  try {
    queryVector = await embedQueryForVectorSearch(rt, rawQuery);
  } catch {
    return {
      hits: [],
      responseWarnings: {
        warning: responseWarnings.warning ?? 'KB vector query embedding is unavailable.',
      },
      fallbackToText: true,
    };
  }
  if (queryVector === null) {
    return {
      hits: [],
      responseWarnings: {
        warning: responseWarnings.warning ?? 'KB vector query embedding is unavailable.',
      },
      fallbackToText: true,
    };
  }

  try {
    return {
      hits: (await vectorRoute.retrieval.search(queryVector, topK, scope)).hits,
      responseWarnings,
      fallbackToText: false,
    };
  } catch {
    if (vectorRoute.backend === 'needle' && options.allowNeedleFallbackToOrama) {
      try {
        return {
          hits: (await createOramaBaseProjection(rt).search(queryVector, topK, scope)).hits,
          responseWarnings: {
            warning:
              responseWarnings.warning ??
              'KB needle search is unavailable; falling back to Orama cosine for this query.',
          },
          fallbackToText: false,
        };
      } catch {
        // Fall through to text fallback below.
      }
    }

    return {
      hits: [],
      responseWarnings: {
        warning: responseWarnings.warning ?? 'KB vector search is unavailable for this query.',
      },
      fallbackToText: true,
    };
  }
}
