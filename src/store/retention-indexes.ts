import type { Database } from './db.js';

export const retentionCausePaths = ['$.causeRef.seq', '$.reason.causeRef.seq', '$.terminal.outcome.causeRef.seq'];

// The literal predicate depends on encodeEventBody (src/store/body-codec.ts) writing every body with JSON.stringify.
// Unknown shapes hold progress globally rather than making a future reader's evidence disappear.
export const unknownRetentionCause = `CASE WHEN json_valid(body) THEN
  (length(CAST(body AS TEXT)) - length(replace(CAST(body AS TEXT), '"causeRef":', ''))) / 11 >
  ((json_type(body, '$.causeRef') IS NOT NULL) +
   (json_type(body, '$.reason.causeRef') IS NOT NULL) +
   (json_type(body, '$.terminal.outcome.causeRef') IS NOT NULL))
  ELSE 1 END`;

/** Maintenance indexes are additive; they do not change the released store-format fingerprint. */
export function ensureRetentionIndexes(db: Database, beforeOperation?: () => void): void {
  beforeOperation?.();
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get() === undefined) return;
  for (const sql of retentionIndexStatements) {
    beforeOperation?.();
    db.exec(sql);
  }
}

export const retentionIndexStatements = [
  'CREATE INDEX IF NOT EXISTS events_retention_age ON events(stream_kind, stream_id, ts, seq)',
  'CREATE INDEX IF NOT EXISTS events_retention_stream ON events(stream_kind, stream_id, seq)',
  'CREATE INDEX IF NOT EXISTS events_retention_causation ON events(causation_seq)',
  ...retentionCausePaths.map(
    (path, index) => `CREATE INDEX IF NOT EXISTS events_retention_cause_${index}
    ON events(CASE WHEN json_valid(body) THEN json_extract(body, '${path}') END)`,
  ),
  `CREATE INDEX IF NOT EXISTS events_retention_unknown_cause_v2 ON events(seq) WHERE ${unknownRetentionCause}`,
];
