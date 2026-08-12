import { createRealRuntime } from '../runtime/real.js';
import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { isRecord } from '../infra/json.js';
import { errorMessage } from '../infra/error-format.js';
import { serializeCoralSetupError, type SerializedCoralSetupError } from '../runtime/errors.js';
import {
  createDefaultKbReadPaths,
  createKbQueryHost,
  type KbQueryContext,
  type KbQueryRuntime,
} from '../read-model/kb-query-runtime.js';
import type { KbMemoListInput, KbPrinciplesInput, KbSearchInput } from '../kb/entry-types.js';
import { KbIndexStore } from '../kb/corpus/index/store.js';
import {
  listStaleCommunities,
  readCommunitySummaryInput,
  type CommunitySummaryReadRuntime,
} from '../kb/curate/community/summary-surface.js';
import {
  diagnoseKnowledgeBase,
  listKnowledgeBaseMemos,
  listKnowledgeBasePrinciples,
  listKnowledgeBaseSources,
  listKnowledgeBaseWikis,
} from '../kb/queries.js';
import { readEntryByKind } from '../kb/read.js';
import { searchKb } from '../kb/ops/search.js';
import { GeneratedCommunityProjectionStore } from '../kb/curate/community/generated-projection-store.js';
import type { KbReadKind } from '../kb/selector.js';
import { kbError, kbSuccess, kbValidationError, type KbToolResult } from '../kb/result.js';
import {
  handleKbCommunitySetSummary,
  handleKbDelete,
  handleKbMemo,
  handleKbMemoDeleteConsolidated,
  handleKbPromote,
  handleKbSourceDelete,
  handleKbUpdate,
  handleKbWikiAdopt,
  handleKbWikiCite,
  handleKbWikiCreate,
  handleKbWikiDelete,
  handleKbWikiLink,
  handleKbWikiRewrite,
  handleKbWikiUnlink,
} from '../kb/tool-handlers.js';
import { kbSearchSchema, kbWakeUpSchema } from '../kb/tool-contracts.js';
import { generateWakeUpPacket } from '../kb/ops/wake-up.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, assertWikiSlug } from '../kb/validation.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { canonicalizeWorkDir, type CanonicalWorkDir, WorkDirectoryError } from '../runtime/canonical-work-dir.js';
import { writeAuthorizationDecisionAudit } from '../infra/audit-log.js';
import type { Capability } from '../security/capability.js';
import type { Principal, ResourceBinding } from '../security/principal.js';
import { authorizeCapability, authorizeResourceBinding, type Decision } from '../security/policy/authorize.js';
import { capabilitiesFor } from '../security/policy/capabilities.js';
import { parsePrincipalWire } from '../security/principal-wire.js';
import {
  kbDaemonRequestContextWireSchema,
  type KbDaemonKbMutationMethod,
  type KbDaemonKbMutationRequest,
  type KbDaemonKbReadHealth,
  type KbDaemonKbReadMethod,
  type KbDaemonKbReadRequest,
} from './protocol.js';

type KbDaemonRequestServiceOptions = {
  pluginRoot: string;
  runtime?: KbQueryRuntime;
  writeRuntime?: KbDaemonWriteRuntimeHost;
  now?: () => number;
};

type KbDaemonRequestContext = {
  projectRoot?: CanonicalWorkDir;
  pluginRoot?: string;
  coralEnv?: Record<string, string>;
  principal: Principal;
};

type RawKbDaemonRequestContext = Omit<KbDaemonRequestContext, 'projectRoot'> & {
  projectRoot?: string;
};

type KbDaemonRequestServiceState = {
  pluginRoot: string;
  getRuntime(): KbQueryRuntime;
  markFailure(error: unknown): void;
};

