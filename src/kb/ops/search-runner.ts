import { serializeCoralSetupError } from '../../runtime/errors.js';
import { areCommunityDocumentsFresh } from '../curate/community/freshness.js';
import { normalizeWhitespace } from '../text-normalization.js';
import type { FtsRetrieval, KbRuntime } from '../contract.js';
import type { EntityGraph, KbIndex, KbSearchMode, KbSearchResponse, KbSearchScope } from '../entry-types.js';
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
  type SearchResponseWarnings,
} from '../search/text-retrieval.js';
import { EMPTY_VECTOR_RETRIEVAL_RESULT, searchExplicitVectorResults } from '../search/vector-query.js';
import type { GraphRetrievalResult, VectorRetrievalHit } from '../search/contract.js';

export type VectorBindingName = 'kb.embedding' | 'kb.vector';

const VECTOR_BINDING_NAMES: ReadonlySet<VectorBindingName> = new Set(['kb.embedding', 'kb.vector']);

export type SearchRequest = {
  rawQuery: string;
  topK: number;
  scope: KbSearchScope;
  mode?: KbSearchMode;
};

export type SearchRuntime = {
  fts: FtsRetrieval;
  index: KbIndex;
};

export type RuntimeResolution =
  | { kind: 'ready'; runtime: SearchRuntime }
  | { kind: 'response'; response: KbSearchResponse };

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

export type SearchExecutionContext = SearchRuntime & {
  rt: KbRuntime;
  request: SearchRequest;
  getQueryContext(): QueryContext;
  getCommunitiesFresh(): boolean;
  getGraphFresh(): boolean;
  getGraphContext(): GraphSearchContext | null;
  getTextState(): Promise<TextSearchState>;
  getTextGraphState(): Promise<TextGraphSearchState>;
  searchVectorResults(explicit: boolean): Promise<Awaited<ReturnType<typeof searchExplicitVectorResults>>>;
};

type SearchRetrieval =
  | {
      mode: 'text';
      hits: Array<ResolvedKbSearchHit | HybridKbSearchHit>;
      queryCtx: QueryContext;
      communitiesFresh: boolean;
      graphFresh: boolean;
      responseWarnings?: SearchResponseWarnings;
    }
  | {
      mode: 'vector';
      hits: readonly VectorRetrievalHit[];
      responseWarnings?: SearchResponseWarnings;
    }
  | {
      mode: 'hybrid';
      hits: HybridKbSearchHit[];
      queryCtx: QueryContext;
      communitiesFresh: boolean;
      graphFresh: boolean;
      responseWarnings?: SearchResponseWarnings;
    };

type SearchExecutionOptions = {
  rethrowMissingVectorBinding(error: unknown): never;
};

export function isVectorBindingName(binding: string): binding is VectorBindingName {
  return VECTOR_BINDING_NAMES.has(binding as VectorBindingName);
}

export function createSearchRequest(
  query: string,
  topKInput: number,
  scope: KbSearchScope,
  mode?: KbSearchMode,
): SearchRequest {
  return {
    rawQuery: query.trim(),
    topK: Number.isInteger(topKInput) && topKInput > 0 ? topKInput : 20,
    scope,
    mode,
  };
}

export function resolveSearchRuntime(rt: KbRuntime, request: SearchRequest): RuntimeResolution {
  let ftsBacked: ReturnType<typeof rt.fts.read>;
  try {
    ftsBacked = rt.fts.read();
  } catch (error) {
    const setupError = serializeCoralSetupError(error);
    if (setupError?.code === 'binding_empty' && setupError.context?.binding === 'kb.fts') {
      return { kind: 'response', response: degradedSearchResponse() };
    }
    throw error;
  }

  const fts: FtsRetrieval = ftsBacked.read();
  const ftsWarnings = fts.warnings();
  if (ftsWarnings.includes('fts_index_uninitialized') || ftsWarnings.includes('fts_index_stale')) {
    return { kind: 'response', response: degradedSearchResponse() };
  }

  const index = rt.readIndex() ?? rt.readIndexOrEmpty();
  if (Object.keys(index.entries).length === 0) {
    return { kind: 'response', response: emptySearchResponse(request.mode) };
  }

  return { kind: 'ready', runtime: { fts, index } };
}

