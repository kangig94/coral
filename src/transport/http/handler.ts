import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodError } from 'zod';
import {
  parseSerializedWaitCursor,
  serializeWaitCursor,
  type WaitStreamEvent,
} from '../../jobs/api.js';
import { isRecord } from '../../shared/utils.js';
import { executeCatalogRequest } from '../dispatch.js';
import { rpcCatalog, transportOperationalCarveouts } from '../rpc-catalog.js';
import type { RpcMethodSpec } from '../rpc-catalog.js';
import {
  domainResultToHttp,
  formatZodError,
  type EventStreamHandlers,
  type HttpHandlerPorts,
  queryParamsToObject,
  type WaitStreamRequest,
} from './contracts.js';
import { subscribeAll } from './sse-subscribe.js';

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  if (statusCode >= 500 || statusCode === 503) {
    res.setHeader('Connection', 'close');
  }
  res.end(payload);
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const INVALID_JSON_RESPONSE = {
  code: 'invalid_request',
  message: 'Invalid JSON body',
};
const REQUEST_PARSE_FAILED = Symbol('request_parse_failed');

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;

    function onData(chunk: Buffer | string) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += buf.length;
      if (totalSize > MAX_BODY_SIZE) {
        settled = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(buf);
    }

    function onError(err: Error) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    req.on('data', onData);
    req.once('error', onError);
    req.once('end', onEnd);
  });
}

// ---------------------------------------------------------------------------
// SSE / streaming helpers
// ---------------------------------------------------------------------------

export function writeSseEvent(res: ServerResponse, event: string, data: unknown, cursorId?: string): void {
  if (res.writableEnded) return;
  if (cursorId) {
    res.write(`event: ${event}\nid: ${cursorId}\ndata: ${JSON.stringify(data)}\n\n`);
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function runOnResponseDone(res: ServerResponse, fn: () => void): void {
  let called = false;
  const run = () => {
    if (called) return;
    called = true;
    res.off('finish', run);
    res.off('close', run);
    fn();
  };

  res.once('finish', run);
  res.once('close', run);
}

export function parseEventStreamFilter(url: string): string | null {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return null;
  const params = new URLSearchParams(url.slice(qIndex));
  const filter = params.get('filter');
  if (!filter) return null;
  const jobMatch = filter.match(/^job:(.+)$/);
  return jobMatch?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

function sendInvalidJson(res: ServerResponse): void {
  sendJson(res, 400, INVALID_JSON_RESPONSE);
}

function sendValidationFailure(res: ServerResponse, error: ZodError): void {
  const { message, detail } = formatZodError(error);
  const response = domainResultToHttp({ ok: false, code: 'invalid_request', message, detail });
  sendJson(res, response.statusCode, response.body);
}

// ---------------------------------------------------------------------------
// Catalog-backed routing
// ---------------------------------------------------------------------------

type HttpMethod = NonNullable<RpcMethodSpec<unknown, unknown>['http']>['method'];

export type CatalogBackedHttpRoute = {
  method: HttpMethod;
  path: string;
  spec: RpcMethodSpec<unknown, unknown>;
};

type ProjectedCatalogBackedHttpRoute = CatalogBackedHttpRoute & {
  pattern: RegExp;
  handle: (req: IncomingMessage, res: ServerResponse, parsedUrl: URL, pathParams: Record<string, string>) => Promise<void>;
};

type TransportLocalRoute = {
  method: 'GET' | 'POST';
  path: string;
};

type ProjectedTransportLocalRoute = TransportLocalRoute & {
  pattern: RegExp;
  requiresRunningLifecycle: boolean;
  handle: (req: IncomingMessage, res: ServerResponse, parsedUrl: URL) => Promise<void>;
};

const [healthPath, shutdownPath, eventsStreamPath] = transportOperationalCarveouts;

export const transportLocalRoutes: readonly TransportLocalRoute[] = [
  { method: 'GET', path: healthPath },
  { method: 'POST', path: shutdownPath },
  { method: 'GET', path: eventsStreamPath },
];

export const coordinatorHttpRoutes: readonly CatalogBackedHttpRoute[] = rpcCatalog.map((spec) => ({
  method: spec.http.method,
  path: spec.http.path,
  spec,
}));

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePathPattern(path: string): RegExp {
  const parts = path.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      return `(?<${segment.slice(1)}>[^/]+)`;
    }
    return escapeRegexLiteral(segment);
  });
  return new RegExp(`^${parts.join('/')}$`);
}

