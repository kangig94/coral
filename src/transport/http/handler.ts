import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z, type ZodError } from 'zod';
import {
  parseSerializedWaitCursor,
  serializeWaitCursor,
  type WaitStreamEvent,
  type WaitStreamRequest,
} from '../../jobs/wait.js';
import { writeAuditEvent } from '../../infra/audit-log.js';
import { isRecord } from '../../infra/json.js';
import { isLoopbackRemoteAddress, normalizeRemoteAddressLiteral } from '../../infra/remote-address.js';
import { executeCatalogRequest } from '../dispatch.js';
import { rpcCatalog, transportOperationalCarveouts, type RpcMethodSpec } from '../rpc/catalog.js';
import { formatZodError } from '../validation.js';
import type { EventStreamHandlers, HttpHandlerPorts } from '../server-ports.js';
import { domainResultToHttp } from '../response.js';
import { subscribeAll } from './sse-subscribe.js';
import type { TimePort } from '../../infra/port-types.js';
import { createRealTimePort } from '../../infra/time.js';

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  if (statusCode >= 500) {
    res.setHeader('Connection', 'close');
  }
  res.end(payload);
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
export const HTTP_MAX_CONCURRENT_BODY_READS = 32;
export const HTTP_BODY_READ_TIMEOUT_MS = 15_000;
const INVALID_JSON_RESPONSE = {
  code: 'invalid_request',
  message: 'Invalid JSON body',
};
const BODY_TOO_LARGE_RESPONSE = {
  code: 'request_body_too_large',
  message: 'Request body too large',
};
const BODY_READ_TIMEOUT_RESPONSE = {
  code: 'request_body_timeout',
  message: 'Request body timed out',
};
const BODY_READ_CAPACITY_RESPONSE = {
  code: 'too_many_request_bodies',
  message: 'Too many concurrent request bodies',
};
const CORS_ALLOWED_HEADERS = 'X-Coral-Backend-Token, X-Coral-Shutdown-Token, Content-Type';
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const KB_DAEMON_HEALTH_PROBE_TTL_MS = 5_000;
const REQUEST_PARSE_FAILED = Symbol('request_parse_failed');
type RestrictedRemoteTransportOption = {
  option: 'bypassPermissions' | 'networkEnv';
  message: string;
};
const eventStreamQuerySchema = z
  .object({
    projectRoot: z.string().min(1, 'Project root is required').optional(),
    filter: z
      .string()
      .regex(/^job:.+$/, 'filter must be job:<jobId>')
      .optional(),
  })
  .passthrough();

function shouldProbeKbDaemonHealth(health: ReturnType<HttpHandlerPorts['health']['read']>, now: number): boolean {
  const kbDaemon = health.kbDaemon;
  if (kbDaemon?.enabled !== true || kbDaemon.phase !== 'online') {
    return false;
  }
  if ((kbDaemon.pendingRequests ?? 0) > 0) {
    return false;
  }
  return kbDaemon.lastHeartbeatAt === undefined || now - kbDaemon.lastHeartbeatAt >= KB_DAEMON_HEALTH_PROBE_TTL_MS;
}

/**
 * Constant-time token comparison. Required for the network gateway because a
 * length-aware byte-by-byte `===` leaks token prefix information through
 * timing. Length differences fall through to `false` immediately — leaking
 * length is acceptable here (tokens are uniform-length identity strings).
 * Spec §11.3.
 */
function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

class HttpBodyReadError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  readonly closeConnection: boolean;

  constructor(
    statusCode: number,
    body: { code: string; message: string },
    options: { closeConnection?: boolean } = {},
  ) {
    super(body.message);
    this.name = 'HttpBodyReadError';
    this.statusCode = statusCode;
    this.body = body;
    this.closeConnection = options.closeConnection === true;
  }
}

export type ReadJsonBodyOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  timers?: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
};

const DEFAULT_BODY_READ_TIMERS: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = createRealTimePort();

let activeBodyReads = 0;

