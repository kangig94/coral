import type { MonotonicArithmetic, MonotonicInstant } from '../infra/monotonic-clock.js';

/** How many recently issued challenges are remembered for reuse rejection. */
export const RECENT_CHALLENGE_HISTORY = 64;

export type ControlLeaseEchoResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'challenge-expired' | 'challenge-mismatch' | 'control-lost' | 'coordinator-not-live';
    }>;

/**
 * What the holder's own composer knows about this lease that the lease itself must not read off any
 * shared clock. Declared once at construction, not threaded through every call: the enforcer's ceiling is
 * always its own adoption deadline and the proxy's is always null, and `coordinatorIsLive` never varied
 * within a call anyway — both were being restated at every call site for a value fixed by who is composing.
 */
export type ControlLeasePolicy<Scope extends symbol> = Readonly<{
  /** The window these challenges are evidence for. Operational control bounds no window and answers null. */
  expiryCeiling(): MonotonicInstant<Scope> | null;
  /** Whether a coordinator is there to have sent an echo. A false makes any echo prove nothing. */
  coordinatorIsLive(): boolean;
}>;

/**
 * What one control tenancy has proven, on the holder's own clock.
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
  readonly #arithmetic: MonotonicArithmetic<Scope>;
  readonly #leaseMs: number;
  readonly #policy: ControlLeasePolicy<Scope>;
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

  constructor(
    arithmetic: MonotonicArithmetic<Scope>,
    leaseMs: number,
    startedAt: MonotonicInstant<Scope>,
    policy: ControlLeasePolicy<Scope>,
  ) {
    this.#arithmetic = arithmetic;
    this.#leaseMs = leaseMs;
    this.#policy = policy;
    // Before any round trip, the holder's own start is the evidence. A set whose coordinator never arrives is
    // still bounded, rather than waiting forever for a first echo that will not come.
    this.#lastRoundTripEvidenceAt = startedAt;
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
    const leaseLossAt = this.#arithmetic.shiftMilliseconds(this.#lastRoundTripEvidenceAt, this.#leaseMs);
    return this.#eofAt === null ? leaseLossAt : this.#arithmetic.earlier(this.#eofAt, leaseLossAt);
  }

  isControlLive(now: MonotonicInstant<Scope>): boolean {
    return this.#arithmetic.compare(now, this.controlLossAt()) < 0;
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
   * control loss — that loss is the precondition for the successor existing at all.
   */
  beginSuccessorControl(challenge: string, issuedAt: MonotonicInstant<Scope>): void {
    this.#installChallenge(challenge, issuedAt, true);
    this.#firstChallengeIssuedAt = issuedAt;
    this.#carriedByLiveConnection();
  }

  /**
   * A live connection carries an already-granted tenancy again: no new challenge is installed — the one
   * already outstanding stays answerable — but any EOF observed by a connection this reconnection has
   * already superseded is not evidence about the tenancy a live connection now carries.
   */
  reattachControl(): void {
    this.#carriedByLiveConnection();
  }

  observeEof(observedAt: MonotonicInstant<Scope>): void {
    this.#eofAt = this.#eofAt === null ? observedAt : this.#arithmetic.earlier(this.#eofAt, observedAt);
  }

  echoChallenge(now: MonotonicInstant<Scope>, challenge: string, nextChallenge: string): ControlLeaseEchoResult {
    if (!this.#policy.coordinatorIsLive()) return { accepted: false, reason: 'coordinator-not-live' };
    if (this.#pendingChallenge === null || this.#pendingChallenge.value !== challenge) {
      return { accepted: false, reason: 'challenge-mismatch' };
    }
    if (!this.#pendingChallenge.allowAfterControlLoss && !this.isControlLive(now)) {
      return { accepted: false, reason: 'control-lost' };
    }
    if (this.#arithmetic.compare(now, this.#challengeExpiresAt(this.#pendingChallenge.issuedAt)) >= 0) {
      return { accepted: false, reason: 'challenge-expired' };
    }

    // The issuance instant, not now: the peer had to receive the challenge before echoing it, so issuance is
    // the latest moment it is known to have been alive — and it is known even if the echo is dequeued later.
    const evidenceAt = this.#pendingChallenge.issuedAt;
    this.#installChallenge(nextChallenge, now, false);
    this.#lastRoundTripEvidenceAt = evidenceAt;
    return { accepted: true };
  }

  /** When the outstanding challenge stops being answerable, given the policy's ceiling. */
  challengeExpiresAt(): MonotonicInstant<Scope> | null {
    return this.#firstChallengeIssuedAt === null ? null : this.#challengeExpiresAt(this.#firstChallengeIssuedAt);
  }

  #challengeExpiresAt(issuedAt: MonotonicInstant<Scope>): MonotonicInstant<Scope> {
    const leaseExpiry = this.#arithmetic.shiftMilliseconds(issuedAt, this.#leaseMs);
    const ceiling = this.#policy.expiryCeiling();
    return ceiling === null ? leaseExpiry : this.#arithmetic.earlier(leaseExpiry, ceiling);
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

  #carriedByLiveConnection(): void {
    this.#eofAt = null;
  }
}