function extractPathParams(match: RegExpExecArray): Record<string, string> {
  return { ...(match.groups ?? {}) };
}

function combineRouteInput(
  method: HttpMethod,
  payload: unknown,
  pathParams: Record<string, string>,
): unknown {
  if (method === 'GET' || method === 'DELETE') {
    return {
      ...(isRecord(payload) ? payload : {}),
      ...pathParams,
    };
  }

  if (Object.keys(pathParams).length === 0) {
    return payload;
  }

  if (isRecord(payload)) {
    return {
      ...payload,
      ...pathParams,
    };
  }

  return payload;
}

async function parseCatalogRequest(
  spec: RpcMethodSpec<unknown, unknown>,
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  pathParams: Record<string, string>,
): Promise<unknown | typeof REQUEST_PARSE_FAILED> {
  let candidate: unknown;

  if (spec.http.method === 'GET' || spec.http.method === 'DELETE') {
    req.resume();
    candidate = combineRouteInput(spec.http.method, queryParamsToObject(parsedUrl.searchParams), pathParams);
  } else {
    try {
      candidate = combineRouteInput(spec.http.method, await readJsonBody(req), pathParams);
    } catch {
      sendInvalidJson(res);
      return REQUEST_PARSE_FAILED;
    }
  }

  const parsed = spec.requestSchema.safeParse(candidate);
  if (!parsed.success) {
    sendValidationFailure(res, parsed.error);
    return REQUEST_PARSE_FAILED;
  }

  return parsed.data;
}

function sendCatalogResponse(res: ServerResponse, result: { statusCode?: number; body: unknown }): void {
  sendJson(res, result.statusCode ?? 200, result.body);
}

async function handleCatalogUnaryRoute(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  res: ServerResponse,
  deps: HttpHandlerPorts,
): Promise<void> {
  const result = await executeCatalogRequest(spec, request, deps);
  if (result.kind !== 'unary') {
    throw new Error(`Expected unary RPC result for ${spec.name}`);
  }

  sendCatalogResponse(res, result);
}

