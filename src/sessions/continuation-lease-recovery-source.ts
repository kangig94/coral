import { observeDatabaseReads } from '../recovery/read-observation.js';
import type { RecoveryObservation } from '../recovery/phase-observation.js';
import type { Database } from '../store/db.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import { PROJECTION_SESSION_COLUMNS, projectionSessionRevisionFields } from '../recovery/row-revision-fields.js';
import type { PendingContinuationLease, ProviderSession } from './entry.js';
import type { RawSessionProjectionRow } from './projection-recovery-source.js';

export type RawPendingContinuationLeaseRow = RawSessionProjectionRow;

export type SessionContinuationLeaseComponent = {
  readonly kind: 'lease';
  readonly row: RawPendingContinuationLeaseRow;
  readonly persistedEntry: ProviderSession;
  readonly effectiveEntry: ProviderSession;
  readonly protectsRetention: boolean;
  readonly overdueLease: PendingContinuationLease | null;
};

function scanPendingContinuationLeaseRows(
  db: Database,
  subjectKey?: string,
): readonly RawPendingContinuationLeaseRow[] {
  if (subjectKey !== undefined) {
    return db
      .prepare<[string], RawPendingContinuationLeaseRow>(
        `SELECT ${PROJECTION_SESSION_COLUMNS}
           FROM projection_sessions
          WHERE instr(entry, '"continuationLease"') > 0
            AND session_id = ?`,
      )
      .all(subjectKey);
  }
  return db
    .prepare<[], RawPendingContinuationLeaseRow>(
      `SELECT ${PROJECTION_SESSION_COLUMNS}
         FROM projection_sessions
        WHERE instr(entry, '"continuationLease"') > 0
        ORDER BY session_id ASC`,
    )
    .all();
}

function pendingLeaseSubject(row: RawPendingContinuationLeaseRow) {
  return {
    key: row.session_id,
    revision: canonicalRecoveryRevision(projectionSessionRevisionFields(row)),
  };
}

export function sessionContinuationLeaseRecoverySource(
  db: Database,
  subject?: RecoverySubject,
  subjectKey?: string,
  observation?: RecoveryObservation,
): RecoverySource<RawPendingContinuationLeaseRow> {
  const observedDb =
    observation === undefined ? db : observeDatabaseReads(db, observation, 'session-continuation-lease');
  return defineRecoverySource({
    boundary: 'session-continuation-lease',
    scanSubject: subject ?? { key: 'session-continuation-lease-discovery', revision: { kind: 'until-cleared' } },
    scan: () => {
      const rows = scanPendingContinuationLeaseRows(observedDb, subject?.key ?? subjectKey);
      observation?.record('session-continuation-lease', { subjects: rows.length });
      return rows;
    },
    subject: pendingLeaseSubject,
  });
}
