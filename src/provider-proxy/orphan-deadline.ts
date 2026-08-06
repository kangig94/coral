import { z } from 'zod';

import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
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

export type GuardianDeadlineState = 'accepting-control' | 'teardown-latched' | 'containment-absent' | 'exited';
export type ReaperDeadlineState = 'armed' | 'successor-rotated' | 'teardown-latched' | 'containment-absent' | 'exited';

export type DeadlineDispatchResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'control-active' | 'control-lost' | 'invalid-state' | 'teardown-latched';
    }>;

export type ChallengeEchoResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'challenge-expired' | 'challenge-mismatch' | 'control-lost' | 'coordinator-not-live' | 'teardown-latched';
    }>;

export type ProviderProxyOrdinaryFrameKind = 'proxy-heartbeat' | 'authenticated-frame';

export type GuardianDeadlineStateMachine<Scope extends symbol> = Readonly<{
  state(): GuardianDeadlineState;
  bounds(): ProviderProxyEnforcerBounds<Scope>;
  issueFirstChallenge(challenge: string): DeadlineDispatchResult;
  echoChallenge(challenge: string, nextChallenge: string): ChallengeEchoResult;
  observeEof(): void;
  dispatchOrdinaryFrame(kind: ProviderProxyOrdinaryFrameKind, work: () => void): DeadlineDispatchResult;
  redeemSuccessor(firstSuccessorChallenge: string, work: () => void): DeadlineDispatchResult;
  latchTeardown(): void;
  markContainmentAbsent(): void;
  markExited(): void;
}>;

export type ReaperDeadlineStateMachine<Scope extends symbol> = Readonly<{
  state(): ReaperDeadlineState;
  bounds(): ProviderProxyEnforcerBounds<Scope>;
  issueFirstChallenge(challenge: string): DeadlineDispatchResult;
  echoChallenge(challenge: string, nextChallenge: string): ChallengeEchoResult;
  observeEof(): void;
  dispatchOrdinaryFrame(kind: ProviderProxyOrdinaryFrameKind, work: () => void): DeadlineDispatchResult;
  rotateSuccessor(firstSuccessorChallenge: string, work: () => void): DeadlineDispatchResult;
  latchTeardown(): void;
  markContainmentAbsent(): void;
  markExited(): void;
}>;

type PendingChallenge<Scope extends symbol> = Readonly<{
  value: string;
  issuedAt: MonotonicInstant<Scope>;
  allowAfterControlLoss: boolean;
}>;

class EnforcerDeadlineEvidence<Scope extends symbol> {
  readonly #clock: MonotonicClock<Scope>;
  readonly #configuration: ProviderProxyDeadlineConfiguration;
  readonly #seenChallenges = new Set<string>();
  #lastRoundTripEvidenceAt: MonotonicInstant<Scope>;
  #eofAt: MonotonicInstant<Scope> | null = null;
  #firstChallengeIssuedAt: MonotonicInstant<Scope> | null = null;
  #pendingChallenge: PendingChallenge<Scope> | null = null;

  constructor(clock: MonotonicClock<Scope>, configuration: ProviderProxyDeadlineConfiguration) {
    if (configuration[providerProxyDeadlineConfigurationBrand] !== true) {
      throw new Error('Provider proxy deadline configuration must be validated before use.');
    }
    this.#clock = clock;
    this.#configuration = configuration;
    this.#lastRoundTripEvidenceAt = clock.now();
  }

  sample(): MonotonicInstant<Scope> {
    return this.#clock.now();
  }

