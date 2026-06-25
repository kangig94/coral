import { timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import * as timers from 'node:timers';
import type { ZodError } from 'zod';
import type { HttpHandlerPorts } from '../server-ports.js';
import { formatZodError } from '../validation.js';
import {
  encode,
  decode,
  type JsonRpcEnvelope,
  type JsonRpcErrorEnvelope,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from './json-rpc.js';
import { createLineFramer, FrameTooLargeError } from '../line-framing.js';
import { rpcCatalog, type RpcMethodSpec } from '../rpc/catalog.js';
import { type CatalogRequestExecution, executeCatalogRequest } from '../dispatch.js';
import { writeAuditEvent } from '../../infra/audit-log.js';
import { buildJsonRpcError } from '../../infra/json-rpc.js';
import { formatError } from '../../infra/error-format.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { buildTransportErrorResponse } from '../error-response.js';

const INVALID_JSON_RESPONSE = {
  code: 'invalid_request',
  message: 'Invalid JSON body',
};
const BACKEND_SHUTTING_DOWN_RESPONSE = {
  code: 'backend_shutting_down',
  message: 'Backend shutting down',
};
const SHUTDOWN_UNAUTHORIZED_RESPONSE = {
  code: 'shutdown_unauthorized',
  message: 'Manual shutdown required: shutdown capability missing or invalid',
};
const KB_RESTART_UNAUTHORIZED_RESPONSE = {
  code: 'shutdown_unauthorized',
  message: 'Manual KB child restart requires shutdown capability',
};
const KB_RESTART_UNAVAILABLE_RESPONSE = {
  code: 'not_implemented',
  message: 'KB child supervisor is not available',
};
export const IPC_DEFAULT_MAX_OPEN_SOCKETS = 128;
export const IPC_DEFAULT_FIRST_FRAME_TIMEOUT_MS = 5_000;
export const IPC_DEFAULT_MAX_AGGREGATE_PENDING_FRAME_BYTES = 32 * 1024 * 1024;
export const IPC_DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 5_000;

export type IpcServerOptions = {
  readonly maxOpenSockets?: number;
  readonly firstFrameTimeoutMs?: number;
  readonly maxAggregatePendingFrameBytes?: number;
  readonly writeDrainTimeoutMs?: number;
};

export type IpcListener = {
  readonly server: NetServer;
  readonly sockets: Set<Socket>;
  socketPath: string | null;
  /**
   * Optional callback invoked alongside `transport.shutdown`'s `requestDrain`.
   * Composition wires this to `coordinator.shutdown(reason)` so a contender
   * can replace a still-`starting` incumbent (where idle-timer driven drain
   * has not yet been installed). Setting/clearing is composition's job.
   */
  onShutdownRequest: ((reason: string) => void) | null;
};

export type IpcDispatchEntry = {
  readonly method: string;
  readonly spec: RpcMethodSpec<unknown, unknown>;
  dispatch(request: unknown, abortSignal?: AbortSignal): Promise<CatalogRequestExecution>;
};

function transportErrorResponse(message: string, data?: unknown): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id: null,
    error: buildJsonRpcError(-32603, message, data),
  };
}

function requestErrorResponse(
  id: JsonRpcRequestEnvelope['id'] | null,
  message: string,
  data?: unknown,
): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32603, message, data),
  };
}

function validationErrorResponse(id: JsonRpcRequestEnvelope['id'], error: ZodError): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32602, 'Invalid params', {
      issues: error.issues,
      message: formatZodError(error),
    }),
  };
}

function methodNotFoundResponse(id: JsonRpcRequestEnvelope['id']): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32601, 'Method not found'),
  };
}

function invalidRequestResponse(id: JsonRpcRequestEnvelope['id'] | null): JsonRpcErrorEnvelope {
  return {
    kind: 'error',
    id,
    error: buildJsonRpcError(-32600, 'Invalid request'),
  };
}

