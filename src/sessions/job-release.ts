import type { Database } from '../store/db.js';

import type { Runtime } from '../runtime/ports.js';
import { SessionManager } from './shell.js';
import type { SessionJobClaimReleaseResult } from './contracts.js';
import type { CommitEventsFn } from '../store/append.js';

export type SessionReleasedEmitter = (payload: { sessionId: string; jobId: string }) => void;

/**
 * Sessions-domain port that coordinator services use to release a job claim
 * without reaching into `sessions/shell/`. The wrapper exists for layering:
 * coordinator/services may import from sessions contracts but not from
 * sessions shell implementations.
 */
export function releaseSessionJobClaim(options: {
  projectRoot: string;
  runtime: Runtime;
  db: Database;
  commitEvents: CommitEventsFn;
  emitSessionReleased: SessionReleasedEmitter;
  sessionId: string;
  jobId: string;
}): SessionJobClaimReleaseResult {
  return SessionManager.forProduction(
    options.projectRoot,
    options.runtime,
    options.commitEvents,
    options.emitSessionReleased,
    {
      db: options.db,
    },
  ).releaseJob(options.sessionId, options.jobId);
}

export function describeSessionJobClaimReleaseResult(result: SessionJobClaimReleaseResult): string {
  switch (result) {
    case 'released':
      return 'released';
    case 'already_absent':
      return 'already absent';
    case 'owned_by_another_job':
      return 'owned by another job';
  }
}
