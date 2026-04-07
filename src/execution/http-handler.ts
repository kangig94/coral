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
import type { CallerContext } from './request-context.js';
import type { PersistedProgressRecord, PersistedStatusRecord, WaitCursor, WaitRequest } from '../shared/types.js';
import { belongsToNamespace } from '../shared/types.js';
import { createReplayCursor } from './progress-store.js';
import type { ProgressStore } from './progress-store.js';
import type { DiscussView } from '../discuss/views.js';
import type { EventStreamHandlers, HttpHandlerDeps } from './backend-contracts.js';
import {
  handleDiscussAbort,
  handleDiscussParticipate,
  handleDiscussSeed,
  handleDiscussStart,
  handleDiscussWatch,
} from './discuss-tools.js';
import {
  handleKbDelete,
  handleKbMemo,
  handleKbMemoDelete,
  handleKbMemoList,
  handleKbMemoPurge,
  handleKbPrinciples,
  handleKbPromote,
  handleKbRead,
  handleKbReindex,
  handleKbSearch,
  handleKbSourceDelete,
  handleKbSourceImport,
  handleKbSourceList,
  handleKbUpdate,
} from './kb-tools.js';
import {
  domainError,
  domainResultToHttp,
  launchToHttp,
  type ToolDomainResult,
} from './tool-response.js';
import { handleWorkflow as launchWorkflow, isWorkflowInputFailure } from '../workflow/handler.js';

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
// Discuss read helpers (used by /api/discuss and /api/discuss/detail)
// ---------------------------------------------------------------------------

export function parseDiscussView(raw: string | null): DiscussView | null {
  if (raw === null || raw === 'control') {
    return 'control';
  }
  if (raw === 'audit') {
    return 'audit';
  }
  return null;
}

function invalidRequestResult(message = 'invalid request'): ToolDomainResult {
  return domainError('invalid_request', message);
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
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
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
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
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
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
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
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
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
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
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
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
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

async function handleDiscussRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  action: string,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
    return;
  }

  if (!request) {
    const response = domainResultToHttp(invalidRequestResult());
    sendJson(res, response.statusCode, response.body);
    return;
  }

  if (deps.runtimeState.getLaunchFenceActive() && (action === 'start' || action === 'participate')) {
    sendJson(res, 503, BACKEND_RECOVERING_RESPONSE);
    return;
  }

  const helpers = {
    getDiscussContext: deps.getDiscussContext,
  };

  let result: ToolDomainResult;
  switch (action) {
    case 'seed':
      result = handleDiscussSeed(request.args);
      break;
    case 'start':
      result = await handleDiscussStart(request.args, request.ctx, helpers);
      break;
    case 'abort':
      result = await handleDiscussAbort(request.args, request.ctx, helpers);
      break;
    case 'watch':
      result = handleDiscussWatch(request.args, request.ctx, helpers);
      break;
    case 'participate':
      result = await handleDiscussParticipate(request.args, request.ctx, helpers);
      break;
    default:
      {
        const response = domainResultToHttp(domainError('not_found', `Unknown discuss action: ${action}`));
        sendJson(res, response.statusCode, response.body);
      }
      return;
  }

  const response = domainResultToHttp(result);
  sendJson(res, response.statusCode, response.body);
}

async function handleKbRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  action: string,
): Promise<void> {
  let request: ParsedDirectBody | null;
  try {
    request = parseDirectBody(await readJsonBody(req), deps.identity.pluginRoot);
  } catch {
    sendJson(res, 400, { code: 'invalid_request', message: 'Invalid JSON body' });
    return;
  }

  if (!request) {
    const response = domainResultToHttp(invalidRequestResult());
    sendJson(res, response.statusCode, response.body);
    return;
  }

  const kbSubsystem = deps.runtimeState.getKbSubsystem();
  if (!kbSubsystem) {
    const response = domainResultToHttp(
      domainError('kb_unavailable', 'Knowledge base is not available. Check backend health for details.'),
    );
    sendJson(res, response.statusCode, response.body);
    return;
  }

  let result: ToolDomainResult;
  switch (action) {
    case 'search':
      result = await handleKbSearch(request.args, kbSubsystem);
      break;
    case 'read':
      result = handleKbRead(request.args, request.ctx);
      break;
    case 'promote':
      result = await handleKbPromote(request.args, kbSubsystem, request.ctx);
      break;
    case 'update':
      result = await handleKbUpdate(request.args, kbSubsystem);
      break;
    case 'delete':
      result = await handleKbDelete(request.args, kbSubsystem);
      break;
    case 'source-import':
      result = await handleKbSourceImport(request.args, kbSubsystem);
      break;
    case 'source-list':
      result = await handleKbSourceList(request.args, kbSubsystem);
      break;
    case 'source-delete':
      result = await handleKbSourceDelete(request.args, kbSubsystem);
      break;
    case 'reindex':
      result = await handleKbReindex(request.args, kbSubsystem);
      break;
    case 'principles':
      result = await handleKbPrinciples(request.args, kbSubsystem);
      break;
    case 'memo':
      result = handleKbMemo(request.args, request.ctx);
      break;
    case 'memo-list':
      result = handleKbMemoList(request.args, request.ctx);
      break;
    case 'memo-delete':
      result = handleKbMemoDelete(request.args, request.ctx);
      break;
    case 'memo-purge':
      result = handleKbMemoPurge(request.args, request.ctx);
      break;
    default: {
      const response = domainResultToHttp(domainError('unknown_tool', `Unknown KB action: ${action}`));
      sendJson(res, response.statusCode, response.body);
      return;
    }
  }

  const response = domainResultToHttp(result);
  sendJson(res, response.statusCode, response.body);
}

