import type { Database } from 'better-sqlite3';

import type { CoralEvent } from './envelope.js';
import type { EventsFilter, EventsPage } from './queries/events.js';
import { getEvent, getEventsSince } from './queries/events.js';
import { loadJobProjectionDetail, readJobProgress } from './queries/jobs.js';

export class CoralStore {
  constructor(private readonly db: Database) {}

  getEvent(stream: { kind: string; id: string }, seq: number): CoralEvent | undefined {
    return getEvent(this.db, stream, seq);
  }

  getEventsSince(afterSeq: number, filter?: EventsFilter, limit?: number): EventsPage {
    return getEventsSince(this.db, afterSeq, filter, limit);
  }

  loadJobProjectionDetail(jobId: string) {
    return loadJobProjectionDetail(this.db, jobId);
  }

  readJobProgress(jobId: string) {
    return readJobProgress(this.db, jobId);
  }
}