async function handleJobsWaitSubscription(
  spec: RpcMethodSpec<unknown, unknown>,
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerPorts,
  request: { jobIds: string[]; projectRoot: string; timeoutSeconds?: number; cursor?: { jobs: Record<string, number> } },
): Promise<void> {
  if (request.cursor !== undefined) {
    sendJson(res, 400, { code: 'invalid_request', message: 'Request body cursor is not supported for /jobs/wait' });
    return;
  }

  const lastEventIdHeader = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id'];
  const headerCursor = parseSerializedWaitCursor(lastEventIdHeader);
  if (lastEventIdHeader && !headerCursor) {
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid Last-Event-ID cursor' });
    return;
  }

  const inputCursor = {
    jobs: {
      ...(headerCursor?.jobs ?? {}),
    },
  };
  const currentCursor = {
    jobs: { ...inputCursor.jobs },
  };
  const controller = new AbortController();
  const waitRequest: WaitStreamRequest = {
    ...request,
    cursor: inputCursor,
  };
  const execution = await executeCatalogRequest(spec, waitRequest, deps, controller.signal);
  if (execution.kind !== 'subscription') {
    controller.abort();
    sendCatalogResponse(res, execution);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  deps.events.addResponse(res);

  let closed = false;
  const iterator = execution.notifications[Symbol.asyncIterator]();
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    controller.abort();
    deps.events.removeResponse(res);
    req.off('close', close);
    void iterator.return?.(undefined).catch(() => undefined);
  };
  req.once('close', close);
  runOnResponseDone(res, close);

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done || closed || res.writableEnded || res.destroyed) {
        break;
      }

      const event = next.value as WaitStreamEvent;
      if (event.type === 'progress') {
        currentCursor.jobs[event.jobId] = event.eventId;
        writeSseEvent(res, 'progress', event, serializeWaitCursor(currentCursor));
        continue;
      }

      if (event.type === 'terminal') {
        writeSseEvent(res, 'terminal', event, serializeWaitCursor(currentCursor));
        continue;
      }

      if (event.type === 'queued') {
        // No cursor update: queued events are synthetic (not persisted in JSONL)
        // and must not advance the replay cursor position.
        writeSseEvent(res, 'queued', event);
        continue;
      }

      writeSseEvent(res, 'waiting', event);
    }
  } catch (error) {
    if (!closed && !controller.signal.aborted) {
      throw error;
    }
  } finally {
    close();
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

async function handleCatalogSubscriptionRoute(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerPorts,
): Promise<void> {
  switch (spec.name) {
    case 'jobs.wait':
      await handleJobsWaitSubscription(
        spec,
        req,
        res,
        deps,
        request as { jobIds: string[]; projectRoot: string; timeoutSeconds?: number; cursor?: { jobs: Record<string, number> } },
      );
      return;
    default:
      throw new Error(`Unhandled HTTP subscription route: ${spec.name}`);
  }
}

export function httpAdapter(
  spec: RpcMethodSpec<unknown, unknown>,
  rpcPorts: HttpHandlerPorts,
): ProjectedCatalogBackedHttpRoute {
  const route = {
    method: spec.http.method,
    path: spec.http.path,
    spec,
  } satisfies CatalogBackedHttpRoute;

  return {
    ...route,
    pattern: compilePathPattern(route.path),
    handle: async (req, res, parsedUrl, pathParams) => {
      const parsed = await parseCatalogRequest(spec, req, res, parsedUrl, pathParams);
      if (parsed === REQUEST_PARSE_FAILED) {
        return;
      }

      if (spec.kind === 'subscription') {
        await handleCatalogSubscriptionRoute(spec, parsed, req, res, rpcPorts);
        return;
      }

      await handleCatalogUnaryRoute(spec, parsed, res, rpcPorts);
    },
  };
}

export function buildCoordinatorHttpDispatchTable(
  rpcPorts: HttpHandlerPorts,
): readonly ProjectedCatalogBackedHttpRoute[] {
  return rpcCatalog.map((spec) => httpAdapter(spec, rpcPorts));
}

async function handleEventStream(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerPorts): Promise<void> {
  const streamId = deps.events.createStreamId();
  const filterJobId = parseEventStreamFilter(req.url ?? '');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  deps.events.addResponse(res);
  writeSseEvent(res, 'ready', { streamId, startedAt: deps.events.nowIsoString() });

  let closed = false;
  const matchesFilter = (jobId: string): boolean => !filterJobId || jobId === filterJobId;

  const onCreated: EventStreamHandlers['onJobCreated'] = (payload) => {
    if (closed || !matchesFilter(payload.jobId)) return;
    writeSseEvent(res, 'job:created', payload);
  };
  const onPhaseChanged: EventStreamHandlers['onPhaseChanged'] = (payload) => {
    if (closed || !matchesFilter(payload.jobId)) return;
    writeSseEvent(res, 'job:phase_changed', payload);
  };
  const onProgress: EventStreamHandlers['onProgress'] = (payload) => {
    if (closed || !matchesFilter(payload.jobId)) return;
    writeSseEvent(res, 'job:progress', payload);
  };
  const onCompleted: EventStreamHandlers['onCompleted'] = (payload) => {
    if (closed || !matchesFilter(payload.jobId)) return;
    writeSseEvent(res, 'job:completed', payload);
  };
  const onDiscussUpdated: EventStreamHandlers['onDiscussUpdated'] = (payload) => {
    if (closed) return;
    writeSseEvent(res, 'discuss:updated', payload);
  };
  const cleanup = subscribeAll(deps.events.bus, {
    'job:created': onCreated,
    'job:phase_changed': onPhaseChanged,
    'job:progress': onProgress,
    'job:completed': onCompleted,
    'discuss:updated': onDiscussUpdated,
  });

  const onClose = () => {
    if (closed) return;
    closed = true;
    deps.events.removeResponse(res);
    res.off('close', onClose);
    cleanup();
  };
  res.once('close', onClose);

  await new Promise<void>((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    res.once('close', resolve);
  });
}

function buildTransportLocalRouteTable(deps: HttpHandlerPorts): readonly ProjectedTransportLocalRoute[] {
  return [
    {
      ...transportLocalRoutes[0],
      pattern: compilePathPattern(transportLocalRoutes[0].path),
      requiresRunningLifecycle: false,
      handle: async (_req, res) => {
        sendJson(res, 200, deps.health.read());
      },
    },
    {
      ...transportLocalRoutes[1],
      pattern: compilePathPattern(transportLocalRoutes[1].path),
      requiresRunningLifecycle: false,
      handle: async (req, res) => {
        req.resume();
        deps.admin.requestDrain('replaced');
        sendJson(res, 200, { status: 'draining', instanceId: deps.identity.instanceId });
      },
    },
    {
      ...transportLocalRoutes[2],
      pattern: compilePathPattern(transportLocalRoutes[2].path),
      requiresRunningLifecycle: true,
      handle: async (req, res) => {
        req.resume();
        await handleEventStream(req, res, deps);
      },
    },
  ];
}

function matchRoute<T extends { method: string; pattern: RegExp }>(
  routes: readonly T[],
  method: string | undefined,
  pathname: string,
): { route: T; pathParams: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }

    return {
      route,
      pathParams: extractPathParams(match),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main request dispatcher
// ---------------------------------------------------------------------------

export function createHttpHandler(deps: HttpHandlerPorts): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { identity } = deps;
  const coordinatorRoutes = buildCoordinatorHttpDispatchTable(deps);
  const localRoutes = buildTransportLocalRouteTable(deps);

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const authHeader = req.headers['x-coral-backend-token'];
    if (typeof authHeader !== 'string' || authHeader !== identity.token) {
      req.resume();
      sendJson(res, 401, { code: 'unauthorized', message: 'Unauthorized' });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Coral-Backend-Token, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    if (!req.url) {
      req.resume();
      sendJson(res, 404, { code: 'not_found', message: 'Not found' });
      return;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const localMatch = matchRoute(localRoutes, req.method, parsedUrl.pathname);

    if (localMatch && !localMatch.route.requiresRunningLifecycle) {
      await localMatch.route.handle(req, res, parsedUrl);
      return;
    }

    if (!deps.admin.isLifecycleRunning() || deps.admin.isDrainRequested()) {
      req.resume();
      sendJson(res, 503, { code: 'backend_shutting_down', message: 'Backend shutting down' });
      return;
    }

    if (localMatch) {
      await localMatch.route.handle(req, res, parsedUrl);
      return;
    }

    deps.admin.beginRequest();
    runOnResponseDone(res, () => {
      deps.admin.endRequest();
    });

    const catalogMatch = matchRoute(coordinatorRoutes, req.method, parsedUrl.pathname);
    if (catalogMatch) {
      await catalogMatch.route.handle(req, res, parsedUrl, catalogMatch.pathParams);
      return;
    }

    req.resume();
    sendJson(res, 404, { code: 'not_found', message: 'Not found' });
  };
}
