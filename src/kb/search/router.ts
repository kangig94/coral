import type { KbRuntime } from '../contracts.js';
import type {
  GraphRetrieval,
  GraphRetrievalResult,
  HybridFusion,
  RetrievalScope,
  TextRetrieval,
  VectorRetrieval,
} from './contract.js';
import { createHybridFusion } from './hybrid.js';
import { createNeedleBackend } from './needle-backend.js';
import { createOramaBaseProjection } from './orama-backend.js';

export interface SearchRouter {
  text: TextRetrieval;
  vector: VectorRetrieval;
  graph: GraphRetrieval;
  hybrid: HybridFusion;
}

export interface SearchRouterOptions {
  graph?: GraphRetrieval;
}

export interface ResolvedVectorRoute {
  retrieval: VectorRetrieval;
  backend: 'orama' | 'needle';
  warning?: string;
}

class NullGraphRetrieval implements GraphRetrieval {
  async search(query: string, scope?: RetrievalScope): Promise<GraphRetrievalResult> {
    void query;
    void scope;
    return { hits: [] };
  }
}

export function resolveVectorRoute(runtime: KbRuntime, fallback = createOramaBaseProjection(runtime)): ResolvedVectorRoute {
  const needle = createNeedleBackend(runtime);
  if (needle.isSearchReady()) {
    return {
      retrieval: needle,
      backend: 'needle',
    };
  }

  if (needle.isSnapshotStale()) {
    return {
      retrieval: fallback,
      backend: 'orama',
      warning: 'KB needle snapshot is stale; falling back to Orama cosine until content manifests match.',
    };
  }

  return {
    retrieval: fallback,
    backend: 'orama',
  };
}

export function createRouter(runtime: KbRuntime, options: SearchRouterOptions = {}): SearchRouter {
  const orama = createOramaBaseProjection(runtime);
  const vectorRoute = resolveVectorRoute(runtime, orama);

  return {
    text: orama,
    vector: vectorRoute.retrieval,
    graph: options.graph ?? new NullGraphRetrieval(),
    hybrid: createHybridFusion(),
  };
}
