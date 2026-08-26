import { z } from 'zod';

import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import { ControlLeaseEvidence, type ControlLeaseEchoResult } from './control-lease.js';
import type { EnvPort } from '../infra/port-types.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../infra/process-constants.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from './protocol.js';

export const CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV = 'CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS';
export const DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = 37_000;
export const MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = 19_001;
export const MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = 300_000;

export const PROXY_CONTROL_HEARTBEAT_MS = 1_000;
export const PROXY_CONTROL_LEASE_MS = 12_000;
export const PROXY_CONTROL_ESTABLISH_READY_MS = 10_000;
export const PROXY_ENDPOINT_CLEANUP_BUDGET_MS = 1_000;
export const PROXY_ENFORCER_MAX_WAKE_LATENCY_MS = 1_000;
export const PROXY_PROCESS_CONTROL_BUDGET_MS = 2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;
export const PROXY_TEARDOWN_RESERVE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  PROXY_ENDPOINT_CLEANUP_BUDGET_MS +
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS +
  PROXY_PROCESS_CONTROL_BUDGET_MS;
export const PROXY_REDEMPTION_DISPATCH_MAX_MS = 1_000;
export const PROXY_STARTUP_ATTACH_RESERVE_MS = 4_000;
export const PROXY_SUCCESSOR_TAIL_MS = Math.max(
  2 * PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_REDEMPTION_DISPATCH_MAX_MS + PROXY_CONTROL_RPC_TIMEOUT_MS + PROXY_STARTUP_ATTACH_RESERVE_MS,
);
export const MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = Math.max(
  MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_ESTABLISH_READY_MS + 2 * PROXY_CONTROL_RPC_TIMEOUT_MS + 1,
  PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_LEASE_MS + PROXY_SUCCESSOR_TAIL_MS + 1,
);

const EXPECTED_PROXY_TEARDOWN_RESERVE_MS = 14_000;
const providerProxyDeadlineConfigurationBrand: unique symbol = Symbol('coral.provider-proxy-deadline-configuration');

export type ProviderProxyDeadlineTiming = Readonly<{
  heartbeatMs: number;
  rpcTimeoutMs: number;
  leaseMs: number;
  establishReadyMs: number;
  redemptionDispatchMs: number;
  startupAttachReserveMs: number;
  teardownReserveMs: number;
  orphanTimeoutMs: number;
}>;

/**
 * How long a role's own enforcer tolerates silence before its adoption deadline can fire, derived from the
 * same two configuration fields `adoptionDeadline()` (below) itself subtracts. Exported so a consumer that
 * needs to agree with this tolerance — the coordinator's own bounded heartbeat-hold escalation
 * (`ProviderProxySetLifecycleDeps.heartbeatHoldBoundMs`) — derives it from this one formula instead of
 * restating it as an independently chosen number.
 */
export function providerProxyAdoptionWindowMs(
  configuration: Pick<ProviderProxyDeadlineTiming, 'orphanTimeoutMs' | 'teardownReserveMs'>,
): number {
  return configuration.orphanTimeoutMs - configuration.teardownReserveMs;
}

export function providerProxyDeadlineTimingIsValid(timing: ProviderProxyDeadlineTiming): boolean {
  const adoptionWindowMs = providerProxyAdoptionWindowMs(timing);
  const successorTailMs = Math.max(
    2 * timing.rpcTimeoutMs,
    timing.redemptionDispatchMs + timing.rpcTimeoutMs + timing.startupAttachReserveMs,
  );
  return (
    2 * timing.rpcTimeoutMs + timing.heartbeatMs < timing.leaseMs &&
    timing.establishReadyMs + 2 * timing.rpcTimeoutMs < adoptionWindowMs &&
    timing.leaseMs + successorTailMs < adoptionWindowMs
  );
}

export type ProviderProxyDeadlineConfiguration = Readonly<{
  orphanTimeoutMs: number;
  heartbeatMs: number;
  leaseMs: number;
  teardownReserveMs: number;
  [providerProxyDeadlineConfigurationBrand]: true;
}>;

