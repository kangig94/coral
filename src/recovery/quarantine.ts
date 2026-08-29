import { z } from 'zod';

import type { TimePort } from '../infra/port-types.js';
import { prepareCached, type Database } from '../store/db.js';
import type {
  RecoveryQuarantineDelete,
  RecoveryQuarantinePort,
  RecoveryQuarantineRecord,
  RecoveryQuarantineWrite,
  RecoverySubject,
} from './containment.js';

type RecoveryQuarantineClock = Pick<TimePort, 'now'>;

const RECOVERY_QUARANTINE_KEY_PREFIX = 'rqk1-';
const ENCODED_CODE_UNIT_WIDTH = 4;

export type RecoveryQuarantineKeyDecode = Readonly<{ kind: 'decoded'; key: string }> | Readonly<{ kind: 'invalid' }>;

/** A shell-safe rendering of the exact JavaScript string used as a recovery subject key. */
export function encodeRecoveryQuarantineKey(key: string): string {
  let encoded = RECOVERY_QUARANTINE_KEY_PREFIX;
  for (let index = 0; index < key.length; index += 1) {
    encoded += key.charCodeAt(index).toString(16).padStart(ENCODED_CODE_UNIT_WIDTH, '0');
  }
  return encoded;
}

export function decodeRecoveryQuarantineKey(encoded: string): RecoveryQuarantineKeyDecode {
  if (!encoded.startsWith(RECOVERY_QUARANTINE_KEY_PREFIX)) {
    return { kind: 'invalid' };
  }
  const payload = encoded.slice(RECOVERY_QUARANTINE_KEY_PREFIX.length);
  if (payload.length === 0 || payload.length % ENCODED_CODE_UNIT_WIDTH !== 0 || !/^[0-9a-f]+$/u.test(payload)) {
    return { kind: 'invalid' };
  }

  let key = '';
  for (let offset = 0; offset < payload.length; offset += ENCODED_CODE_UNIT_WIDTH) {
    key += String.fromCharCode(Number.parseInt(payload.slice(offset, offset + ENCODED_CODE_UNIT_WIDTH), 16));
  }
  return encodeRecoveryQuarantineKey(key) === encoded ? { kind: 'decoded', key } : { kind: 'invalid' };
}

const READ_ONLY_QUARANTINE_CLOCK: RecoveryQuarantineClock = {
  now() {
    throw new Error('Recovery quarantine mutations require a runtime time port.');
  },
};

