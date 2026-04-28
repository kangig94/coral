import { CoralSetupError } from '../../runtime/errors.js';
import { areCommunityDocumentsFresh } from '../curate/community/freshness.js';
import { normalizeWhitespace } from '../text-utils.js';
import type { FtsRetrieval, KbRuntime } from '../contract.js';
import type { EntityGraph, KbSearchMode, KbSearchResponse, KbSearchScope } from '../entry-types.js';
import {
  buildGraphSearchContext,
  isGraphSearchFresh,
  RuntimeGraphRetrieval,
  type GraphSearchContext,
} from '../search/graph-retrieval.js';
import { buildHybridResponse, buildTextResponse, buildVectorResponse } from '../search/responses.js';
import { createRouter } from '../search/router.js';
import type { QueryContext } from '../search/snippets.js';
import {
  emptySearchResponse,
  filterHitsByScope,
  filterSearchableHits,
  fuseRetrievalRoles,
  rerankHits,
  resolveHit,
  shouldContinueWidening,
  type HybridKbSearchHit,
  type ResolvedKbSearchHit,
} from '../search/text-retrieval.js';
import { EMPTY_VECTOR_RETRIEVAL_RESULT, searchExplicitVectorResults } from '../search/vector-query.js';
import type { GraphRetrievalResult } from '../search/contract.js';

const VECTOR_BINDING_NAMES: ReadonlySet<string> = new Set(['kb.embedding', 'kb.vector']);

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

function rethrowAsMissingEmbedder(error: unknown): never {
  if (
    !(error instanceof CoralSetupError) ||
    error.code !== 'binding_empty' ||
    typeof error.context?.binding !== 'string' ||
    !VECTOR_BINDING_NAMES.has(error.context.binding)
  ) {
    throw error;
  }

  const binding = error.context.binding;
  throw Object.assign(
    new CoralSetupError({
      code: 'binding_empty',
      userMessage: 'Vector search needs an embedder.',
      remediation:
        'Run `coral-cli expansion equip <embedder>` — see `coral-cli expansion list --binding kb.embedding`.',
      context: { binding },
    }),
    { binding, cause: error },
  );
}

export async function searchKb(
  rt: KbRuntime,
  query: string,
  top_k = 20,
  scope: KbSearchScope = 'all',
  mode?: KbSearchMode,
): Promise<KbSearchResponse> {
  const rawQuery = query.trim();
  const normalizedQuery = normalizeWhitespace(rawQuery);
  const topK = Number.isInteger(top_k) && top_k > 0 ? top_k : 20;

  let ftsBacked: ReturnType<typeof rt.fts.read>;
  try {
    ftsBacked = rt.fts.read();
  } catch (error) {
    if (error instanceof CoralSetupError && error.code === 'binding_empty' && error.context?.binding === 'kb.fts') {
      return {
        mode: 'text',
        results: [],
        warnings: ['kb_search_degraded_until_coordinator_rebuild'],
      };
    }
    throw error;
  }
  const fts: FtsRetrieval = ftsBacked.read();
  const ftsWarnings = fts.warnings();
  if (ftsWarnings.includes('fts_index_uninitialized') || ftsWarnings.includes('fts_index_stale')) {
    return {
      mode: 'text',
      results: [],
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    };
  }

  const index = rt.readIndex() ?? rt.readIndexOrEmpty();
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

  const getQueryContext = (): QueryContext => {
    if (queryCtx !== undefined) {
      return queryCtx;
    }
    queryCtx = {
      rawQuery,
      normalizedQuery,
      queryTokens: fts.tokenize(normalizedQuery),
      fts,
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
        let result = await fts.search(nextQueryCtx.normalizedQuery, limit, scope);
        resolvedHits.push(...result.hits.map((hit) => resolveHit(hit, index)));

        while (
          shouldContinueWidening(
            result.hits,
            resolvedHits,
            nextCommunitiesFresh,
            scope,
            topK,
            result.exhausted,
          )
        ) {
          const prevCount = result.hits.length;
          limit = Math.max(limit + 1, limit * 2);
          result = await fts.search(nextQueryCtx.normalizedQuery, limit, scope);
          for (let i = prevCount; i < result.hits.length; i += 1) {
            resolvedHits.push(resolveHit(result.hits[i], index));
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
            : fuseRetrievalRoles(
                router.hybrid,
                textState.selectedHits,
                EMPTY_VECTOR_RETRIEVAL_RESULT.hits,
                nextGraphResult,
              ),
      };
    })();

    return textGraphStatePromise;
  };

  const searchVectorResults = async (explicit: boolean) => {
    try {
      return await searchExplicitVectorResults(rt, rawQuery, topK, scope);
    } catch (error) {
      if (
        error instanceof CoralSetupError &&
        error.code === 'binding_empty' &&
        typeof error.context?.binding === 'string' &&
        VECTOR_BINDING_NAMES.has(error.context.binding)
      ) {
        if (explicit) {
          rethrowAsMissingEmbedder(error);
        }
        // Implicit hybrid path with no engine: degrade silently to text-only.
        return {
          hits: [],
          responseWarnings: {},
          fallbackToText: true as const,
        };
      }
      throw error;
    }
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

    const vectorResult = await searchVectorResults(true);
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

    const vectorResult = await searchVectorResults(true);
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

  const textGraphState = await getTextGraphState();

  const vectorResult = await searchVectorResults(false);
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
