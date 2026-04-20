import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { ZodError } from 'zod';
import {
  buildCallerContextFromQuery,
  domainError,
  domainResultToHttp,
  formatZodError,
  launchToHttp,
  type HttpHandlerPorts,
  type JobListFilters,
  type ToolDomainResult,
  type WorkflowPortInput,
} from '../http/contracts.js';
import { encode, decode, type JsonRpcEnvelope, type JsonRpcError, type JsonRpcRequest, type JsonRpcResponse } from '../json-rpc.js';
import { rpcCatalog, type RpcMethodSpec } from '../rpc-catalog.js';
import { buildCallerContext, decodePathSegment } from '../shared-context.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../../jobs/api.js';
import { buildJsonRpcError, formatError, isNoEntryError } from '../../shared/utils.js';

const INVALID_JSON_RESPONSE = {
  code: 'invalid_request',
  message: 'Invalid JSON body',
};
const BACKEND_RECOVERING_RESPONSE = {
  code: 'backend_recovering',
  message: 'recovering — retry after 500ms',
};
const BACKEND_SHUTTING_DOWN_RESPONSE = {
  code: 'backend_shutting_down',
  message: 'Backend shutting down',
};

export type IpcListener = {
  readonly server: NetServer;
  readonly sockets: Set<Socket>;
  socketPath: string | null;
};

type IpcInvocation =
  | { kind: 'unary'; value: unknown }
  | { kind: 'subscription'; notifications: AsyncIterable<unknown> };

export type IpcDispatchEntry = {
  readonly method: string;
  readonly spec: RpcMethodSpec<unknown, unknown>;
  dispatch(request: unknown, rpcPorts: HttpHandlerPorts, abortSignal?: AbortSignal): Promise<IpcInvocation>;
};

function invalidRequestResult(message = 'invalid request', detail?: unknown): ToolDomainResult {
  return domainError('invalid_request', message, detail);
}

function transportErrorResponse(message: string, data?: unknown): JsonRpcError {
  return {
    kind: 'error',
    id: null,
    error: buildJsonRpcError(-32603, message, data),
  };
}

function requestErrorResponse(id: JsonRpcRequest['id'] | null, message: string, data?: unknown): JsonRpcError {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32603, message, data),
  };
}

function validationErrorResponse(id: JsonRpcRequest['id'], error: ZodError): JsonRpcError {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32602, 'Invalid params', {
      issues: error.issues,
      message: formatZodError(error),
    }),
  };
}

function methodNotFoundResponse(id: JsonRpcRequest['id']): JsonRpcError {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32601, 'Method not found'),
  };
}

function invalidRequestResponse(id: JsonRpcRequest['id'] | null): JsonRpcError {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32600, 'Invalid request'),
  };
}

function writeEnvelope(socket: Socket, envelope: JsonRpcEnvelope): void {
  socket.write(`${encode(envelope)}\n`);
}

function buildBodyCallerContext(request: Record<string, unknown>, rpcPorts: HttpHandlerPorts) {
  return buildCallerContext(request, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot);
}

function ensureLaunchFenceInactive(rpcPorts: HttpHandlerPorts): unknown | null {
  if (!rpcPorts.admin.isLaunchFenceActive()) {
    return null;
  }
  return BACKEND_RECOVERING_RESPONSE;
}

