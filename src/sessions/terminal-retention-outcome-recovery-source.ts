import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import { canonicalRecoveryRevision, defineRecoverySource, type RecoverySource } from '../recovery/containment.js';
import { EVENT_COLUMNS, eventRevisionFields } from '../recovery/row-revision-fields.js';

export type RawTerminalRetentionOutcomeRow = EventsRow;

export type TerminalRetentionOutcomeComponent = {
  readonly kind: 'terminal-outcome';
  readonly row: RawTerminalRetentionOutcomeRow;
  readonly sessionId: string;
  readonly terminal: boolean;
};

function scanTerminalRetentionOutcomeRows(db: Database): readonly RawTerminalRetentionOutcomeRow[] {
  return db
    .prepare<[], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE type IN ('session.retention.discard.failed', 'session.retention.discard.completed')
        ORDER BY seq ASC`,
    )
    .all();
}

/** Creates the row-granular terminal retention-outcome source. */
export function terminalRetentionOutcomeRecoverySource(db: Database): RecoverySource<RawTerminalRetentionOutcomeRow> {
  return defineRecoverySource({
    boundary: 'terminal-retention-outcome',
    scanSubject: { key: 'terminal-retention-outcome-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanTerminalRetentionOutcomeRows(db),
    subject: (row) => ({ key: String(row.seq), revision: canonicalRecoveryRevision(eventRevisionFields(row)) }),
  });
}
