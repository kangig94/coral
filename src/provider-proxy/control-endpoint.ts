import { createServer, type Server as NetServer, type Socket } from 'node:net';

import {
  MAX_PROXY_CONTROL_FRAME_BYTES,
  ProxyControlProtocolError,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  type ProxyControlJsonRpcMessage,
} from './protocol.js';

/** JSON-RPC error codes this endpoint reports. Reserved-range values follow the JSON-RPC 2.0 spec. */
const JSON_RPC_INVALID_REQUEST = -32_600;
const JSON_RPC_METHOD_NOT_FOUND = -32_601;
const JSON_RPC_INTERNAL_ERROR = -32_603;

/**
 * Control tenancies are numbered so a heartbeat cannot be replayed against a later tenancy. The first
 * accepted open is epoch 1; a caller that later re-opens after control loss gets a strictly greater epoch.
 */
export type ControlEpoch = number;

/** A one-use challenge string. Minting is injected so this module owns no randomness. */
export type ControlChallenge = string;

/** The elapsed-time surface one request budget draws from. Deliberately not a wall clock. */
export interface ControlEndpointTimer {
  setTimeout(callback: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: { unref?: () => void }): void;
}

export type ControlEndpointErrorCode =
  | 'control_endpoint_listen_failed'
  | 'control_endpoint_already_listening'
  | 'control_endpoint_closed';

export class ControlEndpointError extends Error {
  readonly code: ControlEndpointErrorCode;

  constructor(code: ControlEndpointErrorCode, message: string) {
    super(message);
    this.name = 'ControlEndpointError';
    this.code = code;
    Object.setPrototypeOf(this, ControlEndpointError.prototype);
  }
}

/**
 * A method name absent from the role's dispatch table. Kept distinct from the protocol's error vocabulary —
 * which has no such code — so the JSON-RPC mapping can answer "no such method" without borrowing a code
 * that means something else.
 */
class UnknownControlMethodError extends Error {
  constructor(method: string) {
    super(`Unknown control method ${method}.`);
    this.name = 'UnknownControlMethodError';
    Object.setPrototypeOf(this, UnknownControlMethodError.prototype);
  }
}

/**
 * A method served only while the connection holds active control. `open` and `heartbeat` are not in this
 * map — the endpoint owns their tenancy semantics so no role can implement them inconsistently.
 */
export type ControlMethodHandler = (params: unknown) => Promise<unknown> | unknown;

export type ControlEndpointRole = Readonly<{
  /** Method name for this role's tenancy-opening call, e.g. `guardian.open.v1`. */
  openMethod: string;
  /** Method name for this role's challenge echo, e.g. `guardian.heartbeat.v1`. */
  heartbeatMethod: string;
  /**
   * The one-use secret from this role's bootstrap capsule. The endpoint compares it in constant length
   * and forgets it after the first accepted open, so a second open cannot reuse it.
   */
  bootstrapNonce: string;
  /**
   * Validates the role-specific `open` params and returns the result fields that are not the generic
   * `controlEpoch`/`heartbeatChallenge` pair. Throwing rejects the open without establishing a tenancy.
   */
  openResult(params: unknown): Record<string, unknown>;
  /** Methods requiring active control. */
  methods: ReadonlyMap<string, ControlMethodHandler>;
  /**
   * The capsule-authenticated peer channel, held open for the lifetime of the set alongside control. It is
   * a separate authority: the guardian stages a provider root over it while the coordinator's own control
   * connection is still provisional, and its loss is evidence in its own right.
   */
  pairing?: Readonly<{
    openMethod: string;
    secret: string;
    methods: ReadonlyMap<string, ControlMethodHandler>;
  }>;
}>;

export type ControlEndpointObserver = Readonly<{
  /** A challenge echo was accepted. The owner records round-trip evidence; the endpoint stores no deadline. */
  onChallengeEcho(epoch: ControlEpoch): void;
  /** The control connection ended. The owner may treat this as its local `eofAt`. */
  onControlLost(epoch: ControlEpoch): void;
  /** The paired peer channel ended. Pairing loss accelerates an already-armed enforcer. */
  onPairingLost?(): void;
}>;

export type ControlEndpointOptions = Readonly<{
  socketPath: string;
  role: ControlEndpointRole;
  observer: ControlEndpointObserver;
  timer: ControlEndpointTimer;
  mintChallenge(): ControlChallenge;
  /** Absolute budget for one request handler, in milliseconds. */
  requestTimeoutMs: number;
}>;

