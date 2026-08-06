import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server as NetServer, type Socket } from 'node:net';

import { truncate } from '../infra/text.js';
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
 * Wraps an admission refusal with the deadline machine's own reason. `ProxyControlProtocolError` alone
 * carries only the closed-set code, and `invalid_state` is shared by two refusals a caller must not treat
 * alike: "retry, the incumbent is still live" and "give up, this set is being reaped". The reason has to
 * travel as its own field for a caller to branch on it, not sit only inside the human-readable message.
 */
class ControlAdmissionRefusedError extends ProxyControlProtocolError {
  readonly reason: string;

  constructor(reason: string) {
    super('invalid_state', `Control admission was refused (${reason}).`);
    this.name = 'ControlAdmissionRefusedError';
    this.reason = reason;
    Object.setPrototypeOf(this, ControlAdmissionRefusedError.prototype);
  }
}

export type ControlMethodHandler = (params: unknown) => Promise<unknown> | unknown;

/**
 * An opening method returns the role-specific result fields; the endpoint merges the epoch and the first
 * challenge into them. Typed apart from an ordinary handler because those two fields are the endpoint's to
 * add, and a role that supplied them itself would be naming a tenancy it has not been granted.
 */
export type ControlOpenHandler = (params: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * One method and the credential it requires. Declaring the authority per method rather than per map is what
 * lets one endpoint serve tiers that differ in kind: the coordinator's control tenancy, the peer enforcer's
 * capsule-secret channel, and a successor presenting a grant rather than either.
 *
 * `establishes-control` is the tier that has no tenancy yet — the endpoint knows only that such a method
 * yields one, never which credential proves it. That is deliberate: a bootstrap nonce and a handoff grant
 * are checked and spent by their own owners, so the endpoint never learns a secret to hold or to leak.
 */
export type ControlMethod = Readonly<
  {
    /**
     * Absolute budget for this method, defaulting to the endpoint's. Teardown declares its own because it
     * may legitimately spend the TERM and KILL graces plus a disappearance confirmation; cutting it off
     * would report a failure for a reap still in progress.
     */
    budgetMs?: number | 'caller-deadline';
  } & (
    | { authority: 'establishes-control'; handle: ControlOpenHandler }
    | { authority: 'active' | 'pairing'; handle: ControlMethodHandler }
  )
>;

export type ControlEndpointRole = Readonly<{
  /** Method name for this role's challenge echo, e.g. `guardian.heartbeat.v1`. */
  heartbeatMethod: string;
  /** Every method this role serves, each declaring the authority it requires. */
  methods: ReadonlyMap<string, ControlMethod>;
  /**
   * The capsule-authenticated peer channel, held open for the lifetime of the set alongside control. It is
   * a separate authority: the guardian stages a provider root over it while the coordinator's own control
   * connection is still provisional, and its loss is evidence in its own right.
   */
  pairing?: Readonly<{ openMethod: string; secret: string }>;
}>;

/**
 * The single owner of challenge state. The endpoint deliberately keeps none of its own: two stores each
 * claiming one-use semantics is how round-trip evidence ends up recorded in one place and checked in
 * another, which is exactly the seam where a heartbeat can look accepted while no deadline advances.
 */
export interface ControlChallengeAuthority {
  /** Records the challenge minted for the bootstrap tenancy. A refusal means the tenancy must not open. */
  issueFirstChallenge(challenge: ControlChallenge): { readonly accepted: boolean; readonly reason?: string };
  /**
   * Records the challenge minted for a tenancy that replaces a lapsed one. Refused while the incumbent still
   * holds control, so a successor cannot displace a coordinator that is merely slow.
   */
  admitSuccessor(firstSuccessorChallenge: ControlChallenge): { readonly accepted: boolean; readonly reason?: string };
  /**
   * Whether the established tenancy still holds control. Admission reads this rather than socket liveness:
   * a wedged coordinator keeps its socket open indefinitely, and a successor has to be able to reach the
   * endpoint past it once the lease has lapsed.
   */
  controlIsLive(): boolean;
  /**
   * Verifies an echoed challenge against the outstanding one and, on acceptance, records the round-trip
   * evidence and installs the replacement. The authority owns the comparison, so the endpoint cannot
   * accept an echo the deadline model rejects.
   */
  echoChallenge(
    challenge: ControlChallenge,
    nextChallenge: ControlChallenge,
  ): { readonly accepted: boolean; readonly reason?: string };
}

export type ControlEndpointObserver = Readonly<{
  /** The control connection ended. The owner may treat this as its local `eofAt`. */
  onControlLost(epoch: ControlEpoch): void;
  /** The paired peer channel ended. Pairing loss accelerates an already-armed enforcer. */
  onPairingLost?(): void;
}>;

export type ControlEndpointOptions = Readonly<{
  socketPath: string;
  role: ControlEndpointRole;
  observer: ControlEndpointObserver;
  challenges: ControlChallengeAuthority;
  timer: ControlEndpointTimer;
  mintChallenge(): ControlChallenge;
  /** Default absolute budget for one request handler, in milliseconds. */
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
  active: boolean;
};

function failure(id: string | number | null, code: number, message: string): ProxyControlJsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Maps a thrown handler error onto the wire. The protocol's own code travels in `data` because a caller has
 * to act on it differently by code — `grant_replayed` means give up — and `ControlAdmissionRefusedError`
 * carries its `reason` alongside `data.code` for the same reason: `invalid_state` alone cannot tell "retry"
 * from "give up" apart. Anything that is not this endpoint's own vocabulary — a role's domain error, or a
 * raw `ZodError` from a handler's `.parse()` — still has to report a code from the closed set rather than
 * escape it, because a caller only ever branches on `data.code`, never on prose.
 */
function handlerFailure(id: string | number, error: unknown): ProxyControlJsonRpcMessage {
  const message = error instanceof Error ? error.message : 'Control request failed.';
  if (error instanceof UnknownControlMethodError) return failure(id, JSON_RPC_METHOD_NOT_FOUND, message);
  if (error instanceof ControlAdmissionRefusedError) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: JSON_RPC_INVALID_REQUEST, message, data: { code: error.code, reason: error.reason } },
    };
  }
  if (error instanceof ProxyControlProtocolError) {
    return { jsonrpc: '2.0', id, error: { code: JSON_RPC_INVALID_REQUEST, message, data: { code: error.code } } };
  }
  // Not one of this endpoint's own errors, so it carries no domain code to relay — only `protocol_violation`,
  // the closed set's catch-all. The message is truncated rather than passed through verbatim: a ZodError's
  // `.message` is a JSON dump of every issue, unbounded and shaped like data rather than wire prose.
  return {
    jsonrpc: '2.0',
    id,
    error: { code: JSON_RPC_INVALID_REQUEST, message: truncate(message, 200), data: { code: 'protocol_violation' } },
  };
}

