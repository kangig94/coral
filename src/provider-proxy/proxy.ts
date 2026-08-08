import type { MonotonicClock } from '../infra/monotonic-clock.js';
// The stop cause is shared with the coordinator's durable side. It lives in `providers/` because both sides
// may reach it and neither may reach the other: this tree is barred from `jobs/`, and the reverse edge would
// point the dependency the wrong way.
import { isInterruptionStopCause, type ProviderEventBody, type ProviderStopCause } from '../providers/contract.js';
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
  type OperationLedger,
  type PrepareResult,
  type ProviderOperationKey,
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
  proxyOperationStatusParamsSchema as operationStatusParamsSchema,
  proxyOperationActivateResultSchema,
  proxyOperationCancelPendingResultSchema,
  proxyOperationPrepareCapacityResultSchema,
  proxyOperationPreparePendingResultSchema,
  proxyOperationRenewResultSchema,
  proxyOperationStopResultSchema,
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
  /** Starts the kernel for an activated operation. Throwing leaves the ledger entry untouched. */
  start(
    input: Readonly<{ key: ProviderOperationKey; prepared: ProxyPreparedAppServerOperation }>,
  ): Promise<void> | void;
  /** Stops a running kernel. Called for every recorded stop cause, including a clean handoff. */
  stop(input: Readonly<{ key: ProviderOperationKey; cause: ProviderStopCause }>): Promise<void> | void;
  /**
   * Releases a staged provider root that never reached `executing` — a cancelled reservation, or a stop
   * that arrived before activation. `stop()`'s contract is "stops a running kernel", so a ledger entry that
   * never started one has nothing for it to interrupt; this is the only other way `operation.prepare.v1`'s
   * own staged app-server session ever gets released. Idempotent: a key never staged, or already released
   * through `start`/`stop`'s own cleanup, is a safe no-op. Optional so a test double exercising only the
   * executing path is not required to implement it.
   */
  releaseStaged?(key: ProviderOperationKey): void;
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

