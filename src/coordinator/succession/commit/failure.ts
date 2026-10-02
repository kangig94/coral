import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';

export class TransientCommitFailure extends Error {
  readonly retryAfterMs: number;

  readonly obligationChange: boolean;

  constructor(message: string, retryAfterMs = TRANSIENT_RETRY_BASE_MS, obligationChange = false) {
    super(message);
    this.name = 'TransientCommitFailure';
    this.retryAfterMs = retryAfterMs;
    this.obligationChange = obligationChange;
  }
}
