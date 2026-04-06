declare const __PLUGIN_ROOT__: string;

import { ensureBackend, withAbortTimeout, type BackendHandle } from '../client/backend-lifecycle.js';
import { isBackendHealth } from '../client/backend-health.js';
import { readBackendInfo } from '../infra/backend-info.js';
import { collectCoralEnv, isProcessAlive, isRecord } from '../shared/mcp-utils.js';
import {
  describeHttpError,
  HEALTH_TIMEOUT_MS,
  MAX_WAIT_FETCH_TIMEOUT_MS,
  parseJsonResponse,
  parseSseBlock,
  parseWaitStreamEvent,
  TOOL_TIMEOUT_MS,
  WAIT_FETCH_MARGIN_MS,
} from '../shared/sse-parser.js';
import type { WaitStreamEvent } from '../shared/types.js';
import type { ToolDomainResult } from '../execution/tool-response.js';
import type { ToolDescriptor } from './bridge-types.js';

export { ensureBackend } from '../client/backend-lifecycle.js';

export type BackendStatus = {
  status: 'ok';
  version: string;
  bundleHash: string;
  instanceId: string;
  uptimeMs: number;
  activeChildren: number;
  activeJobs: number;
  inflightRequests: number;
} | {
  status: 'shutting_down';
};

export type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' | 'not_running' };

export type ShutdownResult =
  | { ok: true; alreadyDraining?: true }
  | { ok: false; reason: string };

type ToolCatalog = {
  pluginRoot: string;
  instanceId: string;
  tools: ToolDescriptor[];
  providerNames: Set<string>;
};

type ToolRoute =
  | { kind: 'tool'; path: '/tool'; body: string; backend: BackendHandle }
  | { kind: 'provider'; path: string; body: string; backend: BackendHandle }
  | { kind: 'workflow'; path: '/workflow'; body: string; backend: BackendHandle }
  | { kind: 'abort'; path: '/abort'; body: string; backend: BackendHandle };

const DIRECT_BUILTIN_TOOL_NAMES = new Set(['workflow', 'abort']);
let toolCatalogCache: ToolCatalog | null = null;

function isShuttingDownError(value: unknown): value is { error: 'backend_shutting_down' } {
  return isRecord(value) && value.error === 'backend_shutting_down';
}

function isBackendRecoveringResult(value: unknown): value is Extract<ToolDomainResult, { ok: false }> {
  return (
    isRecord(value) &&
    value.ok === false &&
    value.code === 'backend_recovering' &&
    typeof value.message === 'string'
  );
}

function isToolDescriptor(value: unknown): value is ToolDescriptor {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    isRecord(value.inputSchema)
  );
}

function isCataloguedNonProviderToolName(name: string): boolean {
  return name.startsWith('discuss_') || name.startsWith('kb_') || DIRECT_BUILTIN_TOOL_NAMES.has(name);
}

function buildCallerContext(ctx: { projectRoot: string; pluginRoot: string }) {
  return {
    projectRoot: ctx.projectRoot,
    pluginRoot: ctx.pluginRoot,
    coralEnv: collectCoralEnv(),
  };
}

function buildToolCatalog(pluginRoot: string, instanceId: string, payload: unknown): ToolCatalog {
  const tools = Array.isArray(payload) ? payload.filter(isToolDescriptor) : [];
  const providerNames = new Set(
    tools
      .map((tool) => tool.name)
      .filter((name) => !isCataloguedNonProviderToolName(name)),
  );
  return { pluginRoot, instanceId, tools, providerNames };
}

async function loadToolCatalog(
  pluginRoot: string,
  options: {
    backend?: BackendHandle;
    forceRefresh?: boolean;
  } = {},
): Promise<{ catalog: ToolCatalog; backend: BackendHandle }> {
  const backend = options.backend ?? await ensureBackend(pluginRoot);
  if (
    !options.forceRefresh &&
    toolCatalogCache &&
    toolCatalogCache.pluginRoot === pluginRoot &&
    toolCatalogCache.instanceId === backend.instanceId
  ) {
    return { catalog: toolCatalogCache, backend };
  }

  const response = await withAbortTimeout(TOOL_TIMEOUT_MS, (signal) =>
    fetch(`http://${backend.host}:${backend.port}/tools`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': backend.token },
      signal,
    }),
  );

  if (!response.ok) {
    throw new Error(describeHttpError(response.status, response.statusText));
  }

  const catalog = buildToolCatalog(pluginRoot, backend.instanceId, await parseJsonResponse(response));
  toolCatalogCache = catalog;
  return { catalog, backend };
}

