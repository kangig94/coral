import type { Database } from 'better-sqlite3';

import type { Runtime } from '../runtime/ports.js';
import { SessionManager } from './shell/store.js';

export type SessionReleasedEmitter = (payload: { sessionId: string; jobId: string }) => void;

export function releaseSessionJobClaim(options: {
  projectRoot: string;
  runtime: Runtime;
  db: Database;
  emitSessionReleased: SessionReleasedEmitter;
  sessionId: string;
  jobId: string;
}): void {
  SessionManager.forProduction(options.projectRoot, options.runtime, undefined, options.emitSessionReleased, {
    db: options.db,
  }).releaseJob(options.sessionId, options.jobId);
}
