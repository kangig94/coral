import { z } from 'zod';

import type { Database } from './db.js';
import {
  decodeProviderOperationRecord,
  encodeProviderOperationRecord,
  providerOperationIdentitySchema,
  type ProviderOperationIdentity,
  type ProviderOperationRecord,
} from './provider-operation-record.js';

export type ProviderOperationCompareAndSwapResult =
  | Readonly<{ kind: 'updated'; record: ProviderOperationRecord }>
  | Readonly<{ kind: 'conflict'; current: ProviderOperationRecord | null }>;

export type ProviderOperationDeleteResult =
  | Readonly<{ kind: 'deleted' }>
  | Readonly<{ kind: 'conflict'; current: ProviderOperationRecord | null }>;

type MetaRow = Readonly<{ key: string; value: string }>;
type ProviderOperationDueEntry = Readonly<{
  key: string;
  recordKey: string;
  identity: ProviderOperationIdentity;
  retryNotBeforeMs: number;
  revision: number;
}>;

const PROVIDER_OPERATION_SAGA_PREFIX = 'provider_operation_saga.v1:';
const PROVIDER_OPERATION_RECORD_PREFIX = `${PROVIDER_OPERATION_SAGA_PREFIX}record:`;
const PROVIDER_OPERATION_DUE_PREFIX = `${PROVIDER_OPERATION_SAGA_PREFIX}due:`;
const FIXED_WIDTH_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
const UUID_KEY_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROVIDER_OPERATION_RECORD_KEY_PATTERN = new RegExp(
  `^provider_operation_saga\\.v1:record:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}$`,
  'u',
);
const PROVIDER_OPERATION_DUE_KEY_PATTERN = new RegExp(
  `^provider_operation_saga\\.v1:due:[0-9]{${FIXED_WIDTH_INTEGER_DIGITS}}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:[0-9]{${FIXED_WIDTH_INTEGER_DIGITS}}$`,
  'u',
);
const providerOperationDueEntrySchema = z
  .object({
    key: z.string().regex(PROVIDER_OPERATION_DUE_KEY_PATTERN),
    value: z.string().regex(PROVIDER_OPERATION_RECORD_KEY_PATTERN),
  })
  .strict();

export class ProviderOperationJournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderOperationJournalError';
    Object.setPrototypeOf(this, ProviderOperationJournalError.prototype);
  }
}

function sameIdentity(left: ProviderOperationIdentity, right: ProviderOperationIdentity): boolean {
  return (
    left.jobId === right.jobId &&
    left.operationId === right.operationId &&
    left.proxyInstanceId === right.proxyInstanceId &&
    left.buildSetId === right.buildSetId
  );
}

function encodeFixedWidthInteger(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return String(value).padStart(FIXED_WIDTH_INTEGER_DIGITS, '0');
}

function decodeFixedWidthInteger(value: string, key: string): number {
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new ProviderOperationJournalError(`Provider operation due row '${key}' has an invalid integer field.`);
  }
  return decoded;
}

function canonicalRecordKey(identity: ProviderOperationIdentity): string {
  return (
    `${PROVIDER_OPERATION_RECORD_PREFIX}${identity.jobId}:${identity.operationId}:` +
    `${identity.proxyInstanceId}:${identity.buildSetId}`
  );
}

function dueEntryFor(record: ProviderOperationRecord): MetaRow | null {
  if (record.phase === 'executing') return null;
  return {
    key:
      `${PROVIDER_OPERATION_DUE_PREFIX}${encodeFixedWidthInteger(record.retryNotBeforeMs, 'retryNotBeforeMs')}:` +
      `${record.operation.jobId}:${record.operation.operationId}:${record.operation.proxyInstanceId}:` +
      `${record.operation.buildSetId}:${encodeFixedWidthInteger(record.revision, 'revision')}`,
    value: canonicalRecordKey(record.operation),
  };
}

