import type { Runtime } from '../../runtime/ports.js';
import { createRealRuntime } from '../../runtime/real.js';
import { readBuildFlavor } from '../../infra/bundle-manifest.js';
import { isRecord } from '../../infra/json.js';
import { errorMessage } from '../../infra/error-format.js';
import { createDefaultKbReadPaths, createKbQueryHost, type KbQueryRuntime } from '../../read-model/kb-query-runtime.js';
import type { KbMemoListInput, KbPrinciplesInput, KbSearchInput } from '../../kb/entry-types.js';
import {
  diagnoseKnowledgeBase,
  listKnowledgeBaseMemos,
  listKnowledgeBasePrinciples,
  listKnowledgeBaseSources,
  listKnowledgeBaseWikis,
  searchKnowledgeBase,
} from '../../kb/queries.js';
import { readEntryByKind } from '../../kb/read.js';
import type { KbReadKind } from '../../kb/selector.js';
import { kbError, kbSuccess, type KbToolResult } from '../../kb/result.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, assertWikiSlug } from '../../kb/validation.js';
import type { KbChildKbReadRequest } from './protocol.js';

type KbChildReadHandlerOptions = {
  pluginRoot: string;
  runtime?: KbQueryRuntime;
};

type KbChildReadContext = {
  projectRoot: string;
};

type KbChildReadHandlerState = {
  pluginRoot: string;
  getRuntime(): KbQueryRuntime;
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

function parseContext(value: unknown): KbChildReadContext | undefined {
  if (!isRecord(value) || typeof value.projectRoot !== 'string' || value.projectRoot.length === 0) {
    return undefined;
  }
  return {
    projectRoot: value.projectRoot,
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

function unavailable(message: string, reason: string): KbToolResult {
  return kbError('kb_unavailable', message, { reason });
}

function failed(error: unknown): KbToolResult {
  return kbError('kb_error', errorMessage(error), error instanceof Error ? { message: error.message } : error);
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

async function run(action: () => Promise<unknown> | unknown): Promise<KbToolResult> {
  try {
    return kbSuccess(await action());
  } catch (error: unknown) {
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
  const { runtime, queryContext } = createContext(state, ctx);
  const projectDir = kind === 'memo' ? projectDataDir(runtime, ctx) : undefined;
  if (typeof projectDir !== 'string' && projectDir !== undefined) {
    return Promise.resolve(projectDir);
  }

  try {
    const entry = readEntryByKind(kind, normalizedSlug, {
      storage: runtime.storage,
      paths: createDefaultKbReadPaths(queryContext),
      ...(projectDir === undefined ? {} : { projectDataDir: projectDir }),
    });
    return Promise.resolve(entry === null ? notFound(kind, normalizedSlug) : kbSuccess(entry));
  } catch (error: unknown) {
    return Promise.resolve(failed(error));
  }
}

export function createKbChildReadHandler(options: KbChildReadHandlerOptions) {
  let runtime = options.runtime;
  const state: KbChildReadHandlerState = {
    pluginRoot: options.pluginRoot,
    getRuntime() {
      runtime ??= createRuntime(options.pluginRoot);
      return runtime;
    },
  };

  return async (request: KbChildKbReadRequest): Promise<KbToolResult> => {
    const args = parseRecord(request.args);
    const ctx = parseContext(request.ctx);

    switch (request.method) {
      case 'readSearch': {
        const parsed = parseSearchArgs(args);
        if ('ok' in parsed) {
          return parsed;
        }
        const { queryContext } = createContext(state, ctx);
        const host = createKbQueryHost(queryContext);
        return run(() => searchKnowledgeBase(parsed, host));
      }
      case 'diagnose': {
        const { queryContext } = createContext(state, ctx);
        const host = createKbQueryHost(queryContext);
        return run(() => diagnoseKnowledgeBase(host));
      }
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
      case 'listSources': {
        const { queryContext } = createContext(state, ctx);
        const host = createKbQueryHost(queryContext);
        return run(() => listKnowledgeBaseSources(host));
      }
      case 'listWikis': {
        const { queryContext } = createContext(state, ctx);
        const host = createKbQueryHost(queryContext);
        return run(() => listKnowledgeBaseWikis(host));
      }
      case 'listMemos': {
        if (ctx === undefined) {
          return invalidRequest('KB child read request requires project context.');
        }
        const { runtime } = createContext(state, ctx);
        const dir = projectDataDir(runtime, ctx);
        return typeof dir === 'string'
          ? run(() => listKnowledgeBaseMemos(runtime.storage, dir, parseMemoListArgs(args)))
          : dir;
      }
      case 'listPrinciples': {
        const { queryContext } = createContext(state, ctx);
        const host = createKbQueryHost(queryContext);
        return run(() => listKnowledgeBasePrinciples(parsePrinciplesArgs(args), host));
      }
      case 'listStaleCommunities':
      case 'readCommunitySummaryInput':
        return unavailable(
          `KB child read method is not available yet: ${request.method}`,
          'kb_child_read_not_supported',
        );
    }
  };
}