export async function fetchBackendToolDescriptors(pluginRoot: string): Promise<ToolDescriptor[]> {
  const { catalog } = await loadToolCatalog(pluginRoot);
  return catalog.tools;
}

function buildToolRouteBody(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
): string {
  return JSON.stringify({
    name,
    args,
    context: buildCallerContext(ctx),
  });
}

function buildDedicatedRouteBody(
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
): string {
  return JSON.stringify({
    context: buildCallerContext(ctx),
    args,
  });
}

async function resolveToolRoute(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
  options: {
    backend?: BackendHandle;
    refreshOnMiss?: boolean;
    forceCatalogRefresh?: boolean;
  } = {},
): Promise<ToolRoute> {
  if (name === 'workflow') {
    const backend = options.backend ?? await ensureBackend(ctx.pluginRoot);
    return {
      kind: 'workflow',
      path: '/workflow',
      body: buildDedicatedRouteBody(args, ctx),
      backend,
    };
  }

  if (name === 'abort') {
    const backend = options.backend ?? await ensureBackend(ctx.pluginRoot);
    return {
      kind: 'abort',
      path: '/abort',
      body: buildDedicatedRouteBody(args, ctx),
      backend,
    };
  }

  if (name.startsWith('discuss_') || name.startsWith('kb_')) {
    const backend = options.backend ?? await ensureBackend(ctx.pluginRoot);
    return {
      kind: 'tool',
      path: '/tool',
      body: buildToolRouteBody(name, args, ctx),
      backend,
    };
  }

  const { catalog, backend } = await loadToolCatalog(ctx.pluginRoot, {
    backend: options.backend,
    forceRefresh: options.forceCatalogRefresh,
  });

  if (catalog.providerNames.has(name)) {
    return {
      kind: 'provider',
      path: `/provider/${encodeURIComponent(name)}`,
      body: buildDedicatedRouteBody(args, ctx),
      backend,
    };
  }

  if (options.refreshOnMiss ?? true) {
    return resolveToolRoute(name, args, ctx, {
      refreshOnMiss: false,
      forceCatalogRefresh: true,
    });
  }

  return {
    kind: 'tool',
    path: '/tool',
    body: buildToolRouteBody(name, args, ctx),
    backend,
  };
}

async function postToolRoute(route: ToolRoute): Promise<ToolDomainResult> {
  return withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`http://${route.backend.host}:${route.backend.port}${route.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': route.backend.token,
      },
      body: route.body,
      signal,
    });

    const responseBody = await parseJsonResponse(response);
    if (response.ok) {
      return responseBody as ToolDomainResult;
    }

    if (response.status === 503 && isBackendRecoveringResult(responseBody)) {
      return responseBody;
    }

    throw new Error(describeHttpError(response.status, response.statusText));
  });
}

function throwBackendCommunicationError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error(`Backend communication error: ${String(error)}`, { cause: error });
}

export async function getBackendStatus(pluginRoot: string): Promise<BackendStatus | null> {
  const status = await getBackendStatusFull(pluginRoot);
  if (status.status === 'ok') {
    return status.health;
  }
  if (status.status === 'shutting_down') {
    return { status: 'shutting_down' };
  }
  return null;
}

export async function getBackendStatusFull(pluginRoot: string): Promise<BackendStatusFull> {
  const info = readBackendInfo(pluginRoot);
  if (!info || !isProcessAlive(info.pid)) return { status: 'not_running' };

  try {
    const { body, response } = await withAbortTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`http://${info.host}:${info.port}/health`, {
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': info.token },
        signal,
      });

      return {
        response,
        body: await parseJsonResponse(response),
      };
    });
    if (response.status === 200) {
      if (isBackendHealth(body) && body.namespace === info.namespace) {
        const { namespace: _, queueDepth: _q, ...health } = body;
        return { status: 'ok', health };
      }
      return { status: 'not_running' };
    }
    if (response.status === 503) {
      return { status: 'shutting_down' };
    }
    if (response.status === 401) return { status: 'unauthorized' };
    return { status: 'not_running' };
  } catch {
    return { status: 'not_running' };
  }
}

