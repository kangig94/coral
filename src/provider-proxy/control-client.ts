import { createConnection, type Socket } from 'node:net';

import {
  PROVIDER_EVENT_METHOD,
  PROXY_CONTROL_PROTOCOL_ERROR_CODES,
  ProxyControlProtocolError,
  createFrameReader,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  providerEventRequestSchema,
  providerEventResultSchema,
  type ProviderEventRequest,
  type ProviderEventResult,
  type ProxyControlJsonRpcMessage,
  type ProxyControlProtocolErrorCode,
} from './protocol.js';

/**
 * Answers the one inbound method this client ever serves: `provider.event.v1`, the proxy's own push of one
 * buffered provider event back over the connection this client dialed out on.
 */
export type ProviderEventHandler = (
  request: ProviderEventRequest,
) => Promise<ProviderEventResult> | ProviderEventResult;

/** The elapsed-time surface one request budget draws from. */
export interface ControlClientTimer {
  setTimeout(callback: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: { unref?: () => void }): void;
}

export type ControlClientErrorCode = 'control_client_connect_failed' | 'control_client_closed' | 'control_call_failed';

export type ControlClientErrorOrigin = 'timeout' | 'write' | 'closed' | 'remote-response';

export type ControlClientRemoteFailure =
  | Readonly<{
      kind: 'json-rpc-error';
      jsonRpcCode: number;
      protocolCode: ProxyControlProtocolErrorCode | null;
      admissionReason: 'control-active' | 'invalid-state' | 'teardown-latched' | null;
    }>
  | Readonly<{ kind: 'invalid-frame' }>;

export class ControlClientError extends Error {
  readonly code: ControlClientErrorCode;
  readonly origin: ControlClientErrorOrigin;
  readonly remoteFailure: ControlClientRemoteFailure | null;
  /** Compatibility projection for operation-control policy while it migrates to `remoteFailure`. */
  readonly protocolCode?: ProxyControlProtocolErrorCode;

  constructor(
    code: ControlClientErrorCode,
    message: string,
    origin: Exclude<ControlClientErrorOrigin, 'remote-response'>,
  );
  constructor(
    code: ControlClientErrorCode,
    message: string,
    origin: 'remote-response',
    remoteFailure: ControlClientRemoteFailure,
  );
  constructor(
    code: ControlClientErrorCode,
    message: string,
    origin: ControlClientErrorOrigin,
    remoteFailure: ControlClientRemoteFailure | null = null,
  ) {
    super(message);
    if ((origin === 'remote-response') !== (remoteFailure !== null)) {
      throw new Error('control_client_error_origin_mismatch');
    }
    this.name = 'ControlClientError';
    this.code = code;
    this.origin = origin;
    this.remoteFailure = remoteFailure;
    if (remoteFailure?.kind === 'json-rpc-error' && remoteFailure.protocolCode !== null) {
      this.protocolCode = remoteFailure.protocolCode;
    }
    Object.setPrototypeOf(this, ControlClientError.prototype);
  }
}

/**
 * Reads the server's own protocol code out of a JSON-RPC error's `data`, if it is one this endpoint's
 * closed set actually recognizes. `data` arrives as `unknown` off the wire, so an unrecognized shape — or a
 * peer that is not this endpoint at all — must canonicalize to "no code" rather than be trusted as one.
 */
function protocolCodeFrom(data: unknown): ProxyControlProtocolErrorCode | null {
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' && (PROXY_CONTROL_PROTOCOL_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ProxyControlProtocolErrorCode)
    : null;
}

function admissionReasonFrom(data: unknown): 'control-active' | 'invalid-state' | 'teardown-latched' | null {
  if (typeof data !== 'object' || data === null) return null;
  const reason = (data as { reason?: unknown }).reason;
  return reason === 'control-active' || reason === 'invalid-state' || reason === 'teardown-latched' ? reason : null;
}

