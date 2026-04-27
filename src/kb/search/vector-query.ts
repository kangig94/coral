import type { KbRuntime } from '../contract.js';
import type { KbSearchScope } from '../entry-types.js';
import { CoralSetupError } from '../../runtime/errors.js';
import type { VectorRetrievalHit, VectorRetrievalResult } from './contract.js';
import type { SearchResponseWarnings } from './text-retrieval.js';

export const EMPTY_VECTOR_RETRIEVAL_RESULT: VectorRetrievalResult = { hits: [] };

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
    if (error instanceof CoralSetupError && error.code === 'binding_empty') {
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
      hits: (await rt.vector.read().read().read(queryVector, topK, scope)).hits,
      responseWarnings: {},
      fallbackToText: false,
    };
  } catch {
    return {
      hits: [],
      responseWarnings: {
        warning: 'KB vector search is unavailable for this query.',
      },
      fallbackToText: true,
    };
  }
}
