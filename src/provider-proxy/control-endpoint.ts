import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server as NetServer, type Socket } from 'node:net';

import { truncate } from '../infra/text.js';
import {
  ProxyControlProtocolError,
  controlHeartbeatParamsSchema,
  controlHeartbeatResultSchema,
  controlPairParamsSchema,
  controlPairResultSchema,
  createFrameReader,
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
  | 'control_endpoint_closed'
  /** `pushOnTenancy` refusals — process-local, like the three above, never serialised onto the wire. */
  | 'control_endpoint_push_no_tenancy'
  | 'control_endpoint_push_invalid_frame'
  | 'control_endpoint_push_timeout'
  | 'control_endpoint_push_lost'
  | 'control_endpoint_push_refused';

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

/** Who holds a control tenancy. Two opens naming the same holder are one tenancy re-reported, not two. */
export type ControlTenancyHolder = string;

/**
 * What an opening method answers: who earned the tenancy, and the role-specific result fields. The endpoint
 * merges the epoch and the first challenge into `fields`; a role that supplied those itself would be naming
 * a tenancy it has not been granted. `holder` is what lets a retry be recognised as the same tenancy rather
 * than refused or silently re-minted — every opening method already derives it from `coordinator.instanceId`
 * or `successor.instanceId`, so naming it here costs nothing the credential check did not already establish.
 */
export type ControlOpening = Readonly<{ holder: ControlTenancyHolder; fields: Record<string, unknown> }>;
export type ControlOpenHandler = (params: unknown) => Promise<ControlOpening> | ControlOpening;

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
    | { authority: 'active' | 'pairing' | 'observation'; handle: ControlMethodHandler }
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

/** What `issueFirstChallenge`/`admitSuccessor` answer: the minted challenge on acceptance, or a refusal. */
export type ControlChallengeIssue =
  | Readonly<{ accepted: true; challenge: ControlChallenge }>
  | Readonly<{ accepted: false; reason?: string }>;

/** What `echoChallenge` answers: the next minted challenge on acceptance, or a refusal. */
export type ControlChallengeEcho =
  | Readonly<{ accepted: true; nextChallenge: ControlChallenge }>
  | Readonly<{ accepted: false; reason?: string }>;

/**
 * The single owner of challenge state. The endpoint deliberately keeps none of its own: two stores each
 * claiming one-use semantics is how round-trip evidence ends up recorded in one place and checked in
 * another, which is exactly the seam where a heartbeat can look accepted while no deadline advances.
 *
 * The authority mints every challenge it hands out, rather than receiving one minted by the endpoint: minting
 * and recording were one act that the endpoint used to split in two, and a mint the authority never recorded
 * is exactly what let a duplicate open destroy the challenge a live successor was still waiting to echo.
 */
export interface ControlChallengeAuthority {
  /** Mints and records the challenge for the bootstrap tenancy. A refusal means the tenancy must not open. */
  issueFirstChallenge(): ControlChallengeIssue;
  /**
   * Mints and records the challenge for a tenancy that replaces a lapsed one. Refused while the incumbent
   * still holds control, so a successor cannot displace a coordinator that is merely slow.
   */
  admitSuccessor(): ControlChallengeIssue;
  /**
   * A live connection carries an already-granted tenancy again — the same holder retrying its open, on the
   * same socket or a new one. No new challenge is minted: the one already outstanding stays answerable.
   * Refused once teardown has latched, the one condition that makes carrying the tenancy forward meaningless.
   */
  reattachControl(): { readonly accepted: boolean; readonly reason?: string };
  /**
   * Whether the established tenancy still holds control. Admission and mutation authorization read this
   * rather than socket liveness: a wedged coordinator keeps its socket open indefinitely, but its lease must
   * still end both its authority and its ability to exclude a successor.
   */
  controlIsLive(): boolean;
  /**
   * Verifies an echoed challenge against the outstanding one and, on acceptance, records the round-trip
   * evidence and mints and installs the replacement. The authority owns the comparison, so the endpoint
   * cannot accept an echo the deadline model rejects.
   */
  echoChallenge(challenge: ControlChallenge): ControlChallengeEcho;
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
  /** Default absolute budget for one request handler, in milliseconds. */
  requestTimeoutMs: number;
}>;

export interface ControlEndpoint {
  listen(): Promise<void>;
  close(): Promise<void>;
  /**
   * Writes one pre-encoded request frame onto the live control tenancy's own socket and resolves with its
   * response `result`, or rejects if there is no active tenancy, the frame is malformed, the tenancy closes
   * or rotates before a reply lands, or no reply arrives within `timeoutMs`. This is the one direction this
   * endpoint's own request/response loop never drives on its own — every other write it makes answers
   * something the peer just asked. See the implementation for the full id-space and non-blocking argument.
   */
  pushOnTenancy(frame: string, timeoutMs: number): Promise<unknown>;
}

type Tenancy = {
  readonly epoch: ControlEpoch;
  readonly holder: ControlTenancyHolder;
  /** The exact reply this tenancy opened with. Re-sent verbatim on a reattach; never recomputed. */
  readonly opening: Record<string, unknown>;
  socket: Socket; // one tenancy, successive connections
  active: boolean;
};

/**
 * One outstanding `pushOnTenancy` call, keyed by the id its own frame carries. `socket` is the exact
 * connection the write went out on — not merely "the current tenancy" — so a later rotation or close can
 * find and reject exactly the pushes that were in flight *on that connection*, never one sent since.
 */
type PendingPush = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  budget: { unref?: () => void };
  socket: Socket;
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
  if (error instanceof UnknownControlMethodError) {
    // `data.code` carries `method_not_found` for the same reason every other branch below attaches one: a
    // caller only ever branches on `data.code`, never on prose. This is what lets an N±1-build caller tell
    // "the peer's build does not have this method — fall back" apart from "this call failed" — the sensor
    // the cross-version evolution mechanism (`operation.status.v1`'s own doc makes the same point) depends on.
    return {
      jsonrpc: '2.0',
      id,
      error: { code: JSON_RPC_METHOD_NOT_FOUND, message, data: { code: 'method_not_found' } },
    };
  }
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

export function createControlEndpoint(options: ControlEndpointOptions): ControlEndpoint {
  const { socketPath, role, observer, challenges, timer, requestTimeoutMs } = options;
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
  // Keyed by `String(id)` rather than the raw JSON-RPC id: `provider.event.v1` pushes mint plain numbers,
  // but the wire schema allows a string id too, and normalising here means a lookup can never miss on a
  // type mismatch alone.
  const pendingPushes = new Map<string, PendingPush>();

  const write = (socket: Socket, message: ProxyControlJsonRpcMessage): void => {
    if (socket.destroyed) return;
    socket.write(encodeProxyControlFrame(message));
  };

  /**
   * Opens a tenancy on this connection. The credential is proven first and by its own owner — a bootstrap
   * nonce by the role that holds it, a handoff grant by its registry — so the endpoint learns no secret and
   * spends none. A bootstrap nonce throws on replay and so never reaches the check below; a grant memoizes
   * its redemption and answers with the same holder on every retry, which is what that check recognises.
   */
  const establishControl = async (socket: Socket, handle: ControlOpenHandler, params: unknown): Promise<unknown> => {
    const { holder, fields } = await handle(params);
    const live = tenancy;
    if (live !== null && live.holder === holder) {
      // The same tenancy earned again, on this socket or a new one — not a second tenancy to admit, so the
      // reply that opened it is replayed verbatim rather than re-minted.
      const admitted = challenges.reattachControl();
      if (!admitted.accepted) throw new ControlAdmissionRefusedError(admitted.reason ?? 'rejected');
      if (live.socket !== socket) {
        const stale = live.socket;
        // Reassign before destroying: the stale socket's own `close` handler then sees a tenancy that is no
        // longer its own, and reports no control loss for a connection this retry has already superseded.
        live.socket = socket;
        live.active = false;
        stale.destroy();
      }
      return live.opening;
    }
    // A different holder on a socket that already holds a tenancy is refused outright: establishing here
    // would destroy the displaced socket, which is this very connection.
    if (tenancy?.socket === socket) {
      throw new ProxyControlProtocolError('invalid_state', 'This connection already holds a control tenancy.');
    }
    if (pairedSocket === socket) {
      // The mirror of the pairing branch's own refusal below: control and pairing are different authorities,
      // and admitting one from the socket that already holds the other would collapse the distinction the
      // two-ACK staging rule depends on.
      throw new ProxyControlProtocolError('unauthorized_control', 'The paired connection may not also open control.');
    }
    // The first tenancy this endpoint ever opens is the bootstrap one; every later one is by construction a
    // successor. Deriving it leaves no way for a role to declare itself first twice.
    const issued = nextEpoch === 1 ? challenges.issueFirstChallenge() : challenges.admitSuccessor();
    if (!issued.accepted) {
      throw new ControlAdmissionRefusedError(issued.reason ?? 'rejected');
    }
    const displaced = tenancy;
    const epoch = nextEpoch;
    nextEpoch += 1;
    const opening = { ...fields, controlEpoch: epoch, heartbeatChallenge: issued.challenge };
    // Record the replacement before destroying the predecessor: its `close` handler then sees a tenancy that
    // is not its own and reports no control loss. Reporting one would hand the deadline machine an EOF for
    // the tenancy that just began, and the successor would inherit its predecessor's death.
    tenancy = { epoch, holder, opening, socket, active: false };
    displaced?.socket.destroy();
    return opening;
  };

  const echoChallenge = (socket: Socket, params: unknown): unknown => {
    const live = tenancy;
    if (live === null || live.socket !== socket) {
      throw new ProxyControlProtocolError('invalid_request', 'No control tenancy is open on this connection.');
    }
    const echo = controlHeartbeatParamsSchema.parse(params);
    if (echo.controlEpoch !== live.epoch) {
      throw new ProxyControlProtocolError('invalid_request', 'Heartbeat did not name this control tenancy.');
    }
    // The authority compares and consumes, so a replayed frame cannot re-earn evidence and the endpoint
    // cannot accept an echo the deadline model has already ruled out.
    const recorded = challenges.echoChallenge(echo.heartbeatChallenge);
    if (!recorded.accepted) {
      throw new ProxyControlProtocolError(
        'invalid_request',
        `Heartbeat echo was not accepted (${recorded.reason ?? 'rejected'}).`,
      );
    }
    live.active = true;
    return controlHeartbeatResultSchema.parse({ state: 'active', nextHeartbeatChallenge: recorded.nextChallenge });
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
      const supplied = controlPairParamsSchema.parse(params).pairingSecret;
      const expected = Buffer.from(pairing.secret, 'utf8');
      const offered = Buffer.from(supplied, 'utf8');
      if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
        throw new ProxyControlProtocolError('unauthorized_control', 'Pairing did not present the shared secret.');
      }
      // The control tenancy and the peer channel are different authorities; one connection holding both
      // would collapse the distinction the two-ACK staging rule depends on.
      if (tenancy?.socket === socket) {
        throw new ProxyControlProtocolError('unauthorized_control', 'The control connection may not also pair.');
      }
      pairedSocket = socket;
      return controlPairResultSchema.parse({ state: 'paired' });
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
    if (entry.authority === 'observation') {
      // Deliberately holds no tenancy. Control is single-occupancy and belongs to whoever is running the
      // set, so requiring it here would mean only the owner could ever ask — and the whole point of an
      // observation is that someone *else* wants to know whether this proxy still holds an operation.
      //
      // The handler checks identity instead, and the tuple it checks is the credential: naming this
      // proxy's instance, build set, job, and operation together requires the runtime meta only a
      // coordinator's own store holds. The reply then discloses nothing the asker did not already name.
      // Read-only is what makes that trade sound — an observation moves no deadline and spends nothing.
      return entry.handle(params);
    }
    const live = tenancy;
    if (live === null || live.socket !== socket || !live.active || !challenges.controlIsLive()) {
      throw new ProxyControlProtocolError('unauthorized_control', `${method} requires active control.`);
    }
    return entry.handle(params);
  };

  const serveRequest = async (socket: Socket, message: ProxyControlJsonRpcMessage): Promise<void> => {
    if (!('method' in message)) {
      // Reached only by a response this endpoint has nothing outstanding for — a reply to a `pushOnTenancy`
      // is matched and consumed before dispatch ever gets here. The ordinary way to arrive is a benign race:
      // an ack that crossed its own push's timeout, which already dropped the pending entry. The refusal
      // carries a null id, which the peer's client drops, so answering costs one frame and never loops.
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

  // Whether this role ever answers a connection that claims neither slot. `establishControl` already
  // refuses a second control tenancy on its own (the challenge authority's `admitSuccessor` refusal), and
  // the pairing branch in `dispatch` already refuses a second peer the same way — so accept-time refusal
  // below protects nothing an RPC-level refusal does not already cover for a connection that goes on to
  // request one of those slots. It does matter for a connection that never asks for either: an `observation`
  // method promises exactly that, so a role that serves one must not have every connection destroyed the
  // moment control is merely held, or its one tenancy-free method becomes unreachable in the case it exists
  // for — a live tenancy is the *normal* state, not an edge case, for whoever wants to ask about it.
  const hasObservationMethod = [...role.methods.values()].some((method) => method.authority === 'observation');

  const acceptConnection = (socket: Socket): void => {
    // One connection holds control and, when the role has a peer, one more may hold pairing. A third
    // connection is refused only once both slots are already filled — before the peer has ever paired, or
    // while an incumbent's lease has merely lapsed, a connection is admitted holding neither authority yet.
    // It is tracked in `sockets` below regardless, so it is not a party sitting unaccounted-for on the
    // endpoint: close() still reaches it even if it never claims a slot.
    const controlTaken = tenancy !== null && !tenancy.socket.destroyed && challenges.controlIsLive();
    const pairingTaken = pairedSocket !== null && !pairedSocket.destroyed;
    if (!hasObservationMethod && controlTaken && (role.pairing === undefined || pairingTaken)) {
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
        // A message with no `method` is a response — on this endpoint, that can only ever be a reply to a
        // `pushOnTenancy` write, since nothing else here sends requests. The two id spaces never collide by
        // construction, not convention: a request always carries `method`, a response never does, so the
        // lookup below only ever matches a frame this endpoint itself addressed — never an inbound request
        // that happens to reuse the same numeric id.
        if (!('method' in message) && message.id !== null) {
          const pending = pendingPushes.get(String(message.id));
          if (pending !== undefined) {
            pendingPushes.delete(String(message.id));
            timer.clearTimeout(pending.budget);
            if ('error' in message) {
              pending.reject(new ControlEndpointError('control_endpoint_push_refused', message.error.message));
            } else {
              pending.resolve(message.result);
            }
            return;
          }
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
      // Any push written on this exact socket can never be answered now — reject rather than leave it
      // pending, so a later frame on a *different* (rotated or reattached) socket can never be misread as
      // this one's reply, and so the caller (`proxy.ts`'s drain loop) learns promptly that this event is
      // still only buffered, not delivered.
      for (const [id, pending] of pendingPushes) {
        if (pending.socket !== socket) continue;
        pendingPushes.delete(id);
        timer.clearTimeout(pending.budget);
        pending.reject(
          new ControlEndpointError(
            'control_endpoint_push_lost',
            'The control tenancy closed before this push was acknowledged.',
          ),
        );
      }
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
    /**
     * Scoped to the active tenancy, not "the socket": there is at most one connection holding active
     * control, and if none is active there is nothing to push onto — this rejects immediately rather than
     * buffering or erroring the caller's own state, so "no control right now" and "control was lost mid-push"
     * both resolve the same way for the caller (`proxy.ts` leaves the event buffered either way).
     *
     * Bound to that tenancy's own connection object, not to its epoch number: a reattach can hand the same
     * epoch a new socket, and only a genuinely new tenancy increments the epoch at all, so socket identity is
     * the finer-grained invariant and epoch equality would be redundant with it. The pending entry is created
     * against `live.socket` and is only ever resolved by a frame arriving on that same socket's own reader,
     * or rejected by that same socket's own `close` handler above — so a push issued before a rotation can
     * never land on the successor's connection as though the predecessor's stream continued, and is never
     * silently dropped either: rejection is what lets `proxy.ts`'s drain loop leave the event in the ledger
     * for the next `operation.adopt.v1` to replay.
     *
     * Never blocks `serveRequest`: this method does not go through `dispatch`, and awaiting its returned
     * promise does not hold up the socket's own `'data'` handler — an inbound `operation.stop.v1` arriving
     * while a push is outstanding is read and served independently, on the same tick model as any other pair
     * of concurrent async operations sharing an event loop. Nothing here can make a slow-to-ack coordinator
     * stall the endpoint's own request handling; only the caller's own pacing (the ledger's replay-capacity
     * gate) slows further pushes.
     */
    async pushOnTenancy(frame: string, timeoutMs: number): Promise<unknown> {
      if (closed) throw new ControlEndpointError('control_endpoint_closed', 'This control endpoint was closed.');
      const live = tenancy;
      if (live === null || !live.active || !challenges.controlIsLive()) {
        throw new ControlEndpointError('control_endpoint_push_no_tenancy', 'No active control tenancy to push onto.');
      }
      let decoded: ProxyControlJsonRpcMessage;
      try {
        decoded = decodeProxyControlFrame(frame);
      } catch {
        throw new ControlEndpointError(
          'control_endpoint_push_invalid_frame',
          'The frame to push failed strict validation.',
        );
      }
      if (!('method' in decoded)) {
        throw new ControlEndpointError('control_endpoint_push_invalid_frame', 'Only a request frame may be pushed.');
      }
      const id = String(decoded.id);
      const socket = live.socket;
      return new Promise<unknown>((resolve, reject) => {
        const budget = timer.setTimeout(() => {
          pendingPushes.delete(id);
          reject(new ControlEndpointError('control_endpoint_push_timeout', `Push exceeded its ${timeoutMs}ms budget.`));
        }, timeoutMs);
        budget.unref?.();
        pendingPushes.set(id, { resolve, reject, budget, socket });
        if (socket.destroyed) {
          pendingPushes.delete(id);
          timer.clearTimeout(budget);
          reject(
            new ControlEndpointError(
              'control_endpoint_push_lost',
              'The control tenancy closed before this push could be sent.',
            ),
          );
          return;
        }
        socket.write(frame);
      });
    },
  };
}