function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function readShutdownToken(params: unknown): string | null {
  if (params === null || typeof params !== 'object') {
    return null;
  }
  const token = (params as Record<string, unknown>).shutdownToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function waitForSocketDrain(socket: Socket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed || socket.writableEnded) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timeout = timers.setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();

    const finish = (drained: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      timers.clearTimeout(timeout);
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      socket.off('error', onError);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);

    socket.once('drain', onDrain);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function writeEnvelope(
  socket: Socket,
  envelope: JsonRpcEnvelope,
  options: { drainTimeoutMs?: number } = {},
): Promise<boolean> {
  if (socket.destroyed || socket.writableEnded) {
    return false;
  }

  let accepted: boolean;
  try {
    accepted = socket.write(`${encode(envelope)}\n`);
  } catch {
    return false;
  }

  if (accepted) {
    return true;
  }

  const drained = await waitForSocketDrain(socket, options.drainTimeoutMs ?? IPC_DEFAULT_WRITE_DRAIN_TIMEOUT_MS);
  if (!drained && !socket.destroyed) {
    socket.destroy();
  }
  return drained;
}

export function ipcAdapter(spec: RpcMethodSpec<unknown, unknown>, rpcPorts: HttpHandlerPorts): IpcDispatchEntry {
  return {
    method: spec.name,
    spec,
    // interim mapping; future role-auth derives authority from the authenticated principal, not the transport.
    dispatch: async (request, abortSignal) =>
      await executeCatalogRequest(spec, request, rpcPorts, 'admin', abortSignal),
  };
}

export function buildCoordinatorIpcDispatchTable(rpcPorts: HttpHandlerPorts): readonly IpcDispatchEntry[] {
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

/**
 * Bind result distinguishes "stale orphan socket file" (auto-cleared) from
 * "live incumbent listening" so handoff callers can react instead of being
 * killed by `EADDRINUSE`. The next binder is the only path-cleanup authority.
 */
export type BindSocketResult = { kind: 'bound' } | { kind: 'incumbent'; reason: 'live-listener' };

export async function bindSocket(server: NetServer, socketPath: string): Promise<BindSocketResult> {
  mkdirSync(dirname(socketPath), { recursive: true });

  const finalize = (): void => {
    if (process.platform !== 'win32') {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // Best-effort.
      }
    }
  };

  try {
    await listenSocket(server, socketPath);
    finalize();
    return { kind: 'bound' };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw error;
    }
  }

  // EADDRINUSE — distinguish stale-orphan from live-listener.
  const cleared = await clearStaleSocket(socketPath);
  if (cleared) {
    try {
      await listenSocket(server, socketPath);
      finalize();
      return { kind: 'bound' };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
      return { kind: 'incumbent', reason: 'live-listener' };
    }
  }

  return { kind: 'incumbent', reason: 'live-listener' };
}

/**
 * Phase-B-compatible signature: throws synthetic `EADDRINUSE` when an
 * incumbent owns the socket. Phase C upgrades the public shape to a tagged
 * `ListenIpcServerResult`; this thin wrapper keeps existing callers green.
 */
export async function listenIpcServer(listener: IpcListener, socketPath: string): Promise<{ socketPath: string }> {
  const result = await bindSocket(listener.server, socketPath);
  if (result.kind === 'incumbent') {
    const error = new Error(`IPC socket already in use: ${socketPath}`) as NodeJS.ErrnoException;
    error.code = 'EADDRINUSE';
    throw error;
  }
  listener.socketPath = socketPath;
  return { socketPath };
}

/**
 * Ownership-safe close: destroy tracked sockets, close the server, and forget
 * the listener's socket path. Path-based cleanup belongs to the next binder's
 * `clearStaleSocket` (which probes for liveness before unlinking). This
 * deliberately leaves a stale socket file after graceful shutdown until the
 * next bind attempt clears it — preferable to deleting a path that may now
 * belong to a replacement daemon.
 */
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

  listener.socketPath = null;
}

async function streamSubscription(
  socket: Socket,
  request: JsonRpcRequestEnvelope,
  entry: IpcDispatchEntry,
  invocation: Extract<CatalogRequestExecution, { kind: 'subscription' }>,
  controller: AbortController,
  options: { writeDrainTimeoutMs: number },
): Promise<void> {
  const iterator = invocation.notifications[Symbol.asyncIterator]();
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

  if (
    !(await writeEnvelope(
      socket,
      {
        kind: 'response',
        id: request.id,
        result: { status: 'subscribed', method: entry.method },
      },
      { drainTimeoutMs: options.writeDrainTimeoutMs },
    ))
  ) {
    releaseSubscription();
    return;
  }

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done || socket.destroyed || socket.writableEnded) {
        break;
      }

      const wrote = await writeEnvelope(
        socket,
        {
          kind: 'notification',
          method: entry.method,
          params: next.value,
        },
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      if (!wrote) {
        break;
      }
    }
  } finally {
    releaseSubscription();
  }

  socket.end();
}