const decimalMillisecondsSchema = z
  .string()
  .regex(/^[0-9]+$/u, 'must be a decimal millisecond duration')
  .transform((raw, context) => {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a safe integer millisecond duration' });
      return z.NEVER;
    }
    return parsed;
  });

const providerProxyDeadlineInputSchema = z
  .object({
    orphanTimeoutMs: decimalMillisecondsSchema.default(String(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS)),
  })
  .strict();

export const providerProxyDeadlineConfigurationSchema = providerProxyDeadlineInputSchema
  .superRefine(({ orphanTimeoutMs }, context) => {
    // Keep the plan's strict timing policy independent from the integer production range: the timing
    // relations intentionally reject part of that separately stated range.
    if (
      orphanTimeoutMs < MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS ||
      orphanTimeoutMs > MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orphanTimeoutMs'],
        message: `must be in the stated production range ${MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}..${MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}`,
      });
    }
    if (
      !providerProxyDeadlineTimingIsValid({
        heartbeatMs: PROXY_CONTROL_HEARTBEAT_MS,
        rpcTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
        leaseMs: PROXY_CONTROL_LEASE_MS,
        establishReadyMs: PROXY_CONTROL_ESTABLISH_READY_MS,
        redemptionDispatchMs: PROXY_REDEMPTION_DISPATCH_MAX_MS,
        startupAttachReserveMs: PROXY_STARTUP_ATTACH_RESERVE_MS,
        teardownReserveMs: PROXY_TEARDOWN_RESERVE_MS,
        orphanTimeoutMs,
      })
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orphanTimeoutMs'],
        message: 'must satisfy the strict recurrence, process-bootstrap, and successor-adoption timing policy',
      });
    }
    if (PROXY_TEARDOWN_RESERVE_MS !== EXPECTED_PROXY_TEARDOWN_RESERVE_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teardownReserveMs'],
        message: `derived teardown reserve must equal ${EXPECTED_PROXY_TEARDOWN_RESERVE_MS}`,
      });
    }
  })
  .transform(({ orphanTimeoutMs }): ProviderProxyDeadlineConfiguration => {
    const configuration = {
      orphanTimeoutMs,
      heartbeatMs: PROXY_CONTROL_HEARTBEAT_MS,
      leaseMs: PROXY_CONTROL_LEASE_MS,
      teardownReserveMs: PROXY_TEARDOWN_RESERVE_MS,
    };
    Object.defineProperty(configuration, providerProxyDeadlineConfigurationBrand, { value: true });
    return Object.freeze(configuration) as ProviderProxyDeadlineConfiguration;
  });

export function resolveProviderProxyDeadlineConfiguration(
  env: Pick<EnvPort, 'get'>,
): ProviderProxyDeadlineConfiguration {
  return providerProxyDeadlineConfigurationSchema.parse({
    orphanTimeoutMs: env.get(CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV),
  });
}

export type ProviderProxyEnforcerBounds<Scope extends symbol> = Readonly<{
  lastRoundTripEvidenceAt: MonotonicInstant<Scope>;
  eofAt: MonotonicInstant<Scope> | null;
  controlLossAt: MonotonicInstant<Scope>;
  exitDeadline: MonotonicInstant<Scope>;
  adoptionDeadline: MonotonicInstant<Scope>;
}>;

export type EnforcerDeadlineState = 'accepting-control' | 'teardown-latched' | 'containment-absent' | 'exited';

export type DeadlineDispatchResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'control-active' | 'invalid-state' | 'teardown-latched';
    }>;

/** `DeadlineDispatchResult`'s own refusal reasons, named once so a challenge-carrying result can reuse them. */
type DeadlineDispatchRefusalReason = Extract<DeadlineDispatchResult, { accepted: false }>['reason'];