function prepareIdempotencyKey(operation: OperationIdentity, prepared: ProxyPreparedAppServerOperation): string {
  return JSON.stringify([operation, prepared]);
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
  const preparingOperations = new Map<string, Readonly<{ idempotencyKey: string; promise: Promise<unknown> }>>();
  const activatingOperations = new Map<string, Readonly<{ idempotencyKey: string; promise: Promise<unknown> }>>();
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
        handle: async (params) => {
          const request = prepareParamsSchema.parse(params);
          if (request.hostFingerprint !== capsule.hostFingerprint) {
            throw new ProxyControlProtocolError('identity_mismatch', 'Prepare named a different host fingerprint.');
          }
          const key = ledgerKey(request.operation);
          const token = operationToken(key);
          const idempotencyKey = prepareIdempotencyKey(request.operation, request.prepared);
          const inFlight = preparingOperations.get(token);
          if (inFlight !== undefined) {
            if (inFlight.idempotencyKey !== idempotencyKey) {
              throw new ProxyControlProtocolError('invalid_state', 'This operation is already being prepared.');
            }
            return inFlight.promise;
          }

          const promise = (async (): Promise<unknown> => {
            let reserved: PrepareResult<ProxyPreparedAppServerOperation>;
            try {
              reserved = ledger.prepare({
                key,
                reservation: options.mintReservation(),
                prepared: request.prepared,
                nowMs: nowMs(),
                idempotencyKey,
              });
            } catch (error: unknown) {
              asProtocolError(error);
            }
            if (reserved.kind === 'capacity') {
              return proxyOperationPrepareCapacityResultSchema.parse({
                state: 'capacity',
                retryable: true,
                reason: reserved.reason,
              });
            }
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
              return result;
            } catch (error: unknown) {
              if (!isAmbiguousControlFailure(error)) {
                const entry = ledger.get(key);
                if (entry !== null && entry.reservation === reserved.entry.reservation) {
                  try {
                    ledger.transition(key, 'released');
                  } catch (transitionError: unknown) {
                    asProtocolError(transitionError);
                  }
                }
                host.releaseStaged?.(key);
              }
              throw error;
            }
          })();
          preparingOperations.set(token, { idempotencyKey, promise });
          try {
            return await promise;
          } finally {
            if (preparingOperations.get(token)?.promise === promise) preparingOperations.delete(token);
          }
        },
      },
    ],
    [
      // No requester in this repository, and kept deliberately — the same asymmetry `operation.status.v1`
      // records below. A responder cannot be retrofitted into a process that is already running, so it has to
      // ship before anything needs it; a requester can be added at any time. Until then this method is the
      // only way a lease could ever be extended past `PROXY_PENDING_ACTIVATION_LEASE_MS`, which is a fixed
      // expiry today.
      'operation.renew-activation.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = reservationParamsSchema.parse(params);
          try {
            const entry = ledger.renew(ledgerKey(request.operation), request.reservation, nowMs());
            return proxyOperationRenewResultSchema.parse({
              state: 'pending-activation',
              leaseExpiresInMs: entry.leaseExpiresAtMs - nowMs(),
            });
          } catch (error: unknown) {
            asProtocolError(error);
          }
        },
      },
    ],
    [
      'operation.activate.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = activateParamsSchema.parse(params);
          const key = ledgerKey(request.operation);
          const before = ledger.get(key);
          // The containment receipt is the ledger's own record of which staged root this reservation was
          // reported against; a caller presenting any other string is activating against a root nobody
          // staged with either enforcer.
          if (before !== null && before.jointContainmentReceipt !== request.jointContainmentReceipt) {
            throw new ProxyControlProtocolError(
              'unauthorized_control',
              'Activation named a different containment receipt.',
            );
          }
          const token = operationToken(key);
          const idempotencyKey = JSON.stringify([
            request.reservation,
            request.jointContainmentReceipt,
            request.jointActivationReceipt,
          ]);
          const inFlight = activatingOperations.get(token);
          if (inFlight !== undefined) {
            if (inFlight.idempotencyKey !== idempotencyKey) {
              throw new ProxyControlProtocolError('invalid_state', 'This operation is already being activated.');
            }
            return inFlight.promise;
          }

          const promise = (async (): Promise<unknown> => {
            await options.containment.confirmActivation({
              key,
              jointContainmentReceipt: request.jointContainmentReceipt,
              jointActivationReceipt: request.jointActivationReceipt,
            });
            try {
              ledger.activate(key, request.reservation, nowMs());
            } catch (error: unknown) {
              asProtocolError(error);
            }
            const entry = ledger.get(key);
            if (entry === null) {
              throw new ProxyControlProtocolError('invalid_state', 'Activation succeeded but its entry vanished.');
            }
            if (before?.state !== 'executing') {
              await host.start({ key, prepared: entry.prepared });
            }
            return proxyOperationActivateResultSchema.parse({
              state: 'executing',
              committedThroughProviderSeq: entry.committedThroughProviderSeq,
            });
          })();
          activatingOperations.set(token, { idempotencyKey, promise });
          try {
            return await promise;
          } finally {
            if (activatingOperations.get(token)?.promise === promise) activatingOperations.delete(token);
          }
        },
      },
    ],
    [
      'operation.cancel-pending.v1',
      {
        authority: 'active',
        handle: (params) => {
          const request = reservationParamsSchema.parse(params);
          const key = ledgerKey(request.operation);
          const entry = ledger.get(key);
          // Idempotent: an entry already gone is a cancel that already landed, and reporting `released`
          // is the truthful answer rather than a not-found the caller would have to special-case.
          if (entry === null) return proxyOperationCancelPendingResultSchema.parse({ state: 'released' });
          if (entry.reservation !== request.reservation) {
            throw new ProxyControlProtocolError('invalid_request', 'Cancel presented a different reservation.');
          }
          try {
            ledger.transition(key, 'released');
          } catch (error: unknown) {
            asProtocolError(error);
          }
          // The ledger entry never reached `executing`, so no kernel was ever started for it — but
          // `operation.prepare.v1` may already have staged its provider root. `host.stop` is the only other
          // thing that releases that staging, and it is reachable only from the `executing` path below, so
          // a cancelled reservation needs its own release here or the staged app-server child runs for the
          // rest of this proxy's life with nothing left referencing it.
          host.releaseStaged?.(key);
          return proxyOperationCancelPendingResultSchema.parse({ state: 'released' });
        },
      },
    ],
    [
      'operation.stop.v1',
      {
        authority: 'active',
        handle: async (params) => {
          const request = stopParamsSchema.parse(params);
          const key = ledgerKey(request.operation);
          const entry = ledger.get(key);
          if (entry === null) throw new ProxyControlProtocolError('operation_not_found', 'No such operation.');
          // The terminal is not `released`: the coordinator must durably decide first, and deleting the
          // entry here would drop the replay buffer that decision still needs. Only a recorded restart or
          // handoff suspends — the abort causes end the operation outright, and claiming they interrupted
          // it would write an interruption the user never suffered.
          const next = isInterruptionStopCause(request.cause)
            ? 'suspended-awaiting-durable-decision'
            : 'terminal-awaiting-journal-ack';
          if (entry.state === 'executing') {
            await host.stop({ key, cause: request.cause });
            try {
              ledger.transition(key, next);
            } catch (error: unknown) {
              asProtocolError(error);
            }
          } else {
            // `SemanticOperationHost.stop`'s contract is "stops a running kernel" — an entry that never
            // reached `executing` has none to stop. Releasing it here is what keeps a pending-activation or
            // pending-recovery entry from being stuck forever with nothing left to end it.
            try {
              ledger.transition(key, 'released');
            } catch (error: unknown) {
              asProtocolError(error);
            }
            // Same staged-but-never-started release `operation.cancel-pending.v1` performs: nothing else
            // drops the app-server child `operation.prepare.v1` may have staged for this key.
            host.releaseStaged?.(key);
          }
          const after = ledger.get(key);
          return proxyOperationStopResultSchema.parse({
            state: after?.state ?? 'released',
            committedThroughProviderSeq: after?.committedThroughProviderSeq ?? 0,
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
          return { state: entry.state, replayFromProviderSeq: request.committedThroughProviderSeq + 1 };
        },
      },
    ],
    [
      'operation.status.v1',
      {
        // The one method served without holding control: an observation is asked by whoever is *not*
        // running this set. It reads the ledger and the in-flight activation marker; it moves no deadline,
        // spends no credential, and transitions nothing, so answering it can never change what this proxy
        // would otherwise do.
        authority: 'observation',
        // A background health check, not a mutation the caller is blocked on — bounded well below the
        // ordinary control budget so a wedged reply costs an asker no more than the asker itself budgets
        // for the call.
        //
        // No requester lives in this repo today: the coordinator-side network observer that once paired with
        // this handler (`coordinator/live/carrier-observer.ts`) had no importer anywhere in `src/` and was
        // deleted. The handler stays regardless, because this is a cross-version wire surface — a *successor*
        // coordinator build must be able to observe *this* build's already-running proxy, and a responder
        // cannot be retrofitted into a process that has already shipped. The requester can be added later;
        // the responder cannot, so it ships now, ahead of the build that will call it.
        budgetMs: PROXY_STATUS_RPC_TIMEOUT_MS,
        handle: (params) => {
          const request = operationStatusParamsSchema.parse(params);
          // Every named operation must name *this* proxy. Refusing the whole request rather than the
          // offending entry is deliberate: a caller that mixed two proxies' operations together has a bug
          // in what it believes about its own store, and answering the half that happened to match would
          // hide it behind a plausible-looking reply.
          for (const operation of request.operations) {
            if (operation.proxyInstanceId !== capsule.proxyInstanceId || operation.buildSetId !== capsule.buildSetId) {
              throw new ProxyControlProtocolError('identity_mismatch', 'A named operation is not this proxy.');
            }
          }
          return {
            proxyInstanceId: capsule.proxyInstanceId,
            operations: request.operations.map((operation) => {
              const entry = ledger.get({ jobId: operation.jobId, operationId: operation.operationId });
              // `absent` is a positive finding from the one authority that can make it: this proxy is
              // alive, it answered, and it holds no such operation. It is not the same as an unanswered
              // probe, and the caller must be able to tell them apart.
              return entry === null
                ? { operation, held: false as const }
                : {
                    operation,
                    held: true as const,
                    state: activatingOperations.has(operationToken(entry.key)) ? 'executing' : entry.state,
                    committedThroughProviderSeq: entry.committedThroughProviderSeq,
                  };
            }),
          };
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
    close: () => endpoint.close(),
    ledger: () => ledger,
    emitProviderEvent,
  };
}
