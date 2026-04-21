import type { KbRuntime } from '../contracts.js';
import { readCorpusState } from '../../store/corpus-state.js';
import type {
  GraphRetrieval,
  GraphRetrievalResult,
  HybridFusion,
  RetrievalScope,
  TextRetrieval,
  VectorRetrieval,
} from './contract.js';
import { createHybridFusion } from './hybrid.js';
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

function backendKindOf(retrieval: VectorRetrieval): 'needle' | 'orama' {
  return (retrieval as VectorRetrieval & { readonly backendKind?: 'needle' | 'orama' }).backendKind === 'needle'
    ? 'needle'
    : 'orama';
}

function activationMatchesCorpus(
  runtime: KbRuntime,
  activation: ReturnType<KbRuntime['getEquipmentView']>,
): boolean {
  if (activation.snapshotId === null || activation.contentManifestHash === null) {
    return false;
  }

  const latest = readCorpusState(runtime.db);
  return (
    activation.contentSeq === latest.contentSeq &&
    activation.contentManifestHash === latest.contentManifestHash
  );
}

/** Chooses the active vector backend, falling back to Orama when Needle is not fresh. */
export function resolveVectorRoute(runtime: KbRuntime, fallback = createOramaBaseProjection(runtime)): ResolvedVectorRoute {
  const activation = runtime.getEquipmentView();
  if (backendKindOf(activation.retrieval) !== 'needle') {
    return {
      retrieval: fallback,
      backend: 'orama',
    };
  }

  if (activationMatchesCorpus(runtime, activation)) {
    return {
      retrieval: activation.retrieval,
      backend: 'needle',
    };
  }

  if (activation.snapshotId !== null || activation.contentManifestHash !== null) {
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

/** Builds the KB search router with shared text, vector, graph, and hybrid retrieval roles. */
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
