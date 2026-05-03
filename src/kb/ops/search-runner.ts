import { CoralSetupError, serializeCoralSetupError } from '../../runtime/errors.js';
import { areCommunityDocumentsFresh } from '../curate/community/freshness.js';
import type { Backed, EmbeddingService, FtsRetrieval, KbRuntime } from '../contract.js';
import { KB_EMBEDDING_CAPABILITY, KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '../capability/constants.js';
import type { EntityGraph, KbIndex, KbSearchMode, KbSearchResponse, KbSearchScope } from '../entry-types.js';
import { normalizeWhitespace } from '../text-normalization.js';
import { isGraphSearchFresh } from '../search/graph-retrieval.js';
import { createHybridFusion } from '../search/hybrid.js';
import {
  createQueryPlanner,
  type KbSearchIntent,
  type QueryPlan,
  type RoleInvocation,
} from '../search/query-planner.js';
import { buildHybridResponse, buildTextResponse, buildVectorResponse } from '../search/responses.js';
import type { QueryContext } from '../search/snippets.js';
import { emptySearchResponse, type HybridKbSearchHit, type SearchResponseWarnings } from '../search/text-retrieval.js';
import type {
  RetrievalDiagnostic,
  RetrievalDiagnosticCode,
  RoleExecutionResult,
  RoleQueryContext,
  RoleSearchResult,
} from '../search/contract.js';
import { defaultFusionProfile } from '../search/default-fusion-profile.js';

export type VectorBindingName = typeof KB_VECTOR_CAPABILITY | typeof KB_EMBEDDING_CAPABILITY;

const VECTOR_BINDING_NAMES: ReadonlySet<VectorBindingName> = new Set([
  KB_VECTOR_CAPABILITY,
  KB_EMBEDDING_CAPABILITY,
]);

const neverAbortSignal = new AbortController().signal;

const fallbackFts: FtsRetrieval = {
  async search() {
    return { hits: [], exhausted: true };
  },
  tokenize(text) {
    const normalized = normalizeWhitespace(text.toLowerCase());
    return normalized === '' ? [] : normalized.split(/\s+/u);
  },
  warnings() {
    return [];
  },
};

export type SearchRequest = {
  rawQuery: string;
  topK: number;
  scope: KbSearchScope;
  intent: KbSearchIntent;
  signal: AbortSignal;
};

type SearchRuntime = {
  index: KbIndex;
};

type RuntimeResolution = { kind: 'ready'; runtime: SearchRuntime } | { kind: 'response'; response: KbSearchResponse };

type SearchExecutionContext = SearchRuntime & {
  rt: KbRuntime;
  request: SearchRequest;
  roleQueryContext: RoleQueryContext;
  getQueryContext(): QueryContext;
  getCommunitiesFresh(): boolean;
  getGraphFresh(): boolean;
};

type StageExecution = {
  results: RoleExecutionResult[];
  diagnostics: RetrievalDiagnostic[];
  fallbackRequired: boolean;
};

type SearchRetrieval = {
  mode: KbSearchMode;
  hits: HybridKbSearchHit[];
  diagnostics: RetrievalDiagnostic[];
  responseWarnings: SearchResponseWarnings;
};

export function isVectorBindingName(binding: string): binding is VectorBindingName {
  return VECTOR_BINDING_NAMES.has(binding as VectorBindingName);
}

function missingBindingRemediation(binding: VectorBindingName): string {
  return binding === KB_EMBEDDING_CAPABILITY
    ? "Run `coral-cli expansion list` to find an engine that fills 'kb.embedding', then `coral-cli expansion equip <name>`. FTS-only search continues to work zero-config."
    : "Run `coral-cli expansion list` to find an engine that fills 'kb.vector', then `coral-cli expansion equip <name>`. FTS-only search continues to work zero-config.";
}

function rethrowAsMissingVectorBinding(error: unknown): never {
  const setupError = serializeCoralSetupError(error);
  const binding = setupError?.context?.binding;
  if (
    setupError === null ||
    setupError.code !== 'binding_empty' ||
    typeof binding !== 'string' ||
    !isVectorBindingName(binding)
  ) {
    throw error;
  }

  throw Object.assign(
    new CoralSetupError({
      code: 'binding_empty',
      userMessage: `Vector search needs ${binding}.`,
      remediation: missingBindingRemediation(binding),
      context: { binding },
    }),
    { binding, cause: error },
  );
}

export function createSearchRequest(
  query: string,
  topKInput: number,
  scope: KbSearchScope,
  intent: KbSearchIntent = 'auto',
  signal: AbortSignal = neverAbortSignal,
): SearchRequest {
  return {
    rawQuery: query.trim(),
    topK: Number.isInteger(topKInput) && topKInput > 0 ? topKInput : 20,
    scope,
    intent,
    signal,
  };
}

function resolveSearchRuntime(rt: KbRuntime, request: SearchRequest): RuntimeResolution {
  const storedIndex = rt.readIndex();
  if (storedIndex === null) {
    const emptyResponseForMissingIndex = emptySearchResponse(request.intent);
    return {
      kind: 'response',
      response: {
        ...emptyResponseForMissingIndex,
        warnings: ['kb_search_degraded_until_coordinator_rebuild'],
      },
    };
  }

  const index = storedIndex;
  if (Object.keys(index.entries).length === 0) {
    return { kind: 'response', response: emptySearchResponse(request.intent) };
  }

  return { kind: 'ready', runtime: { index } };
}

function createSearchExecutionContext(
  rt: KbRuntime,
  request: SearchRequest,
  runtime: SearchRuntime,
): SearchExecutionContext {
  const { index } = runtime;
  let normalizedQuery: string | undefined;
  let queryTokens: readonly string[] | undefined;
  let queryContext: QueryContext | undefined;
  let fts: FtsRetrieval | undefined;
  let communitiesFresh: boolean | undefined;
  let currentGraphLoaded = false;
  let currentGraph: EntityGraph | null = null;
  let graphFresh: boolean | undefined;
  let embeddingPromise: Promise<Float32Array> | undefined;

  const getNormalizedQuery = (): string => {
    normalizedQuery ??= normalizeWhitespace(request.rawQuery);
    return normalizedQuery;
  };

  const readFts = (): FtsRetrieval => {
    fts ??= rt.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).read();
    return fts;
  };

  const getQueryContext = (): QueryContext => {
    if (queryContext !== undefined) {
      return queryContext;
    }

    let queryFts: FtsRetrieval;
    try {
      queryFts = readFts();
    } catch {
      queryFts = fallbackFts;
    }

    const normalized = getNormalizedQuery();
    const tokens = queryFts.tokenize(normalized);
    queryContext = {
      rawQuery: request.rawQuery,
      normalizedQuery: normalized,
      queryTokens: tokens,
      fts: queryFts,
    };
    return queryContext;
  };

  const getCommunitiesFresh = (): boolean => {
    communitiesFresh ??= areCommunityDocumentsFresh(rt, index);
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
    graphFresh ??= isGraphSearchFresh(index, getCurrentGraph());
    return graphFresh;
  };

  const roleQueryContext: RoleQueryContext = {
    rawQuery: request.rawQuery,
    topK: request.topK,
    scope: request.scope,
    signal: request.signal,
    normalizedQuery: getNormalizedQuery,
    tokens() {
      if (queryTokens !== undefined) {
        return queryTokens;
      }
      queryTokens = readFts().tokenize(getNormalizedQuery());
      return queryTokens;
    },
    embedding() {
      embeddingPromise ??= rt.capabilityRegistry
        .runtimeView()
        .read<Backed<EmbeddingService>>(KB_EMBEDDING_CAPABILITY)
        .read()
        .embedQuery(request.rawQuery);
      return embeddingPromise;
    },
    index() {
      return index;
    },
    graphContext: getCurrentGraph,
  };

  return {
    ...runtime,
    rt,
    request,
    roleQueryContext,
    getQueryContext,
    getCommunitiesFresh,
    getGraphFresh,
  };
}

