import type { KbRuntime } from '../contract.js';
import type {
  GraphRetrieval,
  GraphRetrievalResult,
  HybridFusion,
  RetrievalScope,
  VectorRetrieval,
} from './contract.js';
import { createHybridFusion } from './hybrid.js';

export interface SearchRouter {
  vector: VectorRetrieval;
  graph: GraphRetrieval;
  hybrid: HybridFusion;
}

export interface SearchRouterOptions {
  graph?: GraphRetrieval;
}

class NullGraphRetrieval implements GraphRetrieval {
  async search(query: string, scope?: RetrievalScope): Promise<GraphRetrievalResult> {
    void query;
    void scope;
    return { hits: [] };
  }
}

/**
 * Builds the KB search router with shared vector, graph, and hybrid retrieval roles.
 * The vector role is read lazily — callers in pure-text/graph paths never trigger
 * `kb.vector.read()` if they don't invoke `router.vector.search(...)`.
 */
export function createRouter(runtime: KbRuntime, options: SearchRouterOptions = {}): SearchRouter {
  return {
    vector: {
      search(embedding, topK, scope) {
        return runtime.vector.read().read().search(embedding, topK, scope);
      },
    },
    graph: options.graph ?? new NullGraphRetrieval(),
    hybrid: createHybridFusion(),
  };
}
