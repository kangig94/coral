import type { z } from 'zod';

import type { Database } from '../store/db.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import type { RawRetentionContinuationRow as QuarantineRetentionContinuationRow } from '../recovery/quarantine.js';
import {
  PROJECTION_SESSION_COLUMNS,
  continuationRevisionFields,
  projectionSessionRevisionFields,
  withConsistentRead,
} from '../recovery/row-revision-fields.js';
import type { ProviderSession } from './entry.js';
import { type projectionSessionStoredRowSchema } from './projections.js';

const RETENTION_WORK_BOUNDARY = 'session-retention-work';

export type RawSessionProjectionRow = z.infer<typeof projectionSessionStoredRowSchema>;
export type RawRetentionContinuationRow = QuarantineRetentionContinuationRow;

export type RawSessionProjectionEnvelope = {
  readonly row: RawSessionProjectionRow;
  readonly retentionContinuations: readonly RawRetentionContinuationRow[];
};

export type SessionProjectionComponent = {
  readonly kind: 'session';
  readonly row: RawSessionProjectionRow;
  readonly entry: ProviderSession;
  readonly hasContinuationLeaseField: boolean;
  readonly retentionContinuations: readonly RawRetentionContinuationRow[];
};

function continuationSessionId(subjectKey: string): string | null {
  const separator = subjectKey.indexOf('\u0000');
  return separator > 0 ? subjectKey.slice(0, separator) : null;
}

function scanSessionProjectionRows(db: Database, subjectKey?: string): readonly RawSessionProjectionEnvelope[] {
  return withConsistentRead(db, () => {
    const rows =
      subjectKey === undefined
        ? db
            .prepare<[], RawSessionProjectionRow>(
              `SELECT ${PROJECTION_SESSION_COLUMNS}
                 FROM projection_sessions
                ORDER BY session_id ASC`,
            )
            .all()
        : db
            .prepare<[string], RawSessionProjectionRow>(
              `SELECT ${PROJECTION_SESSION_COLUMNS}
                 FROM projection_sessions
                WHERE session_id = ?`,
            )
            .all(subjectKey);
    const continuations = db
      .prepare<[string], RawRetentionContinuationRow>(
        `SELECT subject_key, subject_revision, continuation_kind, continuation_key
           FROM recovery_quarantine
          WHERE boundary_id = ?
            AND state = 'continuation'
          ORDER BY subject_key ASC`,
      )
      .all(RETENTION_WORK_BOUNDARY);
    const bySession = new Map<string, RawRetentionContinuationRow[]>();
    for (const continuation of continuations) {
      const sessionId = continuationSessionId(continuation.subject_key);
      if (sessionId === null) continue;
      const rowsForSession = bySession.get(sessionId) ?? [];
      rowsForSession.push(continuation);
      bySession.set(sessionId, rowsForSession);
    }
    return rows.map((row) => ({
      row,
      retentionContinuations: bySession.get(row.session_id) ?? [],
    }));
  });
}

function sessionProjectionSubject(raw: RawSessionProjectionEnvelope): RecoverySubject {
  const fields = projectionSessionRevisionFields(raw.row);
  for (const continuation of raw.retentionContinuations) {
    fields.push(...continuationRevisionFields(RETENTION_WORK_BOUNDARY, continuation.subject_key, continuation));
  }
  return { key: raw.row.session_id, revision: canonicalRecoveryRevision(fields) };
}

export function sessionProjectionRecoverySource(
  db: Database,
  subject?: RecoverySubject,
  subjectKey?: string,
): RecoverySource<RawSessionProjectionEnvelope> {
  return defineRecoverySource({
    boundary: 'session-projection',
    scanSubject: subject ?? { key: 'session-projection-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanSessionProjectionRows(db, subject?.key ?? subjectKey),
    subject: sessionProjectionSubject,
  });
}