  bounds(): ProviderProxyEnforcerBounds<Scope> {
    const leaseLossAt = this.#clock.shiftMilliseconds(this.#lastRoundTripEvidenceAt, this.#configuration.leaseMs);
    const controlLossAt = this.#eofAt === null ? leaseLossAt : this.#clock.earlier(this.#eofAt, leaseLossAt);
    const exitDeadline = this.#clock.shiftMilliseconds(
      this.#lastRoundTripEvidenceAt,
      this.#configuration.orphanTimeoutMs,
    );
    const adoptionDeadline = this.#clock.shiftMilliseconds(exitDeadline, -this.#configuration.teardownReserveMs);
    const firstChallengeExpiresAt =
      this.#firstChallengeIssuedAt === null
        ? null
        : this.#clock.earlier(
            this.#clock.shiftMilliseconds(this.#firstChallengeIssuedAt, this.#configuration.leaseMs),
            adoptionDeadline,
          );

    return Object.freeze({
      lastRoundTripEvidenceAt: this.#lastRoundTripEvidenceAt,
      eofAt: this.#eofAt,
      controlLossAt,
      exitDeadline,
      adoptionDeadline,
      firstChallengeExpiresAt,
    });
  }

  isAtOrAfterAdoptionDeadline(now: MonotonicInstant<Scope>): boolean {
    return this.#clock.compare(now, this.bounds().adoptionDeadline) >= 0;
  }

  isControlLive(now: MonotonicInstant<Scope>): boolean {
    return this.#clock.compare(now, this.bounds().controlLossAt) < 0;
  }

  issueFirstChallenge(challenge: string, issuedAt: MonotonicInstant<Scope>): void {
    if (this.#firstChallengeIssuedAt !== null || this.#pendingChallenge !== null) {
      throw new Error('The first control challenge has already been issued.');
    }
    this.#installChallenge(challenge, issuedAt, false);
    this.#firstChallengeIssuedAt = issuedAt;
  }

  beginSuccessorControl(challenge: string, issuedAt: MonotonicInstant<Scope>): void {
    this.#installChallenge(challenge, issuedAt, true);
    this.#firstChallengeIssuedAt = issuedAt;
    this.#eofAt = null;
  }

  observeEof(observedAt: MonotonicInstant<Scope>): void {
    this.#eofAt = this.#eofAt === null ? observedAt : this.#clock.earlier(this.#eofAt, observedAt);
  }

  echoChallenge(
    now: MonotonicInstant<Scope>,
    challenge: string,
    nextChallenge: string,
    coordinatorIsLive: boolean,
  ): ChallengeEchoResult {
    if (!coordinatorIsLive) return { accepted: false, reason: 'coordinator-not-live' };
    if (this.#pendingChallenge === null || this.#pendingChallenge.value !== challenge) {
      return { accepted: false, reason: 'challenge-mismatch' };
    }
    // Redemption necessarily follows old-control loss, so its provisional first
    // challenge is bounded by its own expiry and the unchanged adoption deadline.
    if (!this.#pendingChallenge.allowAfterControlLoss && !this.isControlLive(now)) {
      return { accepted: false, reason: 'control-lost' };
    }

    const challengeExpiresAt = this.#clock.earlier(
      this.#clock.shiftMilliseconds(this.#pendingChallenge.issuedAt, this.#configuration.leaseMs),
      this.bounds().adoptionDeadline,
    );
    if (this.#clock.compare(now, challengeExpiresAt) >= 0) {
      return { accepted: false, reason: 'challenge-expired' };
    }

    const evidenceAt = this.#pendingChallenge.issuedAt;
    this.#installChallenge(nextChallenge, now, false);
    this.#lastRoundTripEvidenceAt = evidenceAt;
    return { accepted: true };
  }

  #installChallenge(challenge: string, issuedAt: MonotonicInstant<Scope>, allowAfterControlLoss: boolean): void {
    if (challenge.length === 0 || this.#seenChallenges.has(challenge)) {
      throw new Error('A heartbeat challenge must be non-empty and one-use.');
    }
    this.#seenChallenges.add(challenge);
    this.#pendingChallenge = Object.freeze({ value: challenge, issuedAt, allowAfterControlLoss });
  }
}

function assertContainmentAbsentTransition(state: GuardianDeadlineState | ReaperDeadlineState): void {
  if (state !== 'teardown-latched') {
    throw new Error('Containment can be marked absent only after teardown is latched.');
  }
}

function assertExitedTransition(state: GuardianDeadlineState | ReaperDeadlineState): void {
  if (state !== 'containment-absent') {
    throw new Error('The enforcer can exit only after containment absence is confirmed.');
  }
}

