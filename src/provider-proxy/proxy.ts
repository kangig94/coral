import type { MonotonicClock } from '../infra/monotonic-clock.js';
// The stop cause is shared with the coordinator's durable side. It lives in `providers/` because both sides
// may reach it and neither may reach the other: this tree is barred from `jobs/`, and the reverse edge would
// point the dependency the wrong way.
import {
  isInterruptionStopCause,
  type HostRef,
  type ProviderEventBody,
  type ProviderStopCause,
} from '../providers/contract.js';
import { createBootstrapNonceCredential, type ProxyBootstrapCapsule } from './bootstrap-capsule.js';
import { ControlLeaseEvidence } from './control-lease.js';
import {
  createControlEndpoint,
  type ControlChallengeAuthority,
  type ControlEndpoint,
  type ControlEndpointTimer,
  type ControlMethod,
} from './control-endpoint.js';
import {
  createGrantRegistry,
  type GrantBinding,
  proxyHandoffInstallParamsSchema as handoffInstallParamsSchema,
  proxyHandoffRedeemParamsSchema as handoffRedeemParamsSchema,
} from './handoff-capsule.js';
import {
  LedgerError,
  createOperationLedger,
  operationActivationFingerprint,
  operationPrepareAttemptKey,
  type OperationLedger,
  type PrepareResult,
  type ProviderOperationKey,
  type ProviderOperationState,
  type ProviderRootIdentity,
} from './ledger.js';
import { PROXY_CONTROL_LEASE_MS } from './orphan-deadline.js';
import {
  PROVIDER_EVENT_METHOD,
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  ProxyControlProtocolError,
  encodeProxyControlFrame,
  providerEventRequestSchema,
  providerEventResultSchema,
  // Aliased to the names the handlers below already use, so this move changes where these schemas live
  // without touching a single `.parse(params)` call site.
  proxyOperationActivateParamsSchema as activateParamsSchema,
  proxyOperationAdoptParamsSchema as adoptParamsSchema,
  proxyOperationPrepareParamsSchema as prepareParamsSchema,
  proxyOperationReservationParamsSchema as reservationParamsSchema,
  proxyControlOpenParamsSchema as openParamsSchema,
  proxyOperationInspectParamsSchema as inspectParamsSchema,
  proxyOperationCancelParamsSchema as cancelParamsSchema,
  proxyOperationSettleParamsSchema as settleParamsSchema,
  proxyOperationActivateResultSchema,
  proxyOperationCancelResultSchema,
  proxyOperationInspectResultSchema,
  proxyOperationPrepareCapacityResultSchema,
  proxyOperationPreparePendingResultSchema,
  proxyOperationRenewResultSchema,
  proxyOperationStopResultSchema,
  proxyOperationSettleResultSchema,
  proxyOperationStopParamsSchema as stopParamsSchema,
  type CoordinatorIdentity,
  type JointActivationReceipt,
  type JointContainmentReceipt,
  type OperationIdentity,
  type Reservation,
  type ProviderEventResult,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
} from './protocol.js';

/**
 * Who actually runs a provider operation. The proxy owns the protocol, the ledger and the replay buffer; it
 * does not own the Claude/Codex kernel. Injecting the host is what keeps this file free of the provider
 * execution stack — and what lets the ledger's state machine be tested without spawning anything.
 */
export interface SemanticOperationHost {
  /** A thrown start must not leave an executing ledger entry without a kernel. */
  start(
    input: Readonly<{ key: ProviderOperationKey; prepared: ProxyPreparedAppServerOperation }>,
  ): Promise<HostRef> | HostRef;
  /** Stops a running kernel. Called for every recorded stop cause, including a clean handoff. */
  stop(input: Readonly<{ key: ProviderOperationKey; cause: ProviderStopCause }>): Promise<void> | void;
  /**
   * `stop()` is reserved for a host whose activation ACK was stored. Cancellation, expiry, and a rejected
   * start still need a separate idempotent path to discard the staging created by prepare.
   */
  releaseStaged?(key: ProviderOperationKey): void;
  releaseSettled?(key: ProviderOperationKey): void;
}

export type ProxyOptions<Scope extends symbol> = Readonly<{
  capsule: ProxyBootstrapCapsule;
  clock: MonotonicClock<Scope>;
  identity: ProxyIdentity;
  host: SemanticOperationHost;
  timer: ControlEndpointTimer;
  mintChallenge(): string;
  mintReceipt(): string;
  mintReservation(): Reservation;
  wallClockNow(): number;
  /**
   * The joint receipt the guardian issued for this operation's provider root, and the activation receipt it
   * later converts. The proxy verifies both before starting a kernel, so a root neither authority recorded
   * can never execute.
   */
  containment: Readonly<{
    /**
     * `reservation` is exactly what `ledger.prepare()` just returned for `key` — the reservation this proxy's
     * own operation-prepare handler passes straight through, not re-read from the ledger a second time. There
     * is no ledger access in this seam at all, on purpose: an implementation that needed a reservation for
     * `key` could once only mint a fresh one instead of presenting the one that was actually reserved, which
     * is exactly the defect this shape closes off by construction rather than by convention.
     */
    stageProviderRoot(
      key: ProviderOperationKey,
      reserved: Readonly<{ reservation: Reservation; prepared: ProxyPreparedAppServerOperation }>,
    ): Promise<Readonly<{ providerRoot: ProviderRootIdentity; receipt: JointContainmentReceipt }>>;
    /** Throws unless the guardian recognises both receipts for this exact operation. */
    confirmActivation(
      input: Readonly<{
        key: ProviderOperationKey;
        jointContainmentReceipt: JointContainmentReceipt;
        jointActivationReceipt: JointActivationReceipt;
      }>,
    ): Promise<void>;
    releaseMembership(input: Readonly<{ key: ProviderOperationKey; reservation: Reservation }>): Promise<void>;
  }>;
}>;

