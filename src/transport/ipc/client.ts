import { createConnection, type Socket } from 'node:net';
import { errorMessage } from '../../infra/error-format.js';
import { CoralSetupError } from '../../runtime/errors.js';
import { createRealTimePort } from '../../infra/time.js';
import { encode, decode, type IpcAuthMetadata, type JsonRpcEnvelope, type JsonRpcRequestEnvelope } from './json-rpc.js';
import { createLineFramer } from '../line-framing.js';
import type { TimePort } from '../../infra/port-types.js';

const IPC_RETRY_BACKOFF_MS = 100;

/**
 * Request-time budget. `timeoutMs` is converted to an absolute deadline at
 * call entry; the same deadline covers connect, any ECONNREFUSED retry,
 * request write, and response framing. A connect that succeeds just before
 * the deadline does NOT receive a fresh full response timeout — the outer
 * `transport.shutdown` callsite (handoff) relies on this so SIGTERM/SIGKILL
 * scheduling is not stretched by the IPC helper.
 */
export type IpcRequestOptions = {
  timeoutMs?: number;
  time?: TimePort;
  auth?: IpcAuthMetadata | IpcAuthProvider | null;
};

export type IpcSubscriptionOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  time?: TimePort;
  auth?: IpcAuthMetadata | IpcAuthProvider | null;
};

export type IpcAuthProvider = () => IpcAuthMetadata | undefined;
export type IpcClientAuth = IpcAuthMetadata | IpcAuthProvider;

export type IpcSubscription<TResult> = AsyncIterable<TResult> & {
  close(): Promise<void>;
};

export type IpcClient = {
  readonly socketPath: string;
  request<TResult>(method: string, params?: unknown, options?: IpcRequestOptions): Promise<TResult>;
  subscribe<TResult>(
    method: string,
    params?: unknown,
    options?: IpcSubscriptionOptions,
  ): Promise<IpcSubscription<TResult>>;
  ping<TResult>(options?: IpcRequestOptions): Promise<TResult>;
  health<TResult>(options?: IpcRequestOptions): Promise<TResult>;
  shutdown<TResult>(options?: IpcRequestOptions): Promise<TResult>;
};

/**
 * A structured JSON-RPC rejection returned by the Coral coordinator. The
 * numeric JSON-RPC code remains available as `rpcCode`; when the response data
 * carries a public Coral code, `code` preserves it for CLI error rendering.
 */
export class IpcRpcError extends Error {
  readonly rpcCode: number;
  readonly data: unknown;
  readonly code: string | undefined;

  constructor(error: Extract<JsonRpcEnvelope, { kind: 'error' }>['error']) {
    super(error.message, error.data === undefined ? undefined : { cause: error.data });
    this.name = 'IpcRpcError';
    this.rpcCode = error.code;
    this.data = error.data;
    this.code =
      typeof error.data === 'object' &&
      error.data !== null &&
      'code' in error.data &&
      typeof error.data.code === 'string'
        ? error.data.code
        : undefined;
  }
}

let nextRequestId = 1;

function setupError(socketPath: string, error: unknown): CoralSetupError {
  return new CoralSetupError({
    code: 'ipc_connect_failed',
    userMessage: `Failed to connect to the Coral coordinator at ${socketPath}.`,
    remediation:
      'Check whether the coordinator is still starting, or remove a stale socket/discovery record and retry.',
    context: {
      socketPath,
      cause: errorMessage(error),
    },
  });
}

function remainingMs(deadlineMs: number | null, timePort: TimePort): number | undefined {
  if (deadlineMs === null) {
    return undefined;
  }
  return Math.max(0, deadlineMs - timePort.now());
}

async function connectSocket(socketPath: string, deadlineMs: number | null, timePort: TimePort): Promise<Socket> {
  const attemptConnection = async (): Promise<Socket> =>
    await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let timer: ReturnType<TimePort['setTimeout']> | null = null;

      const cleanup = () => {
        if (timer) {
          timePort.clearTimeout(timer);
          timer = null;
        }
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };

      const onConnect = () => {
        cleanup();
        resolve(socket);
      };

      const onError = (error: Error) => {
        cleanup();
        socket.destroy();
        reject(error);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);

      const stepBudget = remainingMs(deadlineMs, timePort);
      if (typeof stepBudget === 'number' && stepBudget > 0) {
        timer = timePort.setTimeout(() => {
          socket.destroy(new Error(`IPC connection timed out after ${stepBudget}ms`));
        }, stepBudget);
      } else if (typeof stepBudget === 'number' && stepBudget === 0) {
        queueMicrotask(() => {
          socket.destroy(new Error('IPC connection deadline already exceeded'));
        });
      }
    });

  try {
    return await attemptConnection();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
      throw setupError(socketPath, error);
    }
  }

  if (deadlineMs !== null && timePort.now() >= deadlineMs) {
    throw setupError(socketPath, new Error('IPC connection deadline exceeded before retry'));
  }
  await timePort.sleep(IPC_RETRY_BACKOFF_MS);

  try {
    return await attemptConnection();
  } catch (error: unknown) {
    throw setupError(socketPath, error);
  }
}

