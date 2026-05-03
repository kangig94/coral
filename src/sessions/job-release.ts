import type { Database } from '../store/db.js';

import type { Runtime } from '../runtime/ports.js';
import { SessionManager } from './shell.js';
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
}): void {
  SessionManager.forProduction(options.projectRoot, options.runtime, options.commitEvents, options.emitSessionReleased, {
    db: options.db,
  }).releaseJob(options.sessionId, options.jobId);
}
