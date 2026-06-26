import type { Runtime } from '../../runtime/ports.js';
import { createRealRuntime } from '../../runtime/real.js';
import { readBuildFlavor } from '../../infra/bundle-manifest.js';
import { isRecord } from '../../infra/json.js';
import { errorMessage } from '../../infra/error-format.js';
import {
  createDefaultKbReadPaths,
  createKbQueryHost,
  resolveQueryMarkdownRoot,
  type KbQueryContext,
  type KbQueryRuntime,
} from '../../read-model/kb-query-runtime.js';
import type { KbMemoListInput, KbPrinciplesInput, KbSearchInput } from '../../kb/entry-types.js';
import { KbIndexStore } from '../../kb/corpus/index-store.js';
import {
  listStaleCommunities,
  readCommunitySummaryInput,
  type CommunitySummaryReadRuntime,
} from '../../kb/curate/community/summary-surface.js';
import {
  diagnoseKnowledgeBase,
  listKnowledgeBaseMemos,
  listKnowledgeBasePrinciples,
  listKnowledgeBaseSources,
  listKnowledgeBaseWikis,
  searchKnowledgeBase,
} from '../../kb/queries.js';
import { readEntryByKind } from '../../kb/read.js';
import { communitiesDir, kbRuntimeDir } from '../../kb/paths.js';
import type { KbReadKind } from '../../kb/selector.js';
import { kbError, kbSuccess, kbValidationError, type KbToolResult } from '../../kb/result.js';
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
} from '../../kb/tool-handlers.js';
import { kbWakeUpSchema } from '../../kb/tool-contracts.js';
import { generateWakeUpPacket } from '../../kb/ops/wake-up.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, assertWikiSlug } from '../../kb/validation.js';
import type { Authority, InvocationContext } from '../../runtime/invocation-context.js';
import type { KbChildKbMutationRequest, KbChildKbReadHealth, KbChildKbReadRequest } from './protocol.js';

type KbChildReadHandlerOptions = {
  pluginRoot: string;
  runtime?: KbQueryRuntime;
  writeRuntime?: KbChildWriteRuntimeHost;
  now?: () => number;
};

type KbChildReadContext = {
  projectRoot: string;
  pluginRoot?: string;
  coralEnv?: Record<string, string>;
  authority?: Authority;
};

type KbChildReadHandlerState = {
  pluginRoot: string;
  getRuntime(): KbQueryRuntime;
  markFailure(error: unknown): void;
};

type KbChildWriteRuntimeHost = {
  withKb<T>(
    fn: (state: {
      kbSubsystem: Parameters<typeof handleKbUpdate>[1];
      runtime: KbQueryRuntime;
    }) => Promise<T> | T,
  ): Promise<T>;
  createSource(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  reindex(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  health(): KbChildKbReadHealth;
};

export type KbChildReadService = {
  read(request: KbChildKbReadRequest): Promise<KbToolResult>;
  mutate(request: KbChildKbMutationRequest): Promise<KbToolResult>;
  warmup(): Promise<KbChildKbReadHealth>;
  health(): KbChildKbReadHealth;
};

function createRuntime(pluginRoot: string): Runtime {
  return createRealRuntime(readBuildFlavor(pluginRoot));
}

function createContext(state: KbChildReadHandlerState, ctx?: KbChildReadContext) {
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

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      parsed[key] = entry;
    }
  }
  return parsed;
}

function parseContext(value: unknown): KbChildReadContext | undefined {
  if (!isRecord(value) || typeof value.projectRoot !== 'string' || value.projectRoot.length === 0) {
    return undefined;
  }
  return {
    projectRoot: value.projectRoot,
    ...(typeof value.pluginRoot === 'string' && value.pluginRoot.length > 0 ? { pluginRoot: value.pluginRoot } : {}),
    ...(value.authority === 'admin' || value.authority === 'user' ? { authority: value.authority } : {}),
    ...(value.coralEnv === undefined ? {} : { coralEnv: parseStringRecord(value.coralEnv) ?? {} }),
  };
}

function invocationContext(
  state: KbChildReadHandlerState,
  ctx: KbChildReadContext | undefined,
): InvocationContext | KbToolResult {
  if (ctx === undefined) {
    return invalidRequest('KB child mutation request requires project context.');
  }
  return {
    projectRoot: ctx.projectRoot,
    pluginRoot: ctx.pluginRoot ?? state.pluginRoot,
    coralEnv: ctx.coralEnv ?? {},
    authority: ctx.authority ?? 'admin',
  };
}