function isSetupFailure(error: unknown): boolean {
  return serializeCoralSetupError(error) !== null;
}

function diagnosticCode(error: unknown, signal: AbortSignal): RetrievalDiagnosticCode {
  const setupError = serializeCoralSetupError(error);
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return 'role_aborted';
  }
  if (setupError?.code === 'binding_empty') {
    return 'binding_missing';
  }
  return 'role_failed';
}

function setupBinding(error: unknown): string | undefined {
  const binding = serializeCoralSetupError(error)?.context?.binding;
  return typeof binding === 'string' ? binding : undefined;
}

function diagnosticPublicText(invocation: RoleInvocation, error: unknown, recoverable: boolean): string | undefined {
  if (recoverable) {
    return undefined;
  }

  const setupError = serializeCoralSetupError(error);
  if (setupError !== null) {
    return setupError.userMessage;
  }
  if (invocation.registeredRole.descriptor.id === 'vector') {
    return 'KB vector search is unavailable for this query.';
  }
  return undefined;
}

function diagnosticFromError(
  invocation: RoleInvocation,
  error: unknown,
  recoverable: boolean,
  signal: AbortSignal,
): RetrievalDiagnostic {
  const code = diagnosticCode(error, signal);
  const publicText = diagnosticPublicText(invocation, error, recoverable);
  return {
    roleId: invocation.registeredRole.descriptor.id,
    code,
    recoverable,
    ...(publicText === undefined ? {} : { publicText }),
  };
}