function degradedSearchResponse(): KbSearchResponse {
  return {
    mode: 'text',
    results: [],
    warnings: ['kb_search_degraded_until_coordinator_rebuild'],
  };
}

function resolveQueryContext(
  _rt: KbRuntime,
  request: SearchRequest & { fts: FtsRetrieval },
): { queryContext: QueryContext; normalizedQuery: string; queryTokens: readonly string[] } {
  const normalizedQuery = normalizeWhitespace(request.rawQuery);
  const queryTokens = request.fts.tokenize(normalizedQuery);

  return {
    normalizedQuery,
    queryTokens,
    queryContext: {
      rawQuery: request.rawQuery,
      normalizedQuery,
      queryTokens,
      fts: request.fts,
    },
  };
}

export function createSearchExecutionContext(
  rt: KbRuntime,
  request: SearchRequest,
  runtime: SearchRuntime,
  options: SearchExecutionOptions,
): SearchExecutionContext {
  const { fts, index } = runtime;
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
    queryCtx = resolveQueryContext(rt, { ...request, fts }).queryContext;
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
        let limit = request.topK;
        let result = await fts.search(nextQueryCtx.normalizedQuery, limit, request.scope);
        resolvedHits.push(...result.hits.map((hit) => resolveHit(hit, index)));

        while (
          shouldContinueWidening(
            result.hits,
            resolvedHits,
            nextCommunitiesFresh,
            request.scope,
            request.topK,
            result.exhausted,
          )
        ) {
          const prevCount = result.hits.length;
          limit = Math.max(limit + 1, limit * 2);
          result = await fts.search(nextQueryCtx.normalizedQuery, limit, request.scope);
          for (let i = prevCount; i < result.hits.length; i += 1) {
            resolvedHits.push(resolveHit(result.hits[i], index));
          }
        }
      }

      const searchableHits = filterSearchableHits(resolvedHits, nextCommunitiesFresh);
      return {
        queryCtx: nextQueryCtx,
        selectedHits:
          request.scope === 'all' ? rerankHits(searchableHits) : filterHitsByScope(searchableHits, request.scope),
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
      const nextGraphResult = await router.graph.search(request.rawQuery, request.scope);

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
      return await searchExplicitVectorResults(rt, request.rawQuery, request.topK, request.scope);
    } catch (error) {
      const setupError = serializeCoralSetupError(error);
      const binding = setupError?.context?.binding;
      if (
        setupError?.code === 'binding_empty' &&
        typeof binding === 'string' &&
        isVectorBindingName(binding)
      ) {
        if (explicit) {
          options.rethrowMissingVectorBinding(error);
        }
        return {
          hits: [],
          responseWarnings: {},
          fallbackToText: true as const,
        };
      }
      throw error;
    }
  };

  return {
    ...runtime,
    rt,
    request,
    getQueryContext,
    getCommunitiesFresh,
    getGraphFresh,
    getGraphContext,
    getTextState,
    getTextGraphState,
    searchVectorResults,
  };
}

function textRetrieval(
  state: TextSearchState,
  responseWarnings?: SearchResponseWarnings,
  hits: Array<ResolvedKbSearchHit | HybridKbSearchHit> = state.selectedHits,
): SearchRetrieval {
  return {
    mode: 'text',
    hits,
    queryCtx: state.queryCtx,
    communitiesFresh: state.communitiesFresh,
    graphFresh: state.graphFresh,
    responseWarnings,
  };
}

async function runFtsOnly(ctx: SearchExecutionContext): Promise<SearchRetrieval> {
  return textRetrieval(await ctx.getTextState());
}

async function runVectorOnly(ctx: SearchExecutionContext): Promise<SearchRetrieval> {
  if (ctx.request.scope === 'communities') {
    return { mode: 'vector', hits: [] };
  }

  const vectorResult = await ctx.searchVectorResults(true);
  if (vectorResult.fallbackToText) {
    return textRetrieval(await ctx.getTextState(), vectorResult.responseWarnings);
  }

  return { mode: 'vector', hits: vectorResult.hits, responseWarnings: vectorResult.responseWarnings };
}

