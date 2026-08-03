import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import { canonicalRecoveryRevision, defineRecoverySource, type RecoverySource } from '../recovery/containment.js';
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

function scanRetentionReleaseAndTerminalRows(db: Database): readonly RawRetentionReleaseAndTerminalRow[] {
  return db
    .prepare<[], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE type IN ('session.claim.released', 'job.terminal.recorded')
        ORDER BY seq ASC`,
    )
    .all();
}

/** Creates the independently keyed release/terminal component source. */
export function retentionReleasePairComponentSource(db: Database): RecoverySource<RawRetentionReleaseAndTerminalRow> {
  return defineRecoverySource({
    boundary: 'retention-release-pair',
    scanSubject: { key: 'retention-release-pair-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanRetentionReleaseAndTerminalRows(db),
    subject: (row) => ({ key: String(row.seq), revision: canonicalRecoveryRevision(eventRevisionFields(row)) }),
  });
}
