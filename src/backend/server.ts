declare const __VERSION__: string;
declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { activeChildren, killAllChildren } from '../runner/engine.js';
import { activeSessions, shutdownSignal, tryClaimTerminalWrite } from '../runner/job-manager.js';
import { writeSessionError } from '../runner/progress.js';
import { isRecord, type McpResult } from '../shared/mcp-utils.js';
import { writeBackendInfo, removeBackendInfoIfOwner } from './backend-info.js';
import { acquireLock, BackendAlreadyRunningError, removeLockIfOwner } from './backend-lock.js';
import { IdleTimer } from './idle-timer.js';
import type { ToolRequest } from './request-context.js';
import { routeBackendToolCall } from './tool-router.js';

export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

type BackendServerOptions = {
  version?: string;
  instanceId?: string;
  token?: string;
  now?: () => number;
  log?: (message: string) => void;
  createIdleTimer?: () => IdleTimer;
  acquireLockFn?: typeof acquireLock;
  writeBackendInfoFn?: typeof writeBackendInfo;
  removeBackendInfoIfOwnerFn?: typeof removeBackendInfoIfOwner;
  removeLockIfOwnerFn?: typeof removeLockIfOwner;
  routeToolCallFn?: typeof routeBackendToolCall;
  closeServerFn?: (server: Server) => Promise<void>;
  markActiveSessionsAsErrorFn?: (message: string) => void;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
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
  return {
    name: body.name,
    args: body.args,
    context: { projectRoot: body.context.projectRoot },
  };
}

function trackRequest(idleTimer: IdleTimer, res: ServerResponse): void {
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    res.off('finish', finish);
    res.off('close', finish);
    idleTimer.endRequest();
  };

  res.once('finish', finish);
  res.once('close', finish);
}

function runAfterResponse(res: ServerResponse, fn: () => void): void {
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

function markActiveSessionsAsError(message: string): void {
  shutdownSignal.abort();

  for (const [sessionId, entry] of activeSessions) {
    if (tryClaimTerminalWrite(sessionId)) {
      writeSessionError(entry.sessionDir, message);
      entry.terminalState = 'error';
    }
    entry.controller.abort();
  }
  activeSessions.clear();
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
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => {
    process.stderr.write(message);
  });
  const acquireLockFn = options.acquireLockFn ?? acquireLock;
  const writeBackendInfoFn = options.writeBackendInfoFn ?? writeBackendInfo;
  const removeBackendInfoIfOwnerFn = options.removeBackendInfoIfOwnerFn ?? removeBackendInfoIfOwner;
  const removeLockIfOwnerFn = options.removeLockIfOwnerFn ?? removeLockIfOwner;
  const routeToolCallFn = options.routeToolCallFn ?? routeBackendToolCall;
  const closeServerFn = options.closeServerFn ?? closeServer;
  const markActiveSessionsAsErrorFn = options.markActiveSessionsAsErrorFn ?? markActiveSessionsAsError;
  const killAllChildrenFn = options.killAllChildrenFn ?? killAllChildren;

  let startedAt = now();
  let lifecycle: LifecycleState = 'starting';
  let shutdownPromise: Promise<void> | null = null;
  let started = false;

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
      await Promise.race([
        serverClosed,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
      ]);

      markActiveSessionsAsErrorFn('Backend shutting down');
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

    idleTimer.beginRequest();
    trackRequest(idleTimer, res);

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version,
        instanceId,
        uptime: now() - startedAt,
        activeChildren: activeChildren.size,
        activeSessions: activeSessions.size,
        inflightRequests: idleTimer.inflightRequests,
      });
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
      const result: McpResult = await routeToolCallFn(request.name, request.args, request.context);
      sendJson(res, 200, result);
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
          && activeSessions.size === 0
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
