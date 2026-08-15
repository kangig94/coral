import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import { EVENT_COLUMNS, eventRevisionFields } from '../recovery/row-revision-fields.js';
import type { ProviderSession } from './entry.js';

export type RawRetentionReleaseAndTerminalRow = EventsRow;

export type RetentionReleasePairComponent =
  | {
      readonly kind: 'release';
      readonly row: RawRetentionReleaseAndTerminalRow;
      readonly sessionId: string;
      readonly jobId: string;
      readonly entry: ProviderSession;
    }
  | {
      readonly kind: 'terminal';
      readonly row: RawRetentionReleaseAndTerminalRow;
      readonly sessionId: string;
      readonly jobId: string;
    };

/**
 * A retention pair is a session claim and the job terminal that releases it, so a terminal carrying no
 * session has no claim to release and never belongs to this boundary. Workflow roots and KB jobs
 * legitimately have none; admitting them fails hydration on a value the pair itself never reads.
 * The targeted `pair` scan states this as equality against a concrete session and is already stricter.
 */
const RETENTION_PAIR_EVENT_PREDICATE = `(
             type = 'session.claim.released'
          OR (type = 'job.terminal.recorded' AND json_extract(refs, '$.sessionId') IS NOT NULL)
        )`;

function scanRetentionReleaseAndTerminalRows(
  db: Database,
  subjectKey?: string,
  pair?: Readonly<{ sessionId: string; jobId: string }>,
): readonly RawRetentionReleaseAndTerminalRow[] {
  if (subjectKey !== undefined) {
    return db
      .prepare<[string], EventsRow>(
        `SELECT ${EVENT_COLUMNS}
           FROM events
          WHERE ${RETENTION_PAIR_EVENT_PREDICATE}
            AND seq = ?`,
      )
      .all(subjectKey);
  }
  if (pair !== undefined) {
    return db
      .prepare<[string, string, string, string], EventsRow>(
        `SELECT ${EVENT_COLUMNS}
           FROM events
          WHERE (
                  type = 'session.claim.released'
              AND stream_id = ?
              AND json_extract(refs, '$.jobId') = ?
          ) OR (
                  type = 'job.terminal.recorded'
              AND stream_id = ?
              AND json_extract(refs, '$.sessionId') = ?
          )
          ORDER BY seq ASC`,
      )
      .all(pair.sessionId, pair.jobId, pair.jobId, pair.sessionId);
  }
  return db
    .prepare<[], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE ${RETENTION_PAIR_EVENT_PREDICATE}
        ORDER BY seq ASC`,
    )
    .all();
}

/** Creates the independently keyed release/terminal component source. */
export function retentionReleasePairComponentSource(
  db: Database,
  subject?: RecoverySubject,
  pair?: Readonly<{ sessionId: string; jobId: string }>,
): RecoverySource<RawRetentionReleaseAndTerminalRow> {
  return defineRecoverySource({
    boundary: 'retention-release-pair',
    scanSubject: subject ?? { key: 'retention-release-pair-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanRetentionReleaseAndTerminalRows(db, subject?.key, pair),
    subject: (row) => ({ key: String(row.seq), revision: canonicalRecoveryRevision(eventRevisionFields(row)) }),
  });
}
