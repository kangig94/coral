import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';

/** How many recently issued challenges are remembered for reuse rejection. */
const RECENT_CHALLENGE_HISTORY = 64;

export type ControlLeaseEchoResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'challenge-expired' | 'challenge-mismatch' | 'control-lost' | 'coordinator-not-live';
    }>;

export type ControlLeaseEchoOptions<Scope extends symbol> = Readonly<{
  /** Whether a coordinator is there to have sent this echo. A false makes the echo prove nothing. */
  coordinatorIsLive: boolean;
  /**
   * An upper bound on how long an outstanding challenge may stay answerable, beyond the lease. The enforcer
   * clamps to its adoption deadline so a challenge cannot outlive the window it is evidence for; operational
   * control has no such window and passes null.
   */
  expiryCeiling: MonotonicInstant<Scope> | null;
}>;

/**
 * What one control connection has proven, on the holder's own clock.
 *
 * Round-trip evidence is the whole point: a challenge is one-use and random, so only an echo of *this*
 * process's outstanding challenge shows a peer was alive to receive it. Receipt time proves nothing — a
 * frame can sit in a socket buffer across the death of its sender — and the recorded instant is therefore
 * the moment the challenge was *issued*, never the moment its echo arrived.
 *
 * This lives apart from any deadline model because two owners of "what counts as evidence" is precisely how
 * evidence ends up recorded in one place and checked in another. The enforcer composes this and adds its
 * teardown deadlines; the proxy uses it alone, holding operational control that bounds nothing.
 */
export class ControlLeaseEvidence<Scope extends symbol> {
  readonly #clock: MonotonicClock<Scope>;
  readonly #leaseMs: number;
  // Bounded: the one-use property needs the outstanding challenge plus a rejection of recent reuse, not a
  // record of every challenge ever issued — an unbounded history grows for the life of the process.
  readonly #seenChallenges = new Set<string>();
  #lastRoundTripEvidenceAt: MonotonicInstant<Scope>;
  #eofAt: MonotonicInstant<Scope> | null = null;
  #firstChallengeIssuedAt: MonotonicInstant<Scope> | null = null;
  #pendingChallenge: Readonly<{
    value: string;
    issuedAt: MonotonicInstant<Scope>;
    allowAfterControlLoss: boolean;
  }> | null = null;

  constructor(clock: MonotonicClock<Scope>, leaseMs: number) {
    this.#clock = clock;
    this.#leaseMs = leaseMs;
    // Before any round trip, the holder's own start is the evidence. A set whose coordinator never arrives is
    // still bounded, rather than waiting forever for a first echo that will not come.
    this.#lastRoundTripEvidenceAt = clock.now();
  }

  sample(): MonotonicInstant<Scope> {
    return this.#clock.now();
  }

  lastRoundTripEvidenceAt(): MonotonicInstant<Scope> {
    return this.#lastRoundTripEvidenceAt;
  }

  eofAt(): MonotonicInstant<Scope> | null {
    return this.#eofAt;
  }

  firstChallengeIssuedAt(): MonotonicInstant<Scope> | null {
    return this.#firstChallengeIssuedAt;
  }

  /** When control ends absent further evidence: the lease running out, or an observed EOF, whichever is first. */
  controlLossAt(): MonotonicInstant<Scope> {
    const leaseLossAt = this.#clock.shiftMilliseconds(this.#lastRoundTripEvidenceAt, this.#leaseMs);
    return this.#eofAt === null ? leaseLossAt : this.#clock.earlier(this.#eofAt, leaseLossAt);
  }

  isControlLive(now: MonotonicInstant<Scope>): boolean {
    return this.#clock.compare(now, this.controlLossAt()) < 0;
  }

  /** False when a first challenge already exists. A second tenancy is a successor, not a first. */
  issueFirstChallenge(challenge: string, issuedAt: MonotonicInstant<Scope>): boolean {
    if (this.#firstChallengeIssuedAt !== null || this.#pendingChallenge !== null) return false;
    this.#installChallenge(challenge, issuedAt, false);
    this.#firstChallengeIssuedAt = issuedAt;
    return true;
  }

  /**
   * Installs the first challenge of a successor's tenancy. Its echo is allowed after the predecessor's
   * control loss — that loss is the precondition for the successor existing at all — and the observed EOF
   * is cleared, because it belonged to a connection that is gone.
   */
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
    options: ControlLeaseEchoOptions<Scope>,
  ): ControlLeaseEchoResult {
    if (!options.coordinatorIsLive) return { accepted: false, reason: 'coordinator-not-live' };
    if (this.#pendingChallenge === null || this.#pendingChallenge.value !== challenge) {
      return { accepted: false, reason: 'challenge-mismatch' };
    }
    if (!this.#pendingChallenge.allowAfterControlLoss && !this.isControlLive(now)) {
      return { accepted: false, reason: 'control-lost' };
    }
    if (this.#clock.compare(now, this.#challengeExpiresAt(this.#pendingChallenge.issuedAt, options)) >= 0) {
      return { accepted: false, reason: 'challenge-expired' };
    }

    // The issuance instant, not now: the peer had to receive the challenge before echoing it, so issuance is
    // the latest moment it is known to have been alive — and it is known even if the echo is dequeued later.
    const evidenceAt = this.#pendingChallenge.issuedAt;
    this.#installChallenge(nextChallenge, now, false);
    this.#lastRoundTripEvidenceAt = evidenceAt;
    return { accepted: true };
  }

  /** When the outstanding challenge stops being answerable, given the caller's ceiling. */
  challengeExpiresAt(options: ControlLeaseEchoOptions<Scope>): MonotonicInstant<Scope> | null {
    return this.#firstChallengeIssuedAt === null
      ? null
      : this.#challengeExpiresAt(this.#firstChallengeIssuedAt, options);
  }

  #challengeExpiresAt(
    issuedAt: MonotonicInstant<Scope>,
    options: ControlLeaseEchoOptions<Scope>,
  ): MonotonicInstant<Scope> {
    const leaseExpiry = this.#clock.shiftMilliseconds(issuedAt, this.#leaseMs);
    return options.expiryCeiling === null ? leaseExpiry : this.#clock.earlier(leaseExpiry, options.expiryCeiling);
  }

  #installChallenge(challenge: string, issuedAt: MonotonicInstant<Scope>, allowAfterControlLoss: boolean): void {
    if (challenge.length === 0 || this.#seenChallenges.has(challenge)) {
      throw new Error('A heartbeat challenge must be non-empty and one-use.');
    }
    this.#seenChallenges.add(challenge);
    if (this.#seenChallenges.size > RECENT_CHALLENGE_HISTORY) {
      const oldest = this.#seenChallenges.values().next();
      if (!oldest.done) this.#seenChallenges.delete(oldest.value);
    }
    this.#pendingChallenge = Object.freeze({ value: challenge, issuedAt, allowAfterControlLoss });
  }
}
