import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { CoralSetupError } from '../../runtime/errors.js';
import { encode, decode, type JsonRpcEnvelope, type JsonRpcRequest, type JsonRpcResponse } from '../json-rpc.js';

const IPC_RETRY_BACKOFF_MS = 100;

export type IpcRequestOptions = {
  timeoutMs?: number;
};

export type IpcClient = {
  readonly socketPath: string;
  request<TResult>(method: string, params?: unknown, options?: IpcRequestOptions): Promise<TResult>;
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

export function createIpcClient(socketPath: string): IpcClient {
  return {
    socketPath,
    request: <TResult>(method: string, params?: unknown, options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, method, params, options),
    health: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.health', undefined, options),
    shutdown: <TResult>(options?: IpcRequestOptions) =>
      requestIpcMethod<TResult>(socketPath, 'transport.shutdown', undefined, options),
  };
}
