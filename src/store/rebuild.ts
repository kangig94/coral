import type BetterSqlite3 from 'better-sqlite3';

import type { ComposedReducers } from './reducers.js';
import { applyReducer } from './reducers.js';
import type { UpcasterRegistry } from './envelope.js';

type Database = BetterSqlite3.Database;
type EventRow = {
  seq: number;
  ts: string;
  type: string;
  stream_kind: string;
  stream_id: string;
  namespace: string | null;
  project: string | null;
  correlation_id: string | null;
  causation_seq: number | null;
  refs: string | null;
  body_version: number;
  body: Uint8Array | Buffer;
};

export interface RebuildOptions {
  readonly db: Database;
  readonly cutoffSeq: number;
  readonly reducers: ComposedReducers;
  readonly upcasters: UpcasterRegistry;
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

  const txn = opts.db.transaction(() => {
    for (const table of tables) {
      opts.db.exec(`DELETE FROM ${table}`);
    }

    const rowsStmt = opts.db.prepare<[number, number, number], EventRow>(
      `SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
    );
    let afterSeq = 0;

    while (afterSeq < opts.cutoffSeq) {
      const rows = rowsStmt.all(afterSeq, opts.cutoffSeq, batchSize);
      if (rows.length === 0) break;

      for (const row of rows) {
        const rawBody = JSON.parse(new TextDecoder().decode(row.body)) as unknown;
        const schema = opts.reducers.schemas.get(row.type);
        const parsedBody = schema ? opts.upcasters.parseBody(row.type, row.body_version, rawBody, schema) : rawBody;

        applyReducer(
          opts.db,
          {
            seq: row.seq,
            ts: row.ts,
            type: row.type,
            stream: { kind: row.stream_kind as 'job' | 'session' | 'discuss' | 'workflow', id: row.stream_id },
            namespace: row.namespace ?? undefined,
            project: row.project ?? undefined,
            correlationId: row.correlation_id ?? undefined,
            causationSeq: row.causation_seq ?? undefined,
            refs: row.refs ? JSON.parse(row.refs) : undefined,
            bodyVersion: row.body_version,
            body: parsedBody,
          },
          opts.reducers,
        );
      }

      afterSeq = rows[rows.length - 1]!.seq;
    }
  });

  txn.immediate();
}
