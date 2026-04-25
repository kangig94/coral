import { areCommunityDocumentsFresh } from '../curate/text-artifacts/index.js';
import {
  normalizeOramaTerm,
  tokenizeQuery,
} from '../orama-factory.js';
import type { KbRuntime } from '../contracts.js';
import type {
  EntityGraph,
  KbSearchMode,
  KbSearchResponse,
  KbSearchScope,
} from '../entry-types.js';
import type { GraphRetrievalResult } from '../search/contract.js';
import {
  buildGraphSearchContext,
  isGraphSearchFresh,
  RuntimeGraphRetrieval,
  type GraphSearchContext,
} from '../search/graph-retrieval.js';
import {
  buildHybridResponse,
  buildTextResponse,
  buildVectorResponse,
} from '../search/responses.js';
import { createRouter, resolveVectorRoute, type ResolvedVectorRoute } from '../search/router.js';
import type { QueryContext } from '../search/snippets.js';
import {
  emptySearchResponse,
  filterHitsByScope,
  filterSearchableHits,
  fuseRetrievalRoles,
  rerankHits,
  resolveHit,
  searchOrama,
  shouldContinueWidening,
  type HybridKbSearchHit,
  type ResolvedKbSearchHit,
} from '../search/text-retrieval.js';
import {
  EMPTY_VECTOR_RETRIEVAL_RESULT,
  searchExplicitVectorResults,
} from '../search/vector-query.js';

type TextSearchState = {
  queryCtx: QueryContext;
  selectedHits: ResolvedKbSearchHit[];
  communitiesFresh: boolean;
  graphFresh: boolean;
};

type TextGraphSearchState = TextSearchState & {
  router: ReturnType<typeof createRouter>;
  graphResult: GraphRetrievalResult;
  textHits: Array<ResolvedKbSearchHit | HybridKbSearchHit>;
};

