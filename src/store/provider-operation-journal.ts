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

export type ProviderOperationRetryOwnership = Readonly<{
  retryCount: number;
  retryNotBeforeMs: number;
  lastError: ProviderOperationRecord['lastError'];
}>;

type ExecutingProviderOperationRecord = Extract<ProviderOperationRecord, { phase: 'executing' }>;

export type CompleteExecutingProviderOperationAttachmentResult =
  | Readonly<{ kind: 'completed'; record: ExecutingProviderOperationRecord }>
  | Readonly<{ kind: 'already-completed'; current: ExecutingProviderOperationRecord }>
  | Readonly<{ kind: 'advanced'; current: ProviderOperationRecord | null }>
  | Readonly<{ kind: 'retry-superseded'; current: ExecutingProviderOperationRecord }>;

export type ProviderOperationMutation =
  | Readonly<{ kind: 'upserted'; record: ProviderOperationRecord }>
  | Readonly<{ kind: 'deleted'; record: ProviderOperationRecord }>;

export type ProviderOperationMutationObserver = (mutation: ProviderOperationMutation) => void;

export type ProviderOperationDueSelection = Readonly<{
  rawKey: string;
  rawValue: string;
  record: ProviderOperationRecord;
}>;

export type FinishProviderOperationDueSelectionResult =
  | Readonly<{ kind: 'removed' }>
  | Readonly<{ kind: 'already-advanced' }>
  | Readonly<{ kind: 'yielded'; record: ProviderOperationRecord }>;

const mutationObservers = new WeakMap<Database, Set<ProviderOperationMutationObserver>>();

export function subscribeProviderOperationMutations(
  db: Database,
  observer: ProviderOperationMutationObserver,
): () => void {
  const observers = mutationObservers.get(db) ?? new Set<ProviderOperationMutationObserver>();
  mutationObservers.set(db, observers);
  observers.add(observer);
  return () => observers.delete(observer);
}

function notifyProviderOperationMutation(db: Database, mutation: ProviderOperationMutation): void {
  for (const observer of mutationObservers.get(db) ?? []) observer(mutation);
}

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
const PROVIDER_OPERATION_READ_PAGE_SIZE = 128;
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

export function providerOperationRecordKeyPrefix(jobId: string): string {
  return `${PROVIDER_OPERATION_RECORD_PREFIX}${jobId}:`;
}

function providerOperationDueEntry(record: ProviderOperationRecord): MetaRow {
  return {
    key:
      `${PROVIDER_OPERATION_DUE_PREFIX}${encodeFixedWidthInteger(record.retryNotBeforeMs, 'retryNotBeforeMs')}:` +
      `${record.operation.jobId}:${record.operation.operationId}:${record.operation.proxyInstanceId}:` +
      `${record.operation.buildSetId}:${encodeFixedWidthInteger(record.revision, 'revision')}`,
    value: canonicalRecordKey(record.operation),
  };
}

function providerOperationHasDueWork(record: ProviderOperationRecord): boolean {
  return record.phase !== 'executing' || record.lastError !== null;
}

function dueEntryFor(record: ProviderOperationRecord): MetaRow | null {
  return providerOperationHasDueWork(record) ? providerOperationDueEntry(record) : null;
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
    due.retryNotBeforeMs === record.retryNotBeforeMs
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
  const entry = providerOperationDueEntry(record);
  const result = db
    .prepare<[string, string]>('DELETE FROM meta WHERE key = ? AND value = ?')
    .run(entry.key, entry.value);
  if (providerOperationHasDueWork(record)) {
    assertOneDueMutation(result.changes, 'delete');
  } else if (result.changes !== 0 && result.changes !== 0n && result.changes !== 1 && result.changes !== 1n) {
    throw new ProviderOperationJournalError(
      `Provider operation due-index legacy delete changed ${String(result.changes)} rows instead of zero or one.`,
    );
  }
}

function sameRetryOwnership(record: ProviderOperationRecord, ownership: ProviderOperationRetryOwnership): boolean {
  const left = record.lastError;
  const right = ownership.lastError;
  return (
    record.retryCount === ownership.retryCount &&
    record.retryNotBeforeMs === ownership.retryNotBeforeMs &&
    (left === right ||
      (left !== null &&
        right !== null &&
        left.observedAtMs === right.observedAtMs &&
        left.code === right.code &&
        left.message === right.message))
  );
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
  notifyProviderOperationMutation(db, { kind: 'upserted', record });
}

