declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;
declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isNoEntryError, isRecord, formatError, providerIdentPattern, readBundleHash } from '../shared/mcp-utils.js';
import { sharedExecSchema, sharedForkSchema, sharedResumeSchema } from '../shared/schemas.js';
import type { ExecutionService } from './service.js';
import { activeChildren, killAllChildren, queueDepth } from './engine.js';
import { writeBackendInfo, removeBackendInfoIfOwner } from './backend-info.js';
import { acquireLock, BackendAlreadyRunningError, removeLockIfOwner } from './backend-lock.js';
import type { AbortResult } from './abort-registry.js';
import { DiscussBridge, type DiscussMachineEvent } from './discuss-bridge.js';
import { eventBus, type EventBusEvents } from './event-bus.js';
import { IdleTimer } from './idle-timer.js';
import { createReplayCursor, ProgressStore, JOBS_DIR } from './progress-store.js';
import type { CallerContext, ToolRequest } from './request-context.js';
import { SessionManager, type SessionEntry } from './session-manager.js';
import { readSessionEntryLenient, readDiscussState, type LenientSessionEntry } from '../client/readers.js';
import { discussBaseDir } from '../client/paths.js';
import { getAllNewProviders, getNewProvider } from '../providers/registry.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import {
  ExecutionService as DefaultExecutionService,
} from './service.js';
import { handleWorkflow } from '../workflow/handler.js';
import type {
  JobPhase,
  PersistedProgressRecord,
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

type ParsedWaitRequest = WaitRequest & { projectRoot: string };
type ScopeCheckResult = {
  valid: string[];
  missing: string[];
  mismatch: string[];
};

type RouteToolCallFn = (
  request: ToolRequest,
  helpers: {
    getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
    abortJobs: (jobIds: string[]) => AbortResult;
    scopeCheckJobs: (jobIds: string[], projectRoot: string) => ScopeCheckResult;
  },
) => Promise<ToolRouteResponse>;

type BackendServerOptions = {
  progressStore?: ProgressStore;
  version?: string;
  bundleHash?: string;
  instanceId?: string;
  token?: string;
  now?: () => number;
  log?: (message: string) => void;
  createIdleTimer?: () => IdleTimer;
  createExecutionService?: (ctx: CallerContext) => ExecutionServiceLike;
  acquireLockFn?: (instanceId: string, version: string, bundleHash: string) => Promise<void>;
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
  host: string;
  token: string;
  version: string;
  bundleHash: string;
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

function parseWaitRequest(body: unknown): ParsedWaitRequest | null {
  if (!isRecord(body)) return null;
  if (!isStringArray(body.jobIds)) return null;
  if (typeof body.projectRoot !== 'string' || body.projectRoot.length === 0) return null;
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
    projectRoot: body.projectRoot,
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

function hasJobDir(progressStore: ProgressStore, jobId: string): boolean {
  try {
    readdirSync(progressStore.jobDir(jobId));
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

function readSessionRefs(shardDir: string): Array<{ sessionId: string; provider: string }> {
  try {
    return readdirSync(shardDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const raw = readFileSync(join(shardDir, entry.name), 'utf-8');
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) return [];
          if (typeof parsed.sessionId !== 'string' || typeof parsed.provider !== 'string') return [];
          return [{ sessionId: parsed.sessionId, provider: parsed.provider }];
        } catch (error: unknown) {
          if (isNoEntryError(error) || error instanceof SyntaxError) return [];
          throw error;
        }
      });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

function markJobAsError(
  progressStore: ProgressStore,
  status: PersistedStatusRecord,
  notice: string,
  log: (message: string) => void,
): void {
  const terminalResult: TerminalResult = status.jobKind === 'workflow'
    ? { content: '', notice, workflow: { steps: [] } }
    : { content: '', notice };
  progressStore.updateLaunchState(status.jobId, 'error', notice);
  if (status.jobKind === 'workflow') {
    try {
      progressStore.writeWorkflowResultMdOrThrow(status.jobId, '');
    } catch (err) {
      log(`Failed to write workflow result for ${status.jobId}: ${formatError(err)}\n`);
    }
  }
  try {
    progressStore.appendTerminal(status.jobId, status.sessionId, terminalResult, 'error');
  } catch {
    progressStore.markTerminalStatus(status.jobId, status.sessionId, terminalResult, 'error');
  }
}

function recoverOrphanedJobs(progressStore: ProgressStore, log: (message: string) => void): void {
  for (const shardDir of SessionManager.listShards()) {
    try {
      const sessionManager = SessionManager.openShard(shardDir);
      for (const sessionRef of readSessionRefs(shardDir)) {
        try {
          const session = sessionManager.get(sessionRef.provider, sessionRef.sessionId);
          if (!session?.activeJobId) continue;
          if (hasJobDir(progressStore, session.activeJobId)) continue;
          sessionManager.releaseJob(session.sessionId, session.activeJobId);
          log(`Recovered orphaned session claim: ${session.sessionId}\n`);
        } catch (err) {
          log(`Failed to recover orphaned session ${sessionRef.sessionId}: ${formatError(err)}\n`);
        }
      }
    } catch (err) {
      log(`Failed to scan session shard ${shardDir}: ${formatError(err)}\n`);
    }
  }

  for (const status of listLiveJobs(progressStore)) {
    try {
      markJobAsError(progressStore, status, ORPHANED_JOB_NOTICE, log);
      const sessionManager = new SessionManager(status.projectRoot);
      sessionManager.releaseJob(status.sessionId, status.jobId);
      log(`Recovered orphaned job: ${status.jobId}\n`);
    } catch (err) {
      log(`Failed to recover orphaned job ${status.jobId}: ${formatError(err)}\n`);
    }
  }
}

function markJobsAsError(progressStore: ProgressStore, message: string): void {
  for (const status of listLiveJobs(progressStore)) {
    try {
      markJobAsError(progressStore, status, message, () => {});
    } catch {
      // fail-isolated: skip this job, continue with others
    }
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
        work_dir: { type: 'string' },
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
          expression: { type: 'string', description: 'Pipeline DSL expression' },
          init_prompt: { type: 'string', description: 'Initial prompt fed to the first step' },
          context: { type: 'string', description: 'Shared context prepended to every atom prompt in every step' },
          provider: { type: 'string', description: 'Default provider for atoms (claude or codex)' },
          work_dir: { type: 'string', description: 'Working directory for spawned atoms' },
        },
        required: ['expression', 'init_prompt'],
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

async function routeToolCall(
  request: ToolRequest,
  helpers: {
    getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
    abortJobs: (jobIds: string[]) => AbortResult;
    scopeCheckJobs: (jobIds: string[], projectRoot: string) => ScopeCheckResult;
  },
): Promise<ToolRouteResponse> {
  registerBuiltInProviders();

  if (request.name === 'abort') {
    if (!isStringArray(request.args.jobs)) {
      return { statusCode: 400, body: { error: 'invalid_request' } };
    }
    const scopeCheck = helpers.scopeCheckJobs(request.args.jobs, request.context.projectRoot);
    if (scopeCheck.mismatch.length > 0) {
      return { statusCode: 403, body: { error: 'scope_mismatch', jobs: scopeCheck.mismatch } };
    }
    return { statusCode: 200, body: helpers.abortJobs(scopeCheck.valid) };
  }

  if (request.name === 'wait') {
    return {
      statusCode: 400,
      body: { error: 'use_sse', message: 'Use POST /wait/stream for wait operations' },
    };
  }

  if (request.name === 'workflow') {
    const svc = helpers.getExecutionService(request.context);
    const decision = await handleWorkflow(request.args, svc, request.context);
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
  const cwd = optionalString(request.args, 'work_dir');

  if (op === 'list') {
    return { statusCode: 200, body: service.list(request.name) };
  }

  if (op === 'fork') {
    const parsed = sharedForkSchema.safeParse(request.args);
    if (!parsed.success) return { statusCode: 400, body: { error: 'invalid_request' } };
    return {
      statusCode: 200,
      body: await service.fork(request.name, {
        sessionId: parsed.data.session,
        prompt: parsed.data.prompt,
        cwd: parsed.data.work_dir,
        model: parsed.data.model,

        bypassPermissions: parsed.data.bypass_permissions ?? false,
        systemPrompt: parsed.data.system_prompt,
      }, request.context),
    };
  }

  if (op === 'resume') {
    const parsed = sharedResumeSchema.safeParse(request.args);
    if (!parsed.success) return { statusCode: 400, body: { error: 'invalid_request' } };
    return {
      statusCode: 200,
      body: await service.resume(request.name, {
        sessionId: parsed.data.session,
        prompt: parsed.data.prompt,
        cwd: parsed.data.work_dir,
        model: parsed.data.model,

        bypassPermissions: parsed.data.bypass_permissions ?? false,
        systemPrompt: parsed.data.system_prompt,
      }, request.context),
    };
  }

  if (op === 'exec') {
    const parsed = sharedExecSchema.safeParse(request.args);
    if (!parsed.success) return { statusCode: 400, body: { error: 'invalid_request' } };

    if (parsed.data.session) {
      return {
        statusCode: 200,
        body: await service.resume(request.name, {
          sessionId: parsed.data.session,
          prompt: parsed.data.prompt,
          cwd: parsed.data.work_dir,
          model: parsed.data.model,
  
          bypassPermissions: parsed.data.bypass_permissions ?? false,
          systemPrompt: parsed.data.system_prompt,
        }, request.context),
      };
    }

    return {
      statusCode: 200,
      body: await service.start(request.name, {
        prompt: parsed.data.prompt,
        cwd: parsed.data.work_dir ?? defaultCwd,
        model: parsed.data.model,

        bypassPermissions: parsed.data.bypass_permissions ?? false,
        systemPrompt: parsed.data.system_prompt,
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
  event: string,
  data: unknown,
  cursorId?: string,
): void {
  if (cursorId) {
    res.write(`event: ${event}\nid: ${cursorId}\ndata: ${JSON.stringify(data)}\n\n`);
    return;
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function resolveClientHost(bindHost: string): string {
  const override = process.env.CORAL_BACKEND_ADVERTISE_HOST;
  if (override) return override;
  if (bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::') return '::1';
  return bindHost;
}

async function listen(server: Server, bindHost: string): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Backend server failed to bind to a TCP port'));
        return;
      }
      resolve({ port: address.port, host: resolveClientHost(bindHost) });
    });
  });
}

export function createBackendServer(options: BackendServerOptions = {}): BackendServerController {
  const version = options.version ?? (typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0');
  const bundleHash = options.bundleHash ?? readBundleHash(defaultPluginRoot);
  const instanceId = options.instanceId ?? randomUUID();
  const token = options.token ?? randomBytes(32).toString('hex');
  const idleTimer = options.createIdleTimer?.() ?? new IdleTimer();
  const progressStore = options.progressStore ?? new ProgressStore();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => {
    process.stderr.write(message);
  });
  const createExecutionService = options.createExecutionService
    ?? ((ctx: CallerContext) => new DefaultExecutionService(ctx, progressStore));
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
  const discussBridges = new Map<string, DiscussBridge>();
  let discussPollTimer: NodeJS.Timeout | null = null;

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

  function scopeCheckJobs(jobIds: string[], projectRoot: string): ScopeCheckResult {
    const valid: string[] = [];
    const missing: string[] = [];
    const mismatch: string[] = [];

    for (const jobId of jobIds) {
      const lookup = progressStore.scopedLookup(jobId, projectRoot);
      if (lookup === 'mismatch') {
        mismatch.push(jobId);
        continue;
      }

      valid.push(jobId);
      if (lookup === 'missing') {
        missing.push(jobId);
      }
    }

    return { valid, missing, mismatch };
  }

  function listAllJobs(store: ProgressStore): Array<{ jobId: string; status: PersistedStatusRecord }> {
    const results: Array<{ jobId: string; status: PersistedStatusRecord }> = [];
    for (const jobId of readJobIds()) {
      const status = store.readStatus(jobId);
      if (status) {
        results.push({ jobId, status });
      }
    }
    return results;
  }

  function getJobDetail(
    store: ProgressStore,
    jobId: string,
  ): { status: PersistedStatusRecord; events: PersistedProgressRecord[] } | null {
    const status = store.readStatus(jobId);
    if (!status) return null;
    const cursor = createReplayCursor();
    const events = store.replayFrom(jobId, 0, cursor);
    return { status, events };
  }

  function listAllSessions(): Array<{ shardHash: string; sessions: LenientSessionEntry[] }> {
    const results: Array<{ shardHash: string; sessions: LenientSessionEntry[] }> = [];
    for (const shardDir of SessionManager.listShards()) {
      const entries = listShardSessions(shardDir);
      if (entries.length > 0) {
        results.push({ shardHash: basename(shardDir), sessions: entries });
      }
    }
    return results;
  }

  function listShardSessions(shardDir: string): LenientSessionEntry[] {
    let files: string[];
    try {
      files = readdirSync(shardDir).filter((file) => file.endsWith('.json') && !file.endsWith('.lock'));
    } catch {
      return [];
    }

    const entries: LenientSessionEntry[] = [];
    for (const file of files) {
      const entry = readSessionEntryLenient(join(shardDir, file));
      if (entry) entries.push(entry);
    }

    return entries;
  }

  type DiscussSessionSummary = {
    sessionId: string;
    projectRoot: string;
    topic: string;
    status: string;
    createdAt: string;
    agentCount: number;
  };

  function listDiscussSessions(): DiscussSessionSummary[] {
    const projectRoots = new Set<string>(discussBridges.keys());
    for (const { sessions } of listAllSessions()) {
      for (const s of sessions) {
        if (s.projectRoot) projectRoots.add(s.projectRoot);
      }
    }

    const results: DiscussSessionSummary[] = [];
    for (const projectRoot of projectRoots) {
      const baseDir = discussBaseDir(projectRoot);
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(baseDir, { withFileTypes: true });
      } catch (error: unknown) {
        if (isNoEntryError(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const state = readDiscussState(join(baseDir, entry.name, 'state.json'));
        if (!state) continue;
        results.push({
          sessionId: state.session_id,
          projectRoot,
          topic: state.topic,
          status: state.status,
          createdAt: state.created_at,
          agentCount: Object.keys(state.agents).length,
        });
      }
    }
    return results;
  }

  function resolveDiscussDir(projectRoot: string, sessionId: string): string | null {
    const baseDir = discussBaseDir(projectRoot);
    let entries: string[];
    try {
      entries = readdirSync(baseDir);
    } catch (error: unknown) {
      if (isNoEntryError(error)) return null;
      throw error;
    }
    if (entries.includes(sessionId)) return join(baseDir, sessionId);
    const match = entries.find((e) => e.startsWith(`${sessionId}-`));
    return match ? join(baseDir, match) : null;
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
      stopDiscussPoll();
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

    const scopeCheck = scopeCheckJobs(parsed.jobIds, parsed.projectRoot);
    if (scopeCheck.mismatch.length > 0) {
      sendJson(res, 403, { error: 'scope_mismatch' });
      return;
    }
    if (scopeCheck.missing.length === parsed.jobIds.length) {
      sendJson(res, 404, { error: 'jobs_not_found' });
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
    const ctx: CallerContext = { projectRoot: parsed.projectRoot, pluginRoot: defaultPluginRoot };

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

    for await (const event of getExecutionService(ctx).waitStream(waitRequest)) {
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

  function getDiscussBridge(projectRoot: string): DiscussBridge {
    const existing = discussBridges.get(projectRoot);
    if (existing) return existing;
    const bridge = new DiscussBridge(projectRoot);
    bridge.rescan();
    discussBridges.set(projectRoot, bridge);
    return bridge;
  }

  function startDiscussPoll(): void {
    if (discussPollTimer) return;
    discussPollTimer = setInterval(() => {
      if (streamResponses.size === 0) return;
      for (const bridge of discussBridges.values()) {
        bridge.rescan();
        const events = bridge.poll();
        for (const event of events) {
          for (const stream of streamResponses) {
            writeSseEvent(stream, 'discuss:event', event);
          }
        }
      }
    }, 2_000);
    discussPollTimer.unref?.();
  }

  function stopDiscussPoll(): void {
    if (discussPollTimer) {
      clearInterval(discussPollTimer);
      discussPollTimer = null;
    }
    for (const bridge of discussBridges.values()) {
      bridge.close();
    }
    discussBridges.clear();
  }

  async function handleEventStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const streamId = randomUUID();
    const filterJobId = parseEventStreamFilter(req.url ?? '');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    streamResponses.add(res);
    for (const shard of listAllSessions()) {
      for (const entry of shard.sessions) {
        if (entry.projectRoot) getDiscussBridge(entry.projectRoot);
      }
    }
    startDiscussPoll();
    writeSseEvent(res, 'ready', { streamId, startedAt: new Date().toISOString() });

    let closed = false;
    const matchesFilter = (jobId: string): boolean => !filterJobId || jobId === filterJobId;

    const onJobCreated = (payload: EventBusEvents['job:created']): void => {
      if (closed || !matchesFilter(payload.jobId)) return;
      if (payload.projectRoot) getDiscussBridge(payload.projectRoot);
      writeSseEvent(res, 'job:created', payload);
    };
    const onPhaseChanged = (payload: EventBusEvents['job:phase_changed']): void => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:phase_changed', payload);
    };
    const onProgress = (payload: EventBusEvents['job:progress']): void => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:progress', payload);
    };
    const onCompleted = (payload: EventBusEvents['job:completed']): void => {
      if (closed || !matchesFilter(payload.jobId)) return;
      writeSseEvent(res, 'job:completed', payload);
    };
    const onSessionUpdated = (payload: EventBusEvents['session:updated']): void => {
      if (closed) return;
      if (payload.projectRoot) getDiscussBridge(payload.projectRoot);
      writeSseEvent(res, 'session:updated', payload);
    };

    const onClose = () => {
      if (closed) return;
      closed = true;
      streamResponses.delete(res);
      res.off('close', onClose);
      eventBus.off('job:created', onJobCreated);
      eventBus.off('job:phase_changed', onPhaseChanged);
      eventBus.off('job:progress', onProgress);
      eventBus.off('job:completed', onCompleted);
      eventBus.off('session:updated', onSessionUpdated);
    };
    res.once('close', onClose);

    eventBus.on('job:created', onJobCreated);
    eventBus.on('job:phase_changed', onPhaseChanged);
    eventBus.on('job:progress', onProgress);
    eventBus.on('job:completed', onCompleted);
    eventBus.on('session:updated', onSessionUpdated);

    await new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      res.once('close', resolve);
    });
  }

  function parseEventStreamFilter(url: string): string | null {
    const qIndex = url.indexOf('?');
    if (qIndex === -1) return null;
    const params = new URLSearchParams(url.slice(qIndex));
    const filter = params.get('filter');
    if (!filter) return null;
    const jobMatch = filter.match(/^job:(.+)$/);
    return jobMatch?.[1] ?? null;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Coral-Backend-Token, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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

    if (req.method === 'GET' && req.url?.startsWith('/events/stream')) {
      req.resume();
      await handleEventStream(req, res);
      return;
    }

    idleTimer.beginRequest();
    runOnResponseDone(res, () => {
      idleTimer.endRequest();
    });

    if (req.method === 'POST' && req.url === '/wait/stream') {
      await handleWaitStream(req, res);
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version,
        bundleHash,
        instanceId,
        uptimeMs: now() - startedAt,
        activeChildren: activeChildren.size,
        activeJobs: progressStore.liveJobCount(),
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
        scopeCheckJobs,
      });
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === 'POST' && req.url === '/admin/shutdown') {
      req.resume();
      runOnResponseDone(res, () => {
        void shutdown('admin').catch(() => {});
      });
      sendJson(res, 200, { status: 'shutting_down' });
      return;
    }

    if (req.method === 'GET' && req.url) {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (pathname === '/api/jobs') {
        req.resume();
        const phase = parsedUrl.searchParams.get('phase');
        let jobs = listAllJobs(progressStore);
        if (phase !== null) {
          jobs = jobs.filter((j) => j.status?.phase === phase);
        }
        sendJson(res, 200, { jobs });
        return;
      }

      const jobDetailMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobDetailMatch) {
        req.resume();
        const detail = getJobDetail(progressStore, jobDetailMatch[1]);
        if (!detail) {
          sendJson(res, 404, { error: 'job_not_found' });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      if (pathname === '/api/sessions') {
        req.resume();
        sendJson(res, 200, { sessions: listAllSessions() });
        return;
      }

      if (pathname === '/api/discuss') {
        req.resume();
        sendJson(res, 200, { sessions: listDiscussSessions() });
        return;
      }

      if (pathname === '/api/discuss/detail') {
        req.resume();
        const projectRoot = parsedUrl.searchParams.get('projectRoot');
        const sessionId = parsedUrl.searchParams.get('sessionId');
        if (!projectRoot || !sessionId) {
          sendJson(res, 400, { error: 'missing_params', message: 'projectRoot and sessionId are required' });
          return;
        }
        const sessionDir = resolveDiscussDir(projectRoot, sessionId);
        if (!sessionDir) {
          sendJson(res, 404, { error: 'session_not_found' });
          return;
        }
        const state = readDiscussState(join(sessionDir, 'state.json'));
        if (!state) {
          sendJson(res, 404, { error: 'session_not_found' });
          return;
        }
        sendJson(res, 200, { session: state });
        return;
      }
    }

    req.resume();
    sendJson(res, 404, { error: 'not_found' });
  }

  async function start(): Promise<BackendServerInfo> {
    if (started) {
      throw new Error('Backend server already started');
    }

    try {
      await acquireLockFn(instanceId, version, bundleHash);
      recoverOrphanedJobsFn();
      const bindHost = process.env.CORAL_BACKEND_BIND ?? '127.0.0.1';
      const { port, host } = await listen(server, bindHost);
      startedAt = now();
      writeBackendInfoFn({
        pid: process.pid,
        port,
        host,
        token,
        version,
        bundleHash,
        instanceId,
        startedAt,
      });

      lifecycle = 'running';
      started = true;
      idleTimer.startWatching(
        () => lifecycle === 'running'
          && activeChildren.size === 0
          && progressStore.liveJobCount() === 0
          && idleTimer.inflightRequests === 0,
        () => {
          void shutdown('idle').catch(() => {});
        },
      );

      return {
        port,
        host,
        token,
        version,
        bundleHash,
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
    process.stderr.write(`Coral backend running on ${info.host}:${info.port}\n`);
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
