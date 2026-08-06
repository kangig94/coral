import { z } from 'zod';

import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import { ControlLeaseEvidence, type ControlLeaseEchoResult } from './control-lease.js';
import type { EnvPort } from '../infra/port-types.js';
import {
  PROXY_DISAPPEARANCE_CONFIRM_MS,
  PROXY_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../infra/process-constants.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from './protocol.js';

export const CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV = 'CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS';
export const DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = 30_000;
export const MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = 19_001;
export const MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = 300_000;

export const PROXY_CONTROL_HEARTBEAT_MS = 1_000;
export const PROXY_CONTROL_LEASE_MS = 5_000;
export const PROXY_ENDPOINT_CLEANUP_BUDGET_MS = 1_000;
export const PROXY_ENFORCER_MAX_WAKE_LATENCY_MS = 1_000;
export const PROXY_PROCESS_CONTROL_BUDGET_MS = 2 * PROXY_PROCESS_CONTROL_CALL_MAX_MS;
export const PROXY_TEARDOWN_RESERVE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  PROXY_DISAPPEARANCE_CONFIRM_MS +
  PROXY_ENDPOINT_CLEANUP_BUDGET_MS +
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS +
  PROXY_PROCESS_CONTROL_BUDGET_MS;
export const PROXY_REDEMPTION_DISPATCH_MAX_MS = 1_000;
export const PROXY_STARTUP_ATTACH_RESERVE_MS = 4_000;
export const MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS = Math.max(
  MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_LEASE_MS + 1,
  PROXY_TEARDOWN_RESERVE_MS +
    PROXY_REDEMPTION_DISPATCH_MAX_MS +
    PROXY_CONTROL_RPC_TIMEOUT_MS +
    PROXY_STARTUP_ATTACH_RESERVE_MS +
    1,
);

const EXPECTED_PROXY_TEARDOWN_RESERVE_MS = 14_000;
const providerProxyDeadlineConfigurationBrand: unique symbol = Symbol('coral.provider-proxy-deadline-configuration');

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
    // Keep the plan's two strict inequalities independent: the redemption
    // margin intentionally rejects part of the separately stated range.
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
      !(
        PROXY_CONTROL_HEARTBEAT_MS < PROXY_CONTROL_LEASE_MS &&
        PROXY_CONTROL_LEASE_MS < orphanTimeoutMs - PROXY_TEARDOWN_RESERVE_MS
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orphanTimeoutMs'],
        message: 'must satisfy heartbeat < lease < orphan timeout - teardown reserve',
      });
    }
    if (
      !(
        PROXY_REDEMPTION_DISPATCH_MAX_MS + PROXY_CONTROL_RPC_TIMEOUT_MS + PROXY_STARTUP_ATTACH_RESERVE_MS <
        orphanTimeoutMs - PROXY_TEARDOWN_RESERVE_MS
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orphanTimeoutMs'],
        message: 'must retain the strict redemption RPC and startup attach margin',
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
  firstChallengeExpiresAt: MonotonicInstant<Scope> | null;
}>;

/**
 * Both enforcers hold the same states. The reaper's `armed` was `accepting-control` under another name, and
 * its `successor-rotated` encoded a credential's one-shot in the deadline model — that belongs to the
 * credential owner, so it is gone and the two machines are one.
 */
export type EnforcerDeadlineState = 'accepting-control' | 'teardown-latched' | 'containment-absent' | 'exited';

export type DeadlineDispatchResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'control-active' | 'control-lost' | 'invalid-state' | 'teardown-latched';
    }>;

export type ChallengeEchoResult = ControlLeaseEchoResult | Readonly<{ accepted: false; reason: 'teardown-latched' }>;

export type ProviderProxyOrdinaryFrameKind = 'proxy-heartbeat' | 'authenticated-frame';

