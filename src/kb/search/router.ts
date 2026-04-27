import type { FtsRetrieval, KbRuntime, VectorRetrieval } from '../contract.js';
import type { GraphRetrieval, GraphRetrievalResult, HybridFusion, RetrievalScope } from './contract.js';
import { createHybridFusion } from './hybrid.js';

export interface SearchRouter {
  text: FtsRetrieval;
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

/** Builds the KB search router with shared text, vector, graph, and hybrid retrieval roles. */
export function createRouter(runtime: KbRuntime, options: SearchRouterOptions = {}): SearchRouter {
  return {
    text: runtime.fts.read().read(),
    vector: runtime.vector.read().read(),
    graph: options.graph ?? new NullGraphRetrieval(),
    hybrid: createHybridFusion(),
  };
}