export interface Proxy {
  listen(): Promise<void>;
  close(): Promise<void>;
  ledger(): OperationLedger<ProxyPreparedAppServerOperation>;
  /**
   * The one seam a semantic operation host uses to hand this proxy one provider event for one operation. A
   * plain, narrow, synchronous buffering call, not a round trip: the caller is a live async generator pulling
   * from a running kernel, and making it await network delivery would tie kernel progress to coordinator
   * reachability — exactly what the ledger's replay buffer exists to decouple. It may throw a `LedgerError`
   * synchronously: `operation_not_found` if `key` names no live entry, or `replay_capacity_exhausted` if this
   * one event alone exceeds `MAX_PROVIDER_REPLAY_BYTES` and could never be fully buffered — the caller routes
   * that into its own failed-terminal path, which this proxy does not own.
   *
   * The one thing a well-behaved caller must honour is the returned `paused` flag: `false` means keep
   * pulling from the kernel, `true` means stop until a later call (after an ACK frees capacity) reports
   * `false` again. Nothing else here enforces the replay-buffer bound — a caller that ignores `paused` is the
   * one way this bound stops being real.
   */
  emitProviderEvent(key: ProviderOperationKey, event: ProviderEventBody): { paused: boolean };
}

/** A ledger refusal is a protocol refusal; this is the one place the two vocabularies meet. */
const LEDGER_WIRE_CODES = new Set(['operation_not_found', 'reservation_expired']);

function asProtocolError(error: unknown): never {
  if (error instanceof LedgerError) {
    const code = LEDGER_WIRE_CODES.has(error.code) ? (error.code as 'operation_not_found') : 'invalid_state';
    throw new ProxyControlProtocolError(code, error.message);
  }
  throw error;
}

function ledgerKey(operation: OperationIdentity): ProviderOperationKey {
  return { jobId: operation.jobId, operationId: operation.operationId };
}

function operationToken(key: ProviderOperationKey): string {
  return `${key.jobId}\u0000${key.operationId}`;
}

function isAmbiguousControlFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { code?: unknown; protocolCode?: unknown };
  return (
    (failure.code === 'control_call_failed' || failure.code === 'control_client_closed') &&
    failure.protocolCode === undefined
  );
}

/**
 * The proxy holds the live carrier and the operation ledger. Its control tenancy is *operational*: losing it
 * stops mutation, but unlike the guardian's and the reaper's it bounds nothing — containment is the
 * enforcers' job, and giving the proxy a teardown deadline would make a wedged proxy able to reap the very
 * set it belongs to.
 */