function tryAcquireBodyRead(): (() => void) | null {
  if (activeBodyReads >= HTTP_MAX_CONCURRENT_BODY_READS) {
    return null;
  }
  activeBodyReads += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeBodyReads -= 1;
  };
}

export function readJsonBody(req: IncomingMessage, options: ReadJsonBodyOptions = {}): Promise<unknown> {
  const acquiredBodyRead = tryAcquireBodyRead();
  if (acquiredBodyRead === null) {
    req.resume();
    return Promise.reject(new HttpBodyReadError(503, BODY_READ_CAPACITY_RESPONSE, { closeConnection: true }));
  }
  const releaseBodyRead = acquiredBodyRead;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const maxBytes = options.maxBytes ?? MAX_BODY_SIZE;
    const timeoutMs = options.timeoutMs ?? HTTP_BODY_READ_TIMEOUT_MS;
    const timers = options.timers ?? DEFAULT_BODY_READ_TIMERS;
    let totalSize = 0;
    let settled = false;
    const timeout = timers.setTimeout(() => {
      fail(new HttpBodyReadError(408, BODY_READ_TIMEOUT_RESPONSE, { closeConnection: true }), true);
    }, timeoutMs);
    timeout.unref?.();

    function cleanup() {
      timers.clearTimeout(timeout);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      releaseBodyRead();
    }

    function fail(error: Error, pauseRequest = false) {
      if (settled) return;
      settled = true;
      cleanup();
      if (pauseRequest) {
        req.pause();
      }
      reject(error);
    }

    function succeed(value: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function onData(chunk: Buffer | string) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += buf.length;
      if (totalSize > maxBytes) {
        fail(new HttpBodyReadError(413, BODY_TOO_LARGE_RESPONSE, { closeConnection: true }), true);
        return;
      }
      chunks.push(buf);
    }

    function onError(err: Error) {
      fail(err);
    }

    function onEnd() {
      if (settled) return;
      if (chunks.length === 0) {
        succeed({});
        return;
      }
      try {
        succeed(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
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

export function writeSseEvent(res: ServerResponse, event: string, data: unknown, cursorId?: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  const payload = cursorId
    ? `event: ${event}\nid: ${cursorId}\ndata: ${JSON.stringify(data)}\n\n`
    : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const accepted = res.write(payload);
  if (!accepted && !res.destroyed) {
    res.destroy(new Error('SSE client backpressure exceeded'));
  }
  return accepted;
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

function parseEventStreamRequest(url: string): { projectRoot?: string; filterJobId: string | null } | ZodError {
  const qIndex = url.indexOf('?');
  const params = new URLSearchParams(qIndex === -1 ? '' : url.slice(qIndex));
  const parsed = eventStreamQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return parsed.error;
  }

  return {
    ...(parsed.data.projectRoot === undefined ? {} : { projectRoot: parsed.data.projectRoot }),
    filterJobId: parsed.data.filter?.slice('job:'.length) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

function sendInvalidJson(res: ServerResponse): void {
  sendJson(res, 400, INVALID_JSON_RESPONSE);
}

function sendBodyReadFailure(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (error instanceof HttpBodyReadError) {
    if (error.closeConnection) {
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
      }
      runOnResponseDone(res, () => {
        if (!req.destroyed) {
          req.destroy();
        }
      });
    }
    sendJson(res, error.statusCode, error.body);
    return;
  }
  sendInvalidJson(res);
}

function sendValidationFailure(res: ServerResponse, error: ZodError): void {
  const { message, detail } = formatZodError(error);
  const response = domainResultToHttp({ ok: false, code: 'invalid_request', message, detail });
  sendJson(res, response.statusCode, response.body);
}

function isLoopbackIpv4Literal(value: string): boolean {
  const octets = value.split('.');
  if (octets.length !== 4 || !octets.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const [first, ...rest] = octets.map((part) => Number(part));
  return first === 127 && rest.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }

  return isLoopbackIpv4Literal(normalized);
}

function resolveAllowedCorsOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return isLoopbackHostname(parsed.hostname) ? origin : null;
  } catch {
    return null;
  }
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') {
    return;
  }

  res.setHeader('Vary', 'Origin');
  const allowedOrigin = resolveAllowedCorsOrigin(origin);
  if (allowedOrigin === null) {
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
}

function findRestrictedRemoteTransportOption(request: unknown): RestrictedRemoteTransportOption | null {
  if (!isRecord(request)) {
    return null;
  }
  if (request.bypassPermissions === true) {
    return {
      option: 'bypassPermissions',
      message: '`bypassPermissions` is only allowed from loopback HTTP clients',
    };
  }
  if (Object.prototype.hasOwnProperty.call(request, 'networkEnv') && request.networkEnv !== undefined) {
    return {
      option: 'networkEnv',
      message: '`networkEnv` forwarding is only allowed from loopback HTTP clients',
    };
  }
  return null;
}

function rejectRestrictedRemoteTransportOption(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerPorts,
  request: unknown,
): boolean {
  const socket = req.socket as IncomingMessage['socket'] | undefined;
  if (socket === undefined) {
    return false;
  }

  const remoteAddress = socket.remoteAddress;
  if (isLoopbackRemoteAddress(remoteAddress)) {
    return false;
  }

  const blocked = findRestrictedRemoteTransportOption(request);
  if (blocked === null) {
    return false;
  }

  writeAuditEvent(
    'remote_transport_option_blocked',
    {
      transport: 'http',
      option: blocked.option,
      method: req.method,
      path: req.url,
      instanceId: deps.identity.instanceId,
      remoteAddress,
    },
    'warn',
  );
  sendJson(res, 403, {
    code: 'remote_transport_option_forbidden',
    message: blocked.message,
    detail: { option: blocked.option },
  });
  return true;
}

function rejectDisallowedRemoteAddress(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerPorts): boolean {
  const allowedRemoteAddresses = deps.remoteAccess?.allowedRemoteAddresses;
  if (allowedRemoteAddresses === undefined || allowedRemoteAddresses.length === 0) {
    return false;
  }

  const socket = req.socket as IncomingMessage['socket'] | undefined;
  const remoteAddress = socket?.remoteAddress;
  if (isLoopbackRemoteAddress(remoteAddress)) {
    return false;
  }

  const normalizedRemoteAddress =
    remoteAddress === undefined ? undefined : normalizeRemoteAddressLiteral(remoteAddress);
  if (
    normalizedRemoteAddress !== undefined &&
    allowedRemoteAddresses.some(
      (allowedAddress) => normalizeRemoteAddressLiteral(allowedAddress) === normalizedRemoteAddress,
    )
  ) {
    return false;
  }

  writeAuditEvent(
    'remote_address_blocked',
    {
      transport: 'http',
      method: req.method,
      path: req.url,
      instanceId: deps.identity.instanceId,
      remoteAddress,
      normalizedRemoteAddress,
      allowlistCount: allowedRemoteAddresses.length,
    },
    'warn',
  );
  sendJson(res, 403, {
    code: 'remote_address_forbidden',
    message: 'Remote address is not allowed',
    detail: { remoteAddress },
  });
  return true;
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
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: URL,
    pathParams: Record<string, string>,
  ) => Promise<void>;
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

const [healthPath, shutdownPath, kbRestartPath, eventsStreamPath] = transportOperationalCarveouts;

export const transportLocalRoutes: readonly TransportLocalRoute[] = [
  { method: 'GET', path: healthPath },
  { method: 'POST', path: shutdownPath },
  { method: 'POST', path: kbRestartPath },
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

function isStaticPath(path: string): boolean {
  return !path.split('/').some((segment) => segment.startsWith(':'));
}

function extractPathParams(match: RegExpExecArray): Record<string, string> {
  return { ...(match.groups ?? {}) };
}

function combineRouteInput(method: HttpMethod, payload: unknown, pathParams: Record<string, string>): unknown {
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
  timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> | undefined,
): Promise<unknown | typeof REQUEST_PARSE_FAILED> {
  let candidate: unknown;

  if (spec.http.method === 'GET' || spec.http.method === 'DELETE') {
    req.resume();
    candidate = combineRouteInput(spec.http.method, Object.fromEntries(parsedUrl.searchParams), pathParams);
  } else {
    try {
      candidate = combineRouteInput(spec.http.method, await readJsonBody(req, { timers }), pathParams);
    } catch (error: unknown) {
      sendBodyReadFailure(req, res, error);
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
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerPorts,
): Promise<void> {
  if (rejectRestrictedRemoteTransportOption(req, res, deps, request)) {
    return;
  }

  // interim mapping; future role-auth derives authority from the authenticated principal, not the transport.
  const result = await executeCatalogRequest(spec, request, deps, 'user');
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
  request: { jobIds: string[]; projectRoot: string; timeoutSeconds?: number; cursor?: { afterSeq: number } },
): Promise<void> {
  if (rejectRestrictedRemoteTransportOption(req, res, deps, request)) {
    return;
  }

  if (request.cursor !== undefined) {
    sendJson(res, 400, { code: 'invalid_request', message: 'Request body cursor is not supported for /jobs/wait' });
    return;
  }

  const serializedCursorHeader = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id'];
  const headerCursor = parseSerializedWaitCursor(serializedCursorHeader);
  if (serializedCursorHeader && !headerCursor) {
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid Last-Event-ID cursor' });
    return;
  }

  const inputCursor = headerCursor ?? { afterSeq: 0 };
  const currentCursor = { afterSeq: inputCursor.afterSeq };
  const controller = new AbortController();
  const waitRequest: WaitStreamRequest = {
    ...request,
    cursor: inputCursor,
  };
  // interim mapping; future role-auth derives authority from the authenticated principal, not the transport.
  const execution = await executeCatalogRequest(spec, waitRequest, deps, 'user', controller.signal);
  if (execution.kind !== 'subscription') {
    controller.abort();
    sendCatalogResponse(res, execution);
    return;
  }

  deps.events.addResponse(res);
  if (res.writableEnded || res.destroyed) {
    controller.abort();
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

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
        currentCursor.afterSeq = event.seq;
        if (!writeSseEvent(res, 'progress', event, serializeWaitCursor(currentCursor))) {
          break;
        }
        continue;
      }

      if (event.type === 'terminal') {
        currentCursor.afterSeq = event.seq;
        if (!writeSseEvent(res, 'terminal', event, serializeWaitCursor(currentCursor))) {
          break;
        }
        continue;
      }

      if (event.type === 'queued') {
        // No cursor update: queued events are synthetic and not Journal events.
        if (!writeSseEvent(res, 'queued', event)) {
          break;
        }
        continue;
      }

      if (!writeSseEvent(res, 'waiting', event)) {
        break;
      }
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
        request as { jobIds: string[]; projectRoot: string; timeoutSeconds?: number; cursor?: { afterSeq: number } },
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
      const parsed = await parseCatalogRequest(spec, req, res, parsedUrl, pathParams, rpcPorts.time);
      if (parsed === REQUEST_PARSE_FAILED) {
        return;
      }

      if (spec.kind === 'subscription') {
        await handleCatalogSubscriptionRoute(spec, parsed, req, res, rpcPorts);
        return;
      }

      await handleCatalogUnaryRoute(spec, parsed, req, res, rpcPorts);
    },
  };
}

export type RouteDispatchTable<T extends { method: string; path: string; pattern: RegExp }> = {
  readonly static: ReadonlyMap<string, T>;
  readonly params: readonly T[];
};

function staticRouteKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function buildRouteDispatchTable<T extends { method: string; path: string; pattern: RegExp }>(
  routes: readonly T[],
): RouteDispatchTable<T> {
  const staticMap = new Map<string, T>();
  const params: T[] = [];
  for (const route of routes) {
    if (isStaticPath(route.path)) {
      staticMap.set(staticRouteKey(route.method, route.path), route);
    } else {
      params.push(route);
    }
  }
  return { static: staticMap, params };
}

export function buildCoordinatorHttpDispatchTable(
  rpcPorts: HttpHandlerPorts,
): RouteDispatchTable<ProjectedCatalogBackedHttpRoute> {
  return buildRouteDispatchTable(rpcCatalog.map((spec) => httpAdapter(spec, rpcPorts)));
}

async function handleEventStream(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerPorts): Promise<void> {
  const streamId = deps.events.createStreamId();
  const streamRequest = parseEventStreamRequest(req.url ?? '');
  if (streamRequest instanceof Error) {
    sendValidationFailure(res, streamRequest);
    return;
  }
  const filterJobId = streamRequest.filterJobId;
  const projectRoot = streamRequest.projectRoot ?? null;

  deps.events.addResponse(res);
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  if (!writeSseEvent(res, 'ready', { streamId, startedAt: deps.events.nowIsoString() })) {
    deps.events.removeResponse(res);
    return;
  }

  let closed = false;
  let cleanup: (() => void) | null = null;
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onClose = () => {
    if (closed) return;
    closed = true;
    deps.events.removeResponse(res);
    res.off('close', onClose);
    cleanup?.();
    resolveClosed();
  };
  const writeOrClose = (event: string, payload: unknown): void => {
    if (!writeSseEvent(res, event, payload)) {
      onClose();
    }
  };
  const matchesJobScope = (jobId: string, eventProjectRoot?: string): boolean => {
    // Streams without projectRoot are intentionally suppressed; job events must be project-scoped.
    if (projectRoot === null) return false;
    if (filterJobId !== null && jobId !== filterJobId) return false;
    if (eventProjectRoot !== undefined && eventProjectRoot !== projectRoot) return false;
    const scopeCheck = deps.jobs.scopeCheck([jobId], projectRoot);
    return scopeCheck.missing.length === 0 && scopeCheck.mismatch.length === 0;
  };
  const matchesDiscussScope = (payloadProjectRoot: string): boolean =>
    projectRoot !== null && payloadProjectRoot === projectRoot;

  const onCreated: EventStreamHandlers['onJobCreated'] = (payload) => {
    if (closed || !matchesJobScope(payload.jobId, payload.projectRoot)) return;
    writeOrClose('job:created', payload);
  };
  const onPhaseChanged: EventStreamHandlers['onPhaseChanged'] = (payload) => {
    if (closed || !matchesJobScope(payload.jobId)) return;
    writeOrClose('job:phase_changed', payload);
  };
  const onProgress: EventStreamHandlers['onProgress'] = (payload) => {
    if (closed || !matchesJobScope(payload.jobId)) return;
    writeOrClose('job:progress', payload);
  };
  const onCompleted: EventStreamHandlers['onCompleted'] = (payload) => {
    if (closed || !matchesJobScope(payload.jobId)) return;
    writeOrClose('job:completed', payload);
  };
  const onDiscussUpdated: EventStreamHandlers['onDiscussUpdated'] = (payload) => {
    if (closed || !matchesDiscussScope(payload.projectRoot)) return;
    writeOrClose('discuss:updated', payload);
  };
  cleanup = subscribeAll(deps.events.bus, {
    'job:created': onCreated,
    'job:phase_changed': onPhaseChanged,
    'job:progress': onProgress,
    'job:completed': onCompleted,
    'discuss:updated': onDiscussUpdated,
  });
  res.once('close', onClose);

  await closedPromise;
}

function buildTransportLocalRouteTable(deps: HttpHandlerPorts): RouteDispatchTable<ProjectedTransportLocalRoute> {
  return buildRouteDispatchTable<ProjectedTransportLocalRoute>([
    {
      ...transportLocalRoutes[0],
      pattern: compilePathPattern(transportLocalRoutes[0].path),
      requiresRunningLifecycle: false,
      handle: async (_req, res) => {
        let health = deps.health.read();
        if (shouldProbeKbDaemonHealth(health, deps.identity.now()) && deps.admin.probeKbDaemon) {
          try {
            await deps.admin.probeKbDaemon();
            health = deps.health.read();
          } catch {
            // `/health` must stay available even if the child probe path itself fails.
          }
        }
        sendJson(res, 200, health);
      },
    },
    {
      ...transportLocalRoutes[1],
      pattern: compilePathPattern(transportLocalRoutes[1].path),
      requiresRunningLifecycle: false,
      handle: async (req, res) => {
        req.resume();
        const reason = 'replaced';
        writeAuditEvent(
          'admin_shutdown_requested',
          {
            transport: 'http',
            reason,
            method: req.method,
            path: shutdownPath,
            instanceId: deps.identity.instanceId,
            remoteAddress: req.socket.remoteAddress,
          },
          'warn',
        );
        deps.admin.requestDrain(reason);
        sendJson(res, 200, { status: 'draining', instanceId: deps.identity.instanceId });
      },
    },
    {
      ...transportLocalRoutes[2],
      pattern: compilePathPattern(transportLocalRoutes[2].path),
      requiresRunningLifecycle: true,
      handle: async (req, res) => {
        req.resume();
        if (!deps.admin.restartKbDaemon) {
          sendJson(res, 501, { code: 'not_implemented', message: 'KB daemon supervisor is not available' });
          return;
        }
        writeAuditEvent(
          'admin_kb_daemon_restart_requested',
          {
            transport: 'http',
            reason: 'admin',
            method: req.method,
            path: kbRestartPath,
            instanceId: deps.identity.instanceId,
            remoteAddress: req.socket.remoteAddress,
          },
          'warn',
        );
        const kbDaemon = await deps.admin.restartKbDaemon('http-admin');
        sendJson(res, 200, { status: 'ok', instanceId: deps.identity.instanceId, kbDaemon });
      },
    },
    {
      ...transportLocalRoutes[3],
      pattern: compilePathPattern(transportLocalRoutes[3].path),
      requiresRunningLifecycle: true,
      handle: async (req, res) => {
        req.resume();
        await handleEventStream(req, res, deps);
      },
    },
  ]);
}

function matchRoute<T extends { method: string; path: string; pattern: RegExp }>(
  table: RouteDispatchTable<T>,
  method: string | undefined,
  pathname: string,
): { route: T; pathParams: Record<string, string> } | null {
  if (method === undefined) {
    return null;
  }

  const exact = table.static.get(staticRouteKey(method, pathname));
  if (exact) {
    return { route: exact, pathParams: {} };
  }

  for (const route of table.params) {
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

export function createHttpHandler(
  deps: HttpHandlerPorts,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { identity } = deps;
  const coordinatorRoutes = buildCoordinatorHttpDispatchTable(deps);
  const localRoutes = buildTransportLocalRouteTable(deps);

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (rejectDisallowedRemoteAddress(req, res, deps)) {
      req.resume();
      return;
    }

    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url) {
      req.resume();
      sendJson(res, 404, { code: 'not_found', message: 'Not found' });
      return;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const localMatch = matchRoute(localRoutes, req.method, parsedUrl.pathname);
    const requiresShutdownToken = localMatch?.route.path === shutdownPath || localMatch?.route.path === kbRestartPath;
    const authHeader = requiresShutdownToken
      ? req.headers['x-coral-shutdown-token']
      : req.headers['x-coral-backend-token'];
    const expectedToken = requiresShutdownToken ? identity.shutdownToken : identity.token;
    if (typeof authHeader !== 'string' || !tokensEqual(authHeader, expectedToken)) {
      req.resume();
      sendJson(res, 401, { code: 'unauthorized', message: 'Unauthorized' });
      return;
    }

    if (localMatch && !localMatch.route.requiresRunningLifecycle) {
      await localMatch.route.handle(req, res, parsedUrl);
      return;
    }

    const lifecycleState =
      deps.admin.getLifecycleState?.() ?? (deps.admin.isLifecycleRunning() ? 'running' : 'stopped');
    if (lifecycleState === 'draining' || lifecycleState === 'stopped' || deps.admin.isDrainRequested()) {
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
