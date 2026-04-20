import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { CoralSetupError } from '../../runtime/errors.js';
import { encode, decode, type JsonRpcEnvelope, type JsonRpcRequest, type JsonRpcResponse } from '../json-rpc.js';

const IPC_RETRY_BACKOFF_MS = 100;

export type IpcRequestOptions = {
  timeoutMs?: number;
};

export type IpcSubscriptionOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

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
  health<TResult>(options?: IpcRequestOptions): Promise<TResult>;
  shutdown<TResult>(options?: IpcRequestOptions): Promise<TResult>;
};

let nextRequestId = 1;

function setupError(socketPath: string, error: unknown): CoralSetupError {
  return new CoralSetupError({
    code: 'ipc_connect_failed',
    userMessage: `Failed to connect to the Coral coordinator at ${socketPath}.`,
    remediation:
      'Check whether the coordinator is still starting, or remove a stale socket/discovery record and retry.',
    context: {
      socketPath,
      cause: error instanceof Error ? error.message : String(error),
    },
  });
}

async function connectSocket(socketPath: string, timeoutMs: number | undefined): Promise<Socket> {
  const attemptConnection = async (): Promise<Socket> =>
    await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
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

      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          socket.destroy(new Error(`IPC connection timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });

  try {
    return await attemptConnection();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
      throw setupError(socketPath, error);
    }
  }

  await delay(IPC_RETRY_BACKOFF_MS);

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

function isSubscriptionAck(value: unknown, method: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.status === 'subscribed' && record.method === method;
}

export async function requestIpcMethod<TResult>(
  socketPath: string,
  method: string,
  params?: unknown,
  options?: IpcRequestOptions,
): Promise<TResult> {
  const requestId = nextRequestId++;
  const timeoutMs = options?.timeoutMs;
  const socket = await connectSocket(socketPath, timeoutMs);

  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let timer: NodeJS.Timeout | null = null;

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
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
      buffer += chunk.toString();
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
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
          finish(() => reject(new Error(envelope.error.message, { cause: envelope.error.data })));
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

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        socket.destroy(new Error(`IPC request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const envelope: JsonRpcRequest = {
      kind: 'request',
      id: requestId,
      method,
      ...(params === undefined ? {} : { params }),
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
  const requestId = nextRequestId++;
  const timeoutMs = options?.timeoutMs;
  const socket = await connectSocket(socketPath, timeoutMs);

  let buffer = '';
  let done = false;
  let failure: Error | null = null;
  let handshakeComplete = false;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let resolveHandshake: (() => void) | null = null;
  let rejectHandshake: ((error: Error) => void) | null = null;
  const queued: IteratorResult<TResult>[] = [];
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
      clearTimeout(handshakeTimer);
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
    buffer += chunk.toString();
    const frames = buffer.split('\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
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
        fail(buildIpcError(envelope.error.message, envelope.error.data));
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

  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    handshakeTimer = setTimeout(() => {
      const error = new Error(`IPC subscription timed out after ${timeoutMs}ms`);
      fail(error);
      socket.destroy(error);
    }, timeoutMs);
  }

  const envelope: JsonRpcRequest = {
    kind: 'request',
    id: requestId,
    method,
    ...(params === undefined ? {} : { params }),
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
      if (queued.length > 0) {
        return queued.shift() as IteratorResult<TResult>;
      }
      if (failure) {
        throw failure;
      }
      if (done) {
        return { done: true, value: undefined as TResult };
      }

      return await new Promise<IteratorResult<TResult>>((resolve, reject) => {
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

export function createIpcClient(socketPath: string): IpcClient {
  return {
    socketPath,
    request: <TResult>(method: string, params?: unknown, options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, method, params, options),
    subscribe: <TResult>(method: string, params?: unknown, options?: IpcSubscriptionOptions) =>
      subscribeIpcMethod<TResult>(socketPath, method, params, options),
    health: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.health', undefined, options),
    shutdown: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.shutdown', undefined, options),
  };
}