export type EnforcerDeadlineStateMachine<Scope extends symbol> = Readonly<{
  state(): EnforcerDeadlineState;
  bounds(): ProviderProxyEnforcerBounds<Scope>;
  issueFirstChallenge(challenge: string): DeadlineDispatchResult;
  /** Whether the established tenancy still holds control on this enforcer's own clock. */
  controlIsLive(): boolean;
  echoChallenge(challenge: string, nextChallenge: string): ChallengeEchoResult;
  observeEof(): void;
  dispatchOrdinaryFrame(kind: ProviderProxyOrdinaryFrameKind, work: () => void): DeadlineDispatchResult;
  /**
   * Admits a successor control tenancy. Refused while control is live or once teardown has latched. The
   * credential's one-shot lives with its owner, so this authorizes and does not also consume.
   */
  admitSuccessor(firstSuccessorChallenge: string): DeadlineDispatchResult;
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

export function createEnforcerDeadlineStateMachine<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  configuration: ProviderProxyDeadlineConfiguration,
  isCoordinatorLive: () => boolean,
): EnforcerDeadlineStateMachine<Scope> {
  if (configuration[providerProxyDeadlineConfigurationBrand] !== true) {
    throw new Error('Provider proxy deadline configuration must be validated before use.');
  }
  const evidence = new ControlLeaseEvidence(clock, configuration.leaseMs);
  let state: EnforcerDeadlineState = 'accepting-control';
  // Deliberately not on `ControlLeaseEvidence`: that class is round-trip evidence for one control
  // connection, and the standalone proxy holds it with no `adoptionDeadline` of its own to accelerate.
  // Pairing loss is a third, independent input — this machine's own state, not the lease's.
  let pairingLossAt: MonotonicInstant<Scope> | null = null;

  /**
   * The teardown deadlines this enforcer adds on top of the lease. Both are anchored on the same round-trip
   * evidence, so nothing but a genuine echo can move either one — except `adoptionDeadline`, which pairing
   * loss may also pull earlier, never later, once the party that would linearize a successor is gone.
   */
  const bounds = (): ProviderProxyEnforcerBounds<Scope> => {
    const lastRoundTripEvidenceAt = evidence.lastRoundTripEvidenceAt();
    const exitDeadline = clock.shiftMilliseconds(lastRoundTripEvidenceAt, configuration.orphanTimeoutMs);
    const derivedAdoptionDeadline = clock.shiftMilliseconds(exitDeadline, -configuration.teardownReserveMs);
    const adoptionDeadline =
      pairingLossAt === null ? derivedAdoptionDeadline : clock.earlier(derivedAdoptionDeadline, pairingLossAt);
    return Object.freeze({
      lastRoundTripEvidenceAt,
      eofAt: evidence.eofAt(),
      controlLossAt: evidence.controlLossAt(),
      exitDeadline,
      adoptionDeadline,
      // A challenge may not outlive the window it is evidence for, so its expiry is clamped to adoption.
      firstChallengeExpiresAt: evidence.challengeExpiresAt({
        coordinatorIsLive: true,
        expiryCeiling: adoptionDeadline,
      }),
    });
  };

  const latchTeardown = (): void => {
    if (state === 'accepting-control') state = 'teardown-latched';
  };
  const sampleBeforeQueuedWork = (): MonotonicInstant<Scope> | null => {
    const now = evidence.sample();
    // Sampling before any queued work is what makes equality and processed-after lose: a handler that was
    // enqueued while the set was still adoptable must not act on that stale belief.
    if (clock.compare(now, bounds().adoptionDeadline) >= 0) latchTeardown();
    return state === 'accepting-control' ? now : null;
  };

  return Object.freeze({
    state: (): EnforcerDeadlineState => state,
    // One definition of "control is held": round-trip evidence on this enforcer's clock. A socket that is
    // merely still open belongs to a wedged coordinator, and a successor must be able to redeem past it.
    controlIsLive: (): boolean => evidence.isControlLive(evidence.sample()),
    bounds,
    issueFirstChallenge: (challenge: string): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      // A refusal, not a throw: "a first challenge already exists" is a state this machine models, and the
      // endpoint has to be able to answer the caller rather than fail the connection over it.
      if (!evidence.issueFirstChallenge(challenge, now)) return { accepted: false, reason: 'invalid-state' };
      return { accepted: true };
    },
    echoChallenge: (challenge: string, nextChallenge: string): ChallengeEchoResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      return evidence.echoChallenge(now, challenge, nextChallenge, {
        coordinatorIsLive: isCoordinatorLive(),
        expiryCeiling: bounds().adoptionDeadline,
      });
    },
    observeEof: (): void => {
      const now = sampleBeforeQueuedWork();
      if (now !== null) evidence.observeEof(now);
    },
    observePairingLoss: (): void => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return;
      // Earliest wins, matching `observeEof`: a second report of the same loss cannot walk the collapse
      // back out. In practice this is the only report that can ever land — the moment it is recorded,
      // `adoptionDeadline` itself collapses to `now`, so any later call already sees itself latched out by
      // `sampleBeforeQueuedWork` above.
      pairingLossAt = pairingLossAt === null ? now : clock.earlier(pairingLossAt, now);
    },
    dispatchOrdinaryFrame: (_kind: ProviderProxyOrdinaryFrameKind, work: () => void): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (!evidence.isControlLive(now)) return { accepted: false, reason: 'control-lost' };
      work();
      return { accepted: true };
    },
    admitSuccessor: (firstSuccessorChallenge: string): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (evidence.isControlLive(now)) return { accepted: false, reason: 'control-active' };
      // Authorizes, and does not also consume: the credential's one-shot belongs to whoever owns the
      // credential. Installing a challenge before the grant is checked would let a refused replay poison a
      // legitimate successor's retry, while the reverse order costs nothing — the set is torn down anyway.
      evidence.beginSuccessorControl(firstSuccessorChallenge, now);
      return { accepted: true };
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