export function readProviderOperation(
  db: Database,
  identity: ProviderOperationIdentity,
): ProviderOperationRecord | null {
  return readCanonicalRecord(db, canonicalRecordKey(identity)) ?? null;
}

export function hasProviderOperationForJob(db: Database, jobId: string): boolean {
  const prefix = providerOperationRecordKeyPrefix(jobId);
  return (
    db
      .prepare<
        [string, string],
        Pick<MetaRow, 'key'>
      >('SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT 1')
      .get(prefix, `${prefix}\uffff`) !== undefined
  );
}

export function readProviderOperationForJob(db: Database, jobId: string): ProviderOperationRecord | null {
  const prefix = providerOperationRecordKeyPrefix(jobId);
  const rows = db
    .prepare<[string, string], MetaRow>('SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT 2')
    .all(prefix, `${prefix}\uffff`);
  if (rows.length > 1) {
    throw new ProviderOperationJournalError(`Job '${jobId}' has more than one live provider operation.`);
  }
  const row = rows[0];
  return row === undefined ? null : decodeCanonicalValue(row.key, row.value);
}

/**
 * The result of walking every saga row, with the rows this build could not read kept separate rather than
 * thrown.
 *
 * A keyed lookup that fails is a caller asking for a record that must exist, and it still throws. A *scan*
 * is different: it is startup asking what is here, and one row it cannot parse is not a reason to refuse to
 * run. That distinction is not hypothetical \u2014 the incarnation token changed this record's shape while
 * leaving `version: 1` on it, so a row written by v0.10.6-v0.10.8 fails validation, and every scan caller
 * sits on a path that ends at the coordinator's own startup.
 *
 * Unreadable rows are reported as keys, never as bytes: what they mean is not this reader's to guess. They
 * are also left in place. Nothing is lost by skipping one \u2014 the row stays, and a build that understands it
 * can still act on it.
 */
export type ProviderOperationScan = Readonly<{
  records: readonly ProviderOperationRecord[];
  unreadableKeys: readonly string[];
}>;

export function readProviderOperations(db: Database): ProviderOperationScan {
  const records: ProviderOperationRecord[] = [];
  const unreadableKeys: string[] = [];
  let cursor = PROVIDER_OPERATION_RECORD_PREFIX;
  for (;;) {
    const rows = db
      .prepare<[string, string, number], MetaRow>(
        `SELECT key, value FROM meta
         WHERE key > ? AND key < ?
         ORDER BY key
         LIMIT ?`,
      )
      .all(cursor, `${PROVIDER_OPERATION_RECORD_PREFIX}\uffff`, PROVIDER_OPERATION_READ_PAGE_SIZE);
    for (const row of rows) {
      try {
        records.push(decodeCanonicalValue(row.key, row.value));
      } catch {
        unreadableKeys.push(row.key);
      }
    }
    if (rows.length < PROVIDER_OPERATION_READ_PAGE_SIZE) {
      return { records, unreadableKeys };
    }
    cursor = rows.at(-1)?.key ?? cursor;
  }
}

export function readProviderOperationsDue(
  db: Database,
  nowMs: number,
  limit: number,
): readonly ProviderOperationRecord[] {
  return readProviderOperationDueSelections(db, nowMs, limit).map((selection) => selection.record);
}

export function readProviderOperationDueSelections(
  db: Database,
  nowMs: number,
  limit: number,
): readonly ProviderOperationDueSelection[] {
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
    return { rawKey: row.key, rawValue: row.value, record };
  });
}