// ---------------------------------------------------------------------------
// Main request dispatcher
// ---------------------------------------------------------------------------

export function createHttpHandler(deps: HttpHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { identity, runtimeState, idleTimer, progressStore, sessionIndex } = deps;

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Coral-Backend-Token, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

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
      const status = idleTimer.isDraining ? 'draining' : lifecycleState === 'running' ? 'ok' : lifecycleState;

      const kbInitError = runtimeState.getKbInitError();
      sendJson(res, 200, {
        status,
        version: identity.version,
        bundleHash: identity.bundleHash,
        namespace: identity.namespace,
        instanceId: identity.instanceId,
        uptimeMs: identity.now() - runtimeState.getStartedAt(),
        active: deps.activeLaunchCount(),
        activeJobs: progressStore.liveJobCount(identity.bundleHash),
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

    if (req.method === 'POST' && req.url === '/jobs/wait') {
      await handleWaitStream(req, res, deps);
      return;
    }

    if (req.method === 'POST' && req.url) {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (pathname === '/sessions') {
        await handleSessionCreate(req, res, deps);
        return;
      }

      const sessionMessageMatch = pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (sessionMessageMatch) {
        await handleSessionMessage(req, res, deps, sessionMessageMatch[1]);
        return;
      }

      const sessionForkMatch = pathname.match(/^\/sessions\/([^/]+)\/forks$/);
      if (sessionForkMatch) {
        await handleSessionFork(req, res, deps, sessionForkMatch[1]);
        return;
      }

      if (pathname === '/workflow') {
        await handleWorkflowRequest(req, res, deps);
        return;
      }

      if (pathname === '/jobs/abort') {
        await handleAbortRequest(req, res, deps);
        return;
      }

      const discussMatch = pathname.match(/^\/discuss\/([^/]+)$/);
      if (discussMatch) {
        await handleDiscussRequest(req, res, deps, discussMatch[1]);
        return;
      }

      const kbMatch = pathname.match(/^\/kb\/([^/]+)$/);
      if (kbMatch) {
        await handleKbRequest(req, res, deps, kbMatch[1]);
        return;
      }
    }

    if (req.method === 'GET' && req.url) {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (pathname === '/api/jobs') {
        req.resume();
        const phase = parsedUrl.searchParams.get('phase');
        let jobs = listAllJobs(progressStore, identity.namespace);
        if (phase !== null) {
          jobs = jobs.filter((j) => j.status?.phase === phase);
        }
        sendJson(res, 200, { jobs });
        return;
      }

      const jobDetailMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobDetailMatch) {
        req.resume();
        const detail = getJobDetail(progressStore, jobDetailMatch[1], identity.namespace);
        if (!detail) {
          sendJson(res, 404, { code: 'job_not_found', message: `Job not found: ${jobDetailMatch[1]}` });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      if (pathname === '/sessions') {
        req.resume();
        const sessions = sessionIndex
          .listForNamespace(identity.namespace, progressStore)
          .flatMap((row) => row.sessions);
        sendJson(res, 200, { sessions });
        return;
      }

      if (pathname === '/api/discuss') {
        req.resume();
        sendJson(res, 200, { sessions: deps.listDiscussSessions() });
        return;
      }

      if (pathname === '/api/discuss/detail') {
        req.resume();
        const projectRoot = parsedUrl.searchParams.get('projectRoot');
        const sessionIdParam = parsedUrl.searchParams.get('sessionId');
        if (!projectRoot || !sessionIdParam) {
          sendJson(res, 400, { error: 'missing_params', message: 'projectRoot and sessionId are required' });
          return;
        }
        const view = parseDiscussView(parsedUrl.searchParams.get('view'));
        if (!view) {
          sendJson(res, 400, { error: 'invalid_view', message: 'view must be control or audit' });
          return;
        }
        const detail = deps.loadDiscussDetail(resolveProjectSource(projectRoot), sessionIdParam, view);
        if (!detail) {
          sendJson(res, 404, { error: 'session_not_found' });
          return;
        }
        if (detail === 'audit_requires_ended_session') {
          sendJson(res, 409, { error: 'audit_requires_ended_session' });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }
    }

    req.resume();
    sendJson(res, 404, { error: 'not_found' });
  };
}
