declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;
declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isNoEntryError, isRecord, formatError } from '../shared/mcp-utils.js';
import type { ExecutionService } from './service.js';
import { activeChildren, killAllChildren, queueDepth } from './engine.js';
import { writeBackendInfo, removeBackendInfoIfOwner } from './backend-info.js';
import { acquireLock, BackendAlreadyRunningError, removeLockIfOwner } from './backend-lock.js';
import { IdleTimer } from './idle-timer.js';
import type { AbortResult } from './job-manager.js';
import { ProgressStore, JOBS_DIR } from './progress-store.js';
import type { CallerContext, ToolRequest } from './request-context.js';
import { getAllNewProviders, getNewProvider } from '../providers/registry.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import {
  ExecutionService as DefaultExecutionService,
} from './service.js';
import { handleWorkflow } from '../workflow/handler.js';
import type {
  JobPhase,
  PersistedStatusRecord,
  TerminalResult,
  WaitCursor,
  WaitRequest,
  WaitStreamEvent,
} from '../types.js';

export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

type ExecutionServiceLike = Pick<
  ExecutionService,
  'start' | 'resume' | 'fork' | 'coralDispatch' | 'executeWorkflow' | 'list' | 'abort' | 'waitStream'
>;

type ToolRouteResponse = {
  statusCode: number;
  body: unknown;
};

type RouteToolCallFn = (
  request: ToolRequest,
  helpers: {
    getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
    abortJobs: (jobIds: string[]) => AbortResult;
  },
) => Promise<ToolRouteResponse>;

type BackendServerOptions = {
  version?: string;
  instanceId?: string;
  token?: string;
  now?: () => number;
  log?: (message: string) => void;
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (ctx: CallerContext) => ExecutionServiceLike;
  acquireLockFn?: typeof acquireLock;
  writeBackendInfoFn?: typeof writeBackendInfo;
  removeBackendInfoIfOwnerFn?: typeof removeBackendInfoIfOwner;
  removeLockIfOwnerFn?: typeof removeLockIfOwner;
  routeToolCallFn?: RouteToolCallFn;
  closeServerFn?: (server: Server) => Promise<void>;
  recoverOrphanedJobsFn?: () => void;
  markJobsAsErrorFn?: (message: string) => void;
  killAllChildrenFn?: () => void;
  onStopped?: () => void;
  onFatalShutdownError?: (error: unknown) => void;
};

export type BackendServerInfo = {
  port: number;
  token: string;
  version: string;
  instanceId: string;
  startedAt: number;
};

export type BackendServerController = {
  server: Server;
  start: () => Promise<BackendServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
};