function isBuiltinRequiredSemantic(invocation: RoleInvocation): boolean {
  const { registeredRole } = invocation;
  return (
    invocation.required &&
    registeredRole.origin === 'builtin' &&
    registeredRole.criticality === 'core' &&
    registeredRole.descriptor.tags[0] === 'semantic'
  );
}

function shouldTriggerFallback(
  intent: KbSearchIntent,
  invocation: RoleInvocation,
  error: unknown,
  signal: AbortSignal,
): boolean {
  return (
    intent === 'vector' &&
    !isSetupFailure(error) &&
    diagnosticCode(error, signal) !== 'role_aborted' &&
    isBuiltinRequiredSemantic(invocation)
  );
}

function fulfilledRoleResult(invocation: RoleInvocation, result: RoleSearchResult): StageExecution {
  if (result.diagnostic !== undefined) {
    const executionResult: RoleExecutionResult = {
      registeredRole: invocation.registeredRole,
      diagnostic: result.diagnostic,
    };
    return { results: [executionResult], diagnostics: [result.diagnostic], fallbackRequired: false };
  }

  return {
    results: [
      {
        registeredRole: invocation.registeredRole,
        hits: result.hits,
      },
    ],
    diagnostics: [],
    fallbackRequired: false,
  };
}

function rejectedRoleResult(ctx: SearchExecutionContext, invocation: RoleInvocation, error: unknown): StageExecution {
  const setupFailure = isSetupFailure(error);
  if (invocation.required && setupFailure) {
    // Rule 1: required setup failures keep their CoralSetupError remediation.
    const binding = setupBinding(error);
    if (binding !== undefined && isVectorBindingName(binding)) {
      rethrowAsMissingVectorBinding(error);
    }
    throw error;
  }

  // Rule 2: required + non-setup -> non-recoverable (Rule 1 above already
  // threw for required + setup, so this branch only handles non-setup).
  // Rule 3: optional (any failure) -> recoverable. Combined: recoverable
  // when !required (Rule 3) OR when required+setup which we never reach.
  const diagnostic = diagnosticFromError(invocation, error, !invocation.required || setupFailure, ctx.request.signal);
  return {
    results: [
      {
        registeredRole: invocation.registeredRole,
        diagnostic,
      },
    ],
    diagnostics: [diagnostic],
    fallbackRequired: shouldTriggerFallback(ctx.request.intent, invocation, error, ctx.request.signal),
  };
}

async function executeStage(
  ctx: SearchExecutionContext,
  invocations: readonly RoleInvocation[],
): Promise<StageExecution> {
  const settled = await Promise.allSettled(
    invocations.map((invocation) => invocation.registeredRole.role.search(ctx.roleQueryContext)),
  );
  const execution: StageExecution = { results: [], diagnostics: [], fallbackRequired: false };

  for (let index = 0; index < settled.length; index += 1) {
    const invocation = invocations[index];
    const settledResult = settled[index];
    const classified =
      settledResult.status === 'fulfilled'
        ? fulfilledRoleResult(invocation, settledResult.value)
        : rejectedRoleResult(ctx, invocation, settledResult.reason);

    execution.results.push(...classified.results);
    execution.diagnostics.push(...classified.diagnostics);
    execution.fallbackRequired ||= classified.fallbackRequired;
  }

  return execution;
}

function roleHasTag(results: readonly RoleExecutionResult[], roleId: string, tag: string): boolean {
  const result = results.find((candidate) => candidate.registeredRole.descriptor.id === roleId);
  return result?.registeredRole.descriptor.tags.includes(tag) ?? false;
}

