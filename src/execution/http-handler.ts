/**
 * HTTP request handler for the backend server.
 *
 * Extracted from `createBackendServer()` in server.ts. All closure
 * dependencies are received through the explicit `HttpHandlerDeps` contract
 * defined in backend-contracts.ts.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { collectCoralEnv, isRecord, nowIsoString } from '../shared/utils.js';
import { resolveProjectSource } from '../infra/paths.js';
import {
  jobAbortSchema,
  jobWaitSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionMessageSchema,
  workflowRequestSchema,
} from '../shared/schemas.js';
import type { CallerContext } from '../shared/request-context.js';
import type { PersistedProgressRecord, PersistedStatusRecord, WaitCursor, WaitRequest } from '../shared/types.js';
import { belongsToNamespace } from '../shared/types.js';
import { createReplayCursor } from './progress-store.js';
import type { ProgressStore } from './progress-store.js';
import type { DiscussView } from '../discuss/views.js';
import type { EventStreamHandlers, HttpHandlerDeps } from './backend-contracts.js';
import {
  handleDiscussAbort,
  handleDiscussBid,
  handleDiscussSeed,
  handleDiscussSpeech,
  handleDiscussStart,
  handleDiscussWatch,
} from './discuss/tools.js';
import {
  handleKbCommunityRead,
  handleKbDelete,
  handleKbMemo,
  handleKbMemoDeleteConsolidated,
  handleKbMemoList,
  handleKbMemoRead,
  handleKbNoteRead,
  handleKbPrincipleRead,
  handleKbPrinciples,
  handleKbPromote,
  handleKbReindex,
  handleKbSearch,
  handleKbSourceDelete,
  handleKbSourceImport,
  handleKbSourceList,
  handleKbSourceRead,
  handleKbUpdate,
} from './kb-tools.js';
import { domainError, domainResultToHttp, launchToHttp, type ToolDomainResult } from './tool-response.js';
import { handleWorkflow as launchWorkflow, isWorkflowInputFailure } from '../workflow/handler.js';
import {
  buildCallerContextFromQuery,
  discussDeleteQuerySchema,
  discussDetailQuerySchema,
  discussEventsQuerySchema,
  kbMemoDeleteQuerySchema,
  kbMemoListQuerySchema,
  kbPrinciplesQuerySchema,
  kbSearchQuerySchema,
  queryParamsToObject,
} from './query-coerce.js';

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

type ParsedDirectBody = {
  ctx: CallerContext;
  args: Record<string, unknown>;
};

function buildControllerEnv(body: Record<string, unknown>): Record<string, string> {
  const env = collectCoralEnv();
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

function buildCallerContext(body: Record<string, unknown>, pluginRoot: string): CallerContext | null {
  if (typeof body.projectRoot !== 'string' || body.projectRoot.length === 0) {
    return null;
  }
  return {
    projectRoot: body.projectRoot,
    pluginRoot,
    coralEnv: buildControllerEnv(body),
  };
}

function parseDirectBody(body: unknown, resolvedPluginRoot: string): ParsedDirectBody | null {
  if (!isRecord(body)) return null;
  if ('owner' in body && body.owner !== undefined && typeof body.owner !== 'string') return null;
  if ('effort' in body && body.effort !== undefined && typeof body.effort !== 'string') return null;
  if ('claudeModelCap' in body && body.claudeModelCap !== undefined && typeof body.claudeModelCap !== 'string') {
    return null;
  }

  const ctx = buildCallerContext(body, resolvedPluginRoot);
  if (!ctx) return null;

  const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } = body;
  return { ctx, args };
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

// ---------------------------------------------------------------------------
// Request parsers
// ---------------------------------------------------------------------------

function isWaitCursor(value: unknown): value is WaitCursor {
  if (!isRecord(value) || !isRecord(value.jobs)) return false;
  return Object.values(value.jobs).every((eventId) => Number.isInteger(eventId) && (eventId as number) >= 0);
}

function parseLastEventIdCursor(raw: string | undefined): WaitCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as unknown;
    return isWaitCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeWaitCursor(cursor: WaitCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
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
// Job read helpers
// ---------------------------------------------------------------------------

export function listAllJobs(
  store: ProgressStore,
  currentNamespace: string,
): Array<{ jobId: string; status: PersistedStatusRecord }> {
  const results: Array<{ jobId: string; status: PersistedStatusRecord }> = [];
  for (const jobId of store.listJobIds()) {
    const status = store.readStatus(jobId);
    if (status && belongsToNamespace(status, currentNamespace)) {
      results.push({ jobId, status });
    }
  }
  return results;
}

export function getJobDetail(
  store: ProgressStore,
  jobId: string,
  currentNamespace: string,
): { status: PersistedStatusRecord; events: PersistedProgressRecord[] } | null {
  const status = store.readStatus(jobId);
  if (!status || !belongsToNamespace(status, currentNamespace)) return null;
  const cursor = createReplayCursor();
  const events = store.replayFrom(jobId, 0, cursor);
  return { status, events };
}

// ---------------------------------------------------------------------------
// Discuss read helpers
// ---------------------------------------------------------------------------

function invalidRequestResult(message = 'invalid request'): ToolDomainResult {
  return domainError('invalid_request', message);
}

function sendToolResult(res: ServerResponse, result: ToolDomainResult, successStatusCode = 200): void {
  const response = domainResultToHttp(result);
  sendJson(res, result.ok ? successStatusCode : response.statusCode, response.body);
}

function sendInvalidJson(res: ServerResponse): void {
  sendJson(res, 400, INVALID_JSON_RESPONSE);
}

function buildReadOnlyCallerContext(pluginRoot: string): CallerContext {
  return {
    projectRoot: '',
    pluginRoot,
    coralEnv: collectCoralEnv(),
  };
}

function requireKbSubsystem(res: ServerResponse, deps: HttpHandlerDeps) {
  const kbSubsystem = deps.runtimeState.getKbSubsystem();
  if (kbSubsystem) {
    return kbSubsystem;
  }

  sendToolResult(
    res,
    domainError('kb_unavailable', 'Knowledge base is not available. Check backend health for details.'),
  );
  return null;
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  match: RegExpExecArray,
  parsedUrl: URL,
) => Promise<void>;

type Route = {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
};

function getRouteParam(match: RegExpExecArray, name: string): string {
  const value = match.groups?.[name];
  if (value === undefined) {
    throw new Error(`Missing route parameter: ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleWaitStream(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  let parsed: ReturnType<typeof jobWaitSchema.parse>;
  try {
    parsed = jobWaitSchema.parse(await readJsonBody(req));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      sendJson(res, 400, { code: 'invalid_request', message: error.message });
      return;
    }
    sendInvalidJson(res);
    return;
  }

  const lastEventIdHeader = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id'];
  const headerCursor = parseLastEventIdCursor(lastEventIdHeader);
  if (lastEventIdHeader && !headerCursor) {
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid Last-Event-ID cursor' });
    return;
  }

  const scopeCheck = deps.scopeCheckJobs(parsed.jobIds, parsed.projectRoot);
  if (scopeCheck.mismatch.length > 0) {
    sendJson(res, 403, {
      code: 'scope_mismatch',
      message: 'Jobs do not belong to this project',
      detail: { jobs: scopeCheck.mismatch },
    });
    return;
  }
  if (scopeCheck.missing.length === parsed.jobIds.length) {
    sendJson(res, 404, {
      code: 'jobs_not_found',
      message: 'Requested jobs were not found',
      detail: { jobs: scopeCheck.missing },
    });
    return;
  }

  const inputCursor: WaitCursor = {
    jobs: { ...(headerCursor ?? parsed.cursor ?? { jobs: {} }).jobs },
  };
  const currentCursor: WaitCursor = {
    jobs: { ...inputCursor.jobs },
  };
  const waitRequest: WaitRequest = {
    ...parsed,
    cursor: inputCursor,
  };
  const ctx = buildCallerContext(parsed, deps.identity.pluginRoot);
  if (!ctx) {
    sendJson(res, 400, { code: 'invalid_request', message: 'Project root is required' });
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  deps.streamResponses.add(res);

  let closed = false;
  const onClose = () => {
    closed = true;
    deps.streamResponses.delete(res);
    req.off('close', onClose);
    res.off('close', onClose);
  };
  req.once('close', onClose);
  res.once('close', onClose);

  for await (const event of deps.getExecutionService(ctx).waitStream(waitRequest)) {
    if (closed || res.writableEnded || res.destroyed) break;

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

    writeSseEvent(res, 'timeout', event);
  }

  if (!closed && !res.writableEnded) {
    res.end();
  }
}

async function handleEventStream(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  const streamId = randomUUID();
  const filterJobId = parseEventStreamFilter(req.url ?? '');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  deps.streamResponses.add(res);
  writeSseEvent(res, 'ready', { streamId, startedAt: nowIsoString() });

  let closed = false;
  const matchesFilter = (jobId: string): boolean => !filterJobId || jobId === filterJobId;

  const handlers: EventStreamHandlers = {
    onJobCreated: (payload) => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:created', payload);
    },
    onPhaseChanged: (payload) => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:phase_changed', payload);
    },
    onProgress: (payload) => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:progress', payload);
    },
    onCompleted: (payload) => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:completed', payload);
    },
    onSessionUpdated: (payload) => {
      if (closed) return;
      writeSseEvent(res, 'session:updated', payload);
    },
    onDiscussUpdated: (payload) => {
      if (closed) return;
      writeSseEvent(res, 'discuss:updated', payload);
    },
  };

  const onClose = () => {
    if (closed) return;
    closed = true;
    deps.streamResponses.delete(res);
    res.off('close', onClose);
    deps.unsubscribeBackendEvents(handlers);
  };
  res.once('close', onClose);

  deps.subscribeBackendEvents(handlers);

  await new Promise<void>((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    res.once('close', resolve);
  });
}

async function handleSessionCreate(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  let parsed: ReturnType<typeof sessionCreateSchema.parse>;
  try {
    parsed = sessionCreateSchema.parse(await readJsonBody(req));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const response = domainResultToHttp(invalidRequestResult(error.message));
      sendJson(res, response.statusCode, response.body);
      return;
    }
    sendInvalidJson(res);
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  const ctx = buildCallerContext(parsed, deps.identity.pluginRoot);
  if (!ctx) {
    const response = domainResultToHttp(invalidRequestResult());
    sendJson(res, response.statusCode, response.body);
    return;
  }

  const decision = await deps.getExecutionService(ctx).start(
    parsed.provider,
    {
      prompt: parsed.prompt,
      agent: parsed.agent,
      model: parsed.model,
      cwd: parsed.workDir,
      bypassPermissions: parsed.bypassPermissions,
      systemPrompt: parsed.systemPrompt,
    },
    ctx,
  );
  const response = launchToHttp(decision, 201);
  sendJson(res, response.statusCode, response.body);
}

async function handleSessionMessage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
): Promise<void> {
  let parsed: ReturnType<typeof sessionMessageSchema.parse>;
  try {
    parsed = sessionMessageSchema.parse(await readJsonBody(req));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const response = domainResultToHttp(invalidRequestResult(error.message));
      sendJson(res, response.statusCode, response.body);
      return;
    }
    sendInvalidJson(res);
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  const ctx = buildCallerContext(parsed, deps.identity.pluginRoot);
  if (!ctx) {
    const response = domainResultToHttp(invalidRequestResult());
    sendJson(res, response.statusCode, response.body);
    return;
  }

  const decision = await deps.getExecutionService(ctx).resumeBySessionId(
    {
      sessionId,
      prompt: parsed.prompt,
      model: parsed.model,
      cwd: parsed.workDir,
      bypassPermissions: parsed.bypassPermissions,
      systemPrompt: parsed.systemPrompt,
    },
    ctx,
  );
  const response = launchToHttp(decision, 202);
  sendJson(res, response.statusCode, response.body);
}

async function handleSessionFork(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
): Promise<void> {
  let parsed: ReturnType<typeof sessionForkSchema.parse>;
  try {
    parsed = sessionForkSchema.parse(await readJsonBody(req));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const response = domainResultToHttp(invalidRequestResult(error.message));
      sendJson(res, response.statusCode, response.body);
      return;
    }
    sendInvalidJson(res);
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  const ctx = buildCallerContext(parsed, deps.identity.pluginRoot);
  if (!ctx) {
    const response = domainResultToHttp(invalidRequestResult());
    sendJson(res, response.statusCode, response.body);
    return;
  }

  const decision = await deps.getExecutionService(ctx).forkBySessionId(
    {
      sessionId,
      prompt: parsed.prompt,
      model: parsed.model,
      cwd: parsed.workDir,
      bypassPermissions: parsed.bypassPermissions,
      systemPrompt: parsed.systemPrompt,
    },
    ctx,
  );
  const response = launchToHttp(decision, 201);
  sendJson(res, response.statusCode, response.body);
}

async function handleWorkflowRequest(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  let parsed: ReturnType<typeof workflowRequestSchema.parse>;
  try {
    parsed = workflowRequestSchema.parse(await readJsonBody(req));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const response = domainResultToHttp(invalidRequestResult(error.message));
      sendJson(res, response.statusCode, response.body);
      return;
    }
    sendInvalidJson(res);
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  const ctx = buildCallerContext(parsed, deps.identity.pluginRoot);
  if (!ctx) {
    const response = domainResultToHttp(invalidRequestResult());
    sendJson(res, response.statusCode, response.body);
    return;
  }

  try {
    const decision = await launchWorkflow(
      {
        expression: parsed.expression,
        start_prompt: parsed.startPrompt,
        ...(parsed.context !== undefined ? { context: parsed.context } : {}),
        ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
        ...(parsed.workDir !== undefined ? { work_dir: parsed.workDir } : {}),
        ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
      },
      deps.getExecutionService(ctx),
      ctx,
      deps.providerRegistry,
    );
    const response = launchToHttp(decision, 202);
    sendJson(res, response.statusCode, response.body);
    return;
  } catch (error: unknown) {
    if (isWorkflowInputFailure(error)) {
      const response = domainResultToHttp(invalidRequestResult(error.message));
      sendJson(res, response.statusCode, response.body);
      return;
    }
    throw error;
  }
}

async function handleAbortRequest(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  let args: ReturnType<typeof jobAbortSchema.parse>;
  try {
    args = jobAbortSchema.parse(await readJsonBody(req));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const response = domainResultToHttp(invalidRequestResult(error.message));
      sendJson(res, response.statusCode, response.body);
      return;
    }
    sendInvalidJson(res);
    return;
  }

  const scopeCheck = deps.scopeCheckJobs(args.jobs, args.projectRoot);
  if (scopeCheck.mismatch.length > 0) {
    const response = domainResultToHttp(
      domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
    );
    sendJson(res, response.statusCode, response.body);
    return;
  }
  if (scopeCheck.missing.length === args.jobs.length) {
    sendJson(res, 404, {
      code: 'jobs_not_found',
      message: 'Requested jobs were not found',
      detail: { jobs: args.jobs },
    });
    return;
  }

  sendJson(res, 200, deps.abortJobs(args.jobs));
}

async function handleDiscussPersonaSets(
  req: IncomingMessage,
  res: ServerResponse,
  _deps: HttpHandlerDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendInvalidJson(res);
    return;
  }

  sendToolResult(res, handleDiscussSeed(body), 200);
}

async function handleDiscussSessionCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  sendToolResult(
    res,
    await handleDiscussStart(request.args, request.ctx, {
      getDiscussContext: deps.getDiscussContext,
    }),
    201,
  );
}

async function handleDiscussSessionDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
  params: URLSearchParams,
): Promise<void> {
  const parsed = discussDetailQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  const context = buildCallerContextFromQuery(parsed.data.projectRoot, deps.identity.pluginRoot);
  const view: DiscussView = parsed.data.view ?? 'control';
  const detail = deps.loadDiscussDetail(resolveProjectSource(context.projectRoot), sessionId, view);
  if (!detail) {
    sendJson(res, 404, { error: 'session_not_found' });
    return;
  }
  if (detail === 'audit_requires_ended_session') {
    sendJson(res, 409, { error: 'audit_requires_ended_session' });
    return;
  }

  sendJson(res, 200, detail);
}

async function handleDiscussEvents(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
  params: URLSearchParams,
): Promise<void> {
  const parsed = discussEventsQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  const context = buildCallerContextFromQuery(parsed.data.projectRoot, deps.identity.pluginRoot);
  const result = handleDiscussWatch(
    {
      session: sessionId,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    },
    context,
    {
      getDiscussContext: deps.getDiscussContext,
    },
  );
  sendToolResult(res, result, 200);
}

async function handleDiscussBidRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  sendToolResult(
    res,
    await handleDiscussBid(
      {
        ...request.args,
        session: sessionId,
      },
      request.ctx,
      {
        getDiscussContext: deps.getDiscussContext,
      },
    ),
    200,
  );
}

async function handleDiscussSpeechRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive()) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  sendToolResult(
    res,
    await handleDiscussSpeech(
      {
        ...request.args,
        session: sessionId,
      },
      request.ctx,
      {
        getDiscussContext: deps.getDiscussContext,
      },
    ),
    200,
  );
}

async function handleDiscussSessionDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  sessionId: string,
  params: URLSearchParams,
): Promise<void> {
  const parsed = discussDeleteQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  const context = buildCallerContextFromQuery(parsed.data.projectRoot, deps.identity.pluginRoot);
  sendToolResult(
    res,
    await handleDiscussAbort({ session: sessionId }, context, {
      getDiscussContext: deps.getDiscussContext,
    }),
    200,
  );
}

async function handleKbEntries(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  params: URLSearchParams,
): Promise<void> {
  const parsed = kbSearchQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(
    res,
    await handleKbSearch(
      {
        query: parsed.data.q,
        ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
        ...(parsed.data.top_k === undefined ? {} : { top_k: parsed.data.top_k }),
      },
      kbSubsystem,
    ),
    200,
  );
}

async function handleKbNoteReadRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  if (!requireKbSubsystem(res, deps)) {
    return;
  }

  sendToolResult(res, handleKbNoteRead(slug, buildReadOnlyCallerContext(deps.identity.pluginRoot)), 200);
}

async function handleKbSourceReadRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, handleKbSourceRead(slug, kbSubsystem), 200);
}

async function handleKbSourceListRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbSourceList({}, kbSubsystem), 200);
}

async function handleKbCommunityReadRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, handleKbCommunityRead(slug, kbSubsystem), 200);
}

async function handleKbMemoReadRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
  params: URLSearchParams,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  const parsed = kbMemoListQuerySchema.pick({ projectRoot: true }).safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  if (!requireKbSubsystem(res, deps)) {
    return;
  }

  sendToolResult(
    res,
    handleKbMemoRead(slug, buildCallerContextFromQuery(parsed.data.projectRoot, deps.identity.pluginRoot)),
    200,
  );
}

async function handleKbMemoListRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  params: URLSearchParams,
): Promise<void> {
  const parsed = kbMemoListQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  if (!requireKbSubsystem(res, deps)) {
    return;
  }

  sendToolResult(
    res,
    handleKbMemoList(
      parsed.data.owner === undefined ? {} : { owner: parsed.data.owner },
      buildCallerContextFromQuery(parsed.data.projectRoot, deps.identity.pluginRoot),
    ),
    200,
  );
}

async function handleKbPrinciplesRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  params: URLSearchParams,
): Promise<void> {
  const parsed = kbPrinciplesQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(
    res,
    await handleKbPrinciples(
      {
        ...(parsed.data.q === undefined ? {} : { query: parsed.data.q }),
        ...(parsed.data.top_k === undefined ? {} : { top_k: parsed.data.top_k }),
        ...(parsed.data.verbose === undefined ? {} : { verbose: parsed.data.verbose }),
      },
      kbSubsystem,
    ),
    200,
  );
}

async function handleKbPrincipleReadRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, handleKbPrincipleRead(slug, kbSubsystem), 200);
}

async function handleKbNoteCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbPromote(request.args, kbSubsystem, request.ctx), 201);
}

async function handleKbSourceCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbSourceImport(request.args, kbSubsystem), 201);
}

async function handleKbMemoCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  if (!requireKbSubsystem(res, deps)) {
    return;
  }

  const args =
    request.ctx.coralEnv.CORAL_OWNER === undefined
      ? request.args
      : { ...request.args, owner: request.ctx.coralEnv.CORAL_OWNER };

  sendToolResult(res, handleKbMemo(args, request.ctx), 201);
}

async function handleKbIndex(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbReindex({}, kbSubsystem), 200);
}

async function handleKbNoteUpdateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendInvalidJson(res);
    return;
  }

  if (!request) {
    sendToolResult(res, invalidRequestResult());
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbUpdate({ ...request.args, note: slug }, kbSubsystem), 200);
}

async function handleKbNoteDeleteRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbDelete({ note: slug }, kbSubsystem), 200);
}

async function handleKbSourceDeleteRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  slugSegment: string,
): Promise<void> {
  const slug = decodePathSegment(slugSegment);
  if (slug === null) {
    sendToolResult(res, invalidRequestResult('Invalid KB slug'));
    return;
  }

  const kbSubsystem = requireKbSubsystem(res, deps);
  if (!kbSubsystem) {
    return;
  }

  sendToolResult(res, await handleKbSourceDelete({ slug }, kbSubsystem), 200);
}

async function handleKbMemoDeleteRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  params: URLSearchParams,
): Promise<void> {
  const parsed = kbMemoDeleteQuerySchema.safeParse(queryParamsToObject(params));
  if (!parsed.success) {
    sendToolResult(res, invalidRequestResult(parsed.error.message));
    return;
  }

  if (!requireKbSubsystem(res, deps)) {
    return;
  }

  sendToolResult(
    res,
    handleKbMemoDeleteConsolidated(
      {
        ...(parsed.data.pattern === undefined ? {} : { pattern: parsed.data.pattern }),
        ...(parsed.data.owner === undefined ? {} : { owner: parsed.data.owner }),
        ...(parsed.data.all === undefined ? {} : { all: parsed.data.all }),
      },
      buildCallerContextFromQuery(parsed.data.projectRoot, deps.identity.pluginRoot),
    ),
    200,
  );
}

async function handleJobListRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  parsedUrl: URL,
): Promise<void> {
  const phase = parsedUrl.searchParams.get('phase');
  let jobs = listAllJobs(deps.progressStore, deps.identity.namespace);
  if (phase !== null) {
    jobs = jobs.filter((job) => job.status?.phase === phase);
  }
  sendJson(res, 200, { jobs });
}

async function handleJobDetailRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  jobId: string,
): Promise<void> {
  const detail = getJobDetail(deps.progressStore, jobId, deps.identity.namespace);
  if (!detail) {
    sendJson(res, 404, { code: 'job_not_found', message: `Job not found: ${jobId}` });
    return;
  }
  sendJson(res, 200, detail);
}

async function handleSessionListRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  const sessions = deps.sessionIndex
    .listForNamespace(deps.identity.namespace, deps.progressStore)
    .flatMap((row) => row.sessions);
  sendJson(res, 200, { sessions });
}

async function handleDiscussSessionListRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  sendJson(res, 200, { sessions: deps.listDiscussSessions() });
}

const routes: Route[] = [
  {
    method: 'POST',
    pattern: /^\/jobs\/wait$/,
    handler: async (req, res, deps) => {
      await handleWaitStream(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/sessions$/,
    handler: async (req, res, deps) => {
      await handleSessionCreate(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/messages$/,
    handler: async (req, res, deps, match) => {
      await handleSessionMessage(req, res, deps, getRouteParam(match, 'sessionId'));
    },
  },
  {
    method: 'POST',
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/forks$/,
    handler: async (req, res, deps, match) => {
      await handleSessionFork(req, res, deps, getRouteParam(match, 'sessionId'));
    },
  },
  {
    method: 'POST',
    pattern: /^\/workflow$/,
    handler: async (req, res, deps) => {
      await handleWorkflowRequest(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/jobs\/abort$/,
    handler: async (req, res, deps) => {
      await handleAbortRequest(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/discuss\/persona-sets$/,
    handler: async (req, res, deps) => {
      await handleDiscussPersonaSets(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/discuss\/sessions$/,
    handler: async (req, res, deps) => {
      await handleDiscussSessionCreate(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/discuss\/sessions\/(?<sessionId>[^/]+)\/bids$/,
    handler: async (req, res, deps, match) => {
      await handleDiscussBidRoute(req, res, deps, getRouteParam(match, 'sessionId'));
    },
  },
  {
    method: 'POST',
    pattern: /^\/discuss\/sessions\/(?<sessionId>[^/]+)\/speeches$/,
    handler: async (req, res, deps, match) => {
      await handleDiscussSpeechRoute(req, res, deps, getRouteParam(match, 'sessionId'));
    },
  },
  {
    method: 'POST',
    pattern: /^\/kb\/notes$/,
    handler: async (req, res, deps) => {
      await handleKbNoteCreate(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/kb\/sources$/,
    handler: async (req, res, deps) => {
      await handleKbSourceCreate(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/kb\/memos$/,
    handler: async (req, res, deps) => {
      await handleKbMemoCreate(req, res, deps);
    },
  },
  {
    method: 'POST',
    pattern: /^\/kb\/index$/,
    handler: async (req, res, deps) => {
      await handleKbIndex(req, res, deps);
    },
  },
  {
    method: 'PUT',
    pattern: /^\/kb\/notes\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      await handleKbNoteUpdateRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/jobs$/,
    handler: async (req, res, deps, _match, parsedUrl) => {
      req.resume();
      await handleJobListRoute(req, res, deps, parsedUrl);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/jobs\/(?<jobId>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleJobDetailRoute(req, res, deps, getRouteParam(match, 'jobId'));
    },
  },
  {
    method: 'GET',
    pattern: /^\/sessions$/,
    handler: async (req, res, deps) => {
      req.resume();
      await handleSessionListRoute(req, res, deps);
    },
  },
  {
    method: 'GET',
    pattern: /^\/discuss\/sessions$/,
    handler: async (req, res, deps) => {
      req.resume();
      await handleDiscussSessionListRoute(req, res, deps);
    },
  },
  {
    method: 'GET',
    pattern: /^\/discuss\/sessions\/(?<sessionId>[^/]+)\/events$/,
    handler: async (req, res, deps, match, parsedUrl) => {
      req.resume();
      await handleDiscussEvents(req, res, deps, getRouteParam(match, 'sessionId'), parsedUrl.searchParams);
    },
  },
  {
    method: 'GET',
    pattern: /^\/discuss\/sessions\/(?<sessionId>[^/]+)$/,
    handler: async (req, res, deps, match, parsedUrl) => {
      req.resume();
      await handleDiscussSessionDetail(req, res, deps, getRouteParam(match, 'sessionId'), parsedUrl.searchParams);
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/entries$/,
    handler: async (req, res, deps, _match, parsedUrl) => {
      req.resume();
      await handleKbEntries(req, res, deps, parsedUrl.searchParams);
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/notes\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleKbNoteReadRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/sources$/,
    handler: async (req, res, deps) => {
      req.resume();
      await handleKbSourceListRoute(req, res, deps);
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/sources\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleKbSourceReadRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/communities\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleKbCommunityReadRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/memos$/,
    handler: async (req, res, deps, _match, parsedUrl) => {
      req.resume();
      await handleKbMemoListRoute(req, res, deps, parsedUrl.searchParams);
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/memos\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match, parsedUrl) => {
      req.resume();
      await handleKbMemoReadRoute(req, res, deps, getRouteParam(match, 'slug'), parsedUrl.searchParams);
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/principles$/,
    handler: async (req, res, deps, _match, parsedUrl) => {
      req.resume();
      await handleKbPrinciplesRoute(req, res, deps, parsedUrl.searchParams);
    },
  },
  {
    method: 'GET',
    pattern: /^\/kb\/principles\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleKbPrincipleReadRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/discuss\/sessions\/(?<sessionId>[^/]+)$/,
    handler: async (req, res, deps, match, parsedUrl) => {
      req.resume();
      await handleDiscussSessionDelete(req, res, deps, getRouteParam(match, 'sessionId'), parsedUrl.searchParams);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/kb\/notes\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleKbNoteDeleteRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/kb\/sources\/(?<slug>[^/]+)$/,
    handler: async (req, res, deps, match) => {
      req.resume();
      await handleKbSourceDeleteRoute(req, res, deps, getRouteParam(match, 'slug'));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/kb\/memos$/,
    handler: async (req, res, deps, _match, parsedUrl) => {
      req.resume();
      await handleKbMemoDeleteRoute(req, res, deps, parsedUrl.searchParams);
    },
  },
];

// ---------------------------------------------------------------------------
// Main request dispatcher
// ---------------------------------------------------------------------------

export function createHttpHandler(deps: HttpHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { identity, runtimeState, idleTimer, progressStore } = deps;

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Coral-Backend-Token, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const authHeader = req.headers['x-coral-backend-token'];
    if (typeof authHeader !== 'string' || authHeader !== identity.token) {
      req.resume();
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const env = collectCoralEnv();
      const lifecycleState = runtimeState.getLifecycle();
      let status: string = lifecycleState;
      if (idleTimer.isDraining) {
        status = 'draining';
      } else if (lifecycleState === 'running') {
        status = 'ok';
      }

      const kbInitError = runtimeState.getKbInitError();
      sendJson(res, 200, {
        status,
        version: identity.version,
        bundleHash: identity.bundleHash,
        flavor: identity.flavor,
        namespace: identity.namespace,
        instanceId: identity.instanceId,
        uptimeMs: identity.now() - runtimeState.getStartedAt(),
        active: deps.activeLaunchCount(),
        activeJobs: progressStore.liveJobCountByNamespace(identity.namespace),
        liveDiscuss: deps.liveDiscussCount(),
        queueDepth: deps.queueDepth(),
        inflightRequests: idleTimer.inflightRequests,
        subsystems: {
          kb: kbInitError === null ? 'ok' : 'unavailable',
          ...(kbInitError !== null ? { kbError: kbInitError } : {}),
          discuss: 'ok',
        },
        env,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/shutdown') {
      req.resume();
      // Flip drain fence immediately, before lifecycle transitions.
      // This closes the race window where requests slip through between requestDrain()
      // and lifecycle = 'draining'.
      deps.requestDrain('replaced');
      sendJson(res, 200, { status: 'draining', instanceId: identity.instanceId });
      return;
    }

    // Drain admission fence: reject work-admitting requests as soon as drain is requested,
    // even before lifecycle transitions to 'draining'.
    if (runtimeState.getLifecycle() !== 'running' || deps.isDrainRequested()) {
      req.resume();
      sendJson(res, 503, { error: 'backend_shutting_down' });
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/events/stream')) {
      req.resume();
      await handleEventStream(req, res, deps);
      return;
    }

    idleTimer.beginRequest();
    runOnResponseDone(res, () => {
      idleTimer.endRequest();
    });

    if (!req.url) {
      req.resume();
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const { pathname } = parsedUrl;

    for (const route of routes) {
      if (req.method !== route.method) {
        continue;
      }

      const match = route.pattern.exec(pathname);
      if (!match) {
        continue;
      }

      await route.handler(req, res, deps, match, parsedUrl);
      return;
    }

    req.resume();
    sendJson(res, 404, { error: 'not_found' });
  };
}