export async function searchKb(
  rt: KbRuntime,
  query: string,
  top_k = 20,
  scope: KbSearchScope = 'all',
  mode?: KbSearchMode,
): Promise<KbSearchResponse> {
  const rawQuery = query.trim();
  const oramaTerm = normalizeOramaTerm(rawQuery);
  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;
  const { db, tokenizer, index, warnings: oramaWarnings } = await rt.ensureOramaIndex();
  if (oramaWarnings?.includes('orama_snapshot_absent') || oramaWarnings?.includes('orama_snapshot_stale')) {
    return {
      mode: 'text',
      results: [],
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    };
  }

  if (Object.keys(index.entries).length === 0) {
    return emptySearchResponse(mode);
  }

  let queryCtx: QueryContext | undefined;
  let communitiesFresh: boolean | undefined;
  let currentGraphLoaded = false;
  let currentGraph: EntityGraph | null = null;
  let graphFresh: boolean | undefined;
  let graphContextLoaded = false;
  let graphContext: GraphSearchContext | null = null;
  let textStatePromise: Promise<TextSearchState> | undefined;
  let textGraphStatePromise: Promise<TextGraphSearchState> | undefined;
  let cachedVectorRoute: ResolvedVectorRoute | undefined;

  const getQueryContext = (): QueryContext => {
    if (queryCtx !== undefined) {
      return queryCtx;
    }
    queryCtx = {
      rawQuery,
      oramaTerm,
      queryTokens: tokenizeQuery(oramaTerm, tokenizer),
      tokenizer,
    };
    return queryCtx;
  };

  const getCommunitiesFresh = (): boolean => {
    if (communitiesFresh !== undefined) {
      return communitiesFresh;
    }
    communitiesFresh = areCommunityDocumentsFresh(rt, index);
    return communitiesFresh;
  };

  const getCurrentGraph = (): EntityGraph | null => {
    if (!currentGraphLoaded) {
      currentGraph = rt.readEntityGraph();
      currentGraphLoaded = true;
    }
    return currentGraph;
  };

  const getGraphFresh = (): boolean => {
    if (graphFresh !== undefined) {
      return graphFresh;
    }
    if (graphContextLoaded) {
      graphFresh = graphContext !== null;
      return graphFresh;
    }
    graphFresh = isGraphSearchFresh(index, getCurrentGraph());
    return graphFresh;
  };

  const getGraphContext = (): GraphSearchContext | null => {
    if (!graphContextLoaded) {
      graphContext = buildGraphSearchContext(index, getCurrentGraph());
      graphContextLoaded = true;
      graphFresh = graphContext !== null;
    }
    return graphContext;
  };

  const getVectorRoute = (): ResolvedVectorRoute => {
    if (cachedVectorRoute !== undefined) {
      return cachedVectorRoute;
    }
    cachedVectorRoute = resolveVectorRoute(rt);
    return cachedVectorRoute;
  };

  const getTextState = async (): Promise<TextSearchState> => {
    if (textStatePromise !== undefined) {
      return textStatePromise;
    }

    textStatePromise = (async () => {
      const nextQueryCtx = getQueryContext();
      const nextCommunitiesFresh = getCommunitiesFresh();
      const resolvedHits: ResolvedKbSearchHit[] = [];

      if (nextQueryCtx.queryTokens.length > 0) {
        let limit = topK;
        let hits = await searchOrama(db, oramaTerm, limit);
        let exhausted = hits.length < limit;
        resolvedHits.push(...hits.map((hit) => resolveHit(hit, index)));

        while (shouldContinueWidening(hits, resolvedHits, nextCommunitiesFresh, scope, topK, exhausted)) {
          const prevCount = hits.length;
          limit = Math.max(limit + 1, limit * 2);
          hits = await searchOrama(db, oramaTerm, limit);
          exhausted = hits.length < limit;
          for (let i = prevCount; i < hits.length; i += 1) {
            resolvedHits.push(resolveHit(hits[i], index));
          }
        }
      }

      const searchableHits = filterSearchableHits(resolvedHits, nextCommunitiesFresh);
      return {
        queryCtx: nextQueryCtx,
        selectedHits: scope === 'all' ? rerankHits(searchableHits) : filterHitsByScope(searchableHits, scope),
        communitiesFresh: nextCommunitiesFresh,
        graphFresh: getGraphFresh(),
      };
    })();

    return textStatePromise;
  };

  const getTextGraphState = async (): Promise<TextGraphSearchState> => {
    if (textGraphStatePromise !== undefined) {
      return textGraphStatePromise;
    }

    textGraphStatePromise = (async () => {
      const textState = await getTextState();
      const router = createRouter(rt, {
        graph: new RuntimeGraphRetrieval(index, getGraphContext()),
        vectorRoute: getVectorRoute(),
      });
      const nextGraphResult = await router.graph.search(rawQuery, scope);

      return {
        ...textState,
        graphFresh: getGraphFresh(),
        router,
        graphResult: nextGraphResult,
        textHits:
          nextGraphResult.hits.length === 0
            ? textState.selectedHits
            : fuseRetrievalRoles(router.hybrid, textState.selectedHits, EMPTY_VECTOR_RETRIEVAL_RESULT.hits, nextGraphResult),
      };
    })();

    return textGraphStatePromise;
  };

  if (mode === 'text') {
    const textState = await getTextState();
    return buildTextResponse(
      textState.selectedHits,
      textState.queryCtx,
      topK,
      index,
      textState.communitiesFresh,
      textState.graphFresh,
    );
  }

  if (mode === 'vector') {
    if (scope === 'communities') {
      return buildVectorResponse([], topK);
    }

    const vectorRoute = getVectorRoute();
    const vectorResult = await searchExplicitVectorResults(rt, rawQuery, topK, scope, vectorRoute, {
      allowNeedleFallbackToOrama: true,
    });
    if (vectorResult.fallbackToText) {
      const textState = await getTextState();
      return buildTextResponse(
        textState.selectedHits,
        textState.queryCtx,
        topK,
        index,
        textState.communitiesFresh,
        textState.graphFresh,
        vectorResult.responseWarnings,
      );
    }
    return buildVectorResponse(vectorResult.hits, topK, vectorResult.responseWarnings);
  }

  if (mode === 'hybrid') {
    if (scope === 'communities') {
      const textGraphState = await getTextGraphState();
      return buildHybridResponse(
        fuseRetrievalRoles(
          textGraphState.router.hybrid,
          textGraphState.selectedHits,
          EMPTY_VECTOR_RETRIEVAL_RESULT.hits,
          textGraphState.graphResult,
        ),
        textGraphState.queryCtx,
        topK,
        index,
        textGraphState.communitiesFresh,
        textGraphState.graphFresh,
      );
    }

    const vectorRoute = getVectorRoute();
    const vectorResult = await searchExplicitVectorResults(rt, rawQuery, topK, scope, vectorRoute, {
      allowNeedleFallbackToOrama: true,
    });
    if (vectorResult.fallbackToText) {
      const textState = await getTextState();
      return buildTextResponse(
        textState.selectedHits,
        textState.queryCtx,
        topK,
        index,
        textState.communitiesFresh,
        textState.graphFresh,
        vectorResult.responseWarnings,
      );
    }

    const textGraphState = await getTextGraphState();
    return buildHybridResponse(
      fuseRetrievalRoles(
        textGraphState.router.hybrid,
        textGraphState.selectedHits,
        vectorResult.hits,
        textGraphState.graphResult,
      ),
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      vectorResult.responseWarnings,
    );
  }

  if (scope === 'communities') {
    const textState = await getTextState();
    return buildTextResponse(
      textState.selectedHits,
      textState.queryCtx,
      topK,
      index,
      textState.communitiesFresh,
      textState.graphFresh,
    );
  }

  const vectorRoute = getVectorRoute();
  const textGraphState = await getTextGraphState();
  if (vectorRoute.backend !== 'needle') {
    const responseWarnings = vectorRoute.warning === undefined ? {} : { warning: vectorRoute.warning };
    return buildTextResponse(
      textGraphState.textHits,
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      responseWarnings,
    );
  }

  const vectorResult = await searchExplicitVectorResults(rt, rawQuery, topK, scope, vectorRoute, {
    allowNeedleFallbackToOrama: false,
  });
  if (vectorResult.fallbackToText) {
    return buildTextResponse(
      textGraphState.textHits,
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      vectorResult.responseWarnings,
    );
  }

  const fusedHits = fuseRetrievalRoles(
    textGraphState.router.hybrid,
    textGraphState.selectedHits,
    vectorResult.hits,
    textGraphState.graphResult,
  );
  const usedVector = fusedHits.slice(0, topK).some((hit) => hit.vectorRank !== undefined);
  if (!usedVector) {
    return buildTextResponse(
      textGraphState.textHits,
      textGraphState.queryCtx,
      topK,
      index,
      textGraphState.communitiesFresh,
      textGraphState.graphFresh,
      vectorResult.responseWarnings,
    );
  }

  return buildHybridResponse(
    fusedHits,
    textGraphState.queryCtx,
    topK,
    index,
    textGraphState.communitiesFresh,
    textGraphState.graphFresh,
    vectorResult.responseWarnings,
  );
}