async function runHybrid(ctx: SearchExecutionContext): Promise<SearchRetrieval> {
  if (ctx.request.scope === 'communities') {
    const textGraphState = await ctx.getTextGraphState();
    return {
      mode: 'hybrid',
      hits: fuseRetrievalRoles(
        textGraphState.router.hybrid,
        textGraphState.selectedHits,
        EMPTY_VECTOR_RETRIEVAL_RESULT.hits,
        textGraphState.graphResult,
      ),
      queryCtx: textGraphState.queryCtx,
      communitiesFresh: textGraphState.communitiesFresh,
      graphFresh: textGraphState.graphFresh,
    };
  }

  const vectorResult = await ctx.searchVectorResults(true);
  if (vectorResult.fallbackToText) {
    return textRetrieval(await ctx.getTextState(), vectorResult.responseWarnings);
  }

  const textGraphState = await ctx.getTextGraphState();
  return {
    mode: 'hybrid',
    hits: fuseRetrievalRoles(
      textGraphState.router.hybrid,
      textGraphState.selectedHits,
      vectorResult.hits,
      textGraphState.graphResult,
    ),
    queryCtx: textGraphState.queryCtx,
    communitiesFresh: textGraphState.communitiesFresh,
    graphFresh: textGraphState.graphFresh,
    responseWarnings: vectorResult.responseWarnings,
  };
}

async function runAuto(ctx: SearchExecutionContext): Promise<SearchRetrieval> {
  if (ctx.request.scope === 'communities') {
    return runFtsOnly(ctx);
  }

  const textGraphState = await ctx.getTextGraphState();
  const vectorResult = await ctx.searchVectorResults(false);
  if (vectorResult.fallbackToText) {
    return textRetrieval(textGraphState, vectorResult.responseWarnings, textGraphState.textHits);
  }

  const fusedHits = fuseRetrievalRoles(
    textGraphState.router.hybrid,
    textGraphState.selectedHits,
    vectorResult.hits,
    textGraphState.graphResult,
  );
  const usedVector = fusedHits.slice(0, ctx.request.topK).some((hit) => hit.vectorRank !== undefined);
  if (!usedVector) {
    return textRetrieval(textGraphState, vectorResult.responseWarnings, textGraphState.textHits);
  }

  return {
    mode: 'hybrid',
    hits: fusedHits,
    queryCtx: textGraphState.queryCtx,
    communitiesFresh: textGraphState.communitiesFresh,
    graphFresh: textGraphState.graphFresh,
    responseWarnings: vectorResult.responseWarnings,
  };
}

export async function runRetrieval(ctx: SearchExecutionContext): Promise<SearchRetrieval> {
  if (ctx.request.mode === 'text') {
    return runFtsOnly(ctx);
  }
  if (ctx.request.mode === 'vector') {
    return runVectorOnly(ctx);
  }
  if (ctx.request.mode === 'hybrid') {
    return runHybrid(ctx);
  }
  return runAuto(ctx);
}

export function buildSearchResponse(ctx: SearchExecutionContext, retrieval: SearchRetrieval): KbSearchResponse {
  if (retrieval.mode === 'vector') {
    return buildVectorResponse(retrieval.hits, ctx.request.topK, retrieval.responseWarnings);
  }
  if (retrieval.mode === 'hybrid') {
    return buildHybridResponse(
      retrieval.hits,
      retrieval.queryCtx,
      ctx.request.topK,
      ctx.index,
      retrieval.communitiesFresh,
      retrieval.graphFresh,
      retrieval.responseWarnings,
    );
  }
  return buildTextResponse(
    retrieval.hits,
    retrieval.queryCtx,
    ctx.request.topK,
    ctx.index,
    retrieval.communitiesFresh,
    retrieval.graphFresh,
    retrieval.responseWarnings,
  );
}
