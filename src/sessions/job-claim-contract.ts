import type { ContinuitySnapshot } from './continuity.js';
import type { SessionEntry } from './entry.js';

export type SessionJobContinuityCheckpointResult =
  | { ok: true; nextVersion: number }
  | { ok: false };

export interface SessionJobReadPort {
  get(provider: string, sessionId: string): SessionEntry | null;
}

export interface SessionJobClaimPort extends SessionJobReadPort {
  releaseJob(sessionId: string, jobId: string): void;
  checkpointJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      snapshot: ContinuitySnapshot;
    },
  ): Promise<SessionJobContinuityCheckpointResult>;
  releaseJobClaimAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
    },
  ): Promise<boolean>;
}