/**
 * What `issueFirstChallenge`/`admitSuccessor` answer: the minted challenge on acceptance, since the
 * authority that admits a tenancy is the authority that mints its first challenge — or one of the same
 * refusal reasons an ordinary dispatch reports.
 */
export type DeadlineChallengeIssueResult =
  | Readonly<{ accepted: true; challenge: string }>
  | Readonly<{ accepted: false; reason: DeadlineDispatchRefusalReason }>;

export type ChallengeEchoResult =
  | Readonly<{ accepted: true; nextChallenge: string }>
  | Exclude<ControlLeaseEchoResult, { accepted: true }>
  | Readonly<{ accepted: false; reason: 'teardown-latched' }>;

export type EnforcerDeadlineStateMachine<Scope extends symbol> = Readonly<{
  state(): EnforcerDeadlineState;
  bounds(): ProviderProxyEnforcerBounds<Scope>;
  /** Mints and installs the tenancy's first challenge in one act; the challenge travels back in the result. */
  issueFirstChallenge(): DeadlineChallengeIssueResult;
  /** Whether recent evidence still satisfies this enforcer's live-control act preconditions. */
  controlIsLive(): boolean;
  echoChallenge(challenge: string): ChallengeEchoResult;
  /**
   * A live connection carries an already-granted tenancy again — the same holder retrying its open, on the
   * same socket or a new one. No new challenge: the one already outstanding stays answerable. Refused only
   * once teardown has latched, the one condition that makes carrying the tenancy forward meaningless.
   */
  reattachControl(): DeadlineDispatchResult;
  observeEof(): void;
  /**
   * Admits a successor control tenancy and mints its first challenge. Refused while control is live or once
   * teardown has latched. The credential's one-shot lives with its owner, so this authorizes and does not
   * also consume.
   */
  admitSuccessor(): DeadlineChallengeIssueResult;
  /**
   * Records that the paired peer channel closed. The party that linearizes an ordered redemption is gone,
   * so admitting a successor can now only ever fail — `adoptionDeadline` collapses to (at most) this
   * instant to stop trying. `exitDeadline` is untouched: teardown still gets its full reserve regardless of
   * which authority failed first, and `eofAt`/`controlLossAt` are untouched too, because this is not
   * evidence about the coordinator's control — a live coordinator keeps heartbeating through it.
   */
  observePairingLoss(): void;
  latchTeardown(): void;
  markContainmentAbsent(): void;
  markExited(): void;
}>;

function assertContainmentAbsentTransition(state: EnforcerDeadlineState): void {
  if (state !== 'teardown-latched') {
    throw new Error('Containment can be marked absent only after teardown is latched.');
  }
}

function assertExitedTransition(state: EnforcerDeadlineState): void {
  if (state !== 'containment-absent') {
    throw new Error('The enforcer can exit only after containment absence is confirmed.');
  }
}

/**
 * What the enforcer needs from its composer to construct its challenge authority: how to mint a challenge.
 * Minting joins this construction rather than staying a `createControlEndpoint` option, the same shape
 * `createGrantRegistry(mintReceipt)` already establishes — the authority that admits a tenancy is the
 * authority that mints its challenges.
 */
export type EnforcerChallengePolicy = Readonly<{
  mintChallenge(): string;
}>;

