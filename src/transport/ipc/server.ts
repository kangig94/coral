import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
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

function writeEnvelope(socket: Socket, envelope: JsonRpcEnvelope): void {
  socket.write(`${encode(envelope)}\n`);
}

export function ipcAdapter(spec: RpcMethodSpec<unknown, unknown>, rpcPorts: HttpHandlerPorts): IpcDispatchEntry {
  return {
    method: spec.name,
    spec,
    // interim mapping; future role-auth derives authority from the authenticated principal, not the transport.
    dispatch: async (request, abortSignal) => await executeCatalogRequest(spec, request, rpcPorts, 'admin', abortSignal),
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

  writeEnvelope(socket, {
    kind: 'response',
    id: request.id,
    result: { status: 'subscribed', method: entry.method },
  });

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done || socket.destroyed || socket.writableEnded) {
        break;
      }

      writeEnvelope(socket, {
        kind: 'notification',
        method: entry.method,
        params: next.value,
      });
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
): Promise<void> {
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
    // `requestDrain` only flips the drain flag and notifies the idle timer;
    // the idle timer is not installed until lifecycle reaches 'running'.
    // To unblock contenders during a still-`starting` incumbent, lifecycle
    // composition registers `onShutdownRequest` to drive `coordinator.shutdown`
    // directly. No-op when lifecycle is already running (drain handles it).
    onShutdownRequest?.('replaced');
    writeEnvelope(socket, {
      kind: 'response',
      id: request.id,
      result: { status: 'draining', instanceId: rpcPorts.identity.instanceId },
    });
    socket.end();
    return;
  }

  const lifecycleState =
    rpcPorts.admin.getLifecycleState?.() ?? (rpcPorts.admin.isLifecycleRunning() ? 'running' : 'stopped');
  if (lifecycleState === 'draining' || lifecycleState === 'stopped' || rpcPorts.admin.isDrainRequested()) {
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
        writeEnvelope(socket, requestErrorResponse(request.id, message, invocation.body));
        socket.end();
        return;
      }
      writeEnvelope(socket, { kind: 'response', id: request.id, result: invocation.body } as JsonRpcResponseEnvelope);
      socket.end();
      return;
    }

    await streamSubscription(socket, request, entry, invocation, subscriptionController);
  } catch (error: unknown) {
    if (subscriptionController?.signal.aborted || socket.destroyed) {
      return;
    }
    rpcPorts.identity.log(`IPC request error (${request.method}): ${formatError(error)}\n`);
    if (!socket.destroyed && !socket.writableEnded) {
      const response = buildTransportErrorResponse(error);
      writeEnvelope(socket, requestErrorResponse(request.id, response.message, response.data));
      socket.end();
    }
  } finally {
    finishRequest();
  }
}

export function createIpcServer(rpcPorts: HttpHandlerPorts): IpcListener {
  const dispatchTable = buildCoordinatorIpcDispatchTable(rpcPorts);
  const dispatchMap = new Map(dispatchTable.map((entry) => [entry.method, entry]));
  const sockets = new Set<Socket>();
  // Mutable holder so the per-connection `dispatchFrame` closure reads the
  // current callback via `listener.onShutdownRequest`. Composition writes to
  // it after wiring the lifecycle controller.
  const listenerRef: { current: IpcListener | null } = { current: null };

  const server = createServer((socket) => {
    sockets.add(socket);
    const framer = createLineFramer();
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

    const onData = (chunk: Buffer | string) => {
      let frames: string[];
      try {
        frames = framer.push(chunk);
      } catch (error: unknown) {
        if (error instanceof FrameTooLargeError) {
          rpcPorts.identity.log(
            `IPC frame too large (${error.observedBytes} > ${error.maxFrameBytes}); destroying socket\n`,
          );
          if (!socket.destroyed) {
            writeEnvelope(
              socket,
              transportErrorResponse('Request frame too large', {
                code: error.code,
                maxFrameBytes: error.maxFrameBytes,
                observedBytes: error.observedBytes,
              }),
            );
            socket.destroy();
          }
          return;
        }
        throw error;
      }
      for (const frame of frames) {
        if (frame.trim().length === 0) {
          continue;
        }
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