export interface ControlEndpoint {
  listen(): Promise<void>;
  close(): Promise<void>;
  /** The epoch of the live tenancy, or null when no connection holds control. */
  currentEpoch(): ControlEpoch | null;
}

type Tenancy = {
  readonly epoch: ControlEpoch;
  readonly socket: Socket;
  outstandingChallenge: ControlChallenge;
  active: boolean;
};

function failure(id: string | number | null, code: number, message: string): ProxyControlJsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function success(id: string | number, result: unknown): ProxyControlJsonRpcMessage {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Reads newline-delimited frames, enforcing the frame cap on the *accumulating* buffer rather than only on
 * complete frames — a peer that never sends a newline must not be able to grow this buffer without bound.
 */
function createFrameReader(onFrame: (frame: string) => void, onOversize: () => void): (chunk: Buffer) => void {
  let pending = '';
  return (chunk: Buffer): void => {
    pending += chunk.toString('utf8');
    if (Buffer.byteLength(pending, 'utf8') > MAX_PROXY_CONTROL_FRAME_BYTES) {
      pending = '';
      onOversize();
      return;
    }
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const frame = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      onFrame(frame);
      newline = pending.indexOf('\n');
    }
  };
}

export function createControlEndpoint(options: ControlEndpointOptions): ControlEndpoint {
  const { socketPath, role, observer, timer, mintChallenge, requestTimeoutMs } = options;
  let server: NetServer | null = null;
  let tenancy: Tenancy | null = null;
  let nextEpoch: ControlEpoch = 1;
  let nonceSpent = false;
  let pairedSocket: Socket | null = null;
  let closed = false;

  const write = (socket: Socket, message: ProxyControlJsonRpcMessage): void => {
    if (socket.destroyed) return;
    socket.write(encodeProxyControlFrame(message));
  };

  const openTenancy = (socket: Socket, params: unknown): Record<string, unknown> => {
    const fields = role.openResult(params);
    const epoch = nextEpoch;
    nextEpoch += 1;
    const heartbeatChallenge = mintChallenge();
    tenancy = { epoch, socket, outstandingChallenge: heartbeatChallenge, active: false };
    nonceSpent = true;
    return { ...fields, controlEpoch: epoch, heartbeatChallenge };
  };

  const echoChallenge = (socket: Socket, params: unknown): unknown => {
    const live = tenancy;
    if (live === null || live.socket !== socket) {
      throw new ProxyControlProtocolError('invalid_request', 'No control tenancy is open on this connection.');
    }
    const echo = params as { controlEpoch?: unknown; heartbeatChallenge?: unknown } | null;
    if (
      typeof echo !== 'object' ||
      echo === null ||
      echo.controlEpoch !== live.epoch ||
      typeof echo.heartbeatChallenge !== 'string' ||
      echo.heartbeatChallenge !== live.outstandingChallenge
    ) {
      throw new ProxyControlProtocolError('invalid_request', 'Heartbeat did not echo the outstanding challenge.');
    }
    // The echoed challenge is consumed here, so a replay of the same frame cannot re-earn evidence.
    live.outstandingChallenge = mintChallenge();
    live.active = true;
    observer.onChallengeEcho(live.epoch);
    return { state: 'active', nextHeartbeatChallenge: live.outstandingChallenge };
  };

  const dispatch = async (socket: Socket, method: string, params: unknown): Promise<unknown> => {
    if (method === role.openMethod) {
      if (nonceSpent) {
        throw new ProxyControlProtocolError('unauthorized_control', 'The bootstrap nonce was already spent.');
      }
      const supplied = (params as { bootstrapNonce?: unknown } | null)?.bootstrapNonce;
      if (typeof supplied !== 'string' || supplied !== role.bootstrapNonce) {
        throw new ProxyControlProtocolError(
          'unauthorized_control',
          'Control open did not present the bootstrap nonce.',
        );
      }
      return openTenancy(socket, params);
    }
    if (method === role.heartbeatMethod) {
      return echoChallenge(socket, params);
    }
    const pairing = role.pairing;
    if (pairing !== undefined && method === pairing.openMethod) {
      const supplied = (params as { pairingSecret?: unknown } | null)?.pairingSecret;
      if (typeof supplied !== 'string' || supplied !== pairing.secret) {
        throw new ProxyControlProtocolError('unauthorized_control', 'Pairing did not present the shared secret.');
      }
      pairedSocket = socket;
      return { state: 'paired' };
    }
    const pairedHandler = pairing?.methods.get(method);
    if (pairedHandler !== undefined) {
      if (pairedSocket !== socket) {
        throw new ProxyControlProtocolError('unauthorized_control', `${method} requires the paired peer channel.`);
      }
      return pairedHandler(params);
    }
    const handler = role.methods.get(method);
    if (handler === undefined) {
      throw new UnknownControlMethodError(method);
    }
    const live = tenancy;
    if (live === null || live.socket !== socket || !live.active) {
      throw new ProxyControlProtocolError('unauthorized_control', `${method} requires active control.`);
    }
    return handler(params);
  };

  const serveRequest = async (socket: Socket, message: ProxyControlJsonRpcMessage): Promise<void> => {
    if (!('method' in message)) {
      // Responses are not accepted on a server endpoint; a peer sending one is out of protocol.
      write(socket, failure(null, JSON_RPC_INVALID_REQUEST, 'Control endpoints accept requests only.'));
      return;
    }
    const { id, method, params } = message;
    let settled = false;
    const budget = timer.setTimeout(() => {
      if (settled) return;
      settled = true;
      write(socket, failure(id, JSON_RPC_INTERNAL_ERROR, `${method} exceeded its ${requestTimeoutMs}ms budget.`));
    }, requestTimeoutMs);
    budget.unref?.();
    try {
      const result = await dispatch(socket, method, params);
      if (settled) return;
      settled = true;
      write(socket, success(id, result));
    } catch (error: unknown) {
      if (settled) return;
      settled = true;
      const code = error instanceof UnknownControlMethodError ? JSON_RPC_METHOD_NOT_FOUND : JSON_RPC_INVALID_REQUEST;
      write(socket, failure(id, code, error instanceof Error ? error.message : 'Control request failed.'));
    } finally {
      timer.clearTimeout(budget);
    }
  };

  const acceptConnection = (socket: Socket): void => {
    // One connection holds control and, when the role has a peer, one more may hold pairing. Anything
    // beyond that is refused rather than queued, so two coordinators can never both believe they own this
    // set and no third party can sit on the endpoint waiting for a slot.
    const controlTaken = tenancy !== null && !tenancy.socket.destroyed;
    const pairingTaken = pairedSocket !== null && !pairedSocket.destroyed;
    if (controlTaken && (role.pairing === undefined || pairingTaken)) {
      socket.destroy();
      return;
    }
    const read = createFrameReader(
      (frame) => {
        let message: ProxyControlJsonRpcMessage;
        try {
          message = decodeProxyControlFrame(frame);
        } catch {
          write(socket, failure(null, JSON_RPC_INVALID_REQUEST, 'Control frame failed strict validation.'));
          socket.destroy();
          return;
        }
        void serveRequest(socket, message);
      },
      () => {
        write(socket, failure(null, JSON_RPC_INVALID_REQUEST, 'Control frame exceeded the frame cap.'));
        socket.destroy();
      },
    );
    socket.on('data', read);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (pairedSocket === socket) {
        pairedSocket = null;
        observer.onPairingLost?.();
      }
      const live = tenancy;
      if (live === null || live.socket !== socket) return;
      tenancy = null;
      observer.onControlLost(live.epoch);
    });
  };

  return {
    async listen(): Promise<void> {
      if (closed) throw new ControlEndpointError('control_endpoint_closed', 'This control endpoint was closed.');
      if (server !== null) {
        throw new ControlEndpointError('control_endpoint_already_listening', 'This control endpoint already listens.');
      }
      const created = createServer(acceptConnection);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          created.off('listening', onListening);
          reject(
            new ControlEndpointError(
              'control_endpoint_listen_failed',
              `Control endpoint bind failed: ${error.message}`,
            ),
          );
        };
        const onListening = (): void => {
          created.off('error', onError);
          resolve();
        };
        created.once('error', onError);
        created.once('listening', onListening);
        // No stale-socket probe and no pre-bind unlink: the path is instance-keyed, so an occupied path means
        // a live peer of this exact instance, which is a bind failure rather than something to clear.
        created.listen(socketPath);
      });
      created.on('error', () => {});
      server = created;
    },
    async close(): Promise<void> {
      closed = true;
      const live = tenancy;
      tenancy = null;
      live?.socket.destroy();
      pairedSocket?.destroy();
      pairedSocket = null;
      const running = server;
      server = null;
      if (running === null) return;
      await new Promise<void>((resolve) => {
        running.close(() => resolve());
      });
    },
    currentEpoch(): ControlEpoch | null {
      return tenancy?.epoch ?? null;
    },
  };
}
