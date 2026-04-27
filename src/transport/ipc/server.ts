import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { ZodError } from 'zod';
import type { HttpHandlerPorts } from '../server-ports.js';
import { formatZodError } from '../validation.js';
import { encode, decode, type JsonRpcEnvelope, type JsonRpcError, type JsonRpcRequest, type JsonRpcResponse } from '../json-rpc.js';
import { createLineFramer } from '../line-framing.js';
import { rpcCatalog, type RpcMethodSpec } from '../rpc/catalog.js';
import { type CatalogRequestExecution, executeCatalogRequest } from '../dispatch.js';
import { buildJsonRpcError } from '../../infra/json-rpc-error.js';
import { formatError } from '../../infra/error-format.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { buildTransportErrorResponse } from '../error-response.js';

const INVALID_JSON_RESPONSE = {
  code: 'invalid_request',
  message: 'Invalid JSON body',
};
const BACKEND_SHUTTING_DOWN_RESPONSE = {
  code: 'coordinator_shutting_down',
  message: 'Coordinator shutting down',
};

export type IpcListener = {
  readonly server: NetServer;
  readonly sockets: Set<Socket>;
  socketPath: string | null;
};

export type IpcDispatchEntry = {
  readonly method: string;
  readonly spec: RpcMethodSpec<unknown, unknown>;
  dispatch(request: unknown, abortSignal?: AbortSignal): Promise<CatalogRequestExecution>;
};

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

export function ipcAdapter(
  spec: RpcMethodSpec<unknown, unknown>,
  rpcPorts: HttpHandlerPorts,
): IpcDispatchEntry {
  return {
    method: spec.name,
    spec,
    dispatch: async (request, abortSignal) => await executeCatalogRequest(spec, request, rpcPorts, abortSignal),
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

async function streamSubscription(
  socket: Socket,
  request: JsonRpcRequest,
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

  startRequest();

  let subscriptionController: AbortController | null = null;
  try {
    subscriptionController = new AbortController();
    const invocation = await entry.dispatch(parsed.data, subscriptionController.signal);
    if (invocation.kind === 'unary') {
      writeEnvelope(socket, { kind: 'response', id: request.id, result: invocation.body } as JsonRpcResponse);
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
      for (const frame of framer.push(chunk)) {
        if (frame.trim().length === 0) {
          continue;
        }
        socket.off('data', onData);
        void dispatchFrame(
          frame,
          socket,
          dispatchMap,
          rpcPorts,
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

  return {
    server,
    sockets,
    socketPath: null,
  };
}
