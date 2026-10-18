import type { RecoveryObservation } from '../recovery/phase-observation.js';
import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import { EVENT_COLUMNS, eventRevisionFields } from '../recovery/row-revision-fields.js';

export type RawTerminalRetentionOutcomeRow = EventsRow;

export type TerminalRetentionOutcomeComponent = {
  readonly kind: 'terminal-outcome';
  readonly row: RawTerminalRetentionOutcomeRow;
  readonly sessionId: string;
  readonly terminal: boolean;
};

function scanTerminalRetentionOutcomeRows(
  db: Database,
  subjectKey?: string,
  sessionId?: string,
): readonly RawTerminalRetentionOutcomeRow[] {
  if (subjectKey !== undefined) {
    return db
      .prepare<[string], EventsRow>(
        `SELECT ${EVENT_COLUMNS}
           FROM events
          WHERE type IN ('session.retention.discard.failed', 'session.retention.discard.completed')
            AND seq = ?`,
      )
      .all(subjectKey);
  }
  if (sessionId !== undefined) {
    return db
      .prepare<[string], EventsRow>(
        `SELECT ${EVENT_COLUMNS}
           FROM events
          WHERE type IN ('session.retention.discard.failed', 'session.retention.discard.completed')
            AND stream_id = ?
          ORDER BY seq ASC`,
      )
      .all(sessionId);
  }
  return db
    .prepare<[], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE type IN ('session.retention.discard.failed', 'session.retention.discard.completed')
        ORDER BY seq ASC`,
    )
    .all();
}

export function terminalRetentionOutcomeRecoverySource(
  db: Database,
  subject?: RecoverySubject,
  sessionId?: string,
  observation?: RecoveryObservation,
): RecoverySource<RawTerminalRetentionOutcomeRow> {
  return defineRecoverySource({
    boundary: 'terminal-retention-outcome',
    scanSubject: subject ?? { key: 'terminal-retention-outcome-discovery', revision: { kind: 'until-cleared' } },
    scan: () => {
      const rows = scanTerminalRetentionOutcomeRows(db, subject?.key, sessionId);
      observation?.record('terminal-retention-outcome', { subjects: rows.length, reads: rows.length });
      return rows;
    },
    subject: (row) => ({ key: String(row.seq), revision: canonicalRecoveryRevision(eventRevisionFields(row)) }),
  });
}
