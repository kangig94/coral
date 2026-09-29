import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';

/** A failure of one attempt's timing or contention, which a later attempt at the same target may overcome. */
export class TransientCommitFailure extends Error {
  readonly retryAfterMs: number;
  /** An obligation change outdated the attempt, which says nothing about its target. */
  readonly obligationChange: boolean;

  constructor(message: string, retryAfterMs = TRANSIENT_RETRY_BASE_MS, obligationChange = false) {
    super(message);
    this.name = 'TransientCommitFailure';
    this.retryAfterMs = retryAfterMs;
    this.obligationChange = obligationChange;
  }
}
