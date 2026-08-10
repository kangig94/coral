import type { MonotonicArithmetic, MonotonicInstant } from '../infra/monotonic-clock.js';

/** How many recently issued challenges are remembered for reuse rejection. */
export const RECENT_CHALLENGE_HISTORY = 64;

export type ControlLeaseEchoResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: 'challenge-expired' | 'challenge-mismatch' | 'control-lost';
    }>;

export type ControlLeaseChallengeKind = 'bootstrap-first' | 'successor-first' | 'recurring';
type ControlLeaseInitialChallengeKind = Exclude<ControlLeaseChallengeKind, 'successor-first'>;

/**
 * What one control tenancy has proven, on the holder's own clock.
 *
 * Round-trip evidence is the whole point: a challenge is one-use and random, so only an echo of *this*
 * process's outstanding challenge shows a peer was alive to receive it. Receipt time proves nothing — a
 * frame can sit in a socket buffer across the death of its sender — but acceptance is the endpoint's local
 * proof that the whole round trip completed, so accepted evidence is recorded at that local instant.
 *
 * This lives apart from any deadline model because two owners of "what counts as evidence" is precisely how
 * evidence ends up recorded in one place and checked in another. The enforcer composes this and adds its
 * teardown deadlines; the proxy uses it alone, holding operational control that bounds nothing.
 */
export class ControlLeaseEvidence<Scope extends symbol> {
  readonly #arithmetic: MonotonicArithmetic<Scope>;
  readonly #leaseMs: number;
  // The window these challenges are evidence for, fixed by whoever composes this lease: the enforcer's is
  // always its own adoption deadline, the proxy's is always null. Declared once at construction rather than
  // threaded through every call, since it never varies within one — a plain closure over that composer-fixed
  // value needs no wrapper type to say so.
  readonly #expiryCeiling: () => MonotonicInstant<Scope> | null;
  // Bounded: the one-use property needs the outstanding challenge plus a rejection of recent reuse, not a
  // record of every challenge ever issued — an unbounded history grows for the life of the process.
  readonly #seenChallenges = new Set<string>();
  #lastRoundTripEvidenceAt: MonotonicInstant<Scope>;
  #eofAt: MonotonicInstant<Scope> | null = null;
  #firstChallengeIssuedAt: MonotonicInstant<Scope> | null = null;
  #pendingChallenge: Readonly<{
    value: string;
    issuedAt: MonotonicInstant<Scope>;
    kind: ControlLeaseChallengeKind;
  }> | null = null;

  constructor(
    arithmetic: MonotonicArithmetic<Scope>,
    leaseMs: number,
    startedAt: MonotonicInstant<Scope>,
    expiryCeiling: () => MonotonicInstant<Scope> | null,
  ) {
    this.#arithmetic = arithmetic;
    this.#leaseMs = leaseMs;
    this.#expiryCeiling = expiryCeiling;
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

  /** When control ends absent further evidence: the lease running out, or an observed EOF, whichever is first. */
  controlLossAt(): MonotonicInstant<Scope> {
    const leaseLossAt = this.#arithmetic.shiftMilliseconds(this.#lastRoundTripEvidenceAt, this.#leaseMs);
    return this.#eofAt === null ? leaseLossAt : this.#arithmetic.earlier(this.#eofAt, leaseLossAt);
  }

  isControlLive(now: MonotonicInstant<Scope>): boolean {
    return this.#arithmetic.compare(now, this.controlLossAt()) < 0;
  }

  /** False when a first challenge already exists. A second tenancy is a successor, not a first. */
  issueFirstChallenge(
    challenge: string,
    issuedAt: MonotonicInstant<Scope>,
    kind: ControlLeaseInitialChallengeKind,
  ): boolean {
    if (this.#firstChallengeIssuedAt !== null || this.#pendingChallenge !== null) return false;
    this.#installChallenge(challenge, issuedAt, kind);
    this.#firstChallengeIssuedAt = issuedAt;
    return true;
  }

  /**
   * Installs the first challenge of a successor's tenancy. Its echo is allowed after the predecessor's
   * control loss — that loss is the precondition for the successor existing at all.
   */
  beginSuccessorControl(challenge: string, issuedAt: MonotonicInstant<Scope>): void {
    this.#installChallenge(challenge, issuedAt, 'successor-first');
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
    // No separate "is a coordinator there" gate: this call is only ever reached over a socket already bound
    // to an open tenancy, and opening one already proved a live process was on the other end. The comparison
    // below is that proof's actual instrument — a stale liveness flag would only restate it less reliably.
    if (this.#pendingChallenge === null || this.#pendingChallenge.value !== challenge) {
      return { accepted: false, reason: 'challenge-mismatch' };
    }
    if (this.#pendingChallenge.kind === 'recurring' && !this.isControlLive(now)) {
      return { accepted: false, reason: 'control-lost' };
    }
    if (this.#arithmetic.compare(now, this.#challengeExpiresAt(this.#pendingChallenge.issuedAt)) >= 0) {
      return { accepted: false, reason: 'challenge-expired' };
    }

    this.#installChallenge(nextChallenge, now, 'recurring');
    this.#lastRoundTripEvidenceAt = now;
    return { accepted: true };
  }

  /** When the outstanding challenge stops being answerable, given the composer's expiry ceiling. */
  challengeExpiresAt(): MonotonicInstant<Scope> | null {
    return this.#firstChallengeIssuedAt === null ? null : this.#challengeExpiresAt(this.#firstChallengeIssuedAt);
  }

  #challengeExpiresAt(issuedAt: MonotonicInstant<Scope>): MonotonicInstant<Scope> {
    const leaseExpiry = this.#arithmetic.shiftMilliseconds(issuedAt, this.#leaseMs);
    const ceiling = this.#expiryCeiling();
    return ceiling === null ? leaseExpiry : this.#arithmetic.earlier(leaseExpiry, ceiling);
  }

  #installChallenge(challenge: string, issuedAt: MonotonicInstant<Scope>, kind: ControlLeaseChallengeKind): void {
    if (challenge.length === 0 || this.#seenChallenges.has(challenge)) {
      throw new Error('A heartbeat challenge must be non-empty and one-use.');
    }
    this.#seenChallenges.add(challenge);
    if (this.#seenChallenges.size > RECENT_CHALLENGE_HISTORY) {
      const oldest = this.#seenChallenges.values().next();
      if (!oldest.done) this.#seenChallenges.delete(oldest.value);
    }
    this.#pendingChallenge = Object.freeze({ value: challenge, issuedAt, kind });
  }

  #carriedByLiveConnection(): void {
    this.#eofAt = null;
  }
}