export function createGuardianDeadlineStateMachine<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  configuration: ProviderProxyDeadlineConfiguration,
  isCoordinatorLive: () => boolean,
): GuardianDeadlineStateMachine<Scope> {
  const evidence = new EnforcerDeadlineEvidence(clock, configuration);
  let state: GuardianDeadlineState = 'accepting-control';
  let successorRedeemed = false;

  const latchTeardown = (): void => {
    if (state === 'accepting-control') state = 'teardown-latched';
  };
  const sampleBeforeQueuedWork = (): MonotonicInstant<Scope> | null => {
    const now = evidence.sample();
    if (evidence.isAtOrAfterAdoptionDeadline(now)) latchTeardown();
    return state === 'accepting-control' ? now : null;
  };

  return Object.freeze({
    state: (): GuardianDeadlineState => state,
    bounds: (): ProviderProxyEnforcerBounds<Scope> => evidence.bounds(),
    issueFirstChallenge: (challenge: string): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      evidence.issueFirstChallenge(challenge, now);
      return { accepted: true };
    },
    echoChallenge: (challenge: string, nextChallenge: string): ChallengeEchoResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      return evidence.echoChallenge(now, challenge, nextChallenge, isCoordinatorLive());
    },
    observeEof: (): void => {
      const now = sampleBeforeQueuedWork();
      if (now !== null) evidence.observeEof(now);
    },
    dispatchOrdinaryFrame: (_kind: ProviderProxyOrdinaryFrameKind, work: () => void): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (!evidence.isControlLive(now)) return { accepted: false, reason: 'control-lost' };
      work();
      return { accepted: true };
    },
    redeemSuccessor: (firstSuccessorChallenge: string, work: () => void): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (successorRedeemed) return { accepted: false, reason: 'invalid-state' };
      if (evidence.isControlLive(now)) return { accepted: false, reason: 'control-active' };
      evidence.beginSuccessorControl(firstSuccessorChallenge, now);
      successorRedeemed = true;
      work();
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

export function createReaperDeadlineStateMachine<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  configuration: ProviderProxyDeadlineConfiguration,
  isCoordinatorLive: () => boolean,
): ReaperDeadlineStateMachine<Scope> {
  const evidence = new EnforcerDeadlineEvidence(clock, configuration);
  let state: ReaperDeadlineState = 'armed';

  const latchTeardown = (): void => {
    if (state === 'armed' || state === 'successor-rotated') state = 'teardown-latched';
  };
  const sampleBeforeQueuedWork = (): MonotonicInstant<Scope> | null => {
    const now = evidence.sample();
    if (evidence.isAtOrAfterAdoptionDeadline(now)) latchTeardown();
    return state === 'armed' || state === 'successor-rotated' ? now : null;
  };

  return Object.freeze({
    state: (): ReaperDeadlineState => state,
    bounds: (): ProviderProxyEnforcerBounds<Scope> => evidence.bounds(),
    issueFirstChallenge: (challenge: string): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      evidence.issueFirstChallenge(challenge, now);
      return { accepted: true };
    },
    echoChallenge: (challenge: string, nextChallenge: string): ChallengeEchoResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      return evidence.echoChallenge(now, challenge, nextChallenge, isCoordinatorLive());
    },
    observeEof: (): void => {
      const now = sampleBeforeQueuedWork();
      if (now !== null) evidence.observeEof(now);
    },
    dispatchOrdinaryFrame: (_kind: ProviderProxyOrdinaryFrameKind, work: () => void): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (!evidence.isControlLive(now)) return { accepted: false, reason: 'control-lost' };
      work();
      return { accepted: true };
    },
    rotateSuccessor: (firstSuccessorChallenge: string, work: () => void): DeadlineDispatchResult => {
      const now = sampleBeforeQueuedWork();
      if (now === null) return { accepted: false, reason: 'teardown-latched' };
      if (state !== 'armed') return { accepted: false, reason: 'invalid-state' };
      evidence.beginSuccessorControl(firstSuccessorChallenge, now);
      state = 'successor-rotated';
      work();
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