export function createEnforcerDeadlineStateMachine<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  configuration: ProviderProxyDeadlineConfiguration,
  policy: EnforcerChallengePolicy,
): EnforcerDeadlineStateMachine<Scope> {
  if (configuration[providerProxyDeadlineConfigurationBrand] !== true) {
    throw new Error('Provider proxy deadline configuration must be validated before use.');
  }
  let state: EnforcerDeadlineState = 'accepting-control';
  // Deliberately not on `ControlLeaseEvidence`: that class is round-trip evidence for one control
  // tenancy, and the standalone proxy holds it with no `adoptionDeadline` of its own to accelerate.
  // Pairing loss is a third, independent input — this machine's own state, not the lease's.
  let pairingLossAt: MonotonicInstant<Scope> | null = null;

  function adoptionDeadline(): MonotonicInstant<Scope> {
    const exit = clock.shiftMilliseconds(evidence.lastRoundTripEvidenceAt(), configuration.orphanTimeoutMs);
    const derived = clock.shiftMilliseconds(exit, -configuration.teardownReserveMs);
    return pairingLossAt === null ? derived : clock.earlier(derived, pairingLossAt);
  }

  const evidence = new ControlLeaseEvidence(clock, configuration.leaseMs, clock.now());

  /**
   * The teardown deadlines this enforcer adds on top of the lease. Both are anchored on the same round-trip
   * evidence, so nothing but a genuine echo can move either one — except `adoptionDeadline`, which pairing
   * loss may also pull earlier, never later, once the party that would linearize a successor is gone.
   */
  const bounds = (): ProviderProxyEnforcerBounds<Scope> => {
    const lastRoundTripEvidenceAt = evidence.lastRoundTripEvidenceAt();
    return Object.freeze({
      lastRoundTripEvidenceAt,
      eofAt: evidence.eofAt(),
      controlLossAt: evidence.controlLossAt(),
      exitDeadline: clock.shiftMilliseconds(lastRoundTripEvidenceAt, configuration.orphanTimeoutMs),
      adoptionDeadline: adoptionDeadline(),
    });
  };

  const latchTeardown = (): void => {
    if (state === 'accepting-control') state = 'teardown-latched';
  };
  const sampleBeforeQueuedWork = (): MonotonicInstant<Scope> | null => {
    const now = clock.now();
    // Sampling before any queued work is what makes equality and processed-after lose: a handler that was
    // enqueued while the set was still adoptable must not act on that stale belief.
    if (clock.compare(now, adoptionDeadline()) >= 0) latchTeardown();
    return state === 'accepting-control' ? now : null;
  };

  return Object.freeze({
    state: (): EnforcerDeadlineState => state,
    // Successor admission and mutation authority share this recent-evidence precondition. Its lapse permits
    // those acts to change disposition; it does not itself end the tenancy.
    controlIsLive: (): boolean => evidence.isControlLive(clock.now()),
    bounds,
    issueFirstChallenge: (): DeadlineChallengeIssueResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      const challenge = policy.mintChallenge();
      // A refusal, not a throw: "a first challenge already exists" is a state this machine models, and the
      // endpoint has to be able to answer the caller rather than fail the connection over it.
      if (!evidence.issueFirstChallenge(challenge)) {
        return { accepted: false, reason: 'invalid-state' };
      }
      return { accepted: true, challenge };
    },
    echoChallenge: (challenge: string): ChallengeEchoResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      const nextChallenge = policy.mintChallenge();
      const recorded = evidence.echoChallenge(now, challenge, nextChallenge);
      return recorded.accepted ? { accepted: true, nextChallenge } : recorded;
    },
    reattachControl: (): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      evidence.reattachControl();
      return { accepted: true };
    },
    observeEof: (): void => {
      const now = sampleBeforeQueuedWork();
      if (now !== null) evidence.observeEof(now);
    },
    observePairingLoss: (): void => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return;
      // Earliest wins, matching `observeEof`: a second report of the same loss cannot walk the collapse
      // back out.
      pairingLossAt = pairingLossAt === null ? now : clock.earlier(pairingLossAt, now);
    },
    admitSuccessor: (): DeadlineChallengeIssueResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (evidence.isControlLive(now)) return { accepted: false, reason: 'control-active' };
      const challenge = policy.mintChallenge();
      // Installing a challenge before the credential is checked would let a refused replay poison a
      // legitimate successor's retry, while the reverse order costs nothing.
      evidence.beginSuccessorControl(challenge);
      return { accepted: true, challenge };
    },
    latchTeardown,
    markContainmentAbsent: (): void => {
      assertContainmentAbsentTransition(state);
      state = 'containment-absent';
    },
    markExited: (): void => {
      assertExitedTransition(state);
      state = 'exited';
    },
  });
}