export interface ControlClient {
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  readonly faulted: Promise<ControlClientError>;
  onFault(listener: (error: ControlClientError) => void): () => void;
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
 *
 * `onProviderEvent`, when supplied, answers the one method the peer may send back over this same connection.
 * Every other inbound method — and `provider.event.v1` itself when no handler was installed — is refused
 * with the protocol's own closed-set vocabulary rather than silently dropped, so a peer sending something out
 * of protocol gets a diagnosable reply instead of a connection that mysteriously never answers.
 */
export async function connectControlClient(
  socketPath: string,
  timer: ControlClientTimer,
  connectTimeoutMs: number,
  onProviderEvent?: ProviderEventHandler,
): Promise<ControlClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const pendingSocket = createConnection(socketPath);
    const budget = timer.setTimeout(() => {
      pendingSocket.destroy();
      reject(
        new ControlClientError(
          'control_client_connect_failed',
          `Control connect exceeded ${connectTimeoutMs}ms.`,
          'timeout',
        ),
      );
    }, connectTimeoutMs);
    budget.unref?.();
    pendingSocket.once('error', (error: Error) => {
      timer.clearTimeout(budget);
      reject(
        new ControlClientError('control_client_connect_failed', `Control connect failed: ${error.message}`, 'closed'),
      );
    });
    pendingSocket.once('connect', () => {
      timer.clearTimeout(budget);
      resolve(pendingSocket);
    });
  });

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  let resolveFault!: (error: ControlClientError) => void;
  let latchedFault: ControlClientError | null = null;
  const faultListeners = new Set<(error: ControlClientError) => void>();
  const faulted = new Promise<ControlClientError>((resolve) => {
    resolveFault = resolve;
  });
  const latchFault = (error: ControlClientError): void => {
    if (latchedFault !== null) return;
    latchedFault = error;
    resolveFault(error);
    for (const listener of faultListeners) listener(error);
  };

  const failAll = (error: Error): void => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      timer.clearTimeout(waiter.budget);
      waiter.reject(error);
    }
  };

  const faultInvalidFrame = (): void => {
    const error = new ControlClientError(
      'control_call_failed',
      'The control channel received an invalid frame.',
      'remote-response',
      { kind: 'invalid-frame' },
    );
    latchFault(error);
    failAll(error);
    socket.destroy();
  };

  // JSON-RPC's own reserved "invalid request"/"internal error" codes. `control-endpoint.ts` uses the same
  // values for its equivalent refusals; redeclared here rather than imported because those constants are
  // private to that module, and this client owns no reach into it.
  const JSON_RPC_INVALID_REQUEST = -32_600;
  const JSON_RPC_INTERNAL_ERROR = -32_603;

  const refuseInboundRequest = (id: string | number, code: ProxyControlProtocolErrorCode, message: string): void => {
    if (socket.destroyed) return;
    socket.write(
      encodeProxyControlFrame({
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_INVALID_REQUEST, message, data: { code } },
      }),
    );
  };

  const serveInboundRequest = async (
    request: Extract<ProxyControlJsonRpcMessage, { method: string }>,
  ): Promise<void> => {
    if (request.method !== PROVIDER_EVENT_METHOD || onProviderEvent === undefined) {
      refuseInboundRequest(request.id, 'protocol_violation', `This control client does not serve ${request.method}.`);
      return;
    }
    let parsed: ProviderEventRequest;
    try {
      parsed = providerEventRequestSchema.parse(request.params);
    } catch {
      refuseInboundRequest(request.id, 'invalid_request', `${PROVIDER_EVENT_METHOD} failed strict validation.`);
      return;
    }
    let result: ProviderEventResult;
    try {
      result = providerEventResultSchema.parse(await onProviderEvent(parsed));
    } catch (error: unknown) {
      if (socket.destroyed) return;
      socket.write(
        encodeProxyControlFrame({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: JSON_RPC_INTERNAL_ERROR,
            message: error instanceof Error ? error.message : `${PROVIDER_EVENT_METHOD} failed.`,
            data: { code: 'protocol_violation' },
          },
        }),
      );
      return;
    }
    if (socket.destroyed) return;
    socket.write(encodeProxyControlFrame({ jsonrpc: '2.0', id: request.id, result }));
  };

  // Frames are split on the newline byte and each complete frame is decoded once. Decoding a socket chunk
  // on its own would corrupt any multi-byte character straddling the boundary, and the damage would survive
  // JSON.parse and strict validation because it lands inside a JSON string.
  const read = createFrameReader((frame) => {
    let message;
    try {
      message = decodeProxyControlFrame(frame);
    } catch {
      faultInvalidFrame();
      return;
    }
    if ('method' in message) {
      void serveInboundRequest(message);
      return;
    }
    if (message.id === null) return;
    const waiter = pending.get(Number(message.id));
    if (waiter === undefined) return;
    pending.delete(Number(message.id));
    timer.clearTimeout(waiter.budget);
    if ('error' in message) {
      waiter.reject(
        new ControlClientError('control_call_failed', message.error.message, 'remote-response', {
          kind: 'json-rpc-error',
          jsonRpcCode: message.error.code,
          protocolCode: protocolCodeFrom(message.error.data),
          admissionReason: admissionReasonFrom(message.error.data),
        }),
      );
    } else {
      waiter.resolve(message.result);
    }
  }, faultInvalidFrame);
  socket.on('data', read);
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    closed = true;
    const error = new ControlClientError('control_client_closed', 'The control channel closed.', 'closed');
    latchFault(error);
    failAll(error);
  });

  return {
    faulted,
    onFault(listener) {
      if (latchedFault !== null) {
        listener(latchedFault);
        return () => undefined;
      }

      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
      if (closed) {
        return Promise.reject(new ControlClientError('control_client_closed', 'The control channel closed.', 'closed'));
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        const budget = timer.setTimeout(() => {
          pending.delete(id);
          reject(
            new ControlClientError('control_call_failed', `${method} exceeded its ${timeoutMs}ms budget.`, 'timeout'),
          );
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
              : new ControlClientError('control_call_failed', `${method} could not be sent.`, 'write'),
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