function normalizeIpcError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function buildIpcError(message: string, data?: unknown): Error {
  return data === undefined ? new Error(message) : new Error(message, { cause: data });
}

function buildIpcRpcError(error: Extract<JsonRpcEnvelope, { kind: 'error' }>['error']): IpcRpcError {
  return new IpcRpcError(error);
}

function isSubscriptionAck(value: unknown, method: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.status === 'subscribed' && record.method === method;
}

function resolveAuthMetadata(auth: IpcAuthMetadata | IpcAuthProvider | null | undefined): IpcAuthMetadata | undefined {
  return typeof auth === 'function' ? auth() : (auth ?? undefined);
}

export async function requestIpcMethod<TResult>(
  socketPath: string,
  method: string,
  params?: unknown,
  options?: IpcRequestOptions,
): Promise<TResult> {
  const timePort = options?.time ?? createRealTimePort();
  const auth = resolveAuthMetadata(options?.auth);
  const requestId = nextRequestId++;
  const timeoutMs = options?.timeoutMs;
  const deadlineMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timePort.now() + timeoutMs : null;
  const socket = await connectSocket(socketPath, deadlineMs, timePort);

  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<TimePort['setTimeout']> | null = null;
    const framer = createLineFramer();

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        timePort.clearTimeout(timer);
        timer = null;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      handler();
    };

    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    const onClose = () => {
      finish(() => reject(new Error(`IPC connection closed before ${method} returned a response`)));
    };

    const onData = (chunk: Buffer | string) => {
      for (const frame of framer.push(chunk)) {
        if (frame.trim().length === 0) {
          continue;
        }

        let envelope: JsonRpcEnvelope;
        try {
          envelope = decode(frame);
        } catch (error: unknown) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          return;
        }

        if (envelope.kind === 'notification') {
          continue;
        }

        if (envelope.kind === 'error') {
          if (envelope.id !== requestId) {
            continue;
          }
          finish(() => reject(buildIpcRpcError(envelope.error)));
          return;
        }

        if (envelope.kind === 'response' && envelope.id === requestId) {
          finish(() => resolve(envelope.result as TResult));
          socket.end();
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    const responseBudget = remainingMs(deadlineMs, timePort);
    if (typeof responseBudget === 'number' && responseBudget > 0) {
      timer = timePort.setTimeout(() => {
        socket.destroy(new Error(`IPC request timed out after ${responseBudget}ms`));
      }, responseBudget);
    } else if (typeof responseBudget === 'number' && responseBudget === 0) {
      queueMicrotask(() => {
        socket.destroy(new Error('IPC request deadline already exceeded'));
      });
    }

    const envelope: JsonRpcRequestEnvelope = {
      kind: 'request',
      id: requestId,
      method,
      ...(params === undefined ? {} : { params }),
      ...(auth === undefined ? {} : { auth }),
    };
    socket.write(`${encode(envelope)}\n`);
  });
}