async function dispatchFrame(
  frame: string,
  socket: Socket,
  dispatchMap: ReadonlyMap<string, IpcDispatchEntry>,
  rpcPorts: HttpHandlerPorts,
  onShutdownRequest: ((reason: string) => void) | null,
  startRequest: () => void,
  finishRequest: () => void,
  options: { writeDrainTimeoutMs: number },
): Promise<void> {
  let envelope: JsonRpcEnvelope;
  try {
    envelope = decode(frame);
  } catch (error: unknown) {
    await writeEnvelope(socket, transportErrorResponse(INVALID_JSON_RESPONSE.message, { cause: String(error) }), {
      drainTimeoutMs: options.writeDrainTimeoutMs,
    });
    socket.end();
    return;
  }

  if (envelope.kind !== 'request') {
    await writeEnvelope(socket, invalidRequestResponse('id' in envelope ? envelope.id : null), {
      drainTimeoutMs: options.writeDrainTimeoutMs,
    });
    socket.end();
    return;
  }

  const request = envelope;
  if (request.method === 'transport.health') {
    await writeEnvelope(
      socket,
      { kind: 'response', id: request.id, result: rpcPorts.health.read() },
      {
        drainTimeoutMs: options.writeDrainTimeoutMs,
      },
    );
    socket.end();
    return;
  }

  if (request.method === 'transport.shutdown') {
    const shutdownToken = readShutdownToken(request.params);
    if (shutdownToken === null || !tokensEqual(shutdownToken, rpcPorts.identity.shutdownToken)) {
      await writeEnvelope(
        socket,
        requestErrorResponse(request.id, SHUTDOWN_UNAUTHORIZED_RESPONSE.message, SHUTDOWN_UNAUTHORIZED_RESPONSE),
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      socket.end();
      return;
    }
    const reason = 'replaced';
    writeAuditEvent(
      'admin_shutdown_requested',
      {
        transport: 'ipc',
        reason,
        instanceId: rpcPorts.identity.instanceId,
      },
      'warn',
    );
    rpcPorts.admin.requestDrain(reason);
    // `requestDrain` only flips the drain flag and notifies the idle timer;
    // the idle timer is not installed until lifecycle reaches 'running'.
    // To unblock contenders during a still-`starting` incumbent, lifecycle
    // composition registers `onShutdownRequest` to drive `coordinator.shutdown`
    // directly. No-op when lifecycle is already running (drain handles it).
    onShutdownRequest?.(reason);
    await writeEnvelope(
      socket,
      {
        kind: 'response',
        id: request.id,
        result: { status: 'draining', instanceId: rpcPorts.identity.instanceId },
      },
      { drainTimeoutMs: options.writeDrainTimeoutMs },
    );
    socket.end();
    return;
  }

  const lifecycleState =
    rpcPorts.admin.getLifecycleState?.() ?? (rpcPorts.admin.isLifecycleRunning() ? 'running' : 'stopped');
  if (request.method === 'transport.kb.restart') {
    const shutdownToken = readShutdownToken(request.params);
    if (shutdownToken === null || !tokensEqual(shutdownToken, rpcPorts.identity.shutdownToken)) {
      await writeEnvelope(
        socket,
        requestErrorResponse(request.id, KB_RESTART_UNAUTHORIZED_RESPONSE.message, KB_RESTART_UNAUTHORIZED_RESPONSE),
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      socket.end();
      return;
    }
    if (lifecycleState === 'draining' || lifecycleState === 'stopped' || rpcPorts.admin.isDrainRequested()) {
      await writeEnvelope(
        socket,
        {
          kind: 'response',
          id: request.id,
          result: BACKEND_SHUTTING_DOWN_RESPONSE,
        },
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      socket.end();
      return;
    }
    if (!rpcPorts.admin.restartKbChild) {
      await writeEnvelope(
        socket,
        requestErrorResponse(request.id, KB_RESTART_UNAVAILABLE_RESPONSE.message, KB_RESTART_UNAVAILABLE_RESPONSE),
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      socket.end();
      return;
    }
    writeAuditEvent(
      'admin_kb_child_restart_requested',
      {
        transport: 'ipc',
        reason: 'admin',
        instanceId: rpcPorts.identity.instanceId,
      },
      'warn',
    );
    try {
      const kbChild = await rpcPorts.admin.restartKbChild('ipc-admin');
      await writeEnvelope(
        socket,
        {
          kind: 'response',
          id: request.id,
          result: { status: 'ok', instanceId: rpcPorts.identity.instanceId, kbChild },
        },
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      socket.end();
    } catch (error: unknown) {
      rpcPorts.identity.log(`IPC request error (${request.method}): ${formatError(error)}\n`);
      if (!socket.destroyed && !socket.writableEnded) {
        const response = buildTransportErrorResponse(error);
        await writeEnvelope(socket, requestErrorResponse(request.id, response.message, response.data), {
          drainTimeoutMs: options.writeDrainTimeoutMs,
        });
        socket.end();
      }
    }
    return;
  }

  if (lifecycleState === 'draining' || lifecycleState === 'stopped' || rpcPorts.admin.isDrainRequested()) {
    await writeEnvelope(
      socket,
      {
        kind: 'response',
        id: request.id,
        result: BACKEND_SHUTTING_DOWN_RESPONSE,
      },
      { drainTimeoutMs: options.writeDrainTimeoutMs },
    );
    socket.end();
    return;
  }

  const entry = dispatchMap.get(request.method);
  if (!entry) {
    await writeEnvelope(socket, methodNotFoundResponse(request.id), { drainTimeoutMs: options.writeDrainTimeoutMs });
    socket.end();
    return;
  }

  const parsed = entry.spec.requestSchema.safeParse(request.params ?? {});
  if (!parsed.success) {
    await writeEnvelope(socket, validationErrorResponse(request.id, parsed.error), {
      drainTimeoutMs: options.writeDrainTimeoutMs,
    });
    socket.end();
    return;
  }

  startRequest();

  let subscriptionController: AbortController | null = null;
  try {
    subscriptionController = new AbortController();
    const invocation = await entry.dispatch(parsed.data, subscriptionController.signal);
    if (invocation.kind === 'unary') {
      // Domain-level errors (statusCode >= 400) ride a JSON-RPC `error`
      // envelope so the client rejects with a typed error instead of
      // resolving with the error body. Without this, callers that expect a
      // success-shaped result silently mis-render the error payload (e.g. a
      // CLI formatter accessing `data.slug` on `{code, message}`).
      if (typeof invocation.statusCode === 'number' && invocation.statusCode >= 400) {
        const body = invocation.body as { code?: unknown; message?: unknown };
        const message = typeof body.message === 'string' ? body.message : 'request failed';
        await writeEnvelope(socket, requestErrorResponse(request.id, message, invocation.body), {
          drainTimeoutMs: options.writeDrainTimeoutMs,
        });
        socket.end();
        return;
      }
      await writeEnvelope(
        socket,
        { kind: 'response', id: request.id, result: invocation.body } as JsonRpcResponseEnvelope,
        { drainTimeoutMs: options.writeDrainTimeoutMs },
      );
      socket.end();
      return;
    }

    await streamSubscription(socket, request, entry, invocation, subscriptionController, options);
  } catch (error: unknown) {
    if (subscriptionController?.signal.aborted || socket.destroyed) {
      return;
    }
    rpcPorts.identity.log(`IPC request error (${request.method}): ${formatError(error)}\n`);
    if (!socket.destroyed && !socket.writableEnded) {
      const response = buildTransportErrorResponse(error);
      await writeEnvelope(socket, requestErrorResponse(request.id, response.message, response.data), {
        drainTimeoutMs: options.writeDrainTimeoutMs,
      });
      socket.end();
    }
  } finally {
    finishRequest();
  }
}

export function createIpcServer(rpcPorts: HttpHandlerPorts, options: IpcServerOptions = {}): IpcListener {
  const dispatchTable = buildCoordinatorIpcDispatchTable(rpcPorts);
  const dispatchMap = new Map(dispatchTable.map((entry) => [entry.method, entry]));
  const sockets = new Set<Socket>();
  const maxOpenSockets = options.maxOpenSockets ?? IPC_DEFAULT_MAX_OPEN_SOCKETS;
  const firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? IPC_DEFAULT_FIRST_FRAME_TIMEOUT_MS;
  const maxAggregatePendingFrameBytes =
    options.maxAggregatePendingFrameBytes ?? IPC_DEFAULT_MAX_AGGREGATE_PENDING_FRAME_BYTES;
  const writeDrainTimeoutMs = options.writeDrainTimeoutMs ?? IPC_DEFAULT_WRITE_DRAIN_TIMEOUT_MS;
  let aggregatePendingFrameBytes = 0;
  // Mutable holder so the per-connection `dispatchFrame` closure reads the
  // current callback via `listener.onShutdownRequest`. Composition writes to
  // it after wiring the lifecycle controller.
  const listenerRef: { current: IpcListener | null } = { current: null };

  const server = createServer((socket) => {
    if (sockets.size >= maxOpenSockets) {
      rpcPorts.identity.log(`IPC connection cap exceeded (${sockets.size} >= ${maxOpenSockets}); destroying socket\n`);
      void writeEnvelope(
        socket,
        transportErrorResponse('Too many IPC connections', {
          code: 'too_many_ipc_connections',
          maxOpenSockets,
        }),
        { drainTimeoutMs: writeDrainTimeoutMs },
      ).finally(() => socket.destroy());
      return;
    }

    sockets.add(socket);
    const framer = createLineFramer();
    let inflightRequest = false;
    let pendingFrameBytes = 0;
    const firstFrameTimer = timers.setTimeout(() => {
      rpcPorts.identity.log(`IPC socket did not send a complete frame within ${firstFrameTimeoutMs}ms; destroying\n`);
      socket.destroy();
    }, firstFrameTimeoutMs);
    firstFrameTimer.unref?.();

    const updatePendingFrameBytes = (nextBytes: number) => {
      aggregatePendingFrameBytes += nextBytes - pendingFrameBytes;
      pendingFrameBytes = nextBytes;
    };

    const releasePendingFrameBytes = () => {
      updatePendingFrameBytes(0);
    };

    const finishRequest = () => {
      if (!inflightRequest) {
        return;
      }
      inflightRequest = false;
      rpcPorts.admin.endRequest();
    };

    socket.once('close', () => {
      timers.clearTimeout(firstFrameTimer);
      releasePendingFrameBytes();
      finishRequest();
      sockets.delete(socket);
    });

    socket.on('error', (error) => {
      rpcPorts.identity.log(`IPC socket error: ${formatError(error)}\n`);
      finishRequest();
    });

    const onData = (chunk: Buffer | string) => {
      let frames: string[];
      try {
        frames = framer.push(chunk);
        updatePendingFrameBytes(framer.pendingBytes());
      } catch (error: unknown) {
        if (error instanceof FrameTooLargeError) {
          updatePendingFrameBytes(error.observedBytes);
          rpcPorts.identity.log(
            `IPC frame too large (${error.observedBytes} > ${error.maxFrameBytes}); destroying socket\n`,
          );
          if (!socket.destroyed) {
            void writeEnvelope(
              socket,
              transportErrorResponse('Request frame too large', {
                code: error.code,
                maxFrameBytes: error.maxFrameBytes,
                observedBytes: error.observedBytes,
              }),
              { drainTimeoutMs: writeDrainTimeoutMs },
            ).finally(() => socket.destroy());
          }
          return;
        }
        throw error;
      }
      if (aggregatePendingFrameBytes > maxAggregatePendingFrameBytes) {
        rpcPorts.identity.log(
          `IPC pending frame budget exceeded (${aggregatePendingFrameBytes} > ${maxAggregatePendingFrameBytes}); destroying socket\n`,
        );
        void writeEnvelope(
          socket,
          transportErrorResponse('Too many pending IPC frame bytes', {
            code: 'ipc_pending_frame_budget_exceeded',
            maxAggregatePendingFrameBytes,
            observedBytes: aggregatePendingFrameBytes,
          }),
          { drainTimeoutMs: writeDrainTimeoutMs },
        ).finally(() => socket.destroy());
        return;
      }
      for (const frame of frames) {
        if (frame.trim().length === 0) {
          continue;
        }
        timers.clearTimeout(firstFrameTimer);
        releasePendingFrameBytes();
        socket.off('data', onData);
        void dispatchFrame(
          frame,
          socket,
          dispatchMap,
          rpcPorts,
          listenerRef.current?.onShutdownRequest ?? null,
          () => {
            rpcPorts.admin.beginRequest();
            inflightRequest = true;
          },
          finishRequest,
          { writeDrainTimeoutMs },
        );
        return;
      }
    };

    socket.on('data', onData);
  });

  const listener: IpcListener = {
    server,
    sockets,
    socketPath: null,
    onShutdownRequest: null,
  };
  listenerRef.current = listener;
  return listener;
}