async function handleCatalogUnaryRequest(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  rpcPorts: HttpHandlerPorts,
): Promise<unknown> {
  switch (spec.name) {
    case 'sessions.create': {
      const parsed = request as Record<string, unknown> & { provider: string; prompt: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const decision = await rpcPorts.sessions.start(
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
      return launchToHttp(decision, 201).body;
    }

    case 'sessions.message': {
      const parsed = request as Record<string, unknown> & { sessionId: string; prompt: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const decision = await rpcPorts.sessions.resumeBySessionId(
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
      return launchToHttp(decision, 202).body;
    }

    case 'sessions.fork': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const decision = await rpcPorts.sessions.forkBySessionId(
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
      return launchToHttp(decision, 201).body;
    }

    case 'workflow.run': {
      const parsed = request as Record<string, unknown>;
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const { projectRoot: _projectRoot, claudeModelCap: _claudeModelCap, ...workflowCommand } = parsed;
      const result = await rpcPorts.workflows.execute(workflowCommand as WorkflowPortInput, ctx);
      if (result.kind === 'invalid_request') {
        return domainResultToHttp(invalidRequestResult(result.message, result.detail)).body;
      }

      return launchToHttp(result.decision, 202).body;
    }

    case 'jobs.abort': {
      const parsed = request as { jobs: string[]; projectRoot: string };
      const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobs, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return domainResultToHttp(
          domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
        ).body;
      }
      if (scopeCheck.missing.length === parsed.jobs.length) {
        return {
          code: 'jobs_not_found',
          message: 'Requested jobs were not found',
          detail: { jobs: parsed.jobs },
        };
      }

      return rpcPorts.jobs.abort(parsed.jobs);
    }

    case 'jobs.list': {
      const parsed = request as JobListFilters & { provider?: string };
      const jobs = rpcPorts.jobs.list({
        ...(parsed.projectRoot === undefined ? {} : { projectRoot: parsed.projectRoot }),
        ...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
        ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
        all: parsed.all === true,
      });
      jobs.sort((left, right) => right.status.launch.updatedAt.localeCompare(left.status.launch.updatedAt));
      return { jobs };
    }

    case 'jobs.detail': {
      const parsed = request as { jobId: string };
      const detail = rpcPorts.jobs.detail(parsed.jobId);
      if (!detail) {
        return { code: 'job_not_found', message: `Job not found: ${parsed.jobId}` };
      }
      return detail;
    }

    case 'discuss.persona.generate':
      return domainResultToHttp(rpcPorts.discuss.seed(request)).body;

    case 'discuss.session.create': {
      const parsed = request as Record<string, unknown>;
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const {
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return domainResultToHttp(await rpcPorts.discuss.start(args, ctx)).body;
    }

    case 'discuss.session.list':
      return { sessions: rpcPorts.discuss.listSessions() };

    case 'discuss.session.detail': {
      const parsed = request as { projectRoot: string; sessionId: string; view?: 'control' | 'audit' };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        rpcPorts.identity.pluginRoot,
        rpcPorts.coralEnvSnapshot,
      );
      const detail = rpcPorts.discuss.loadDetail(context.projectRoot, parsed.sessionId, parsed.view ?? 'control');
      if (!detail) {
        return { code: 'session_not_found', message: 'Session not found' };
      }
      if (detail === 'audit_requires_ended_session') {
        return { code: 'audit_requires_ended_session', message: 'Audit requires ended session' };
      }
      return detail;
    }

    case 'discuss.session.events': {
      const parsed = request as { sessionId: string; projectRoot: string; cursor?: number };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        rpcPorts.identity.pluginRoot,
        rpcPorts.coralEnvSnapshot,
      );
      return domainResultToHttp(
        rpcPorts.discuss.watch(
          {
            session: parsed.sessionId,
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          },
          context,
        ),
      ).body;
    }

    case 'discuss.session.bid': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const {
        sessionId,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return domainResultToHttp(await rpcPorts.discuss.bid({ ...args, session: sessionId }, ctx)).body;
    }

    case 'discuss.session.speech': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return recovering;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const {
        sessionId,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return domainResultToHttp(await rpcPorts.discuss.speech({ ...args, session: sessionId }, ctx)).body;
    }

    case 'discuss.session.delete': {
      const parsed = request as { sessionId: string; projectRoot: string };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        rpcPorts.identity.pluginRoot,
        rpcPorts.coralEnvSnapshot,
      );
      return domainResultToHttp(await rpcPorts.discuss.abort({ session: parsed.sessionId }, context)).body;
    }

    case 'kb.entries.search': {
      const parsed = request as { q: string; scope?: string; top_k?: number };
      return domainResultToHttp(
        await rpcPorts.kb.readSearch({
          query: parsed.q,
          ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
          ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
        }),
      ).body;
    }

    case 'kb.note.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(rpcPorts.kb.readNote(slug)).body;
    }

    case 'kb.note.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const {
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return domainResultToHttp(await rpcPorts.kb.createNote(args, ctx)).body;
    }

    case 'kb.note.update': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;

      const {
        slug: _slug,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return domainResultToHttp(await rpcPorts.kb.updateNote({ ...args, note: slug })).body;
    }

    case 'kb.note.delete': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(await rpcPorts.kb.deleteNote(slug)).body;
    }

    case 'kb.source.list':
      return domainResultToHttp(await rpcPorts.kb.listSources()).body;

    case 'kb.source.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(rpcPorts.kb.readSource(slug)).body;
    }

    case 'kb.source.create': {
      const parsed = request as Record<string, unknown>;
      const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } =
        parsed;
      return domainResultToHttp(await rpcPorts.kb.createSource(args)).body;
    }

    case 'kb.source.delete': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(await rpcPorts.kb.deleteSource(slug)).body;
    }

    case 'kb.community.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(rpcPorts.kb.readCommunity(slug)).body;
    }

    case 'kb.memo.list': {
      const parsed = request as { projectRoot: string; owner?: string };
      return domainResultToHttp(
        rpcPorts.kb.listMemos(
          parsed.owner === undefined ? {} : { owner: parsed.owner },
          buildCallerContextFromQuery(parsed.projectRoot, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot),
        ),
      ).body;
    }

    case 'kb.memo.read': {
      const parsed = request as { slug: string; projectRoot: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(
        rpcPorts.kb.readMemo(
          slug,
          buildCallerContextFromQuery(parsed.projectRoot, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot),
        ),
      ).body;
    }

    case 'kb.memo.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return domainResultToHttp(invalidRequestResult()).body;

      const { projectRoot: _projectRoot, owner: _owner, effort: _effort, claudeModelCap: _claudeModelCap, ...args } =
        parsed;
      const memoArgs = ctx.coralEnv.CORAL_OWNER === undefined ? args : { ...args, owner: ctx.coralEnv.CORAL_OWNER };
      return domainResultToHttp(rpcPorts.kb.createMemo(memoArgs, ctx)).body;
    }

    case 'kb.memo.delete': {
      const parsed = request as { projectRoot: string; pattern?: string; owner?: string; all?: boolean };
      return domainResultToHttp(
        rpcPorts.kb.deleteMemos(
          {
            ...(parsed.pattern === undefined ? {} : { pattern: parsed.pattern }),
            ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
            ...(parsed.all === undefined ? {} : { all: parsed.all }),
          },
          buildCallerContextFromQuery(parsed.projectRoot, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot),
        ),
      ).body;
    }

    case 'kb.principles.list': {
      const parsed = request as { q?: string; top_k?: number; verbose?: boolean };
      return domainResultToHttp(
        await rpcPorts.kb.listPrinciples({
          ...(parsed.q === undefined ? {} : { query: parsed.q }),
          ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
          ...(parsed.verbose === undefined ? {} : { verbose: parsed.verbose }),
        }),
      ).body;
    }

    case 'kb.principle.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return domainResultToHttp(invalidRequestResult('Invalid KB slug')).body;
      return domainResultToHttp(rpcPorts.kb.readPrinciple(slug)).body;
    }

    case 'kb.reindex':
      return domainResultToHttp(await rpcPorts.kb.reindex()).body;

    default:
      throw new Error(`Unhandled IPC RPC route: ${spec.name}`);
  }
}