export async function subscribeIpcMethod<TResult>(
  socketPath: string,
  method: string,
  params?: unknown,
  options?: IpcSubscriptionOptions,
): Promise<IpcSubscription<TResult>> {
  const timePort = options?.time ?? createRealTimePort();
  const auth = resolveAuthMetadata(options?.auth);
  const requestId = nextRequestId++;
  const timeoutMs = options?.timeoutMs;
  const deadlineMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timePort.now() + timeoutMs : null;
  const socket = await connectSocket(socketPath, deadlineMs, timePort);

  let done = false;
  let failure: Error | null = null;
  let handshakeComplete = false;
  let handshakeTimer: ReturnType<TimePort['setTimeout']> | null = null;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let resolveHandshake: (() => void) | null = null;
  let rejectHandshake: ((error: Error) => void) | null = null;
  const framer = createLineFramer();
  const queued: IteratorResult<TResult>[] = [];
  let queuedHead = 0;
  const waiters: Array<{
    resolve: (value: IteratorResult<TResult>) => void;
    reject: (error: unknown) => void;
  }> = [];
  const handshakePromise = new Promise<void>((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });

  const closeSettled = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const clearHandshakeTimer = () => {
    if (handshakeTimer) {
      timePort.clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  };

  const flushDone = () => {
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined as TResult });
    }
  };

  const flushError = (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  };

  const dequeue = (): IteratorResult<TResult> | undefined => {
    if (queuedHead >= queued.length) {
      queuedHead = 0;
      queued.length = 0;
      return undefined;
    }

    const value = queued[queuedHead];
    queuedHead += 1;
    if (queuedHead > 64 && queuedHead * 2 >= queued.length) {
      queued.splice(0, queuedHead);
      queuedHead = 0;
    }
    return value;
  };

  const push = (value: IteratorResult<TResult>) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    queued.push(value);
  };

  const cleanup = () => {
    clearHandshakeTimer();
    socket.off('data', onData);
    socket.off('error', onError);
    socket.off('close', onClose);
    options?.signal?.removeEventListener('abort', onAbort);
  };

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
    flushDone();
    resolveClose?.();
  };

  const fail = (error: unknown) => {
    if (failure) {
      return;
    }
    failure = normalizeIpcError(error);
    cleanup();
    rejectHandshake?.(failure);
    flushError(failure);
    resolveClose?.();
  };

  const onAbort = () => {
    const aborted = new TypeError('terminated');
    fail(aborted);
    socket.destroy();
  };

  const onError = (error: Error) => {
    fail(error);
  };

  const onClose = () => {
    if (failure) {
      return;
    }
    if (!handshakeComplete) {
      fail(new Error(`IPC connection closed before ${method} returned a subscription acknowledgement`));
      return;
    }
    finish();
  };

  const onData = (chunk: Buffer | string) => {
    for (const frame of framer.push(chunk)) {
      if (frame.trim().length === 0) {
        continue;
      }

      let envelope: JsonRpcEnvelope;
      try {
        envelope = decode(frame);
      } catch (error: unknown) {
        fail(error);
        socket.destroy(normalizeIpcError(error));
        return;
      }

      if (envelope.kind === 'error') {
        if (envelope.id !== requestId) {
          continue;
        }
        fail(buildIpcRpcError(envelope.error));
        socket.destroy();
        return;
      }

      if (!handshakeComplete) {
        if (envelope.kind !== 'response' || envelope.id !== requestId) {
          continue;
        }
        if (!isSubscriptionAck(envelope.result, method)) {
          fail(buildIpcError(`Subscription open failed for ${method}`, envelope.result));
          socket.destroy();
          return;
        }
        handshakeComplete = true;
        clearHandshakeTimer();
        resolveHandshake?.();
        continue;
      }

      if (envelope.kind === 'notification' && envelope.method === method) {
        push({ done: false, value: envelope.params as TResult });
      }
    }
  };

  socket.on('data', onData);
  socket.once('error', onError);
  socket.once('close', onClose);

  if (options?.signal?.aborted) {
    onAbort();
  } else {
    options?.signal?.addEventListener('abort', onAbort, { once: true });
  }

  const handshakeBudget = remainingMs(deadlineMs, timePort);
  if (typeof handshakeBudget === 'number' && handshakeBudget > 0) {
    handshakeTimer = timePort.setTimeout(() => {
      const error = new Error(`IPC subscription timed out after ${handshakeBudget}ms`);
      fail(error);
      socket.destroy(error);
    }, handshakeBudget);
  }

  const envelope: JsonRpcRequestEnvelope = {
    kind: 'request',
    id: requestId,
    method,
    ...(params === undefined ? {} : { params }),
    ...(auth === undefined ? {} : { auth }),
  };
  socket.write(`${encode(envelope)}\n`);
  await handshakePromise;

  const close = async (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }

    finish();
    socket.destroy();
    closePromise = closeSettled;
    await closePromise;
  };

  const iterator: AsyncIterator<TResult> = {
    next: async () => {
      const queuedValue = dequeue();
      if (queuedValue !== undefined) {
        return queuedValue;
      }
      if (failure) {
        throw failure;
      }
      if (done) {
        return { done: true, value: undefined as TResult };
      }

      return new Promise<IteratorResult<TResult>>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    return: async () => {
      await close();
      return { done: true, value: undefined as TResult };
    },
    throw: async (error?: unknown) => {
      await close();
      throw normalizeIpcError(error);
    },
  };

  return {
    close,
    [Symbol.asyncIterator]: () => iterator,
  };
}

export function createIpcClient(
  socketPath: string,
  timePort: TimePort = createRealTimePort(),
  auth?: IpcClientAuth,
): IpcClient {
  const withRequestOptions = (options?: IpcRequestOptions): IpcRequestOptions => ({
    ...options,
    time: options?.time ?? timePort,
    auth: options && 'auth' in options ? options.auth : auth,
  });
  const withSubscriptionOptions = (options?: IpcSubscriptionOptions): IpcSubscriptionOptions => ({
    ...options,
    time: options?.time ?? timePort,
    auth: options && 'auth' in options ? options.auth : auth,
  });

  return {
    socketPath,
    request: <TResult>(method: string, params?: unknown, options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, method, params, withRequestOptions(options)),
    subscribe: <TResult>(method: string, params?: unknown, options?: IpcSubscriptionOptions) =>
      subscribeIpcMethod<TResult>(socketPath, method, params, withSubscriptionOptions(options)),
    ping: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.ping', undefined, {
        ...options,
        auth: null,
        time: options?.time ?? timePort,
      }),
    health: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.health', undefined, withRequestOptions(options)),
    shutdown: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.shutdown', {}, withRequestOptions(options)),
  };
}