export function createProxy<Scope extends symbol>(options: ProxyOptions<Scope>): Proxy {
  const { capsule, clock, identity, host, timer, mintChallenge, mintReceipt } = options;
  const ledger = createOperationLedger<ProxyPreparedAppServerOperation>();
  const operationTails = new Map<string, Promise<void>>();
  const prepareAttempts = new Map<
    string,
    Readonly<{ prepareAttemptNumber: number; prepareAttemptKey: string; fenced: boolean }>
  >();
  const leaseTimers = new Map<string, { unref?: () => void }>();
  type ReleaseIntent =
    | Readonly<{
        kind: 'never-started' | 'prepare-failed' | 'activation-failed';
        prepareAttemptNumber: number;
        prepareAttemptKey: string;
        reservation: Reservation;
      }>
    | Readonly<{
        kind: 'settled';
        prepareAttemptNumber: number;
        prepareAttemptKey: string;
        reservation: Reservation;
        finalProviderSeq: number;
      }>;
  const releaseIntents = new Map<string, ReleaseIntent>();
  const releasedOperations = new Map<
    string,
    Readonly<{
      kind: ReleaseIntent['kind'];
      prepareAttemptNumber: number;
      prepareAttemptKey: string;
      reservation: Reservation;
      settledThroughProviderSeq: number;
    }>
  >();
  const bootstrapNonce = createBootstrapNonceCredential(capsule.bootstrapNonce);
  const grants = createGrantRegistry(mintReceipt);
  // Ledger leases are plain milliseconds on the proxy's own clock, measured from its start. The branded
  // instants never leave this file, so a lease can never be compared against another process's reading. The
  // same start instant seeds the control lease's round-trip evidence below: before any heartbeat, this
  // proxy's own start is the evidence, exactly as the ledger's own baseline already was.
  const startedAt = clock.now();
  const nowMs = (): number => clock.millisecondsBetween(startedAt, clock.now());
  // Operational control is evidence for no containment window, so it has no ceiling to clamp against.
  const evidence = new ControlLeaseEvidence(clock, PROXY_CONTROL_LEASE_MS, startedAt, () => null);

  const serializeOperation = <T>(key: ProviderOperationKey, action: () => Promise<T> | T): Promise<T> => {
    const token = operationToken(key);
    const previous = operationTails.get(token) ?? Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(
      () => {},
      () => {},
    );
    operationTails.set(token, tail);
    void tail.then(() => {
      if (operationTails.get(token) === tail) operationTails.delete(token);
    });
    return result;
  };

  const isPermanentlyReleased = (token: string): boolean => {
    const released = releasedOperations.get(token);
    return released?.kind === 'activation-failed' || released?.kind === 'settled';
  };

  const registerPrepareAttempt = (
    key: ProviderOperationKey,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): void => {
    const token = operationToken(key);
    if (isPermanentlyReleased(token)) {
      throw new ProxyControlProtocolError('invalid_state', 'Activation has already begun for this operation.');
    }
    const current = prepareAttempts.get(token);
    if (current === undefined) {
      prepareAttempts.set(token, { prepareAttemptNumber, prepareAttemptKey, fenced: false });
      return;
    }
    if (prepareAttemptNumber < current.prepareAttemptNumber) {
      throw new ProxyControlProtocolError('invalid_state', 'A delayed lower prepare attempt was refused.');
    }
    if (prepareAttemptNumber === current.prepareAttemptNumber) {
      if (prepareAttemptKey !== current.prepareAttemptKey) {
        throw new ProxyControlProtocolError('invalid_request', 'A prepare attempt number named different bytes.');
      }
      return;
    }
    if (!current.fenced) {
      throw new ProxyControlProtocolError('invalid_state', 'The previous prepare attempt is not fenced.');
    }
    prepareAttempts.set(token, { prepareAttemptNumber, prepareAttemptKey, fenced: false });
  };

  const fencePrepareAttempt = (
    key: ProviderOperationKey,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): void => {
    const token = operationToken(key);
    if (isPermanentlyReleased(token)) {
      throw new ProxyControlProtocolError('invalid_state', 'Activation has already begun for this operation.');
    }
    const current = prepareAttempts.get(token);
    if (current === undefined) {
      prepareAttempts.set(token, { prepareAttemptNumber, prepareAttemptKey, fenced: true });
      return;
    }
    if (prepareAttemptNumber < current.prepareAttemptNumber) {
      throw new ProxyControlProtocolError('invalid_state', 'A delayed lower prepare attempt was refused.');
    }
    if (prepareAttemptNumber === current.prepareAttemptNumber) {
      if (prepareAttemptKey !== current.prepareAttemptKey) {
        throw new ProxyControlProtocolError('invalid_request', 'A prepare attempt number named different bytes.');
      }
      if (!current.fenced) prepareAttempts.set(token, { ...current, fenced: true });
      return;
    }
    if (!current.fenced) {
      throw new ProxyControlProtocolError('invalid_state', 'The previous prepare attempt is not fenced.');
    }
    prepareAttempts.set(token, { prepareAttemptNumber, prepareAttemptKey, fenced: true });
  };

  const assertPrepareAttemptOpen = (
    key: ProviderOperationKey,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): void => {
    const attempt = prepareAttempts.get(operationToken(key));
    if (
      attempt === undefined ||
      attempt.prepareAttemptNumber !== prepareAttemptNumber ||
      attempt.prepareAttemptKey !== prepareAttemptKey
    ) {
      throw new ProxyControlProtocolError('invalid_state', 'This operation is owned by another prepare attempt.');
    }
    if (attempt.fenced) {
      throw new ProxyControlProtocolError('invalid_state', 'This prepare attempt is fenced.');
    }
  };

  const clearLeaseTimer = (key: ProviderOperationKey): void => {
    const token = operationToken(key);
    const handle = leaseTimers.get(token);
    if (handle === undefined) return;
    timer.clearTimeout(handle);
    leaseTimers.delete(token);
  };

  const sameReleaseIntent = (left: ReleaseIntent, right: ReleaseIntent): boolean =>
    left.kind === right.kind &&
    left.prepareAttemptNumber === right.prepareAttemptNumber &&
    left.prepareAttemptKey === right.prepareAttemptKey &&
    left.reservation === right.reservation &&
    (left.kind !== 'settled' || (right.kind === 'settled' && left.finalProviderSeq === right.finalProviderSeq));

  const beginRelease = (key: ProviderOperationKey, intent: ReleaseIntent): void => {
    const token = operationToken(key);
    const existing = releaseIntents.get(token);
    if (existing !== undefined && !sameReleaseIntent(existing, intent)) {
      throw new ProxyControlProtocolError('invalid_state', 'This operation is already releasing for another reason.');
    }
    releaseIntents.set(token, existing ?? intent);
    clearLeaseTimer(key);
    try {
      ledger.beginRelease(key);
    } catch (error: unknown) {
      asProtocolError(error);
    }
  };

  const finishRelease = async (key: ProviderOperationKey, intent: ReleaseIntent): Promise<void> => {
    const token = operationToken(key);
    const recorded = releaseIntents.get(token);
    if (recorded === undefined || !sameReleaseIntent(recorded, intent)) {
      throw new ProxyControlProtocolError(
        'invalid_state',
        'This release does not match the operation release in flight.',
      );
    }
    if (intent.kind === 'settled') host.releaseSettled?.(key);
    else host.releaseStaged?.(key);
    await options.containment.releaseMembership({ key, reservation: intent.reservation });
    try {
      ledger.transition(key, 'released');
    } catch (error: unknown) {
      asProtocolError(error);
    }
    releasedOperations.set(token, {
      kind: intent.kind,
      prepareAttemptNumber: intent.prepareAttemptNumber,
      prepareAttemptKey: intent.prepareAttemptKey,
      reservation: intent.reservation,
      settledThroughProviderSeq: intent.kind === 'settled' ? intent.finalProviderSeq : 0,
    });
    releaseIntents.delete(token);
  };

  const armLeaseTimer = (key: ProviderOperationKey): void => {
    clearLeaseTimer(key);
    const entry = ledger.get(key);
    if (entry === null || (entry.state !== 'preparing' && entry.state !== 'prepared')) return;
    const token = operationToken(key);
    const leaseExpiresAtMs = entry.leaseExpiresAtMs;
    const handle = timer.setTimeout(
      () => {
        if (leaseTimers.get(token) !== handle) return;
        leaseTimers.delete(token);
        const current = ledger.get(key);
        if (
          current === null ||
          current.leaseExpiresAtMs !== leaseExpiresAtMs ||
          (current.state !== 'preparing' && current.state !== 'prepared')
        ) {
          return;
        }
        fencePrepareAttempt(key, current.prepareAttemptNumber, current.prepareAttemptKey);
        const intent: ReleaseIntent = {
          kind: 'never-started',
          prepareAttemptNumber: current.prepareAttemptNumber,
          prepareAttemptKey: current.prepareAttemptKey,
          reservation: current.reservation,
        };
        beginRelease(key, intent);
        void serializeOperation(key, () => finishRelease(key, intent)).catch(() => {});
      },
      Math.max(0, leaseExpiresAtMs - nowMs()),
    );
    handle.unref?.();
    leaseTimers.set(token, handle);
  };

  const legacyState = (state: ProviderOperationState): string => {
    if (state === 'preparing' || state === 'prepared' || state === 'starting') return 'pending-activation';
    if (state === 'terminal-awaiting-settlement') return 'terminal-awaiting-journal-ack';
    return state;
  };

  const cancelNeverStarted = (
    key: ProviderOperationKey,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): Promise<void> => {
    const token = operationToken(key);
    const before = ledger.get(key);
    if (
      before !== null &&
      before.prepareAttemptNumber === prepareAttemptNumber &&
      before.prepareAttemptKey === prepareAttemptKey &&
      (before.state === 'starting' ||
        before.state === 'executing' ||
        before.state === 'terminal-awaiting-settlement' ||
        before.state === 'suspended-awaiting-durable-decision')
    ) {
      throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
    }
    fencePrepareAttempt(key, prepareAttemptNumber, prepareAttemptKey);
    if (
      before !== null &&
      before.prepareAttemptNumber === prepareAttemptNumber &&
      before.prepareAttemptKey === prepareAttemptKey &&
      (before.state === 'preparing' || before.state === 'prepared')
    ) {
      beginRelease(key, {
        kind: 'never-started',
        prepareAttemptNumber,
        prepareAttemptKey,
        reservation: before.reservation,
      });
    }

    return serializeOperation(key, async () => {
      const released = releasedOperations.get(token);
      if (released !== undefined) {
        if (released.kind === 'activation-failed' || released.kind === 'settled') {
          throw new ProxyControlProtocolError('invalid_state', 'This operation was released after activation began.');
        }
        if (
          released.prepareAttemptNumber === prepareAttemptNumber &&
          released.prepareAttemptKey === prepareAttemptKey
        ) {
          return;
        }
      }

      const entry = ledger.get(key);
      if (entry === null) return;
      if (entry.prepareAttemptNumber !== prepareAttemptNumber || entry.prepareAttemptKey !== prepareAttemptKey) {
        throw new ProxyControlProtocolError('invalid_state', 'Cancel does not name the active prepare attempt.');
      }
      if (
        entry.state === 'starting' ||
        entry.state === 'executing' ||
        entry.state === 'terminal-awaiting-settlement' ||
        entry.state === 'suspended-awaiting-durable-decision'
      ) {
        throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
      }
      const intent: ReleaseIntent = {
        kind: 'never-started',
        prepareAttemptNumber,
        prepareAttemptKey,
        reservation: entry.reservation,
      };
      if (entry.state !== 'releasing') beginRelease(key, intent);
      const recorded = releaseIntents.get(token);
      if (recorded === undefined || recorded.kind !== 'never-started') {
        throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
      }
      await finishRelease(key, recorded);
    });
  };

  // --- provider.event.v1 outbound push -------------------------------------------------------------------
  // `endpoint` is assigned near the bottom of this function (it needs `challenges` and `methods`, both built
  // below), but `pump` only ever *reads* it once invoked, and nothing here invokes `pump` before `createProxy`
  // has returned and `endpoint.listen()` has been called. The forward reference is a deferred-assignment
  // closure, not a use-before-init: TypeScript's strict definite-assignment checking does not — and cannot —
  // reject a read inside a nested function body for exactly this reason. `prefer-const` cannot see that
  // either — from its view this is one assignment that could just be a `const` at its own call site — so it
  // is disabled here for the one binding that genuinely needs `let` for this deferred-assignment pattern.
  // eslint-disable-next-line prefer-const
  let endpoint!: ControlEndpoint;
  // This proxy's own request ids for the one method it ever sends rather than serves. A separate, global (not
  // per-operation) counter, because two operations pushing concurrently on the one connection must never
  // collide — and because request ids and response ids never share a space to begin with: a message carrying
  // `method` is always something the coordinator asked this proxy (control-endpoint.ts's own dispatch), and a
  // message without one is always a reply to something this proxy asked the coordinator (matched inside
  // `control-endpoint.ts`'s `pushOnTenancy`) — the two are mutually exclusive on the wire, so no shared
  // numbering is needed for them not to collide.
  let nextProviderEventFrameId = 1;
  // Stops this proxy from running two overlapping drains of the same operation's buffer. Not a second source
  // of truth for anything the ledger itself owns — membership here only ever gates concurrency.
  const pumpingOperations = new Set<string>();
  const pumpToken = operationToken;

  /**
   * Drains one operation's buffered-but-unacknowledged events over the live control tenancy, oldest first,
   * one at a time — matching "one event per operation is in flight" on the wire. Each push either commits
   * (an `ack`, which frees the ledger's buffer up to that point) or is asked to resend (a `replay`, which
   * retries the same oldest frame: the ledger only ever discards through the last real ack, so the head is
   * always exactly what a `replay` is asking for — no extra bookkeeping is needed to honour
   * `replayFromProviderSeq` beyond "keep retrying the head until it is acknowledged").
   *
   * A rejected push — no active tenancy, a dead or rotated connection, or a timeout — stops the drain without
   * losing anything: `control-endpoint.ts`'s `pushOnTenancy` rejects exactly when the event could not have
   * been durably delivered, so the ledger keeps every unacknowledged frame for the next trigger
   * (`emitProviderEvent`, a successful `operation.adopt.v1`, or a redemption reattach) to pick back up.
   */
  const pump = async (key: ProviderOperationKey): Promise<void> => {
    const token = pumpToken(key);
    if (pumpingOperations.has(token)) return;
    pumpingOperations.add(token);
    try {
      while (true) {
        const entry = ledger.get(key);
        if (entry?.state === 'starting' || entry?.state === 'preparing' || entry?.state === 'prepared') return;
        const next = entry?.bufferedEvents[0];
        if (next === undefined) return;
        let response: unknown;
        try {
          response = await endpoint.pushOnTenancy(next.frame, PROXY_EVENT_COMMIT_TIMEOUT_MS);
        } catch {
          return;
        }
        let result: ProviderEventResult;
        try {
          result = providerEventResultSchema.parse(response);
        } catch {
          return; // A malformed reply is as unusable as none; stop rather than spin on it.
        }
        if (result.kind === 'ack') {
          try {
            ledger.acknowledge(key, result.committedThroughProviderSeq);
          } catch {
            return; // Released mid-drain, or an ack that moved backwards: nothing more to do here.
          }
        }
        // 'replay' leaves the ledger untouched; the loop's next iteration resends the same head frame.
      }
    } finally {
      pumpingOperations.delete(token);
    }
  };

  /** See the `Proxy.emitProviderEvent` interface doc for this seam's full contract. */
  const emitProviderEvent = (key: ProviderOperationKey, event: ProviderEventBody): { paused: boolean } => {
    const providerSeq = ledger.nextProviderSeq(key);
    const request = providerEventRequestSchema.parse({
      operation: {
        jobId: key.jobId,
        operationId: key.operationId,
        proxyInstanceId: identity.proxyInstanceId,
        buildSetId: capsule.buildSetId,
      },
      providerSeq,
      event,
    });
    const frame = encodeProxyControlFrame({
      jsonrpc: '2.0',
      id: nextProviderEventFrameId,
      method: PROVIDER_EVENT_METHOD,
      params: request,
    });
    nextProviderEventFrameId += 1;
    const { paused } = ledger.recordEvent(key, { providerSeq, frame });
    void pump(key);
    return { paused };
  };

  const challenges: ControlChallengeAuthority = {
    controlIsLive: () => evidence.isControlLive(clock.now()),
    issueFirstChallenge: () => {
      const now = clock.now();
      const challenge = mintChallenge();
      return evidence.issueFirstChallenge(challenge, now)
        ? { accepted: true, challenge }
        : { accepted: false, reason: 'invalid-state' };
    },
    admitSuccessor: () => {
      const now = clock.now();
      if (evidence.isControlLive(now)) return { accepted: false, reason: 'control-active' };
      const challenge = mintChallenge();
      evidence.beginSuccessorControl(challenge, now);
      return { accepted: true, challenge };
    },
    // No teardown to refuse against: operational control carries no latch, so a live connection always
    // carries its tenancy forward. Reachable only by a retried `handoff.redeem.v1` for the same successor and
    // grant (this proxy's own `control.open.v1` spends a capsule-wide single-use nonce every time, so its
    // tenancy can never re-enter this branch) — `operation.adopt.v1` is still the documented, exact,
    // per-operation resume path, so this is a defensive second trigger for a successor whose reattach does
    // not immediately re-adopt every operation it holds.
    reattachControl: () => {
      evidence.reattachControl();
      for (const key of ledger.keys()) void pump(key);
      return { accepted: true };
    },
    echoChallenge: (challenge) => {
      const nextChallenge = mintChallenge();
      const recorded = evidence.echoChallenge(clock.now(), challenge, nextChallenge);
      return recorded.accepted ? { accepted: true, nextChallenge } : recorded;
    },
  };

  /** As on the guardian: the set comes from this proxy's own capsule, the timeout from the installer. */
  const setIdentity: GrantBinding = Object.freeze({
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    proxyInstanceId: capsule.proxyInstanceId,
  });

  /** The set a caller names must be this proxy's own, or the grant it presents was never for this carrier. */
  const assertNamedSet = (
    named: Readonly<{ generation: string; hostFingerprint: string; buildSetId: string; proxyInstanceId: string }>,
  ): void => {
    if (
      named.generation !== capsule.generation ||
      named.hostFingerprint !== capsule.hostFingerprint ||
      named.buildSetId !== capsule.buildSetId ||
      named.proxyInstanceId !== capsule.proxyInstanceId
    ) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named set is not this proxy.');
    }
  };

  const assertNamedCoordinatorBuild = (coordinator: CoordinatorIdentity): void => {
    if (
      coordinator.generation !== capsule.generation ||
      coordinator.flavor !== capsule.flavor ||
      coordinator.buildSetId !== capsule.buildSetId
    ) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named coordinator belongs to a different build.');
    }
  };

  const assertNamedOperation = (operation: OperationIdentity): void => {
    if (operation.proxyInstanceId !== capsule.proxyInstanceId || operation.buildSetId !== capsule.buildSetId) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named operation is not held by this proxy.');
    }
  };

  const methods = new Map<string, ControlMethod>([
    [
      'control.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = openParamsSchema.parse(params);
          bootstrapNonce.spend(request.bootstrapNonce);
          assertNamedCoordinatorBuild(request.coordinator);
          return { holder: request.coordinator.instanceId, fields: { proxy: identity } };
        },
      },
    ],
    [
      'operation.prepare.v1',
      {
        authority: 'active',
        // `containment.stageProviderRoot` (`role-main.ts`) can legitimately spend a full app-server cold
        // start (`PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS`, `providers/app-server-transport.ts`) plus the
        // guardian round trip it chains through — longer than `PROXY_CONTROL_RPC_TIMEOUT_MS`, the ordinary
        // mutation-RPC budget this endpoint otherwise defaults every method to. Declaring `budgetMs` here,
        // mirroring `guardian.stop-and-reap.v1`'s own precedent, is what stops this endpoint's own timer from
        // writing a "budget exceeded" failure while the handler is still legitimately running: the
        // alternative left the handler completing in the background with nothing coordinating it, orphaning
        // the staged app-server child and a guardian root registration nobody would ever release.
        budgetMs: 'caller-deadline',
        handle: (params) => {
          const request = prepareParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          if (request.hostFingerprint !== capsule.hostFingerprint) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Prepare named a different host fingerprint.');
          }
          const key = ledgerKey(request.operation);
          const token = operationToken(key);
          const attemptKey = operationPrepareAttemptKey(request);
          registerPrepareAttempt(key, request.prepareAttemptNumber, attemptKey);
          return serializeOperation(key, async (): Promise<unknown> => {
            assertPrepareAttemptOpen(key, request.prepareAttemptNumber, attemptKey);
            const released = releasedOperations.get(token);
            if (
              released !== undefined &&
              released.prepareAttemptNumber < request.prepareAttemptNumber &&
              (released.kind === 'never-started' || released.kind === 'prepare-failed')
            ) {
              releasedOperations.delete(token);
            }
            let reserved: PrepareResult<ProxyPreparedAppServerOperation>;
            try {
              reserved = ledger.prepare({
                key,
                reservation: options.mintReservation(),
                prepared: request.prepared,
                nowMs: nowMs(),
                prepareAttemptNumber: request.prepareAttemptNumber,
                idempotencyKey: attemptKey,
              });
            } catch (error: unknown) {
              asProtocolError(error);
            }
            if (reserved.kind === 'capacity') {
              fencePrepareAttempt(key, request.prepareAttemptNumber, attemptKey);
              return proxyOperationPrepareCapacityResultSchema.parse({
                state: 'capacity',
                retryable: true,
                reason: reserved.reason,
              });
            }
            armLeaseTimer(key);
            if (reserved.entry.providerRoot !== null && reserved.entry.jointContainmentReceipt !== null) {
              return proxyOperationPreparePendingResultSchema.parse({
                state: 'pending-activation',
                reservation: reserved.entry.reservation,
                leaseExpiresInMs: reserved.entry.leaseExpiresAtMs - nowMs(),
                providerRoot: reserved.entry.providerRoot,
                jointContainmentReceipt: reserved.entry.jointContainmentReceipt,
              });
            }

            try {
              const staged = await options.containment.stageProviderRoot(key, {
                reservation: reserved.entry.reservation,
                prepared: reserved.entry.prepared,
              });
              const result = proxyOperationPreparePendingResultSchema.parse({
                state: 'pending-activation',
                reservation: reserved.entry.reservation,
                leaseExpiresInMs: reserved.entry.leaseExpiresAtMs - nowMs(),
                providerRoot: staged.providerRoot,
                jointContainmentReceipt: staged.receipt,
              });
              ledger.recordPreparation(key, result.providerRoot, result.jointContainmentReceipt);
              if (ledger.get(key)?.state === 'releasing') {
                throw new ProxyControlProtocolError('reservation_expired', 'The activation lease expired.');
              }
              return result;
            } catch (error: unknown) {
              const entry = ledger.get(key);
              if (!isAmbiguousControlFailure(error) && entry !== null && entry.state !== 'releasing') {
                const intent: ReleaseIntent = {
                  kind: 'prepare-failed',
                  prepareAttemptNumber: request.prepareAttemptNumber,
                  prepareAttemptKey: attemptKey,
                  reservation: reserved.entry.reservation,
                };
                fencePrepareAttempt(key, request.prepareAttemptNumber, attemptKey);
                beginRelease(key, intent);
                await finishRelease(key, intent);
              }
              throw error;
            }
          });
        },
      },
    ],
    [
      // No requester currently extends the fixed activation lease, but the mutation remains part of the
      // reservation protocol.
      'operation.renew-activation.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = reservationParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const key = ledgerKey(request.operation);
          return serializeOperation(key, () => {
            try {
              const entry = ledger.renew(key, request.reservation, nowMs());
              armLeaseTimer(key);
              return proxyOperationRenewResultSchema.parse({
                state: 'pending-activation',
                leaseExpiresInMs: entry.leaseExpiresAtMs - nowMs(),
              });
            } catch (error: unknown) {
              asProtocolError(error);
            }
          });
        },
      },
    ],
    [
      'operation.activate.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = activateParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const key = ledgerKey(request.operation);
          const fingerprint = operationActivationFingerprint(request);
          return serializeOperation(key, async (): Promise<unknown> => {
            let entry = ledger.get(key);
            if (entry === null) {
              throw new ProxyControlProtocolError('operation_not_found', 'No such prepared operation.');
            }
            if (entry.activationFingerprint !== null && entry.activationFingerprint !== fingerprint) {
              throw new ProxyControlProtocolError('invalid_state', 'Activation does not match the stored attempt.');
            }
            if (entry.activationAck !== null) {
              return proxyOperationActivateResultSchema.parse(entry.activationAck);
            }
            assertPrepareAttemptOpen(key, entry.prepareAttemptNumber, entry.prepareAttemptKey);
            if (entry.jointContainmentReceipt !== request.jointContainmentReceipt) {
              throw new ProxyControlProtocolError(
                'unauthorized_control',
                'Activation named a different containment receipt.',
              );
            }
            await options.containment.confirmActivation({
              key,
              jointContainmentReceipt: request.jointContainmentReceipt,
              jointActivationReceipt: request.jointActivationReceipt,
            });
            entry = ledger.get(key);
            if (entry === null) {
              throw new ProxyControlProtocolError('invalid_state', 'Prepared operation vanished during activation.');
            }
            if (entry.state === 'releasing') {
              const intent = releaseIntents.get(operationToken(key));
              if (intent !== undefined) await finishRelease(key, intent);
              throw new ProxyControlProtocolError('reservation_expired', 'The activation lease expired.');
            }
            try {
              ledger.beginActivation(key, request.reservation, nowMs(), fingerprint);
              clearLeaseTimer(key);
            } catch (error: unknown) {
              if (error instanceof LedgerError && error.code === 'reservation_expired') {
                const intent: ReleaseIntent = {
                  kind: 'never-started',
                  prepareAttemptNumber: entry.prepareAttemptNumber,
                  prepareAttemptKey: entry.prepareAttemptKey,
                  reservation: request.reservation,
                };
                fencePrepareAttempt(key, intent.prepareAttemptNumber, intent.prepareAttemptKey);
                beginRelease(key, intent);
                await finishRelease(key, intent);
              }
              asProtocolError(error);
            }
            entry = ledger.get(key);
            if (entry === null) {
              throw new ProxyControlProtocolError('invalid_state', 'Activation began but its entry vanished.');
            }
            let hostRef: HostRef;
            try {
              hostRef = await host.start({ key, prepared: entry.prepared });
            } catch (error: unknown) {
              const intent: ReleaseIntent = {
                kind: 'activation-failed',
                prepareAttemptNumber: entry.prepareAttemptNumber,
                prepareAttemptKey: entry.prepareAttemptKey,
                reservation: entry.reservation,
              };
              beginRelease(key, intent);
              await finishRelease(key, intent);
              throw error;
            }
            const ack = proxyOperationActivateResultSchema.parse({
              state: 'executing',
              activationFingerprint: fingerprint,
              startedAt: new Date(options.wallClockNow()).toISOString(),
              hostRef,
              committedThroughProviderSeq: entry.committedThroughProviderSeq,
            });
            try {
              ledger.completeActivation(key, fingerprint, ack);
            } catch (error: unknown) {
              asProtocolError(error);
            }
            void pump(key);
            return ack;
          });
        },
      },
    ],
    [
      'operation.cancel.v2',
      {
        authority: 'active',
        handle: (params) => {
          const request = cancelParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const key = ledgerKey(request.operation);
          return cancelNeverStarted(key, request.prepareAttemptNumber, request.prepareAttemptKey).then(() =>
            proxyOperationCancelResultSchema.parse({
              state: 'released-never-started',
              operation: request.operation,
              prepareAttemptNumber: request.prepareAttemptNumber,
              prepareAttemptKey: request.prepareAttemptKey,
            }),
          );
        },
      },
    ],
    [
      'operation.stop.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = stopParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const key = ledgerKey(request.operation);
          const before = ledger.get(key);
          if (before !== null && (before.state === 'preparing' || before.state === 'prepared')) {
            const intent: ReleaseIntent = {
              kind: 'never-started',
              prepareAttemptNumber: before.prepareAttemptNumber,
              prepareAttemptKey: before.prepareAttemptKey,
              reservation: before.reservation,
            };
            fencePrepareAttempt(key, before.prepareAttemptNumber, before.prepareAttemptKey);
            beginRelease(key, intent);
          }
          return serializeOperation(key, async () => {
            const entry = ledger.get(key);
            if (entry === null) throw new ProxyControlProtocolError('operation_not_found', 'No such operation.');
            const next = isInterruptionStopCause(request.cause)
              ? 'suspended-awaiting-durable-decision'
              : 'terminal-awaiting-settlement';
            if (entry.state === 'executing') {
              await host.stop({ key, cause: request.cause });
              const afterStop = ledger.get(key);
              if (afterStop?.state === 'executing') {
                try {
                  ledger.transition(key, next);
                } catch (error: unknown) {
                  asProtocolError(error);
                }
              }
            } else if (entry.state === 'preparing' || entry.state === 'prepared' || entry.state === 'releasing') {
              const intent = releaseIntents.get(operationToken(key));
              if (intent === undefined || intent.kind !== 'never-started') {
                throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
              }
              await finishRelease(key, intent);
            }
            const after = ledger.get(key);
            return proxyOperationStopResultSchema.parse({
              state: after === null ? 'released' : legacyState(after.state),
              committedThroughProviderSeq: after?.committedThroughProviderSeq ?? 0,
            });
          });
        },
      },
    ],
    [
      'operation.settle.v2',
      {
        authority: 'active',
        handle: (params) => {
          const request = settleParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const key = ledgerKey(request.operation);
          const token = operationToken(key);
          return serializeOperation(key, async () => {
            const released = releasedOperations.get(token);
            if (released !== undefined) {
              if (released.kind !== 'settled' || request.finalProviderSeq > released.settledThroughProviderSeq) {
                throw new ProxyControlProtocolError('invalid_state', 'Settlement exceeds the released watermark.');
              }
              return proxyOperationSettleResultSchema.parse({
                state: 'released-after-terminal',
                settledThroughProviderSeq: released.settledThroughProviderSeq,
              });
            }

            const entry = ledger.get(key);
            if (entry === null) {
              return proxyOperationSettleResultSchema.parse({
                state: 'released-after-terminal',
                settledThroughProviderSeq: request.finalProviderSeq,
              });
            }
            if (
              entry.state !== 'terminal-awaiting-settlement' &&
              entry.state !== 'suspended-awaiting-durable-decision' &&
              entry.state !== 'releasing'
            ) {
              throw new ProxyControlProtocolError('invalid_state', 'Operation is not ready for settlement.');
            }
            const lastProviderSeq = ledger.nextProviderSeq(key) - 1;
            if (request.finalProviderSeq !== lastProviderSeq) {
              throw new ProxyControlProtocolError('invalid_request', 'Settlement named a different final sequence.');
            }
            try {
              ledger.acknowledge(key, request.finalProviderSeq);
            } catch (error: unknown) {
              asProtocolError(error);
            }
            const intent: ReleaseIntent = {
              kind: 'settled',
              prepareAttemptNumber: entry.prepareAttemptNumber,
              prepareAttemptKey: entry.prepareAttemptKey,
              reservation: entry.reservation,
              finalProviderSeq: request.finalProviderSeq,
            };
            if (entry.state !== 'releasing') beginRelease(key, intent);
            const recorded = releaseIntents.get(token);
            if (recorded === undefined || recorded.kind !== 'settled') {
              throw new ProxyControlProtocolError('invalid_state', 'Operation is releasing without settlement.');
            }
            await finishRelease(key, recorded);
            return proxyOperationSettleResultSchema.parse({
              state: 'released-after-terminal',
              settledThroughProviderSeq: request.finalProviderSeq,
            });
          });
        },
      },
    ],
    [
      'operation.adopt.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = adoptParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const redemption = grants.redemption();
          if (redemption === null) {
            throw new ProxyControlProtocolError('invalid_state', 'No grant has been redeemed on this proxy.');
          }
          // Set-scoping, not a separate authority: an operation outside the redeemed set is one this
          // successor never earned, however valid its control tenancy is.
          if (
            !redemption.grant.operations.some((operation) => operation.operationId === request.operation.operationId)
          ) {
            throw new ProxyControlProtocolError('operation_not_found', 'That operation is outside the redeemed set.');
          }
          const key = ledgerKey(request.operation);
          const entry = ledger.get(key);
          if (entry === null) throw new ProxyControlProtocolError('operation_not_found', 'No such operation.');
          try {
            ledger.acknowledge(key, request.committedThroughProviderSeq);
          } catch (error: unknown) {
            asProtocolError(error);
          }
          // The documented resume trigger: this successor's control is now the one `pushOnTenancy` writes
          // onto, so whatever this operation still has buffered past the watermark it just acknowledged is
          // exactly the `replayFromProviderSeq` it is about to be told to expect.
          void pump(key);
          return { state: legacyState(entry.state), replayFromProviderSeq: request.committedThroughProviderSeq + 1 };
        },
      },
    ],
    [
      'operation.inspect.v2',
      {
        authority: 'observation',
        budgetMs: PROXY_STATUS_RPC_TIMEOUT_MS,
        handle: (params) => {
          const request = inspectParamsSchema.parse(params);
          assertNamedOperation(request.operation);
          const entry = ledger.get(ledgerKey(request.operation));
          if (entry === null) return proxyOperationInspectResultSchema.parse({ state: 'absent' });
          if (entry.prepareAttemptKey !== request.prepareAttemptKey) {
            throw new ProxyControlProtocolError('invalid_state', 'Inspect does not match the prepared operation.');
          }
          if (entry.state === 'preparing') {
            return proxyOperationInspectResultSchema.parse({
              state: 'preparing',
              reservation: entry.reservation,
              leaseExpiresInMs: entry.leaseExpiresAtMs - nowMs(),
            });
          }
          if (entry.state === 'prepared') {
            if (entry.providerRoot === null || entry.jointContainmentReceipt === null) {
              throw new ProxyControlProtocolError('invalid_state', 'Prepared operation lacks containment evidence.');
            }
            return proxyOperationInspectResultSchema.parse({
              state: 'prepared',
              reservation: entry.reservation,
              leaseExpiresInMs: entry.leaseExpiresAtMs - nowMs(),
              providerRoot: entry.providerRoot,
              jointContainmentReceipt: entry.jointContainmentReceipt,
            });
          }
          if (entry.state === 'starting') {
            if (
              entry.providerRoot === null ||
              entry.jointContainmentReceipt === null ||
              entry.activationFingerprint === null
            ) {
              throw new ProxyControlProtocolError('invalid_state', 'Starting operation lacks activation evidence.');
            }
            return proxyOperationInspectResultSchema.parse({
              state: 'starting',
              reservation: entry.reservation,
              providerRoot: entry.providerRoot,
              jointContainmentReceipt: entry.jointContainmentReceipt,
              activationFingerprint: entry.activationFingerprint,
            });
          }
          if (entry.state === 'releasing') {
            return proxyOperationInspectResultSchema.parse({
              state: 'releasing',
              reservation: entry.reservation,
              providerRoot: entry.providerRoot,
              jointContainmentReceipt: entry.jointContainmentReceipt,
              activationFingerprint: entry.activationFingerprint,
              activationAck: entry.activationAck,
              committedThroughProviderSeq: entry.committedThroughProviderSeq,
            });
          }
          if (entry.activationFingerprint === null || entry.activationAck === null) {
            throw new ProxyControlProtocolError('invalid_state', 'Operation lacks its activation acknowledgement.');
          }
          if (entry.state === 'executing') {
            return proxyOperationInspectResultSchema.parse(entry.activationAck);
          }
          return proxyOperationInspectResultSchema.parse({
            state: 'terminal-awaiting-settlement',
            activationFingerprint: entry.activationFingerprint,
            activationAck: entry.activationAck,
            committedThroughProviderSeq: entry.committedThroughProviderSeq,
          });
        },
      },
    ],
    [
      'handoff.install.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = handoffInstallParamsSchema.parse(params);
          assertNamedSet(request);
          return grants.install({
            grantId: request.grantId,
            secretSha256: request.secretSha256,
            ...setIdentity,
            operations: request.operations,
            orphanTimeoutMs: request.orphanTimeoutMs,
          });
        },
      },
    ],
    [
      'handoff.redeem.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const request = handoffRedeemParamsSchema.parse(params);
          assertNamedSet(request);
          assertNamedCoordinatorBuild(request.successor);
          const redemption = grants.redeem({
            grantId: request.grantId,
            secret: request.secret,
            successorInstanceId: request.successor.instanceId,
            binding: setIdentity,
          });
          return {
            holder: request.successor.instanceId,
            fields: {
              state: 'redeemed-provisional',
              redemptionReceipt: redemption.redemptionReceipt,
              proxy: identity,
              operations: redemption.grant.operations,
            },
          };
        },
      },
    ],
  ]);

  endpoint = createControlEndpoint({
    socketPath: capsule.canonicalEndpoint,
    role: { heartbeatMethod: 'control.heartbeat.v1', methods },
    challenges,
    // EOF revokes operational control. It stops mutation and makes the dormant grant redeemable; it never
    // reaps anything, because this process is inside the containment the enforcers would be reaping.
    observer: { onControlLost: () => evidence.observeEof(clock.now()) },
    timer,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
  });

  return {
    listen: () => endpoint.listen(),
    close: () => {
      for (const handle of leaseTimers.values()) timer.clearTimeout(handle);
      leaseTimers.clear();
      return endpoint.close();
    },
    ledger: () => ledger,
    emitProviderEvent,
  };
}
