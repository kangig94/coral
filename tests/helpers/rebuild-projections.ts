import { withImmediate, type Database } from '../../src/store/db.js';

import { decodeStoredBody } from '#src/store/body-codec.js';
import { type ComposedReducers, applyReducer } from '#src/store/reducers.js';
import { rowToCoralEvent } from '#src/store/envelope.js';
import type { EventBodyCodec } from '#src/store/event-body-codec.js';
import type { EventsRow } from '#src/store/schema.js';

export interface RebuildOptions {
  readonly db: Database;
  readonly cutoffSeq: number;
  readonly reducers: ComposedReducers;
  readonly bodyCodec: EventBodyCodec;
  readonly extraProjectionTables?: readonly string[];
  readonly batchSize?: number; // default 1000
}

const JOURNAL_PROJECTION_TABLES = [
  'projection_jobs',
  'projection_sessions',
  'projection_discuss',
  'projection_workflows',
] as const;

export function rebuildProjections(opts: RebuildOptions): void {
  const tables = [...JOURNAL_PROJECTION_TABLES, ...(opts.extraProjectionTables ?? [])];
  const batchSize = opts.batchSize ?? 1000;
  const readCtx = {
    schemas: opts.reducers.schemas,
    streamKinds: opts.reducers.streamKinds,
    bodyCodec: opts.bodyCodec,
  };

  withImmediate(opts.db, () => {
    for (const table of tables) {
      opts.db.exec(`DELETE FROM ${table}`);
    }

    const rowsStmt = opts.db.prepare<[number, number, number], EventsRow>(
      `SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
    );
    let afterSeq = 0;

    while (afterSeq < opts.cutoffSeq) {
      const rows = rowsStmt.all(afterSeq, opts.cutoffSeq, batchSize);
      if (rows.length === 0) break;

      for (const row of rows) {
        const parsedBody = decodeStoredBody(row, readCtx);
        applyReducer(opts.db, rowToCoralEvent(row, parsedBody), opts.reducers);
      }

      afterSeq = rows[rows.length - 1].seq;
    }
  });
}