function readCanonicalValue(db: Database, key: string): string | undefined {
  return db.prepare<[string], Pick<MetaRow, 'value'>>('SELECT value FROM meta WHERE key = ?').get(key)?.value;
}

function decodeCanonicalValue(key: string, value: string): ProviderOperationRecord {
  let record: ProviderOperationRecord;
  try {
    record = decodeProviderOperationRecord(value);
  } catch (error: unknown) {
    throw new ProviderOperationJournalError(`Provider operation record '${key}' contains an invalid value.`, {
      cause: error,
    });
  }
  if (canonicalRecordKey(record.operation) !== key) {
    throw new ProviderOperationJournalError(`Provider operation record '${key}' disagrees with its key identity.`);
  }
  return record;
}

function readCanonicalRecord(db: Database, key: string): ProviderOperationRecord | undefined {
  const value = readCanonicalValue(db, key);
  return value === undefined ? undefined : decodeCanonicalValue(key, value);
}

function parseDueIdentity(parts: readonly string[], key: string): ProviderOperationIdentity {
  const parsed = providerOperationIdentitySchema.safeParse({
    jobId: parts[3],
    operationId: parts[4],
    proxyInstanceId: parts[5],
    buildSetId: parts[6],
  });
  if (!parsed.success) {
    throw new ProviderOperationJournalError(`Provider operation due row '${key}' has an invalid identity.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseRecordKeyIdentity(key: string): ProviderOperationIdentity {
  const parts = key.split(':');
  const parsed = providerOperationIdentitySchema.safeParse({
    jobId: parts[2],
    operationId: parts[3],
    proxyInstanceId: parts[4],
    buildSetId: parts[5],
  });
  if (!parsed.success) {
    throw new ProviderOperationJournalError(`Provider operation due pointer '${key}' has an invalid identity.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function decodeDueEntry(row: MetaRow): ProviderOperationDueEntry {
  const parsed = providerOperationDueEntrySchema.safeParse(row);
  if (!parsed.success) {
    throw new ProviderOperationJournalError(`Provider operation due row '${row.key}' is invalid.`, {
      cause: parsed.error,
    });
  }
  const parts = parsed.data.key.split(':');
  const retryNotBeforeMs = decodeFixedWidthInteger(parts[2] ?? '', parsed.data.key);
  const revision = decodeFixedWidthInteger(parts[7] ?? '', parsed.data.key);
  const identity = parseDueIdentity(parts, parsed.data.key);
  const pointerIdentity = parseRecordKeyIdentity(parsed.data.value);
  if (!sameIdentity(identity, pointerIdentity)) {
    throw new ProviderOperationJournalError(
      `Provider operation due row '${parsed.data.key}' disagrees with its record pointer.`,
    );
  }
  return {
    key: parsed.data.key,
    recordKey: parsed.data.value,
    identity,
    retryNotBeforeMs,
    revision,
  };
}

function dueEntryMatchesRecord(due: ProviderOperationDueEntry, record: ProviderOperationRecord): boolean {
  return (
    sameIdentity(due.identity, record.operation) &&
    due.revision === record.revision &&
    due.retryNotBeforeMs === record.retryNotBeforeMs &&
    record.phase !== 'executing'
  );
}

function assertOneDueMutation(changes: number | bigint, action: string): void {
  if (changes !== 1 && changes !== 1n) {
    throw new ProviderOperationJournalError(
      `Provider operation due-index ${action} changed ${String(changes)} rows instead of one.`,
    );
  }
}

function insertDueEntry(db: Database, record: ProviderOperationRecord): void {
  const entry = dueEntryFor(record);
  if (entry === null) return;
  const result = db
    .prepare<[string, string]>('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .run(entry.key, entry.value);
  assertOneDueMutation(result.changes, 'insert');
}

function deleteDueEntry(db: Database, record: ProviderOperationRecord): void {
  const entry = dueEntryFor(record);
  if (entry === null) return;
  const result = db
    .prepare<[string, string]>('DELETE FROM meta WHERE key = ? AND value = ?')
    .run(entry.key, entry.value);
  assertOneDueMutation(result.changes, 'delete');
}

function inWriteTransaction<T>(db: Database, write: () => T): T {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    if (ownsTransaction) db.exec('COMMIT');
    return result;
  } catch (error: unknown) {
    if (ownsTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The write failure remains the authority when rollback cannot add usable evidence.
      }
    }
    throw error;
  }
}

export function insertProviderOperation(db: Database, record: ProviderOperationRecord): void {
  const encoded = encodeProviderOperationRecord(record);
  if (record.revision !== 0) {
    throw new ProviderOperationJournalError('A provider operation must enter the journal at revision 0.');
  }
  inWriteTransaction(db, () => {
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      canonicalRecordKey(record.operation),
      encoded,
    );
    insertDueEntry(db, record);
  });
}

export function readProviderOperation(
  db: Database,
  identity: ProviderOperationIdentity,
): ProviderOperationRecord | null {
  return readCanonicalRecord(db, canonicalRecordKey(identity)) ?? null;
}

export function readProviderOperationsDue(
  db: Database,
  nowMs: number,
  limit: number,
): readonly ProviderOperationRecord[] {
  const encodedNow = encodeFixedWidthInteger(nowMs, 'nowMs');
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be a positive safe integer.');
  const rows = db
    .prepare<[string, string, number], MetaRow>(
      `SELECT key, value FROM meta
       WHERE key >= ? AND key < ?
       ORDER BY key
       LIMIT ?`,
    )
    .all(PROVIDER_OPERATION_DUE_PREFIX, `${PROVIDER_OPERATION_DUE_PREFIX}${encodedNow};`, limit);
  return rows.map((row) => {
    const due = decodeDueEntry(row);
    const record = readCanonicalRecord(db, due.recordKey);
    if (record === undefined) {
      throw new ProviderOperationJournalError(
        `Provider operation due row '${due.key}' references a missing canonical record.`,
      );
    }
    if (!dueEntryMatchesRecord(due, record)) {
      throw new ProviderOperationJournalError(
        `Provider operation due row '${due.key}' is stale or disagrees with its canonical record.`,
      );
    }
    return record;
  });
}

export function compareAndSwapProviderOperation(
  db: Database,
  expected: ProviderOperationRecord,
  next: ProviderOperationRecord,
): ProviderOperationCompareAndSwapResult {
  const expectedEncoded = encodeProviderOperationRecord(expected);
  const nextEncoded = encodeProviderOperationRecord(next);
  if (!sameIdentity(expected.operation, next.operation)) {
    throw new ProviderOperationJournalError('Compare-and-swap cannot change provider operation identity.');
  }
  if (next.revision !== expected.revision + 1) {
    throw new ProviderOperationJournalError('Compare-and-swap must advance the provider operation revision by one.');
  }
  return inWriteTransaction(db, () => {
    const key = canonicalRecordKey(expected.operation);
    const result = db
      .prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key = ? AND value = ?')
      .run(nextEncoded, key, expectedEncoded);
    if (result.changes !== 1) {
      return { kind: 'conflict', current: readCanonicalRecord(db, key) ?? null };
    }
    deleteDueEntry(db, expected);
    insertDueEntry(db, next);
    return { kind: 'updated', record: next };
  });
}

export function deleteProviderOperation(
  db: Database,
  expected: ProviderOperationRecord,
): ProviderOperationDeleteResult {
  const expectedEncoded = encodeProviderOperationRecord(expected);
  return inWriteTransaction(db, () => {
    const key = canonicalRecordKey(expected.operation);
    const result = db
      .prepare<[string, string]>('DELETE FROM meta WHERE key = ? AND value = ?')
      .run(key, expectedEncoded);
    if (result.changes !== 1) {
      return { kind: 'conflict', current: readCanonicalRecord(db, key) ?? null };
    }
    deleteDueEntry(db, expected);
    return { kind: 'deleted' };
  });
}