async function handleCatalogSubscriptionRequest(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  rpcPorts: HttpHandlerPorts,
  abortSignal?: AbortSignal,
): Promise<IpcInvocation> {
  switch (spec.name) {
    case 'jobs.wait': {
      const parsed = request as {
        jobIds: string[];
        projectRoot: string;
        timeoutSeconds?: number;
        cursor?: { jobs: Record<string, number> };
      };
      const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobIds, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return {
          kind: 'unary',
          value: domainResultToHttp(
            domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
          ).body,
        };
      }
      if (scopeCheck.missing.length === parsed.jobIds.length) {
        return {
          kind: 'unary',
          value: {
            code: 'jobs_not_found',
            message: 'Requested jobs were not found',
            detail: { jobs: scopeCheck.missing },
          },
        };
      }

      const waitRequest: WaitStreamRequest = { ...parsed };
      if (abortSignal) {
        Object.defineProperty(waitRequest, 'abortSignal', {
          value: abortSignal,
          enumerable: false,
          configurable: true,
        });
      }

      return {
        kind: 'subscription',
        notifications: rpcPorts.jobs.waitStream(waitRequest) as AsyncIterable<WaitStreamEvent>,
      };
    }
    default:
      throw new Error(`Unhandled IPC subscription route: ${spec.name}`);
  }
}

