import { createConnection, type Socket } from 'node:net';

import {
  PROXY_CONTROL_PROTOCOL_ERROR_CODES,
  ProxyControlProtocolError,
  createFrameReader,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  type ProxyControlProtocolErrorCode,
} from './protocol.js';

/** The elapsed-time surface one request budget draws from. */
export interface ControlClientTimer {
  setTimeout(callback: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: { unref?: () => void }): void;
}

export type ControlClientErrorCode = 'control_client_connect_failed' | 'control_client_closed' | 'control_call_failed';

export class ControlClientError extends Error {
  readonly code: ControlClientErrorCode;
  /**
   * The server's own closed-set code, when the failure came from a JSON-RPC error response. Absent for a
   * connect failure, a per-call timeout, or a channel close — those never reach the wire's `error.data`, so
   * there is no protocol code to carry.
   */
  readonly protocolCode?: ProxyControlProtocolErrorCode;

  constructor(code: ControlClientErrorCode, message: string, protocolCode?: ProxyControlProtocolErrorCode) {
    super(message);
    this.name = 'ControlClientError';
    this.code = code;
    this.protocolCode = protocolCode;
    Object.setPrototypeOf(this, ControlClientError.prototype);
  }
}

/**
 * Reads the server's own protocol code out of a JSON-RPC error's `data`, if it is one this endpoint's
 * closed set actually recognizes. `data` arrives as `unknown` off the wire, so an unrecognized shape — or a
 * peer that is not this endpoint at all — must canonicalize to "no code" rather than be trusted as one.
 */
function protocolCodeFrom(data: unknown): ProxyControlProtocolErrorCode | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' && (PROXY_CONTROL_PROTOCOL_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ProxyControlProtocolErrorCode)
    : undefined;
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

  const failAll = (error: Error): void => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      timer.clearTimeout(waiter.budget);
      waiter.reject(error);
    }
  };

  // Frames are split on the newline byte and each complete frame is decoded once. Decoding a socket chunk
  // on its own would corrupt any multi-byte character straddling the boundary, and the damage would survive
  // JSON.parse and strict validation because it lands inside a JSON string.
  const read = createFrameReader(
    (frame) => {
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
      if (message.id === null) return;
      const waiter = pending.get(Number(message.id));
      if (waiter === undefined) return;
      pending.delete(Number(message.id));
      timer.clearTimeout(waiter.budget);
      if ('error' in message) {
        waiter.reject(
          new ControlClientError('control_call_failed', message.error.message, protocolCodeFrom(message.error.data)),
        );
      } else {
        waiter.resolve(message.result);
      }
    },
    () => socket.destroy(),
  );
  socket.on('data', read);
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