export function finishProviderOperationDueSelection(
  db: Database,
  selection: ProviderOperationDueSelection,
  scanCutoffMs: number,
  nextDueAtMs: number,
): FinishProviderOperationDueSelectionResult {
  encodeFixedWidthInteger(scanCutoffMs, 'scanCutoffMs');
  encodeFixedWidthInteger(nextDueAtMs, 'nextDueAtMs');
  if (nextDueAtMs <= scanCutoffMs) {
    throw new RangeError('nextDueAtMs must be greater than scanCutoffMs.');
  }

  const result: FinishProviderOperationDueSelectionResult = inWriteTransaction(db, () => {
    const selectedDelete = db
      .prepare<[string, string]>('DELETE FROM meta WHERE key = ? AND value = ?')
      .run(selection.rawKey, selection.rawValue);
    if (
      selectedDelete.changes !== 0 &&
      selectedDelete.changes !== 0n &&
      selectedDelete.changes !== 1 &&
      selectedDelete.changes !== 1n
    ) {
      throw new ProviderOperationJournalError(
        `Provider operation selected due-key delete changed ${String(selectedDelete.changes)} rows instead of zero or one.`,
      );
    }

    const key = canonicalRecordKey(selection.record.operation);
    const current = readCanonicalRecord(db, key);
    if (current === undefined) return { kind: 'removed' };
    const currentDue = providerOperationDueEntry(current);

    if (!providerOperationHasDueWork(current)) {
      deleteDueEntry(db, current);
      return { kind: 'removed' };
    }

    if (current.retryNotBeforeMs > scanCutoffMs) {
      const currentDueValue = readCanonicalValue(db, currentDue.key);
      if (currentDueValue !== currentDue.value) {
        throw new ProviderOperationJournalError(
          `Provider operation due row '${currentDue.key}' is missing or disagrees after advancing.`,
        );
      }
      return { kind: 'already-advanced' };
    }

    const next: ProviderOperationRecord = {
      ...current,
      revision: current.revision + 1,
      retryNotBeforeMs: nextDueAtMs,
    };
    const currentEncoded = encodeProviderOperationRecord(current);
    const nextEncoded = encodeProviderOperationRecord(next);
    const write = db
      .prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key = ? AND value = ?')
      .run(nextEncoded, key, currentEncoded);
    if (write.changes !== 1) {
      throw new ProviderOperationJournalError(
        `Provider operation due-turn canonical update changed ${String(write.changes)} rows instead of one.`,
      );
    }

    const currentDelete = db
      .prepare<[string, string]>('DELETE FROM meta WHERE key = ? AND value = ?')
      .run(currentDue.key, currentDue.value);
    const currentWasSelected = currentDue.key === selection.rawKey && currentDue.value === selection.rawValue;
    const expectedDeleteChanges = currentWasSelected ? 0 : 1;
    if (currentDelete.changes !== expectedDeleteChanges && currentDelete.changes !== BigInt(expectedDeleteChanges)) {
      throw new ProviderOperationJournalError(
        `Provider operation current due-key delete changed ${String(currentDelete.changes)} rows instead of ${expectedDeleteChanges}.`,
      );
    }

    insertDueEntry(db, next);
    return { kind: 'yielded', record: next };
  });
  if (result.kind === 'yielded') {
    notifyProviderOperationMutation(db, { kind: 'upserted', record: result.record });
  }
  return result;
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
  const result: ProviderOperationCompareAndSwapResult = inWriteTransaction(db, () => {
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
  if (result.kind === 'updated') notifyProviderOperationMutation(db, { kind: 'upserted', record: result.record });
  return result;
}

export function completeExecutingProviderOperationAttachment(
  db: Database,
  operation: ProviderOperationIdentity,
  expectedRetryOwnership: ProviderOperationRetryOwnership,
  completedAtMs: number,
): CompleteExecutingProviderOperationAttachmentResult {
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0) {
    throw new RangeError('completedAtMs must be a non-negative safe integer.');
  }
  const result: CompleteExecutingProviderOperationAttachmentResult = inWriteTransaction(db, () => {
    const key = canonicalRecordKey(operation);
    const current = readCanonicalRecord(db, key) ?? null;
    if (current === null || current.phase !== 'executing') return { kind: 'advanced', current };
    if (!sameRetryOwnership(current, expectedRetryOwnership)) {
      return current.lastError === null
        ? { kind: 'already-completed', current }
        : { kind: 'retry-superseded', current };
    }

    const next: ExecutingProviderOperationRecord = {
      ...current,
      revision: current.revision + 1,
      retryCount: 0,
      retryNotBeforeMs: completedAtMs,
      lastError: null,
    };
    const write = db
      .prepare<[string, string, string]>('UPDATE meta SET value = ? WHERE key = ? AND value = ?')
      .run(encodeProviderOperationRecord(next), key, encodeProviderOperationRecord(current));
    if (write.changes !== 1) {
      throw new ProviderOperationJournalError(
        `Provider operation attachment completion changed ${String(write.changes)} rows instead of one.`,
      );
    }
    deleteDueEntry(db, current);
    return { kind: 'completed', record: next };
  });
  if (result.kind === 'completed') {
    notifyProviderOperationMutation(db, { kind: 'upserted', record: result.record });
  }
  return result;
}

export function deleteProviderOperation(
  db: Database,
  expected: ProviderOperationRecord,
): ProviderOperationDeleteResult {
  const expectedEncoded = encodeProviderOperationRecord(expected);
  const result: ProviderOperationDeleteResult = inWriteTransaction(db, () => {
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
  if (result.kind === 'deleted') notifyProviderOperationMutation(db, { kind: 'deleted', record: expected });
  return result;
}