type KbDaemonWriteRuntimeHost = {
  withKb<T>(
    fn: (state: { kbRuntime: Parameters<typeof handleKbUpdate>[1]; runtime: KbQueryRuntime }) => Promise<T> | T,
  ): Promise<T>;
  warmSearchRuntime?(): void;
  searchReadiness?():
    | { ready: true }
    | {
        ready: false;
        reason: string;
        message: string;
        detail?: Record<string, unknown>;
        setupError?: SerializedCoralSetupError;
      };
  createSource(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  reindex(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  health(): KbDaemonKbReadHealth;
};

const KB_DAEMON_READ_CAPABILITIES = {
  readSearch: 'kb:read',
  diagnose: 'kb:read',
  readNote: 'kb:read',
  readSource: 'kb:read',
  readCommunity: 'kb:read',
  listStaleCommunities: 'kb:read',
  readCommunitySummaryInput: 'kb:read',
  readWiki: 'kb:read',
  readMemo: 'kb:read',
  readPrinciple: 'kb:read',
  listSources: 'kb:read',
  listWikis: 'kb:read',
  listMemos: 'kb:read',
  listPrinciples: 'kb:read',
  wakeUp: 'kb:read',
} as const satisfies Record<KbDaemonKbReadMethod, Capability>;

const KB_DAEMON_MUTATION_CAPABILITIES = {
  setCommunitySummary: 'kb:write',
  createNote: 'kb:write',
  updateNote: 'kb:write',
  deleteNote: 'kb:write',
  createSource: 'kb:source:import',
  createWiki: 'kb:write',
  rewriteWiki: 'kb:write',
  linkWiki: 'kb:write',
  unlinkWiki: 'kb:write',
  citeWiki: 'kb:write',
  adoptWiki: 'kb:write',
  deleteWiki: 'kb:write',
  deleteSource: 'kb:write',
  createMemo: 'kb:write',
  deleteMemos: 'kb:write',
  reindex: 'kb:write',
} as const satisfies Record<KbDaemonKbMutationMethod, Capability>;

export type KbDaemonRequestService = {
  read(request: KbDaemonKbReadRequest): Promise<KbToolResult>;
  mutate(request: KbDaemonKbMutationRequest): Promise<KbToolResult>;
  warmup(): Promise<KbDaemonKbReadHealth>;
  health(): KbDaemonKbReadHealth;
};

function createContext(state: KbDaemonRequestServiceState, ctx?: KbDaemonRequestContext) {
  const runtime = state.getRuntime();
  return {
    runtime,
    queryContext: {
      pluginRoot: state.pluginRoot,
      runtime,
      ...(ctx?.projectRoot === undefined ? {} : { projectRoot: ctx.projectRoot }),
    },
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseContext(value: unknown): RawKbDaemonRequestContext | undefined {
  const parsed = kbDaemonRequestContextWireSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const principal = parsePrincipalWire(parsed.data.principal, {
    transport: 'kb-daemon',
    credential: { kind: 'daemon-rpc', id: 'request-context' },
  });
  if (principal === null) {
    return undefined;
  }
  const subjectCaps = capabilitiesFor(principal.subject);
  const constrainedPrincipal =
    principal.attenuatedCaps === undefined
      ? principal
      : {
          ...principal,
          attenuatedCaps: new Set([...principal.attenuatedCaps].filter((capability) => subjectCaps.has(capability))),
        };
  return {
    ...(parsed.data.projectRoot === undefined ? {} : { projectRoot: parsed.data.projectRoot }),
    ...(parsed.data.pluginRoot === undefined ? {} : { pluginRoot: parsed.data.pluginRoot }),
    ...(parsed.data.coralEnv === undefined ? {} : { coralEnv: parsed.data.coralEnv }),
    principal: constrainedPrincipal,
  };
}

function invocationContext(
  state: KbDaemonRequestServiceState,
  ctx: KbDaemonRequestContext | undefined,
): InvocationContext | KbToolResult {
  if (ctx?.projectRoot === undefined) {
    return invalidRequest('KB daemon mutation request requires project context.');
  }
  return {
    projectRoot: ctx.projectRoot,
    pluginRoot: ctx.pluginRoot ?? state.pluginRoot,
    coralEnv: ctx.coralEnv ?? {},
    principal: ctx.principal,
  };
}

function parseSearchArgs(args: Record<string, unknown>): KbSearchInput | KbToolResult {
  const parsed = kbSearchSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }
  const signal = asAbortSignal(args.abortSignal);
  return {
    ...parsed.data,
    ...(signal === undefined ? {} : { signal }),
  };
}

function asAbortSignal(value: unknown): AbortSignal | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    'addEventListener' in value &&
    'removeEventListener' in value
    ? (value as AbortSignal)
    : undefined;
}

function parseMemoListArgs(args: Record<string, unknown>): KbMemoListInput {
  return typeof args.owner === 'string' ? { owner: args.owner } : {};
}

function parsePrinciplesArgs(args: Record<string, unknown>): KbPrinciplesInput {
  return {
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(typeof args.top_k === 'number' ? { top_k: args.top_k } : {}),
    ...(typeof args.verbose === 'boolean' ? { verbose: args.verbose } : {}),
  };
}

function invalidRequest(message: string): KbToolResult {
  return kbError('invalid_request', message);
}

function unauthorized(method: string, decision: Extract<Decision, { ok: false }>): KbToolResult {
  return kbError('unauthorized', `KB daemon request ${method} requires ${decision.detail.requires}.`, {
    method,
    decision,
  });
}

function requestedBindingFromContext(ctx: KbDaemonRequestContext): ResourceBinding {
  return ctx.projectRoot === undefined ? { kind: 'unbound' } : { kind: 'project', root: ctx.projectRoot };
}

function authorizeDaemonRequest(
  rawCtx: RawKbDaemonRequestContext,
  method: string,
  requires: Capability,
): KbDaemonRequestContext | KbToolResult {
  const capabilityDecision = authorizeCapability(rawCtx.principal, requires);
  if (!capabilityDecision.ok) {
    const unbound = { kind: 'unbound' } as const;
    writeAuthorizationDecisionAudit(rawCtx.principal, `kb-daemon.${method}`, capabilityDecision, unbound);
    return unauthorized(method, capabilityDecision);
  }

  const projectRoot =
    rawCtx.projectRoot === undefined ? undefined : canonicalizeWorkDir(rawCtx.projectRoot, process.cwd());
  let principal = rawCtx.principal;
  const ctx: KbDaemonRequestContext = {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(rawCtx.pluginRoot === undefined ? {} : { pluginRoot: rawCtx.pluginRoot }),
    ...(rawCtx.coralEnv === undefined ? {} : { coralEnv: rawCtx.coralEnv }),
    principal,
  };
  const requestedBinding = requestedBindingFromContext(ctx);
  if (principal.binding.kind === 'unbound' && requestedBinding.kind === 'project') {
    principal = { ...principal, binding: requestedBinding };
    ctx.principal = principal;
  }
  const decision = authorizeResourceBinding(principal, requires, requestedBinding);
  writeAuthorizationDecisionAudit(principal, `kb-daemon.${method}`, decision, requestedBinding);
  return decision.ok ? ctx : unauthorized(method, decision);
}

function invalidRequestFromError(error: unknown): KbToolResult {
  return invalidRequest(errorMessage(error));
}

function failed(error: unknown): KbToolResult {
  if (error instanceof WorkDirectoryError) {
    return kbError(error.code, error.message, { workDir: error.workDir, projectRoot: error.baseDir });
  }
  const setupError = serializeCoralSetupError(error);
  if (setupError !== null) {
    return {
      ok: false,
      code: setupError.code,
      message: setupError.userMessage,
      remediation: setupError.remediation,
      ...(setupError.context === undefined ? {} : { detail: setupError.context }),
      setupError,
    };
  }
  return kbError('kb_error', errorMessage(error), error instanceof Error ? { message: error.message } : error);
}

function getWriteRuntimeOrError(
  writeRuntime: KbDaemonWriteRuntimeHost | undefined,
): KbDaemonWriteRuntimeHost | KbToolResult {
  if (writeRuntime === undefined) {
    return kbError('kb_unavailable', 'KB daemon write runtime is not configured.');
  }
  const phase = writeRuntime.health().phase;
  if (phase === 'disposing' || phase === 'disposed') {
    return kbError('kb_unavailable', `KB daemon write runtime is ${phase}.`);
  }
  return writeRuntime;
}

function searchRuntimeNotReady(
  readiness:
    | {
        ready: false;
        reason: string;
        message: string;
        detail?: Record<string, unknown>;
        setupError?: SerializedCoralSetupError;
      }
    | undefined,
): KbToolResult {
  if (readiness?.setupError !== undefined) {
    return failed(readiness.setupError);
  }
  return kbError(
    'kb_search_runtime_not_ready',
    readiness?.message ?? 'KB search runtime is not ready.',
    readiness === undefined
      ? { reason: 'search_readiness_unavailable' }
      : { ...(readiness.detail ?? {}), reason: readiness.reason },
  );
}

function notFound(kind: KbReadKind, slug: string): KbToolResult {
  return kbError('not_found', `KB ${kind} not found: ${slug}`);
}

function getSlug(request: KbDaemonKbReadRequest): string | KbToolResult {
  if (typeof request.slug !== 'string' || request.slug.length === 0) {
    return invalidRequest('KB daemon read request requires a slug.');
  }
  return request.slug;
}

function getMutationSlug(request: KbDaemonKbMutationRequest): string | KbToolResult {
  if (typeof request.slug !== 'string' || request.slug.length === 0) {
    return invalidRequest('KB daemon mutation request requires a slug.');
  }
  return request.slug;
}

function normalizeSlug(kind: KbReadKind, slug: string): string | KbToolResult {
  try {
    switch (kind) {
      case 'community':
        return assertCommunitySlug(slug, kind);
      case 'source':
        return assertSourceSlug(slug, kind);
      case 'wiki':
        return assertWikiSlug(slug, kind);
      case 'memo':
      case 'note':
      case 'principle':
        return assertNoteSlug(slug, kind);
    }
  } catch (error: unknown) {
    return invalidRequestFromError(error);
  }
}

function projectDataDir(runtime: KbQueryRuntime, ctx: KbDaemonRequestContext): string | KbToolResult {
  if (ctx.projectRoot === undefined) {
    return invalidRequest('KB daemon read request requires project context.');
  }
  return runtime.paths.projectData(ctx.projectRoot);
}

function createCommunitySummaryRuntime(
  runtime: KbQueryRuntime,
  queryContext: KbQueryContext,
): CommunitySummaryReadRuntime {
  const paths = createDefaultKbReadPaths(queryContext);
  const indexStorage = runtime.storage;
  const runtimeDir = runtime.paths.coral.kbRuntime.root;
  const indexStore = new KbIndexStore({
    runtimeDir,
    storage: {
      readFileSync: (path, encoding) => indexStorage.readFileSync(path, encoding),
      // KbIndexStore normally quarantines corrupt artifacts by unlinking them.
      // The daemon read path must not mutate coordinator-owned KB artifacts.
      rmSync: () => undefined,
      mkdirSync: () => undefined,
      writeFileSync: () => undefined,
      renameSync: () => undefined,
    },
    ids: runtime.ids,
  });
  return {
    generatedCommunityProjectionStore: new GeneratedCommunityProjectionStore({
      runtimeDir,
      storage: runtime.storage,
      ids: runtime.ids,
      time: runtime.time,
    }),
    storagePort: runtime.storage,
    communityPath: paths.communityPath,
    notePath: paths.notePath,
    sourcePath: paths.sourcePath,
    readIndexOrEmpty: () => indexStore.readIndexOrEmpty(),
  };
}

async function run(
  action: () => Promise<unknown> | unknown,
  onError?: (error: unknown) => void,
): Promise<KbToolResult> {
  try {
    return kbSuccess(await action());
  } catch (error: unknown) {
    onError?.(error);
    return failed(error);
  }
}

async function runToolResult(
  action: () => Promise<KbToolResult> | KbToolResult,
  onError?: (error: unknown) => void,
): Promise<KbToolResult> {
  try {
    return await action();
  } catch (error: unknown) {
    onError?.(error);
    return failed(error);
  }
}

function readTyped(
  state: KbDaemonRequestServiceState,
  kind: KbReadKind,
  request: KbDaemonKbReadRequest,
  ctx: KbDaemonRequestContext,
): Promise<KbToolResult> {
  const slug = getSlug(request);
  if (typeof slug !== 'string') {
    return Promise.resolve(slug);
  }
  const normalizedSlug = normalizeSlug(kind, slug);
  if (typeof normalizedSlug !== 'string') {
    return Promise.resolve(normalizedSlug);
  }
  if (kind === 'memo' && ctx.projectRoot === undefined) {
    return Promise.resolve(invalidRequest('KB daemon read request requires project context.'));
  }
  try {
    const { runtime, queryContext } = createContext(state, ctx);
    const projectDir = kind === 'memo' ? projectDataDir(runtime, ctx) : undefined;
    if (typeof projectDir !== 'string' && projectDir !== undefined) {
      return Promise.resolve(projectDir);
    }
    const entry = readEntryByKind(kind, normalizedSlug, {
      storage: runtime.storage,
      paths: createDefaultKbReadPaths(queryContext),
      communityDocumentProvider: createKbQueryHost(queryContext).communityDocumentProvider,
      ...(projectDir === undefined ? {} : { projectDataDir: projectDir }),
    });
    return Promise.resolve(entry === null ? notFound(kind, normalizedSlug) : kbSuccess(entry));
  } catch (error: unknown) {
    state.markFailure(error);
    return Promise.resolve(failed(error));
  }
}

export function createKbDaemonRequestService(options: KbDaemonRequestServiceOptions): KbDaemonRequestService {
  let runtime = options.runtime;
  const now = options.now ?? Date.now;
  let phase: KbDaemonKbReadHealth['phase'] = 'not_initialized';
  let initializedAt: number | undefined;
  let lastError: string | undefined;
  let lastSetupError: SerializedCoralSetupError | undefined;
  const markReady = (): void => {
    phase = 'ready';
    initializedAt ??= now();
    lastError = undefined;
    lastSetupError = undefined;
  };
  const markFailure = (error: unknown): void => {
    phase = 'failed';
    lastError = errorMessage(error);
    lastSetupError = serializeCoralSetupError(error) ?? undefined;
  };
  const state: KbDaemonRequestServiceState = {
    pluginRoot: options.pluginRoot,
    markFailure,
    getRuntime() {
      if (runtime !== undefined) {
        markReady();
        return runtime;
      }
      try {
        runtime = createRealRuntime(readBuildFlavor(options.pluginRoot));
        markReady();
      } catch (error: unknown) {
        markFailure(error);
        throw error;
      }
      return runtime;
    },
  };
  const writeRuntime = options.writeRuntime;

  const read = async (request: KbDaemonKbReadRequest): Promise<KbToolResult> => {
    try {
      const args = parseRecord(request.args);
      const rawCtx = parseContext(request.ctx);
      if (rawCtx === undefined) {
        return invalidRequest('KB daemon read request requires principal context.');
      }
      const authorization = authorizeDaemonRequest(rawCtx, request.method, KB_DAEMON_READ_CAPABILITIES[request.method]);
      if ('ok' in authorization) {
        return authorization;
      }
      const ctx = authorization;

      switch (request.method) {
        case 'readSearch': {
          const parsed = parseSearchArgs(args);
          if ('ok' in parsed) {
            return parsed;
          }
          return runToolResult(async () => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            activeWriteRuntime.warmSearchRuntime?.();
            const readiness = activeWriteRuntime.searchReadiness?.();
            if (readiness?.ready !== true) {
              return searchRuntimeNotReady(readiness);
            }
            return kbSuccess(
              await activeWriteRuntime.withKb(({ kbRuntime }) =>
                searchKb(
                  kbRuntime.kb,
                  parsed.query,
                  parsed.top_k ?? 20,
                  parsed.scope ?? 'all',
                  parsed.mode ?? 'auto',
                  parsed.signal,
                ),
              ),
            );
          }, markFailure);
        }
        case 'diagnose':
          return run(() => {
            const { queryContext } = createContext(state, ctx);
            const host = createKbQueryHost(queryContext);
            return diagnoseKnowledgeBase(host);
          }, markFailure);
        case 'readNote':
          return readTyped(state, 'note', request, ctx);
        case 'readSource':
          return readTyped(state, 'source', request, ctx);
        case 'readCommunity':
          return readTyped(state, 'community', request, ctx);
        case 'readWiki':
          return readTyped(state, 'wiki', request, ctx);
        case 'readMemo':
          return readTyped(state, 'memo', request, ctx);
        case 'readPrinciple':
          return readTyped(state, 'principle', request, ctx);
        case 'listSources':
          return run(() => {
            const { queryContext } = createContext(state, ctx);
            const host = createKbQueryHost(queryContext);
            return listKnowledgeBaseSources(host);
          }, markFailure);
        case 'listWikis':
          return run(() => {
            const { queryContext } = createContext(state, ctx);
            const host = createKbQueryHost(queryContext);
            return listKnowledgeBaseWikis(host);
          }, markFailure);
        case 'listMemos': {
          const projectRoot = ctx.projectRoot;
          if (projectRoot === undefined) {
            return invalidRequest('KB daemon read request requires project context.');
          }
          return run(() => {
            const { runtime } = createContext(state, ctx);
            return listKnowledgeBaseMemos(
              runtime.storage,
              runtime.paths.projectData(projectRoot),
              parseMemoListArgs(args),
            );
          }, markFailure);
        }
        case 'listPrinciples':
          return run(() => {
            const { queryContext } = createContext(state, ctx);
            const host = createKbQueryHost(queryContext);
            return listKnowledgeBasePrinciples(parsePrinciplesArgs(args), host);
          }, markFailure);
        case 'wakeUp': {
          const parsed = kbWakeUpSchema.safeParse(args);
          if (!parsed.success) {
            return kbValidationError(parsed.error);
          }
          return run(async () => {
            const { runtime, queryContext } = createContext(state, ctx);
            const paths = createDefaultKbReadPaths(queryContext);
            return {
              content: await generateWakeUpPacket(
                {
                  storagePort: runtime.storage,
                  wikiPath: paths.wikiPath,
                },
                parsed.data.project,
              ),
            };
          }, markFailure);
        }
        case 'listStaleCommunities': {
          const { runtime, queryContext } = createContext(state, ctx);
          return kbSuccess(listStaleCommunities(createCommunitySummaryRuntime(runtime, queryContext)));
        }
        case 'readCommunitySummaryInput': {
          const slug = getSlug(request);
          if (typeof slug !== 'string') {
            return slug;
          }
          const normalizedSlug = normalizeSlug('community', slug);
          if (typeof normalizedSlug !== 'string') {
            return normalizedSlug;
          }
          const { runtime, queryContext } = createContext(state, ctx);
          const input = readCommunitySummaryInput(createCommunitySummaryRuntime(runtime, queryContext), normalizedSlug);
          return input === null ? notFound('community', normalizedSlug) : kbSuccess(input);
        }
      }
    } catch (error: unknown) {
      markFailure(error);
      return failed(error);
    }
  };
  const mutate = async (request: KbDaemonKbMutationRequest): Promise<KbToolResult> => {
    try {
      const args = parseRecord(request.args);
      const rawCtx = parseContext(request.ctx);
      if (rawCtx === undefined) {
        return invalidRequest('KB daemon mutation request requires principal context.');
      }
      const authorization = authorizeDaemonRequest(
        rawCtx,
        request.method,
        KB_DAEMON_MUTATION_CAPABILITIES[request.method],
      );
      if ('ok' in authorization) {
        return authorization;
      }
      const ctx = authorization;

      switch (request.method) {
        case 'createMemo':
          return runToolResult(() => {
            const invocation = invocationContext(state, ctx);
            if ('ok' in invocation) {
              return invocation;
            }
            const { runtime } = createContext(state, ctx);
            return handleKbMemo(args, invocation, runtime);
          }, markFailure);
        case 'deleteMemos':
          return runToolResult(() => {
            const invocation = invocationContext(state, ctx);
            if ('ok' in invocation) {
              return invocation;
            }
            const { runtime } = createContext(state, ctx);
            return handleKbMemoDeleteConsolidated(args, invocation, runtime);
          }, markFailure);
        case 'setCommunitySummary':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbCommunitySetSummary(args, kbRuntime));
          }, markFailure);
        case 'createNote':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const invocation = invocationContext(state, ctx);
            if ('ok' in invocation) {
              return invocation;
            }
            return activeWriteRuntime.withKb(({ kbRuntime, runtime }) =>
              handleKbPromote(args, kbRuntime, invocation, runtime),
            );
          }, markFailure);
        case 'createSource':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const invocation = invocationContext(state, ctx);
            if ('ok' in invocation) {
              return invocation;
            }
            return activeWriteRuntime.createSource(args, invocation);
          }, markFailure);
        case 'updateNote':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbUpdate(args, kbRuntime));
          }, markFailure);
        case 'deleteNote':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const slug = getMutationSlug(request);
            if (typeof slug !== 'string') {
              return slug;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbDelete({ note: slug }, kbRuntime));
          }, markFailure);
        case 'createWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbWikiCreate(args, kbRuntime));
          }, markFailure);
        case 'rewriteWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbWikiRewrite(args, kbRuntime));
          }, markFailure);
        case 'linkWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbWikiLink(args, kbRuntime));
          }, markFailure);
        case 'unlinkWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbWikiUnlink(args, kbRuntime));
          }, markFailure);
        case 'citeWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbWikiCite(args, kbRuntime));
          }, markFailure);
        case 'adoptWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const invocation = invocationContext(state, ctx);
            if ('ok' in invocation) {
              return invocation;
            }
            return activeWriteRuntime.withKb(({ kbRuntime, runtime }) =>
              handleKbWikiAdopt(args, kbRuntime, invocation, runtime),
            );
          }, markFailure);
        case 'deleteWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const slug = getMutationSlug(request);
            if (typeof slug !== 'string') {
              return slug;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbWikiDelete({ slug }, kbRuntime));
          }, markFailure);
        case 'deleteSource':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const slug = getMutationSlug(request);
            if (typeof slug !== 'string') {
              return slug;
            }
            return activeWriteRuntime.withKb(({ kbRuntime }) => handleKbSourceDelete({ slug }, kbRuntime));
          }, markFailure);
        case 'reindex':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            const invocation = invocationContext(state, ctx);
            if ('ok' in invocation) {
              return invocation;
            }
            return activeWriteRuntime.reindex(args, invocation);
          }, markFailure);
      }
    } catch (error: unknown) {
      markFailure(error);
      return failed(error);
    }
  };
  const health = (): KbDaemonKbReadHealth => ({
    phase,
    ...(initializedAt === undefined ? {} : { initializedAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastSetupError === undefined ? {} : { setupError: lastSetupError }),
  });
  const warmup = async (): Promise<KbDaemonKbReadHealth> => {
    try {
      const { queryContext } = createContext(state);
      createDefaultKbReadPaths(queryContext);
      writeRuntime?.warmSearchRuntime?.();
      markReady();
    } catch (error: unknown) {
      markFailure(error);
    }
    return health();
  };

  return {
    read,
    mutate,
    warmup,
    health,
  };
}