export function ipcAdapter(
  spec: RpcMethodSpec<unknown, unknown>,
  rpcPorts: HttpHandlerPorts,
): IpcDispatchEntry {
  return {
    method: spec.name,
    spec,
    dispatch: async (request, _rpcPorts, abortSignal) => {
      if (spec.kind === 'subscription') {
        return handleCatalogSubscriptionRequest(spec, request, rpcPorts, abortSignal);
      }

      return {
        kind: 'unary',
        value: await handleCatalogUnaryRequest(spec, request, rpcPorts),
      };
    },
  };
}

export function buildCoordinatorIpcDispatchTable(
  rpcPorts: HttpHandlerPorts,
): readonly IpcDispatchEntry[] {
  return rpcCatalog.map((spec) => ipcAdapter(spec, rpcPorts));
}

async function listenSocket(server: NetServer, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

async function clearStaleSocket(socketPath: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => {
        socket.destroy();
        reject(new Error('socket-in-use'));
      });
      socket.once('error', (error: Error) => {
        socket.destroy();
        reject(error);
      });
    });
    return false;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ECONNREFUSED' && code !== 'ENOENT') {
      return false;
    }
  }

  try {
    unlinkSync(socketPath);
    return true;
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return true;
    }
    throw error;
  }
}

async function bindSocket(server: NetServer, socketPath: string): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });

  try {
    await listenSocket(server, socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw error;
    }

    const cleared = await clearStaleSocket(socketPath);
    if (!cleared) {
      throw error;
    }
    await listenSocket(server, socketPath);
  }

  if (process.platform !== 'win32') {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

export async function listenIpcServer(listener: IpcListener, socketPath: string): Promise<{ socketPath: string }> {
  await bindSocket(listener.server, socketPath);
  listener.socketPath = socketPath;
  return { socketPath };
}

export async function closeIpcServer(listener: IpcListener): Promise<void> {
  for (const socket of listener.sockets) {
    socket.destroy();
  }

  await new Promise<void>((resolve, reject) => {
    if (!listener.server.listening) {
      resolve();
      return;
    }

    listener.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  if (listener.socketPath) {
    try {
      unlinkSync(listener.socketPath);
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
    listener.socketPath = null;
  }
}

export function createIpcServer(rpcPorts: HttpHandlerPorts): IpcListener {
  const dispatchTable = buildCoordinatorIpcDispatchTable(rpcPorts);
  const dispatchMap = new Map(dispatchTable.map((entry) => [entry.method, entry]));
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let handled = false;
    let inflightRequest = false;

    const finishRequest = () => {
      if (!inflightRequest) {
        return;
      }
      inflightRequest = false;
      rpcPorts.admin.endRequest();
    };

    socket.once('close', () => {
      finishRequest();
      sockets.delete(socket);
    });

    socket.on('error', (error) => {
      rpcPorts.identity.log(`IPC socket error: ${formatError(error)}\n`);
      finishRequest();
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (handled || frame.trim().length === 0) {
          continue;
        }
        handled = true;
        void (async () => {
          let envelope: JsonRpcEnvelope;
          try {
            envelope = decode(frame);
          } catch (error: unknown) {
            writeEnvelope(socket, transportErrorResponse(INVALID_JSON_RESPONSE.message, { cause: String(error) }));
            socket.end();
            return;
          }

          if (envelope.kind !== 'request') {
            writeEnvelope(socket, invalidRequestResponse('id' in envelope ? envelope.id : null));
            socket.end();
            return;
          }

          const request = envelope;
          if (request.method === 'transport.health') {
            writeEnvelope(socket, { kind: 'response', id: request.id, result: rpcPorts.health.read() });
            socket.end();
            return;
          }

          if (request.method === 'transport.shutdown') {
            rpcPorts.admin.requestDrain('replaced');
            writeEnvelope(socket, {
              kind: 'response',
              id: request.id,
              result: { status: 'draining', instanceId: rpcPorts.identity.instanceId },
            });
            socket.end();
            return;
          }

          if (!rpcPorts.admin.isLifecycleRunning() || rpcPorts.admin.isDrainRequested()) {
            writeEnvelope(socket, {
              kind: 'response',
              id: request.id,
              result: BACKEND_SHUTTING_DOWN_RESPONSE,
            });
            socket.end();
            return;
          }

          const entry = dispatchMap.get(request.method);
          if (!entry) {
            writeEnvelope(socket, methodNotFoundResponse(request.id));
            socket.end();
            return;
          }

          const parsed = entry.spec.requestSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            writeEnvelope(socket, validationErrorResponse(request.id, parsed.error));
            socket.end();
            return;
          }

          rpcPorts.admin.beginRequest();
          inflightRequest = true;

          let subscriptionController: AbortController | null = null;
          try {
            subscriptionController = new AbortController();
            const abortSignal = subscriptionController.signal;
            const invocation = await entry.dispatch(parsed.data, rpcPorts, abortSignal);
            if (invocation.kind === 'unary') {
              writeEnvelope(socket, { kind: 'response', id: request.id, result: invocation.value } as JsonRpcResponse);
              socket.end();
              return;
            }

            const iterator = invocation.notifications[Symbol.asyncIterator]();
            const controller = subscriptionController;
            let released = false;
            const releaseSubscription = () => {
              if (released) {
                return;
              }
              released = true;
              controller.abort();
              socket.off('close', releaseSubscription);
              void iterator.return?.().catch(() => undefined);
            };
            socket.once('close', releaseSubscription);

            writeEnvelope(socket, {
              kind: 'response',
              id: request.id,
              result: { status: 'subscribed', method: entry.method },
            });
            while (true) {
              const next = await iterator.next();
              if (next.done || socket.destroyed || socket.writableEnded) {
                break;
              }

              const notification = next.value;
              writeEnvelope(socket, {
                kind: 'notification',
                method: entry.method,
                params: notification,
              });
            }
            releaseSubscription();
            socket.end();
          } catch (error: unknown) {
            if (subscriptionController?.signal.aborted || socket.destroyed) {
              return;
            }
            rpcPorts.identity.log(`IPC request error (${request.method}): ${formatError(error)}\n`);
            if (!socket.destroyed && !socket.writableEnded) {
              writeEnvelope(socket, requestErrorResponse(request.id, 'Internal error'));
              socket.end();
            }
          } finally {
            finishRequest();
          }
        })();
      }
    });
  });

  return {
    server,
    sockets,
    socketPath: null,
  };
}
