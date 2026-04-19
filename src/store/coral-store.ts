import type { Database } from 'better-sqlite3';

import type { StoreReadContext } from './body-codec.js';
import type { CoralEvent } from './envelope.js';
import type { EventsFilter, EventsPage } from './queries/events.js';
import { getEvent, getEventsSince } from './queries/events.js';
import { loadJobProjectionDetail, readJobProgress } from './queries/jobs.js';

export class CoralStore implements StoreReadContext {
  public readonly schemas: StoreReadContext['schemas'];
  public readonly upcasters: StoreReadContext['upcasters'];

  constructor(
    private readonly db: Database,
    readCtx: StoreReadContext,
  ) {
    this.schemas = readCtx.schemas;
    this.upcasters = readCtx.upcasters;
  }

  getEvent(stream: { kind: string; id: string }, seq: number): CoralEvent | undefined {
    return getEvent(this.db, stream, seq, this);
  }

  getEventsSince(afterSeq: number, filter?: EventsFilter, limit?: number): EventsPage {
    return getEventsSince(this.db, afterSeq, filter, limit, this);
  }

  loadJobProjectionDetail(jobId: string) {
    return loadJobProjectionDetail(this.db, jobId, this);
  }

  readJobProgress(jobId: string) {
    return readJobProgress(this.db, jobId, this);
  }
}