function success(id: string | number, result: unknown): ProxyControlJsonRpcMessage {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Reads newline-delimited frames from raw socket bytes. Chunks are accumulated as bytes and each complete
 * frame is decoded exactly once: decoding a chunk on its own would replace any multi-byte character split
 * across the boundary with U+FFFD, and that damage lands inside a JSON string where both `JSON.parse` and
 * strict validation still succeed. A newline byte cannot occur inside a multi-byte sequence, so splitting on
 * the byte is safe. The cap is applied to the accumulating buffer, not only to complete frames, so a peer
 * that never sends a newline cannot grow it without bound.
 */
function createFrameReader(onFrame: (frame: string) => void, onOversize: () => void): (chunk: Buffer) => void {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (pending.byteLength > MAX_PROXY_CONTROL_FRAME_BYTES) {
      pending = Buffer.alloc(0);
      onOversize();
      return;
    }
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      onFrame(pending.subarray(0, newline + 1).toString('utf8'));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
  };
}

export function createControlEndpoint(options: ControlEndpointOptions): ControlEndpoint {
  const { socketPath, role, observer, challenges, timer, mintChallenge, requestTimeoutMs } = options;
  let server: NetServer | null = null;
  let tenancy: Tenancy | null = null;
  let nextEpoch: ControlEpoch = 1;
  let pairedSocket: Socket | null = null;
  let closed = false;
  // Every accepted connection, not only the two that go on to hold an authority. A connection is admitted
  // whenever a slot is open — before the peer has ever paired, or while an incumbent's lease has merely
  // lapsed — and one that never claims control or pairing, or never sends anything at all, is still a
  // connection close() has to reach: server.close() fires its callback only once every existing connection
  // has ended.
  const sockets = new Set<Socket>();

  const write = (socket: Socket, message: ProxyControlJsonRpcMessage): void => {
    if (socket.destroyed) return;
    socket.write(encodeProxyControlFrame(message));
  };

  /**
   * Opens a tenancy on this connection. The credential is proven first and by its own owner — a bootstrap
   * nonce by the role that holds it, a handoff grant by its registry — so the endpoint learns no secret and
   * spends none. Admission then runs against the deadline machine, which is what can still say no: an
   * incumbent that holds live control is not displaced by a successor that merely presents a valid grant.
   */
  const establishControl = async (socket: Socket, handle: ControlOpenHandler, params: unknown): Promise<unknown> => {
    const fields = await handle(params);
    // Only after the credential has answered: a caller replaying a spent nonce deserves to hear that its
    // credential is spent, not a generic complaint about its connection. A grant, by contrast, memoizes its
    // redemption and so reaches here twice — and a second tenancy on the same socket would destroy the very
    // connection it just granted, because the displaced socket and the new one are the same.
    if (tenancy?.socket === socket) {
      throw new ProxyControlProtocolError('invalid_state', 'This connection already holds a control tenancy.');
    }
    if (pairedSocket === socket) {
      // The mirror of the pairing branch's own refusal below: control and pairing are different authorities,
      // and admitting one from the socket that already holds the other would collapse the distinction the
      // two-ACK staging rule depends on.
      throw new ProxyControlProtocolError('unauthorized_control', 'The paired connection may not also open control.');
    }
    const heartbeatChallenge = mintChallenge();
    // The first tenancy this endpoint ever opens is the bootstrap one; every later one is by construction a
    // successor. Deriving it leaves no way for a role to declare itself first twice.
    const admitted =
      nextEpoch === 1
        ? challenges.issueFirstChallenge(heartbeatChallenge)
        : challenges.admitSuccessor(heartbeatChallenge);
    if (!admitted.accepted) {
      throw new ControlAdmissionRefusedError(admitted.reason ?? 'rejected');
    }
    const displaced = tenancy;
    const epoch = nextEpoch;
    nextEpoch += 1;
    // Record the replacement before destroying the predecessor: its `close` handler then sees a tenancy that
    // is not its own and reports no control loss. Reporting one would hand the deadline machine an EOF for
    // the tenancy that just began, and the successor would inherit its predecessor's death.
    tenancy = { epoch, socket, active: false };
    displaced?.socket.destroy();
    return { ...fields, controlEpoch: epoch, heartbeatChallenge };
  };

  const echoChallenge = (socket: Socket, params: unknown): unknown => {
    const live = tenancy;
    if (live === null || live.socket !== socket) {
      throw new ProxyControlProtocolError('invalid_request', 'No control tenancy is open on this connection.');
    }
    const echo = params as { controlEpoch?: unknown; heartbeatChallenge?: unknown } | null;
    if (typeof echo !== 'object' || echo === null || echo.controlEpoch !== live.epoch) {
      throw new ProxyControlProtocolError('invalid_request', 'Heartbeat did not name this control tenancy.');
    }
    if (typeof echo.heartbeatChallenge !== 'string') {
      throw new ProxyControlProtocolError('invalid_request', 'Heartbeat carried no challenge.');
    }
    // The authority compares and consumes, so a replayed frame cannot re-earn evidence and the endpoint
    // cannot accept an echo the deadline model has already ruled out.
    const nextHeartbeatChallenge = mintChallenge();
    const recorded = challenges.echoChallenge(echo.heartbeatChallenge, nextHeartbeatChallenge);
    if (!recorded.accepted) {
      throw new ProxyControlProtocolError(
        'invalid_request',
        `Heartbeat echo was not accepted (${recorded.reason ?? 'rejected'}).`,
      );
    }
    live.active = true;
    return { state: 'active', nextHeartbeatChallenge };
  };

  const dispatch = async (socket: Socket, method: string, params: unknown): Promise<unknown> => {
    if (method === role.heartbeatMethod) {
      return echoChallenge(socket, params);
    }
    const pairing = role.pairing;
    if (pairing !== undefined && method === pairing.openMethod) {
      if (pairedSocket !== null && !pairedSocket.destroyed && pairedSocket !== socket) {
        throw new ProxyControlProtocolError('unauthorized_control', 'A peer already holds the pairing channel.');
      }
      const supplied = (params as { pairingSecret?: unknown } | null)?.pairingSecret;
      const expected = Buffer.from(pairing.secret, 'utf8');
      const offered = typeof supplied === 'string' ? Buffer.from(supplied, 'utf8') : Buffer.alloc(0);
      if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
        throw new ProxyControlProtocolError('unauthorized_control', 'Pairing did not present the shared secret.');
      }
      // The control tenancy and the peer channel are different authorities; one connection holding both
      // would collapse the distinction the two-ACK staging rule depends on.
      if (tenancy?.socket === socket) {
        throw new ProxyControlProtocolError('unauthorized_control', 'The control connection may not also pair.');
      }
      pairedSocket = socket;
      return { state: 'paired' };
    }
    const entry = role.methods.get(method);
    if (entry === undefined) {
      throw new UnknownControlMethodError(method);
    }
    if (entry.authority === 'establishes-control') {
      return establishControl(socket, entry.handle, params);
    }
    if (entry.authority === 'pairing') {
      if (pairedSocket !== socket) {
        throw new ProxyControlProtocolError('unauthorized_control', `${method} requires the paired peer channel.`);
      }
      return entry.handle(params);
    }
    const live = tenancy;
    if (live === null || live.socket !== socket || !live.active) {
      throw new ProxyControlProtocolError('unauthorized_control', `${method} requires active control.`);
    }
    return entry.handle(params);
  };

  const serveRequest = async (socket: Socket, message: ProxyControlJsonRpcMessage): Promise<void> => {
    if (!('method' in message)) {
      // Responses are not accepted on a server endpoint; a peer sending one is out of protocol.
      write(socket, failure(null, JSON_RPC_INVALID_REQUEST, 'Control endpoints accept requests only.'));
      return;
    }
    const { id, method, params } = message;
    let settled = false;
    if (role.methods.get(method)?.budgetMs === 'caller-deadline') {
      try {
        write(socket, success(id, await dispatch(socket, method, params)));
      } catch (error: unknown) {
        write(socket, handlerFailure(id, error));
      }
      return;
    }
    const declared = role.methods.get(method)?.budgetMs;
    const budgetMs = typeof declared === 'number' ? declared : requestTimeoutMs;
    const budget = timer.setTimeout(() => {
      if (settled) return;
      settled = true;
      write(socket, failure(id, JSON_RPC_INTERNAL_ERROR, `${method} exceeded its ${budgetMs}ms budget.`));
    }, budgetMs);
    budget.unref?.();
    try {
      const result = await dispatch(socket, method, params);
      if (settled) return;
      settled = true;
      write(socket, success(id, result));
    } catch (error: unknown) {
      if (settled) return;
      settled = true;
      write(socket, handlerFailure(id, error));
    } finally {
      timer.clearTimeout(budget);
    }
  };

  const acceptConnection = (socket: Socket): void => {
    // One connection holds control and, when the role has a peer, one more may hold pairing. A third
    // connection is refused only once both slots are already filled — before the peer has ever paired, or
    // while an incumbent's lease has merely lapsed, a connection is admitted holding neither authority yet.
    // It is tracked in `sockets` below regardless, so it is not a party sitting unaccounted-for on the
    // endpoint: close() still reaches it even if it never claims a slot.
    const controlTaken = tenancy !== null && !tenancy.socket.destroyed && challenges.controlIsLive();
    const pairingTaken = pairedSocket !== null && !pairedSocket.destroyed;
    if (controlTaken && (role.pairing === undefined || pairingTaken)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
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
      sockets.delete(socket);
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
      tenancy = null;
      pairedSocket = null;
      // Destroys every accepted connection, not only the tenancy and pairing sockets: `sockets` is the
      // superset those two are drawn from, so this is what keeps server.close() below from waiting forever
      // on a connection that never claimed either authority.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
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
