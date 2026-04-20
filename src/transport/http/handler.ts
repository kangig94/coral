/**
 * HTTP request handler for the backend server.
 *
 * Extracted from `createBackendServer()` in server.ts. All closure
 * dependencies are received through the explicit `HttpHandlerPorts` contract
 * defined in contracts.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodError } from 'zod';
import {
  parseSerializedWaitCursor,
  serializeWaitCursor,
  type WaitStreamEvent,
} from '../../jobs/api.js';
import { rpcCatalog, transportOperationalCarveouts } from '../rpc-catalog.js';
import type { RpcMethodSpec } from '../rpc-catalog.js';
import {
  buildCallerContextFromQuery,
  type CallerContext,
  domainError,
  domainResultToHttp,
  formatZodError,
  type EventStreamHandlers,
  type HttpHandlerPorts,
  type JobListFilters,
  launchToHttp,
  queryParamsToObject,
  type ToolDomainResult,
  type WaitStreamRequest,
  type WorkflowPortInput,
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
const BACKEND_RECOVERING_RESPONSE = {
  code: 'backend_recovering',
  message: 'recovering — retry after 500ms',
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

function buildControllerEnv(
  body: Record<string, unknown>,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = { ...coralEnvSnapshot };
  if (typeof body.owner === 'string') {
    env.CORAL_OWNER = body.owner;
  }
  if (typeof body.effort === 'string') {
    env.CORAL_EFFORT = body.effort;
  }
  if (typeof body.claudeModelCap === 'string') {
    env.CORAL_CLAUDE_MODEL_CAP = body.claudeModelCap;
  }
  return env;
}

function buildCallerContext(
  body: Record<string, unknown>,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): CallerContext | null {
  if (typeof body.projectRoot !== 'string' || body.projectRoot.length === 0) {
    return null;
  }
  return {
    projectRoot: body.projectRoot,
    pluginRoot,
    coralEnv: buildControllerEnv(body, coralEnvSnapshot),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function invalidRequestResult(message = 'invalid request', detail?: unknown): ToolDomainResult {
  return domainError('invalid_request', message, detail);
}

function sendToolResult(res: ServerResponse, result: ToolDomainResult, successStatusCode = 200): void {
  const response = domainResultToHttp(result);
  sendJson(res, result.ok ? successStatusCode : response.statusCode, response.body);
}

function sendInvalidJson(res: ServerResponse): void {
  sendJson(res, 400, INVALID_JSON_RESPONSE);
}

function sendValidationFailure(res: ServerResponse, error: ZodError): void {
  const { message, detail } = formatZodError(error);
  const response = domainResultToHttp(invalidRequestResult(message, detail));
  sendJson(res, response.statusCode, response.body);
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function sendInvalidRequestBody(res: ServerResponse): void {
  const response = domainResultToHttp(invalidRequestResult());
  sendJson(res, response.statusCode, response.body);
}

function ensureLaunchFenceInactive(res: ServerResponse, deps: HttpHandlerPorts): boolean {
  if (deps.admin.isLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return false;
  }
  return true;
}

function buildBodyCallerContext(
  res: ServerResponse,
  request: Record<string, unknown>,
  deps: HttpHandlerPorts,
): CallerContext | null {
  const ctx = buildCallerContext(request, deps.identity.pluginRoot, deps.coralEnvSnapshot);
  if (!ctx) {
    sendInvalidRequestBody(res);
    return null;
  }
  return ctx;
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

async function handleCatalogUnaryRoute(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  res: ServerResponse,
  deps: HttpHandlerPorts,
): Promise<void> {
  switch (spec.name) {
    case 'sessions.create': {
      const parsed = request as Record<string, unknown> & {
        provider: string;
        prompt: string;
      };
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const decision = await deps.sessions.start(
        parsed.provider,
        {
          prompt: parsed.prompt,
          ...(typeof parsed.agent === 'string' ? { agent: parsed.agent } : {}),
          ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
          ...(typeof parsed.workDir === 'string' ? { cwd: parsed.workDir } : {}),
          ...(typeof parsed.effort === 'string' ? { effort: parsed.effort } : {}),
          ...(typeof parsed.bypassPermissions === 'boolean' ? { bypassPermissions: parsed.bypassPermissions } : {}),
          ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
        },
        ctx,
      );
      const response = launchToHttp(decision, 201);
      sendJson(res, response.statusCode, response.body);
      return;
    }

    case 'sessions.message': {
      const parsed = request as Record<string, unknown> & {
        sessionId: string;
        prompt: string;
      };
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const decision = await deps.sessions.resumeBySessionId(
        {
          sessionId: parsed.sessionId,
          prompt: parsed.prompt,
          ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
          ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
          ...(typeof parsed.workDir === 'string' ? { cwd: parsed.workDir } : {}),
          ...(typeof parsed.effort === 'string' ? { effort: parsed.effort } : {}),
          ...(typeof parsed.bypassPermissions === 'boolean' ? { bypassPermissions: parsed.bypassPermissions } : {}),
          ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
        },
        ctx,
      );
      const response = launchToHttp(decision, 202);
      sendJson(res, response.statusCode, response.body);
      return;
    }

    case 'sessions.fork': {
      const parsed = request as Record<string, unknown> & {
        sessionId: string;
      };
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const decision = await deps.sessions.forkBySessionId(
        {
          sessionId: parsed.sessionId,
          ...(typeof parsed.prompt === 'string' ? { prompt: parsed.prompt } : {}),
          ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
          ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
          ...(typeof parsed.workDir === 'string' ? { cwd: parsed.workDir } : {}),
          ...(typeof parsed.effort === 'string' ? { effort: parsed.effort } : {}),
          ...(typeof parsed.bypassPermissions === 'boolean' ? { bypassPermissions: parsed.bypassPermissions } : {}),
          ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
        },
        ctx,
      );
      const response = launchToHttp(decision, 201);
      sendJson(res, response.statusCode, response.body);
      return;
    }

    case 'workflow.run': {
      const parsed = request as Record<string, unknown>;
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const { projectRoot: _projectRoot, claudeModelCap: _claudeModelCap, ...workflowCommand } = parsed;
      const result = await deps.workflows.execute(workflowCommand as WorkflowPortInput, ctx);
      if (result.kind === 'invalid_request') {
        const response = domainResultToHttp(invalidRequestResult(result.message, result.detail));
        sendJson(res, response.statusCode, response.body);
        return;
      }

      const response = launchToHttp(result.decision, 202);
      sendJson(res, response.statusCode, response.body);
      return;
    }

    case 'jobs.abort': {
      const parsed = request as { jobs: string[]; projectRoot: string };
      const scopeCheck = deps.jobs.scopeCheck(parsed.jobs, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        const response = domainResultToHttp(
          domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
        );
        sendJson(res, response.statusCode, response.body);
        return;
      }
      if (scopeCheck.missing.length === parsed.jobs.length) {
        sendJson(res, 404, {
          code: 'jobs_not_found',
          message: 'Requested jobs were not found',
          detail: { jobs: parsed.jobs },
        });
        return;
      }

      sendJson(res, 200, deps.jobs.abort(parsed.jobs));
      return;
    }

    case 'jobs.list': {
      const parsed = request as JobListFilters & { provider?: string };
      const jobs = deps.jobs.list({
        ...(parsed.projectRoot === undefined ? {} : { projectRoot: parsed.projectRoot }),
        ...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
        ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
        all: parsed.all === true,
      });
      jobs.sort((left, right) => right.status.launch.updatedAt.localeCompare(left.status.launch.updatedAt));

      sendJson(res, 200, { jobs });
      return;
    }

    case 'jobs.detail': {
      const parsed = request as { jobId: string };
      const detail = deps.jobs.detail(parsed.jobId);
      if (!detail) {
        sendJson(res, 404, { code: 'job_not_found', message: `Job not found: ${parsed.jobId}` });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    case 'discuss.persona.generate': {
      sendToolResult(res, deps.discuss.seed(request), 200);
      return;
    }

    case 'discuss.session.create': {
      const parsed = request as Record<string, unknown>;
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } =
        parsed;
      sendToolResult(res, await deps.discuss.start(args, ctx), 201);
      return;
    }

    case 'discuss.session.list': {
      sendJson(res, 200, { sessions: deps.discuss.listSessions() });
      return;
    }

    case 'discuss.session.detail': {
      const parsed = request as { projectRoot: string; sessionId: string; view?: 'control' | 'audit' };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        deps.identity.pluginRoot,
        deps.coralEnvSnapshot,
      );
      const view = parsed.view ?? 'control';
      const detail = deps.discuss.loadDetail(context.projectRoot, parsed.sessionId, view);
      if (!detail) {
        sendJson(res, 404, { code: 'session_not_found', message: 'Session not found' });
        return;
      }
      if (detail === 'audit_requires_ended_session') {
        sendJson(res, 409, { code: 'audit_requires_ended_session', message: 'Audit requires ended session' });
        return;
      }

      sendJson(res, 200, detail);
      return;
    }

    case 'discuss.session.events': {
      const parsed = request as { sessionId: string; projectRoot: string; cursor?: number };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        deps.identity.pluginRoot,
        deps.coralEnvSnapshot,
      );
      sendToolResult(
        res,
        deps.discuss.watch(
          {
            session: parsed.sessionId,
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          },
          context,
        ),
        200,
      );
      return;
    }

    case 'discuss.session.bid': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const {
        sessionId,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      sendToolResult(
        res,
        await deps.discuss.bid(
          {
            ...args,
            session: sessionId,
          },
          ctx,
        ),
        200,
      );
      return;
    }

    case 'discuss.session.speech': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      if (!ensureLaunchFenceInactive(res, deps)) return;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const {
        sessionId,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      sendToolResult(
        res,
        await deps.discuss.speech(
          {
            ...args,
            session: sessionId,
          },
          ctx,
        ),
        200,
      );
      return;
    }

    case 'discuss.session.delete': {
      const parsed = request as { sessionId: string; projectRoot: string };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        deps.identity.pluginRoot,
        deps.coralEnvSnapshot,
      );
      sendToolResult(res, await deps.discuss.abort({ session: parsed.sessionId }, context), 200);
      return;
    }

    case 'kb.entries.search': {
      const parsed = request as { q: string; scope?: string; top_k?: number };
      sendToolResult(
        res,
        await deps.kb.readSearch({
          query: parsed.q,
          ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
          ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
        }),
        200,
      );
      return;
    }

    case 'kb.note.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(res, deps.kb.readNote(slug), 200);
      return;
    }

    case 'kb.note.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } =
        parsed;
      sendToolResult(res, await deps.kb.createNote(args, ctx), 201);
      return;
    }

    case 'kb.note.update': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }

      const {
        slug: _slug,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      sendToolResult(res, await deps.kb.updateNote({ ...args, note: slug }), 200);
      return;
    }

    case 'kb.note.delete': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(res, await deps.kb.deleteNote(slug), 200);
      return;
    }

    case 'kb.source.list': {
      sendToolResult(res, await deps.kb.listSources(), 200);
      return;
    }

    case 'kb.source.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(res, deps.kb.readSource(slug), 200);
      return;
    }

    case 'kb.source.create': {
      const parsed = request as Record<string, unknown>;
      const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } =
        parsed;
      sendToolResult(res, await deps.kb.createSource(args), 201);
      return;
    }

    case 'kb.source.delete': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(res, await deps.kb.deleteSource(slug), 200);
      return;
    }

    case 'kb.community.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(res, deps.kb.readCommunity(slug), 200);
      return;
    }

    case 'kb.memo.list': {
      const parsed = request as { projectRoot: string; owner?: string };
      sendToolResult(
        res,
        deps.kb.listMemos(
          parsed.owner === undefined ? {} : { owner: parsed.owner },
          buildCallerContextFromQuery(parsed.projectRoot, deps.identity.pluginRoot, deps.coralEnvSnapshot),
        ),
        200,
      );
      return;
    }

    case 'kb.memo.read': {
      const parsed = request as { slug: string; projectRoot: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(
        res,
        deps.kb.readMemo(
          slug,
          buildCallerContextFromQuery(parsed.projectRoot, deps.identity.pluginRoot, deps.coralEnvSnapshot),
        ),
        200,
      );
      return;
    }

    case 'kb.memo.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyCallerContext(res, parsed, deps);
      if (!ctx) return;

      const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } =
        parsed;
      const memoArgs = ctx.coralEnv.CORAL_OWNER === undefined ? args : { ...args, owner: ctx.coralEnv.CORAL_OWNER };
      sendToolResult(res, deps.kb.createMemo(memoArgs, ctx), 201);
      return;
    }

    case 'kb.memo.delete': {
      const parsed = request as { projectRoot: string; pattern?: string; owner?: string; all?: boolean };
      sendToolResult(
        res,
        deps.kb.deleteMemos(
          {
            ...(parsed.pattern === undefined ? {} : { pattern: parsed.pattern }),
            ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
            ...(parsed.all === undefined ? {} : { all: parsed.all }),
          },
          buildCallerContextFromQuery(parsed.projectRoot, deps.identity.pluginRoot, deps.coralEnvSnapshot),
        ),
        200,
      );
      return;
    }

    case 'kb.principles.list': {
      const parsed = request as { q?: string; top_k?: number; verbose?: boolean };
      sendToolResult(
        res,
        await deps.kb.listPrinciples({
          ...(parsed.q === undefined ? {} : { query: parsed.q }),
          ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
          ...(parsed.verbose === undefined ? {} : { verbose: parsed.verbose }),
        }),
        200,
      );
      return;
    }

    case 'kb.principle.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) {
        sendToolResult(res, invalidRequestResult('Invalid KB slug'));
        return;
      }
      sendToolResult(res, deps.kb.readPrinciple(slug), 200);
      return;
    }

    case 'kb.reindex': {
      sendToolResult(res, await deps.kb.reindex(), 200);
      return;
    }

    default:
      throw new Error(`Unhandled HTTP RPC route: ${spec.name}`);
  }
}

async function handleJobsWaitSubscription(
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

  const scopeCheck = deps.jobs.scopeCheck(request.jobIds, request.projectRoot);
  if (scopeCheck.mismatch.length > 0) {
    sendJson(res, 403, {
      code: 'scope_mismatch',
      message: 'Jobs do not belong to this project',
      detail: { jobs: scopeCheck.mismatch },
    });
    return;
  }
  if (scopeCheck.missing.length === request.jobIds.length) {
    sendJson(res, 404, {
      code: 'jobs_not_found',
      message: 'Requested jobs were not found',
      detail: { jobs: scopeCheck.missing },
    });
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
  Object.defineProperty(waitRequest, 'abortSignal', {
    value: controller.signal,
    enumerable: false,
    configurable: true,
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  deps.events.addResponse(res);

  let closed = false;
  const iterator = deps.jobs.waitStream(waitRequest)[Symbol.asyncIterator]();
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

      const event: WaitStreamEvent = next.value;
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
      await handleJobsWaitSubscription(req, res, deps, request as { jobIds: string[]; projectRoot: string; timeoutSeconds?: number; cursor?: { jobs: Record<string, number> } });
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
