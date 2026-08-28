import type { MonotonicArithmetic, MonotonicInstant } from '../infra/monotonic-clock.js';

/** How many recently issued challenges are remembered for reuse rejection. */
export const RECENT_CHALLENGE_HISTORY = 64;

export type ControlLeaseEchoResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'challenge-mismatch';
      nextChallenge: string;
    }>;

/**
 * What one control tenancy has proven on this grantor's local monotonic clock.
 *
 * Round-trip evidence is the whole point: a challenge is one-use and random, so only an echo of *this*
 * process's outstanding challenge shows a peer was alive to receive it. Receipt time proves nothing — a
 * frame can sit in a socket buffer across the death of its sender — but acceptance is the endpoint's local
 * proof that the whole round trip completed, so accepted evidence is recorded at that local instant.
 * Deadline expiry is not evidence and cannot reject a matching echo. It only licenses successor admission
 * or enforcer teardown; the tenancy ends when one of those authorities acts, or when EOF is observed.
 *
 * This lives apart from any deadline model because two owners of "what counts as evidence" is precisely how
 * evidence ends up recorded in one place and checked in another. The enforcer composes this and adds its
 * teardown deadlines; the proxy uses it alone, holding operational control that bounds nothing.
 */
export class ControlLeaseEvidence<Scope extends symbol> {
  readonly #arithmetic: MonotonicArithmetic<Scope>;
  readonly #leaseMs: number;
  // Bounded: the one-use property needs the outstanding challenge plus a rejection of recent reuse, not a
  // record of every challenge ever issued — an unbounded history grows for the life of the process.
  readonly #seenChallenges = new Set<string>();
  #lastRoundTripEvidenceAt: MonotonicInstant<Scope>;
  #eofAt: MonotonicInstant<Scope> | null = null;
  #pendingChallenge: string | null = null;

  constructor(arithmetic: MonotonicArithmetic<Scope>, leaseMs: number, startedAt: MonotonicInstant<Scope>) {
    this.#arithmetic = arithmetic;
    this.#leaseMs = leaseMs;
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

  controlLossAt(): MonotonicInstant<Scope> {
    const leaseLossAt = this.#arithmetic.shiftMilliseconds(this.#lastRoundTripEvidenceAt, this.#leaseMs);
    return this.#eofAt === null ? leaseLossAt : this.#arithmetic.earlier(this.#eofAt, leaseLossAt);
  }

  isControlLive(now: MonotonicInstant<Scope>): boolean {
    return this.#arithmetic.compare(now, this.controlLossAt()) < 0;
  }

  /** False when a first challenge already exists. A second tenancy is a successor, not a first. */
  issueFirstChallenge(challenge: string): boolean {
    if (this.#pendingChallenge !== null) return false;
    this.#installChallenge(challenge);
    return true;
  }

  /**
   * Installs the first challenge of a successor's tenancy. Its echo is allowed after the predecessor's
   * live-evidence lapse — that lapse was the precondition for the admission act.
   */
  beginSuccessorControl(challenge: string): void {
    this.#installChallenge(challenge);
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
    if (this.#pendingChallenge !== challenge) {
      this.#installChallenge(nextChallenge);
      return { accepted: false, reason: 'challenge-mismatch', nextChallenge };
    }

    this.#installChallenge(nextChallenge);
    this.#lastRoundTripEvidenceAt = now;
    return { accepted: true };
  }

  #installChallenge(challenge: string): void {
    if (challenge.length === 0 || this.#seenChallenges.has(challenge)) {
      throw new Error('A heartbeat challenge must be non-empty and one-use.');
    }
    this.#seenChallenges.add(challenge);
    if (this.#seenChallenges.size > RECENT_CHALLENGE_HISTORY) {
      const oldest = this.#seenChallenges.values().next();
      if (!oldest.done) this.#seenChallenges.delete(oldest.value);
    }
    this.#pendingChallenge = challenge;
  }

  #carriedByLiveConnection(): void {
    this.#eofAt = null;
  }
}