function topKEvidenceHasTag(
  hits: readonly HybridKbSearchHit[],
  results: readonly RoleExecutionResult[],
  topK: number,
  tag: string,
): boolean {
  return hits.slice(0, topK).some((hit) => hit.evidence.some((evidence) => roleHasTag(results, evidence.roleId, tag)));
}

function hasSuccessfulSemanticContributor(results: readonly RoleExecutionResult[]): boolean {
  return results.some((result) => 'hits' in result && result.registeredRole.descriptor.tags.includes('semantic'));
}

function deriveResponseMode(
  intent: KbSearchIntent,
  plan: QueryPlan,
  results: readonly RoleExecutionResult[],
  fusedHits: readonly HybridKbSearchHit[],
  topK: number,
): KbSearchMode {
  if (intent === 'text') {
    return 'text';
  }
  if (intent === 'hybrid') {
    return 'hybrid';
  }
  if (intent === 'vector') {
    if (plan.primaryInvocations.length === 0 || hasSuccessfulSemanticContributor(results)) {
      return 'vector';
    }
    return 'text';
  }
  return topKEvidenceHasTag(fusedHits, results, topK, 'semantic') ? 'hybrid' : 'text';
}

function responseWarningsFromDiagnostics(diagnostics: readonly RetrievalDiagnostic[]): SearchResponseWarnings {
  const warnings = [
    ...new Set(
      diagnostics.map((diagnostic) => diagnostic.publicText).filter((text): text is string => text !== undefined),
    ),
  ];
  return warnings.length === 0 ? {} : { warnings };
}

function emptyResponse(
  mode: KbSearchMode,
  diagnostics: readonly RetrievalDiagnostic[],
  responseWarnings: SearchResponseWarnings,
): KbSearchResponse {
  return {
    mode,
    results: [],
    retrievalDiagnostics: [...diagnostics],
    ...(responseWarnings.warning === undefined ? {} : { warning: responseWarnings.warning }),
    ...(responseWarnings.warnings === undefined ? {} : { warnings: responseWarnings.warnings }),
  };
}

function buildSearchResponse(ctx: SearchExecutionContext, retrieval: SearchRetrieval): KbSearchResponse {
  if (retrieval.hits.length === 0) {
    return emptyResponse(retrieval.mode, retrieval.diagnostics, retrieval.responseWarnings);
  }

  if (retrieval.mode === 'vector') {
    return buildVectorResponse(retrieval.hits, ctx.request.topK, retrieval.responseWarnings, retrieval.diagnostics);
  }
  if (retrieval.mode === 'hybrid') {
    return buildHybridResponse(
      retrieval.hits,
      ctx.getQueryContext(),
      ctx.request.topK,
      ctx.index,
      ctx.getCommunitiesFresh(),
      ctx.getGraphFresh(),
      retrieval.responseWarnings,
      retrieval.diagnostics,
    );
  }
  return buildTextResponse(
    retrieval.hits,
    ctx.getQueryContext(),
    ctx.request.topK,
    ctx.index,
    ctx.getCommunitiesFresh(),
    ctx.getGraphFresh(),
    retrieval.responseWarnings,
    retrieval.diagnostics,
  );
}

export async function runRetrieval(rt: KbRuntime, request: SearchRequest): Promise<KbSearchResponse> {
  const resolution = resolveSearchRuntime(rt, request);
  if (resolution.kind === 'response') {
    return resolution.response;
  }

  const ctx = createSearchExecutionContext(rt, request, resolution.runtime);
  const planner = createQueryPlanner();
  const plan = planner.plan(request.intent, rt.roleRegistry.executionView(), ctx.roleQueryContext);
  const primary = await executeStage(ctx, plan.primaryInvocations);
  const fallback =
    primary.fallbackRequired && plan.fallbackInvocations !== undefined
      ? await executeStage(ctx, plan.fallbackInvocations)
      : { results: [], diagnostics: [], fallbackRequired: false };
  const results = [...primary.results, ...fallback.results];
  const diagnostics = [...primary.diagnostics, ...fallback.diagnostics];
  const fused = createHybridFusion().fuse(results, defaultFusionProfile);
  const mode = deriveResponseMode(request.intent, plan, results, fused.hits, request.topK);
  const responseWarnings = responseWarningsFromDiagnostics(diagnostics);

  return buildSearchResponse(ctx, {
    mode,
    hits: fused.hits,
    diagnostics,
    responseWarnings,
  });
}