const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_POLL_MS = 50;
const ORPHANED_JOB_NOTICE = 'Unclean shutdown - orphaned job';
const CORAL_OP_PREFIX = 'coral:';
const defaultPluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  if (statusCode >= 500 || statusCode === 503) {
    res.setHeader('Connection', 'close');
  }
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.once('error', reject);
    req.once('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseToolRequest(body: unknown): ToolRequest | null {
  if (!isRecord(body)) return null;
  if (typeof body.name !== 'string') return null;
  if (!isRecord(body.args) || !isRecord(body.context)) return null;
  if (typeof body.context.projectRoot !== 'string' || body.context.projectRoot.length === 0) return null;
  if ('pluginRoot' in body.context && body.context.pluginRoot !== undefined && typeof body.context.pluginRoot !== 'string') {
    return null;
  }
  return {
    name: body.name,
    args: body.args,
    context: {
      projectRoot: body.context.projectRoot,
      pluginRoot: typeof body.context.pluginRoot === 'string' ? body.context.pluginRoot : defaultPluginRoot,
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isWaitCursor(value: unknown): value is WaitCursor {
  if (!isRecord(value) || !isRecord(value.jobs)) return false;
  return Object.values(value.jobs).every((eventId) => Number.isInteger(eventId) && (eventId as number) >= 0);
}

function parseWaitRequest(body: unknown): WaitRequest | null {
  if (!isRecord(body)) return null;
  if (!isStringArray(body.jobIds)) return null;
  if ('timeoutSeconds' in body && body.timeoutSeconds !== undefined && typeof body.timeoutSeconds !== 'number') {
    return null;
  }
  if ('cursor' in body && body.cursor !== undefined && !isWaitCursor(body.cursor)) {
    return null;
  }
  return {
    jobIds: body.jobIds,
    timeoutSeconds: typeof body.timeoutSeconds === 'number' ? body.timeoutSeconds : undefined,
    cursor: isWaitCursor(body.cursor) ? body.cursor : undefined,
  };
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

function trackRequest(idleTimer: IdleTimer, res: ServerResponse): void {
  runOnResponseDone(res, () => {
    idleTimer.endRequest();
  });
}

function runAfterResponse(res: ServerResponse, fn: () => void): void {
  runOnResponseDone(res, fn);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

function waitForInflightDrain(idleTimer: IdleTimer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (idleTimer.inflightRequests === 0 || Date.now() >= deadline) {
        clearInterval(interval);
        resolve();
      }
    };

    const interval = setInterval(check, SHUTDOWN_POLL_MS);
    interval.unref?.();
    check();
  });
}

function readJobIds(): string[] {
  try {
    return readdirSync(JOBS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

function listLiveJobs(progressStore: ProgressStore): PersistedStatusRecord[] {
  return readJobIds()
    .map((jobId) => progressStore.readStatus(jobId))
    .filter((status): status is PersistedStatusRecord =>
      status !== null && (status.phase === 'queued' || status.phase === 'launching' || status.phase === 'running'));
}

function markJobAsError(
  progressStore: ProgressStore,
  status: PersistedStatusRecord,
  notice: string,
): void {
  const terminalResult: TerminalResult = status.jobKind === 'workflow'
    ? { content: '', notice, workflow: { steps: [] } }
    : { content: '', notice };
  progressStore.updateLaunchState(status.jobId, 'error', notice);
  if (status.jobKind === 'workflow') {
    progressStore.writeWorkflowResultMdOrThrow(status.jobId, '');
  }
  progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
}

function recoverOrphanedJobs(progressStore: ProgressStore, log: (message: string) => void): void {
  for (const status of listLiveJobs(progressStore)) {
    markJobAsError(progressStore, status, ORPHANED_JOB_NOTICE);
    log(`Recovered orphaned job: ${status.jobId}\n`);
  }
}

function markJobsAsError(progressStore: ProgressStore, message: string): void {
  for (const status of listLiveJobs(progressStore)) {
    markJobAsError(progressStore, status, message);
  }
}

function getToolDescriptors(): Array<Record<string, unknown>> {
  registerBuiltInProviders();

  const providerTools = getAllNewProviders().map((provider) => ({
    name: provider.name,
    description: `Execute prompts with the ${provider.name} provider.`,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string' },
        prompt: { type: 'string' },
        session: { type: 'string' },
        working_directory: { type: 'string' },
      },
      required: ['op'],
    },
  }));

  return [
    ...providerTools,
    {
      name: 'wait',
      description: 'Stream job progress and completion events over POST /wait/stream.',
      inputSchema: {
        type: 'object',
        properties: {
          jobIds: { type: 'array', items: { type: 'string' } },
          timeoutSeconds: { type: 'number' },
          cursor: { type: 'object' },
        },
        required: ['jobIds'],
      },
    },
    {
      name: 'abort',
      description: 'Abort running jobs by job ID.',
      inputSchema: {
        type: 'object',
        properties: {
          jobs: { type: 'array', items: { type: 'string' } },
        },
        required: ['jobs'],
      },
    },
    {
      name: 'workflow',
      description: 'Execute a workflow pipeline across one or more Coral atoms.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
          prompt: { type: 'string' },
          provider: { type: 'string' },
        },
        required: ['expression', 'prompt'],
      },
    },
  ];
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

async function routeToolCall(
  request: ToolRequest,
  helpers: {
    getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
    abortJobs: (jobIds: string[]) => AbortResult;
  },
): Promise<ToolRouteResponse> {
  registerBuiltInProviders();

  if (request.name === 'abort') {
    if (!isStringArray(request.args.jobs)) {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    return { statusCode: 200, body: helpers.abortJobs(request.args.jobs) };
  }

  if (request.name === 'wait') {
    return {
      statusCode: 400,
      body: { error: 'use_sse', message: 'Use POST /wait/stream for wait operations' },
    };
  }

  if (request.name === 'workflow') {
    const svc = helpers.getExecutionService(request.context);
    const decision = await handleWorkflow(request.args, svc as ExecutionService, request.context);
    return { statusCode: 200, body: decision };
  }

  if (!getNewProvider(request.name)) {
    return {
      statusCode: 404,
      body: { error: 'not_found', message: `Unknown tool: ${request.name}` },
    };
  }

  const service = helpers.getExecutionService(request.context);
  const op = requireString(request.args, 'op');
  if (!op) {
    return { statusCode: 400, body: { error: 'invalid_request' } };
  }

  const sessionId = optionalString(request.args, 'session');
  const prompt = optionalString(request.args, 'prompt');
  const defaultCwd = request.context.projectRoot;
  const cwd = optionalString(request.args, 'working_directory');

  if (op === 'list') {
    return { statusCode: 200, body: service.list(request.name) };
  }

  if (op === 'fork') {
    if (!sessionId) {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    return {
      statusCode: 200,
      body: await service.fork(request.name, {
        sessionId,
        prompt,
        cwd,
      }, request.context),
    };
  }

  if (op === 'resume' || (op === 'exec' && sessionId)) {
    if (!sessionId || typeof prompt !== 'string') {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    return {
      statusCode: 200,
      body: await service.resume(request.name, {
        sessionId,
        prompt,
        cwd,
      }, request.context),
    };
  }

  if (op === 'exec') {
    if (typeof prompt !== 'string') {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    return {
      statusCode: 200,
      body: await service.start(request.name, {
        prompt,
        cwd: cwd ?? defaultCwd,
      }, request.context),
    };
  }

  if (op.startsWith(CORAL_OP_PREFIX)) {
    if (typeof prompt !== 'string') {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    return {
      statusCode: 200,
      body: await service.coralDispatch(request.name, op.slice(CORAL_OP_PREFIX.length), {
        prompt,
        sessionId,
        cwd: sessionId ? cwd : cwd ?? defaultCwd,
      }, request.context),
    };
  }

  return { statusCode: 400, body: { error: 'invalid_request' } };
}

function writeSseEvent(
  res: ServerResponse,
  event: 'progress' | 'terminal' | 'timeout' | 'queued',
  data: unknown,
  cursorId?: string,
): void {
  if (cursorId) {
    res.write(`event: ${event}\nid: ${cursorId}\ndata: ${JSON.stringify(data)}\n\n`);
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Backend server failed to bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

export function createBackendServer(options: BackendServerOptions = {}): BackendServerController {
  const version = options.version ?? (typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0');
  const instanceId = options.instanceId ?? randomUUID();
  const token = options.token ?? randomBytes(32).toString('hex');
  const idleTimer = options.createIdleTimer?.() ?? new IdleTimer();
  const progressStore = new ProgressStore();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => {
    process.stderr.write(message);
  });
  const createExecutionService = options.createExecutionService ?? ((ctx: CallerContext) => new DefaultExecutionService(ctx));
  const acquireLockFn = options.acquireLockFn ?? acquireLock;
  const writeBackendInfoFn = options.writeBackendInfoFn ?? writeBackendInfo;
  const removeBackendInfoIfOwnerFn = options.removeBackendInfoIfOwnerFn ?? removeBackendInfoIfOwner;
  const removeLockIfOwnerFn = options.removeLockIfOwnerFn ?? removeLockIfOwner;
  const routeToolCallFn = options.routeToolCallFn ?? routeToolCall;
  const closeServerFn = options.closeServerFn ?? closeServer;
  const recoverOrphanedJobsFn = options.recoverOrphanedJobsFn ?? (() => recoverOrphanedJobs(progressStore, log));
  const markJobsAsErrorFn = options.markJobsAsErrorFn ?? ((message: string) => {
    markJobsAsError(progressStore, message);
  });
  const killAllChildrenFn = options.killAllChildrenFn ?? killAllChildren;

  const services = new Map<string, ExecutionServiceLike>();
  const streamResponses = new Set<ServerResponse>();
  const defaultContext: CallerContext = { projectRoot: process.cwd(), pluginRoot: defaultPluginRoot };

  let startedAt = now();
  let lifecycle: LifecycleState = 'starting';
  let shutdownPromise: Promise<void> | null = null;
  let started = false;

  function getExecutionService(ctx: CallerContext): ExecutionServiceLike {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const created = createExecutionService(ctx);
    services.set(key, created);
    return created;
  }

  function abortJobs(jobIds: string[]): AbortResult {
    const pending = new Set(jobIds);
    const aborted: string[] = [];

    for (const service of services.values()) {
      if (pending.size === 0) break;
      const result = service.abort([...pending]);
      for (const jobId of result.aborted) {
        if (!pending.has(jobId)) continue;
        pending.delete(jobId);
        aborted.push(jobId);
      }
    }

    return { aborted, notFound: [...pending] };
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
        return;
      }
      res.destroy();
    });
  });

  async function shutdown(reason: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      if (lifecycle === 'stopped') return;

      log(`Coral backend shutting down (${reason})...\n`);
      lifecycle = 'draining';
      idleTimer.stopWatching();

      const serverClosed = closeServerFn(server);
      await waitForInflightDrain(idleTimer, SHUTDOWN_DRAIN_TIMEOUT_MS);
      server.closeAllConnections?.();
      for (const stream of streamResponses) {
        stream.end();
      }
      await Promise.race([
        serverClosed,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
      ]);

      markJobsAsErrorFn('Backend shutting down');
      killAllChildrenFn();

      removeBackendInfoIfOwnerFn(instanceId);
      removeLockIfOwnerFn(instanceId);

      lifecycle = 'stopped';
      options.onStopped?.();
    })().catch((error) => {
      lifecycle = 'stopped';
      options.onFatalShutdownError?.(error);
      throw error;
    });

    return shutdownPromise;
  }

  async function handleWaitStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const parsed = parseWaitRequest(body);
    if (!parsed) {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }

    const lastEventIdHeader = Array.isArray(req.headers['last-event-id'])
      ? req.headers['last-event-id'][0]
      : req.headers['last-event-id'];
    const headerCursor = parseLastEventIdCursor(lastEventIdHeader);
    if (lastEventIdHeader && !headerCursor) {
      sendJson(res, 400, { error: 'invalid_request' });
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

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    streamResponses.add(res);

    let closed = false;
    const onClose = () => {
      closed = true;
      streamResponses.delete(res);
      req.off('close', onClose);
      res.off('close', onClose);
    };
    req.once('close', onClose);
    res.once('close', onClose);

    for await (const event of getExecutionService(defaultContext).waitStream(waitRequest)) {
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

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers['x-coral-backend-token'];
    if (typeof authHeader !== 'string' || authHeader !== token) {
      req.resume();
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (lifecycle !== 'running') {
      req.resume();
      sendJson(res, 503, { error: 'backend_shutting_down' });
      return;
    }

    if (req.method === 'POST' && req.url === '/wait/stream') {
      await handleWaitStream(req, res);
      return;
    }

    idleTimer.beginRequest();
    trackRequest(idleTimer, res);

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version,
        instanceId,
        uptimeMs: now() - startedAt,
        activeChildren: activeChildren.size,
        activeJobs: listLiveJobs(progressStore).length,
        queueDepth: queueDepth(),
        inflightRequests: idleTimer.inflightRequests,
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/tools') {
      sendJson(res, 200, getToolDescriptors());
      return;
    }

    if (req.method === 'POST' && req.url === '/tool') {
      let request: ToolRequest | null;
      try {
        request = parseToolRequest(await readJsonBody(req));
      } catch {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      if (!request) {
        sendJson(res, 400, { error: 'invalid_request' });
        return;
      }
      const result = await routeToolCallFn(request, {
        getExecutionService,
        abortJobs,
      });
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/shutdown') {
      req.resume();
      runAfterResponse(res, () => {
        void shutdown('admin').catch(() => {});
      });
      sendJson(res, 200, { status: 'shutting_down' });
      return;
    }

    req.resume();
    sendJson(res, 404, { error: 'not_found' });
  }

  async function start(): Promise<BackendServerInfo> {
    if (started) {
      throw new Error('Backend server already started');
    }

    try {
      await acquireLockFn(instanceId, version);
      recoverOrphanedJobsFn();
      const port = await listen(server);
      startedAt = now();
      writeBackendInfoFn({
        pid: process.pid,
        port,
        token,
        version,
        instanceId,
        startedAt,
      });

      lifecycle = 'running';
      started = true;
      idleTimer.startWatching(
        () => lifecycle === 'running'
          && activeChildren.size === 0
          && listLiveJobs(progressStore).length === 0
          && idleTimer.inflightRequests === 0,
        () => {
          void shutdown('idle').catch(() => {});
        },
      );

      return {
        port,
        token,
        version,
        instanceId,
        startedAt,
      };
    } catch (error: unknown) {
      lifecycle = 'stopped';
      idleTimer.stopWatching();

      try {
        await closeServerFn(server);
      } catch {
        /* best effort */
      }
      removeBackendInfoIfOwnerFn(instanceId);
      removeLockIfOwnerFn(instanceId);

      throw error;
    }
  }

  return {
    server,
    start,
    shutdown,
    waitForShutdown: () => shutdownPromise ?? Promise.resolve(),
    getLifecycle: () => lifecycle,
  };
}

async function main(): Promise<void> {
  const backend = createBackendServer({
    onStopped: () => {
      process.exit(0);
    },
    onFatalShutdownError: (error) => {
      process.stderr.write(`Fatal shutdown error: ${formatError(error)}\n`);
      process.exit(1);
    },
  });

  process.on('SIGTERM', () => {
    void backend.shutdown('sigterm').catch(() => {});
  });
  process.on('SIGINT', () => {
    void backend.shutdown('sigint').catch(() => {});
  });

  try {
    const info = await backend.start();
    process.stderr.write(`Coral backend running on 127.0.0.1:${info.port}\n`);
  } catch (error: unknown) {
    if (error instanceof BackendAlreadyRunningError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(0);
      return;
    }

    process.stderr.write(`Fatal startup error: ${formatError(error)}\n`);
    process.exit(1);
  }
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) {
  void main();
}