function parseSearchArgs(args: Record<string, unknown>): KbSearchInput | KbToolResult {
  if (typeof args.query !== 'string' || args.query.length === 0) {
    return invalidRequest('KB child search requires a query.');
  }
  return {
    query: args.query,
    ...(typeof args.top_k === 'number' ? { top_k: args.top_k } : {}),
    ...(args.scope === 'notes' ||
    args.scope === 'sources' ||
    args.scope === 'communities' ||
    args.scope === 'wiki' ||
    args.scope === 'all'
      ? { scope: args.scope }
      : {}),
    ...(args.mode === 'text' || args.mode === 'vector' || args.mode === 'hybrid' ? { mode: args.mode } : {}),
  };
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

function invalidRequestFromError(error: unknown): KbToolResult {
  return invalidRequest(errorMessage(error));
}

function failed(error: unknown): KbToolResult {
  return kbError('kb_error', errorMessage(error), error instanceof Error ? { message: error.message } : error);
}

function getWriteRuntimeOrError(writeRuntime: KbChildWriteRuntimeHost | undefined): KbChildWriteRuntimeHost | KbToolResult {
  if (writeRuntime === undefined) {
    return kbError('kb_unavailable', 'KB child write runtime is not configured.');
  }
  const phase = writeRuntime.health().phase;
  if (phase === 'disposing' || phase === 'disposed') {
    return kbError('kb_unavailable', `KB child write runtime is ${phase}.`);
  }
  return writeRuntime;
}

function notFound(kind: KbReadKind, slug: string): KbToolResult {
  return kbError('not_found', `KB ${kind} not found: ${slug}`);
}

function getSlug(request: KbChildKbReadRequest): string | KbToolResult {
  if (typeof request.slug !== 'string' || request.slug.length === 0) {
    return invalidRequest('KB child read request requires a slug.');
  }
  return request.slug;
}

function getMutationSlug(request: KbChildKbMutationRequest): string | KbToolResult {
  if (typeof request.slug !== 'string' || request.slug.length === 0) {
    return invalidRequest('KB child mutation request requires a slug.');
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

function projectDataDir(runtime: KbQueryRuntime, ctx: KbChildReadContext | undefined): string | KbToolResult {
  if (ctx === undefined) {
    return invalidRequest('KB child read request requires project context.');
  }
  return runtime.paths.projectData(ctx.projectRoot);
}

function createCommunitySummaryRuntime(
  runtime: KbQueryRuntime,
  queryContext: KbQueryContext,
): CommunitySummaryReadRuntime {
  const markdownRoot = resolveQueryMarkdownRoot(queryContext);
  const paths = createDefaultKbReadPaths(queryContext);
  const indexStorage = runtime.storage;
  const indexStore = new KbIndexStore({
    runtimeDir: kbRuntimeDir(runtime.flavor, runtime.paths.configSlot),
    storage: {
      readFileSync: (path, encoding) => indexStorage.readFileSync(path, encoding),
      // KbIndexStore normally quarantines corrupt artifacts by unlinking them.
      // The child read daemon must not mutate parent-owned KB artifacts.
      rmSync: () => undefined,
      mkdirSync: () => undefined,
      writeFileSync: () => undefined,
      renameSync: () => undefined,
    },
    ids: runtime.ids,
  });
  return {
    storagePort: runtime.storage,
    communitiesDir: () => communitiesDir(markdownRoot),
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
  state: KbChildReadHandlerState,
  kind: KbReadKind,
  request: KbChildKbReadRequest,
): Promise<KbToolResult> {
  const slug = getSlug(request);
  if (typeof slug !== 'string') {
    return Promise.resolve(slug);
  }
  const normalizedSlug = normalizeSlug(kind, slug);
  if (typeof normalizedSlug !== 'string') {
    return Promise.resolve(normalizedSlug);
  }
  const ctx = parseContext(request.ctx);
  if (kind === 'memo' && ctx === undefined) {
    return Promise.resolve(invalidRequest('KB child read request requires project context.'));
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
      ...(projectDir === undefined ? {} : { projectDataDir: projectDir }),
    });
    return Promise.resolve(entry === null ? notFound(kind, normalizedSlug) : kbSuccess(entry));
  } catch (error: unknown) {
    state.markFailure(error);
    return Promise.resolve(failed(error));
  }
}

export function createKbChildReadService(options: KbChildReadHandlerOptions): KbChildReadService {
  let runtime = options.runtime;
  const now = options.now ?? Date.now;
  let phase: KbChildKbReadHealth['phase'] = 'not_initialized';
  let initializedAt: number | undefined;
  let lastError: string | undefined;
  const markReady = (): void => {
    phase = 'ready';
    initializedAt ??= now();
    lastError = undefined;
  };
  const markFailure = (error: unknown): void => {
    phase = 'failed';
    lastError = errorMessage(error);
  };
  const state: KbChildReadHandlerState = {
    pluginRoot: options.pluginRoot,
    markFailure,
    getRuntime() {
      if (runtime !== undefined) {
        markReady();
        return runtime;
      }
      try {
        runtime = createRuntime(options.pluginRoot);
        markReady();
      } catch (error: unknown) {
        markFailure(error);
        throw error;
      }
      return runtime;
    },
  };
  const writeRuntime = options.writeRuntime;

  const read = async (request: KbChildKbReadRequest): Promise<KbToolResult> => {
    try {
      const args = parseRecord(request.args);
      const ctx = parseContext(request.ctx);

      switch (request.method) {
        case 'readSearch': {
          const parsed = parseSearchArgs(args);
          if ('ok' in parsed) {
            return parsed;
          }
          return run(() => {
            const { queryContext } = createContext(state, ctx);
            const host = createKbQueryHost(queryContext);
            return searchKnowledgeBase(parsed, host);
          }, markFailure);
        }
        case 'diagnose':
          return run(() => {
            const { queryContext } = createContext(state, ctx);
            const host = createKbQueryHost(queryContext);
            return diagnoseKnowledgeBase(host);
          }, markFailure);
        case 'readNote':
          return readTyped(state, 'note', request);
        case 'readSource':
          return readTyped(state, 'source', request);
        case 'readCommunity':
          return readTyped(state, 'community', request);
        case 'readWiki':
          return readTyped(state, 'wiki', request);
        case 'readMemo':
          return readTyped(state, 'memo', request);
        case 'readPrinciple':
          return readTyped(state, 'principle', request);
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
          if (ctx === undefined) {
            return invalidRequest('KB child read request requires project context.');
          }
          return run(() => {
            const { runtime } = createContext(state, ctx);
            return listKnowledgeBaseMemos(
              runtime.storage,
              runtime.paths.projectData(ctx.projectRoot),
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
  const mutate = async (request: KbChildKbMutationRequest): Promise<KbToolResult> => {
    try {
      const args = parseRecord(request.args);
      const ctx = parseContext(request.ctx);

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
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbCommunitySetSummary(args, kbSubsystem));
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
            return activeWriteRuntime.withKb(({ kbSubsystem, runtime }) =>
              handleKbPromote(args, kbSubsystem, invocation, runtime),
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
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbUpdate(args, kbSubsystem));
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
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbDelete({ note: slug }, kbSubsystem));
          }, markFailure);
        case 'createWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbWikiCreate(args, kbSubsystem));
          }, markFailure);
        case 'rewriteWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbWikiRewrite(args, kbSubsystem));
          }, markFailure);
        case 'linkWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbWikiLink(args, kbSubsystem));
          }, markFailure);
        case 'unlinkWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbWikiUnlink(args, kbSubsystem));
          }, markFailure);
        case 'citeWiki':
          return runToolResult(() => {
            const activeWriteRuntime = getWriteRuntimeOrError(writeRuntime);
            if ('ok' in activeWriteRuntime) {
              return activeWriteRuntime;
            }
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbWikiCite(args, kbSubsystem));
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
            return activeWriteRuntime.withKb(({ kbSubsystem, runtime }) =>
              handleKbWikiAdopt(args, kbSubsystem, invocation, runtime),
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
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbWikiDelete({ slug }, kbSubsystem));
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
            return activeWriteRuntime.withKb(({ kbSubsystem }) => handleKbSourceDelete({ slug }, kbSubsystem));
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
  const health = (): KbChildKbReadHealth => ({
    phase,
    ...(initializedAt === undefined ? {} : { initializedAt }),
    ...(lastError === undefined ? {} : { lastError }),
  });
  const warmup = async (): Promise<KbChildKbReadHealth> => {
    try {
      const { queryContext } = createContext(state);
      createDefaultKbReadPaths(queryContext);
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

export function createKbChildReadHandler(options: KbChildReadHandlerOptions) {
  return createKbChildReadService(options).read;
}