export async function shutdownBackend(pluginRoot: string): Promise<ShutdownResult> {
  const info = readBackendInfo(pluginRoot);
  if (!info || !isProcessAlive(info.pid)) {
    return { ok: false, reason: 'not_running' };
  }

  try {
    const { body, response } = await withAbortTimeout(HEALTH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`http://${info.host}:${info.port}/admin/shutdown`, {
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': info.token },
        signal,
      });

      return {
        response,
        body: await parseJsonResponse(response),
      };
    });
    if (response.status === 200 && isRecord(body) && body.status === 'shutting_down') {
      return { ok: true };
    }
    if (response.status === 503 && isShuttingDownError(body)) {
      return { ok: true, alreadyDraining: true };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    return { ok: false, reason: `${response.status} ${response.statusText}` };
  } catch {
    return { ok: false, reason: 'not_running' };
  }
}

export async function proxyToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { projectRoot: string; pluginRoot: string },
): Promise<ToolDomainResult> {
  try {
    const route = await resolveToolRoute(name, args, ctx);
    const result = await postToolRoute(route);

    if (
      route.kind === 'provider' &&
      !result.ok &&
      (result.code === 'not_found' || result.code === 'unknown_provider')
    ) {
      const refreshedRoute = await resolveToolRoute(name, args, ctx, {
        refreshOnMiss: false,
        forceCatalogRefresh: true,
      });
      if (refreshedRoute.kind !== 'provider') {
        return await postToolRoute(refreshedRoute);
      }
      if (refreshedRoute.backend.instanceId !== route.backend.instanceId || refreshedRoute.path !== route.path) {
        return await postToolRoute(refreshedRoute);
      }
    }

    return result;
  } catch (error) {
    throwBackendCommunicationError(error);
  }
}

export type WaitCursorRef = { lastEventId?: string };

export async function* streamWait(
  jobIds: string[],
  timeoutSeconds: number | undefined,
  backendInfo: { host: string; port: number; token: string },
  lastEventId?: string,
  signal?: AbortSignal,
  projectRoot?: string,
  cursorRef?: WaitCursorRef,
): AsyncGenerator<WaitStreamEvent> {
  const fetchTimeoutMs = Math.min(
    (timeoutSeconds ?? 600) * 1000 + WAIT_FETCH_MARGIN_MS,
    MAX_WAIT_FETCH_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', onExternalAbort);
  }

  try {
    const response = await fetch(`http://${backendInfo.host}:${backendInfo.port}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backendInfo.token,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      body: JSON.stringify({ jobIds, timeoutSeconds, projectRoot }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await parseJsonResponse(response);
      const message = isRecord(body) && typeof body.message === 'string'
        ? body.message
        : describeHttpError(response.status, response.statusText);
      throw new Error(message);
    }

    if (!response.body) {
      throw new Error('Backend wait stream returned no response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
      const decoded = decoder.decode(chunk, { stream: true });
      buffer += decoded;
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        if (cursorRef && parsed.id) cursorRef.lastEventId = parsed.id;
        const event = parseWaitStreamEvent(parsed.event, parsed.data);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const finalBlock = parseSseBlock(buffer);
    if (!finalBlock) return;
    if (cursorRef && finalBlock.id) cursorRef.lastEventId = finalBlock.id;
    const finalEvent = parseWaitStreamEvent(finalBlock.event, finalBlock.data);
    if (finalEvent) yield finalEvent;
  } catch (error) {
    throwBackendCommunicationError(error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