const recoveryQuarantineRowSchema = z
  .object({
    boundary_id: z.string(),
    subject_key: z.string(),
    subject_revision: z.string().nullable(),
    state: z.enum(['active', 'retrying', 'continuation']),
    stage: z.enum(['scan', 'hydrate', 'settle']),
    retry_token: z.string().nullable(),
    retry_owner: z.string().nullable(),
    continuation_kind: z.string().nullable(),
    continuation_key: z.string().nullable(),
    error_message: z.string(),
    disposition_detail: z.string(),
    detected_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const rawRetentionContinuationRowSchema = recoveryQuarantineRowSchema
  .pick({
    subject_key: true,
    subject_revision: true,
    continuation_kind: true,
    continuation_key: true,
  })
  .extend({
    subject_key: z.string().min(1),
  })
  .strict();

export type RawRetentionContinuationRow = z.infer<typeof rawRetentionContinuationRowSchema>;

type RecoveryQuarantineRow = z.infer<typeof recoveryQuarantineRowSchema>;

const QUARANTINE_COLUMNS = `boundary_id,
         subject_key,
         subject_revision,
         state,
         stage,
         retry_token,
         retry_owner,
         continuation_kind,
         continuation_key,
         error_message,
         disposition_detail,
         detected_at,
         updated_at`;

export type RecoveryRetryAuthority = {
  readonly owner: string;
  readonly token: string;
};

export type RecoveryQuarantineClaim = {
  readonly boundary: string;
  readonly subject: RecoverySubject;
  readonly retry: RecoveryRetryAuthority;
};

export type RecoveryQuarantineReclaim = RecoveryQuarantineClaim & {
  readonly expectedRetry: RecoveryRetryAuthority;
};

/** Exact retry claim that may be returned to active quarantine ownership without changing its evidence. */
export type RecoveryQuarantineRelease = {
  readonly boundary: string;
  readonly subject: RecoverySubject;
  readonly expectedRetry: RecoveryRetryAuthority;
};

export type RecoveryQuarantineEntry = {
  readonly boundary: string;
  readonly subject: RecoverySubject;
  readonly state: 'active' | 'retrying' | 'continuation';
  readonly stage: 'scan' | 'hydrate' | 'settle';
  readonly retry: RecoveryRetryAuthority | null;
  readonly continuation: { readonly kind: string; readonly key: string } | null;
  readonly errorMessage: string;
  readonly detail: string;
  readonly detectedAt: string;
  readonly updatedAt: string;
};

export type RecoveryQuarantineListEntry = Omit<RecoveryQuarantineEntry, 'detectedAt' | 'updatedAt'> & {
  readonly detectedAt: string | null;
  readonly updatedAt: string | null;
};

type RecoveryQuarantineColumns = {
  readonly boundaryId: string;
  readonly subjectKey: string;
  readonly subjectRevision: string | null;
  readonly state: 'active' | 'continuation';
  readonly stage: 'scan' | 'hydrate' | 'settle';
  readonly continuationKind: string | null;
  readonly continuationKey: string | null;
  readonly errorMessage: string;
  readonly dispositionDetail: string;
};

function revisionValue(subject: RecoverySubject): string | null {
  return subject.revision.kind === 'fingerprint' ? subject.revision.value : null;
}

function writeColumns(write: RecoveryQuarantineWrite): RecoveryQuarantineColumns {
  if (write.state === 'continuation' && write.continuation === undefined) {
    throw new Error(`Recovery continuation is missing for ${write.boundary}:${write.subject.key}`);
  }

  return {
    boundaryId: write.boundary,
    subjectKey: write.subject.key,
    subjectRevision: revisionValue(write.subject),
    state: write.state,
    stage: write.stage,
    continuationKind: write.state === 'continuation' ? (write.continuation?.kind ?? null) : null,
    continuationKey: write.state === 'continuation' ? (write.continuation?.key ?? null) : null,
    errorMessage: write.errorMessage,
    dispositionDetail: write.detail,
  };
}

function rowToEntry(row: RecoveryQuarantineRow): RecoveryQuarantineEntry {
  const parsed = recoveryQuarantineRowSchema.parse(row);
  const subject: RecoverySubject = {
    key: parsed.subject_key,
    revision:
      parsed.subject_revision === null
        ? { kind: 'until-cleared' }
        : { kind: 'fingerprint', value: parsed.subject_revision },
  };

  const hasRetry = parsed.retry_owner !== null || parsed.retry_token !== null;
  if (parsed.state === 'retrying' && (parsed.retry_owner === null || parsed.retry_token === null)) {
    throw new Error(`Recovery retry authority is incomplete for ${parsed.boundary_id}:${parsed.subject_key}`);
  }
  if (parsed.state !== 'retrying' && hasRetry) {
    throw new Error(
      `Recovery retry authority is retained outside retrying for ${parsed.boundary_id}:${parsed.subject_key}`,
    );
  }

  const hasContinuation = parsed.continuation_kind !== null || parsed.continuation_key !== null;
  if (parsed.state === 'continuation' && (parsed.continuation_kind === null || parsed.continuation_key === null)) {
    throw new Error(`Recovery continuation is incomplete for ${parsed.boundary_id}:${parsed.subject_key}`);
  }
  if (parsed.state !== 'continuation' && hasContinuation) {
    throw new Error(
      `Recovery continuation is retained outside continuation for ${parsed.boundary_id}:${parsed.subject_key}`,
    );
  }

  const retry: RecoveryRetryAuthority | null =
    parsed.state === 'retrying' && parsed.retry_owner !== null && parsed.retry_token !== null
      ? { owner: parsed.retry_owner, token: parsed.retry_token }
      : null;
  const continuation: RecoveryQuarantineEntry['continuation'] =
    parsed.state === 'continuation' && parsed.continuation_kind !== null && parsed.continuation_key !== null
      ? { kind: parsed.continuation_kind, key: parsed.continuation_key }
      : null;

  return {
    boundary: parsed.boundary_id,
    subject,
    state: parsed.state,
    stage: parsed.stage,
    retry,
    continuation,
    errorMessage: parsed.error_message,
    detail: parsed.disposition_detail,
    detectedAt: parsed.detected_at,
    updatedAt: parsed.updated_at,
  };
}

function rowToRecord(row: RecoveryQuarantineRow): RecoveryQuarantineRecord {
  const entry = rowToEntry(row);
  return {
    boundary: entry.boundary,
    subject: entry.subject,
    state: entry.state,
    ...(entry.retry === null ? {} : { retry: entry.retry }),
  };
}

export class RecoveryQuarantineStore implements RecoveryQuarantinePort {
  private readonly db: Database;
  private readonly time: RecoveryQuarantineClock;

  constructor(db: Database, time: RecoveryQuarantineClock) {
    this.db = db;
    this.time = time;
  }

  static readOnly(db: Database): RecoveryQuarantineStore {
    return new RecoveryQuarantineStore(db, READ_ONLY_QUARANTINE_CLOCK);
  }

  private timestamp(): string {
    return new Date(this.time.now()).toISOString();
  }

  read(boundary: string, subjectKey: string): RecoveryQuarantineRecord | null {
    const row = prepareCached<[string, string], RecoveryQuarantineRow>(
      this.db,
      `SELECT ${QUARANTINE_COLUMNS}
       FROM recovery_quarantine
       WHERE boundary_id = ? AND subject_key = ?`,
    ).get(boundary, subjectKey);

    return row === undefined ? null : rowToRecord(row);
  }

  list(): readonly RecoveryQuarantineEntry[] {
    const rows = prepareCached<[], RecoveryQuarantineRow>(
      this.db,
      `SELECT ${QUARANTINE_COLUMNS}
       FROM recovery_quarantine
       ORDER BY boundary_id ASC, subject_key ASC`,
    ).all();

    return rows.map(rowToEntry);
  }

  claimRetry(request: RecoveryQuarantineClaim): boolean {
    const result = prepareCached<[string, string, string, string, string, string | null]>(
      this.db,
      `UPDATE recovery_quarantine
       SET state = 'retrying',
           retry_owner = ?,
           retry_token = ?,
           continuation_kind = NULL,
           continuation_key = NULL,
           updated_at = ?
       WHERE boundary_id = ?
         AND subject_key = ?
         AND subject_revision IS ?
         AND state = 'active'`,
    ).run(
      request.retry.owner,
      request.retry.token,
      this.timestamp(),
      request.boundary,
      request.subject.key,
      revisionValue(request.subject),
    );
    return Number(result.changes) === 1;
  }

  reclaimRetry(request: RecoveryQuarantineReclaim): boolean {
    const result = prepareCached<[string, string, string, string, string, string | null, string, string]>(
      this.db,
      `UPDATE recovery_quarantine
       SET retry_owner = ?,
           retry_token = ?,
           updated_at = ?
       WHERE boundary_id = ?
         AND subject_key = ?
         AND subject_revision IS ?
         AND state = 'retrying'
         AND retry_owner = ?
         AND retry_token = ?`,
    ).run(
      request.retry.owner,
      request.retry.token,
      this.timestamp(),
      request.boundary,
      request.subject.key,
      revisionValue(request.subject),
      request.expectedRetry.owner,
      request.expectedRetry.token,
    );
    return Number(result.changes) === 1;
  }

  releaseRetry(request: RecoveryQuarantineRelease): boolean {
    const result = prepareCached<[string, string, string | null, string, string]>(
      this.db,
      `UPDATE recovery_quarantine
       SET state = 'active',
           retry_owner = NULL,
           retry_token = NULL
       WHERE boundary_id = ?
         AND subject_key = ?
         AND subject_revision IS ?
         AND state = 'retrying'
         AND retry_owner = ?
         AND retry_token = ?`,
    ).run(
      request.boundary,
      request.subject.key,
      revisionValue(request.subject),
      request.expectedRetry.owner,
      request.expectedRetry.token,
    );
    return Number(result.changes) === 1;
  }

  upsert(write: RecoveryQuarantineWrite): boolean {
    const row = writeColumns(write);
    if (write.expectedRetry !== undefined) {
      if (write.expectedRetry.subject.key !== write.subject.key) {
        throw new Error(
          `Recovery retry cannot move to a different subject key: ${write.boundary}:${write.subject.key}`,
        );
      }
      const result = prepareCached<
        [
          string | null,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string,
          string,
        ]
      >(
        this.db,
        `UPDATE recovery_quarantine
         SET subject_revision = ?,
             state = ?,
             stage = ?,
             retry_token = NULL,
             retry_owner = NULL,
             continuation_kind = ?,
             continuation_key = ?,
             error_message = ?,
             disposition_detail = ?,
             updated_at = ?
         WHERE boundary_id = ?
           AND subject_key = ?
           AND subject_revision IS ?
           AND state = 'retrying'
           AND retry_owner = ?
           AND retry_token = ?`,
      ).run(
        row.subjectRevision,
        row.state,
        row.stage,
        row.continuationKind,
        row.continuationKey,
        row.errorMessage,
        row.dispositionDetail,
        this.timestamp(),
        row.boundaryId,
        row.subjectKey,
        revisionValue(write.expectedRetry.subject),
        write.expectedRetry.owner,
        write.expectedRetry.token,
      );
      return Number(result.changes) === 1;
    }

    const statement = prepareCached<
      [string, string, string | null, string, string, string | null, string | null, string, string, string, string]
    >(
      this.db,
      `INSERT INTO recovery_quarantine (
         boundary_id,
         subject_key,
         subject_revision,
         state,
         stage,
         retry_token,
         retry_owner,
         continuation_kind,
         continuation_key,
         error_message,
         disposition_detail,
         detected_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(boundary_id, subject_key) DO UPDATE SET
         subject_revision = excluded.subject_revision,
         state = excluded.state,
         stage = excluded.stage,
         retry_token = NULL,
         retry_owner = NULL,
         continuation_kind = excluded.continuation_kind,
         continuation_key = excluded.continuation_key,
         error_message = excluded.error_message,
         disposition_detail = excluded.disposition_detail,
         updated_at = excluded.updated_at
       WHERE recovery_quarantine.state != 'retrying'`,
    );
    const timestamp = this.timestamp();
    const result = statement.run(
      row.boundaryId,
      row.subjectKey,
      row.subjectRevision,
      row.state,
      row.stage,
      row.continuationKind,
      row.continuationKey,
      row.errorMessage,
      row.dispositionDetail,
      timestamp,
      timestamp,
    );
    return Number(result.changes) === 1;
  }

  delete(request: RecoveryQuarantineDelete): boolean {
    const subjectRevision = revisionValue(request.subject);
    if (request.expectedRetry !== undefined) {
      const result = prepareCached<[string, string, string | null, string, string]>(
        this.db,
        `DELETE FROM recovery_quarantine
         WHERE boundary_id = ?
           AND subject_key = ?
           AND subject_revision IS ?
           AND state = 'retrying'
           AND retry_owner = ?
           AND retry_token = ?`,
      ).run(
        request.boundary,
        request.subject.key,
        subjectRevision,
        request.expectedRetry.owner,
        request.expectedRetry.token,
      );
      return Number(result.changes) === 1;
    }

    const result = prepareCached<[string, string, string | null]>(
      this.db,
      `DELETE FROM recovery_quarantine
       WHERE boundary_id = ?
         AND subject_key = ?
         AND subject_revision IS ?
         AND state != 'retrying'`,
    ).run(request.boundary, request.subject.key, subjectRevision);
    return Number(result.changes) === 1;
  }
}
