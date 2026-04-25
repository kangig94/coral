import type { JobPhase } from './phase.js';
import type { JobKind } from './records.js';

export type ClaimJobOptions = {
  expectedVersion?: number;
  initialPhase?: Extract<JobPhase, 'queued' | 'launching'>;
  jobKind?: JobKind;
};

export class SessionClaimError extends Error {
  constructor() {
    super('Session claim failed');
    this.name = 'SessionClaimError';
  }
}
