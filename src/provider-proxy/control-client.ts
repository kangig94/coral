import { createConnection, type Socket } from 'node:net';

import {
  MAX_PROXY_CONTROL_FRAME_BYTES,
  ProxyControlProtocolError,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
} from './protocol.js';

/** The elapsed-time surface one request budget draws from. */
export interface ControlClientTimer {
  setTimeout(callback: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: { unref?: () => void }): void;
}

export type ControlClientErrorCode = 'control_client_connect_failed' | 'control_client_closed' | 'control_call_failed';

export class ControlClientError extends Error {
  readonly code: ControlClientErrorCode;

  constructor(code: ControlClientErrorCode, message: string) {
    super(message);
    this.name = 'ControlClientError';
    this.code = code;
    Object.setPrototypeOf(this, ControlClientError.prototype);
  }
}

export interface ControlClient {
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  close(): void;
}

type Pending = Readonly<{
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  budget: { unref?: () => void };
}>;

/**
 * Connects one control channel. A single connection carries the whole channel lifetime because the server
 * side reserves exactly one live connection as control — reconnecting would be a new tenancy, not a retry.
 */
export async function connectControlClient(
  socketPath: string,
  timer: ControlClientTimer,
  connectTimeoutMs: number,
): Promise<ControlClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const pendingSocket = createConnection(socketPath);
    const budget = timer.setTimeout(() => {
      pendingSocket.destroy();
      reject(
        new ControlClientError('control_client_connect_failed', `Control connect exceeded ${connectTimeoutMs}ms.`),
      );
    }, connectTimeoutMs);
    budget.unref?.();
    pendingSocket.once('error', (error: Error) => {
      timer.clearTimeout(budget);
      reject(new ControlClientError('control_client_connect_failed', `Control connect failed: ${error.message}`));
    });
    pendingSocket.once('connect', () => {
      timer.clearTimeout(budget);
      resolve(pendingSocket);
    });
  });

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  let buffer = '';

  const failAll = (error: Error): void => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      timer.clearTimeout(waiter.budget);
      waiter.reject(error);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer, 'utf8') > MAX_PROXY_CONTROL_FRAME_BYTES) {
      buffer = '';
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const frame = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      let message;
      try {
        message = decodeProxyControlFrame(frame);
      } catch {
        socket.destroy();
        return;
      }
      // A control server never calls back, so an inbound request is out of protocol rather than work.
      if ('method' in message) {
        socket.destroy();
        return;
      }
      if (message.id === null) continue;
      const waiter = pending.get(Number(message.id));
      if (waiter === undefined) continue;
      pending.delete(Number(message.id));
      timer.clearTimeout(waiter.budget);
      if ('error' in message) {
        waiter.reject(new ControlClientError('control_call_failed', message.error.message));
      } else {
        waiter.resolve(message.result);
      }
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    closed = true;
    failAll(new ControlClientError('control_client_closed', 'The control channel closed.'));
  });

  return {
    call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
      if (closed) {
        return Promise.reject(new ControlClientError('control_client_closed', 'The control channel closed.'));
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        const budget = timer.setTimeout(() => {
          pending.delete(id);
          reject(new ControlClientError('control_call_failed', `${method} exceeded its ${timeoutMs}ms budget.`));
        }, timeoutMs);
        budget.unref?.();
        pending.set(id, { resolve, reject, budget });
        try {
          socket.write(encodeProxyControlFrame({ jsonrpc: '2.0', id, method, params }));
        } catch (error: unknown) {
          pending.delete(id);
          timer.clearTimeout(budget);
          reject(
            error instanceof ProxyControlProtocolError
              ? error
              : new ControlClientError('control_call_failed', `${method} could not be sent.`),
          );
        }
      });
    },
    close(): void {
      closed = true;
      socket.destroy();
    },
  };
}
