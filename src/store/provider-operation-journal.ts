import { z } from 'zod';

import { withImmediate, type Database } from './db.js';
import {
  decodeProviderOperationRecord,
  encodeProviderOperationRecord,
  providerOperationIdentitySchema,
  PROVIDER_OPERATION_RECORD_VERSION,
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

function sagaPrefix(version: number): string {
  return `provider_operation_saga.v${version}:`;
}

function escapeKeyPrefix(prefix: string): string {
  return prefix.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const PROVIDER_OPERATION_SAGA_PREFIX = sagaPrefix(PROVIDER_OPERATION_RECORD_VERSION);
const PROVIDER_OPERATION_RECORD_PREFIX = `${PROVIDER_OPERATION_SAGA_PREFIX}record:`;
const PROVIDER_OPERATION_DUE_PREFIX = `${PROVIDER_OPERATION_SAGA_PREFIX}due:`;

/**
 * Generations this build addresses but cannot decode.
 *
 * Their rows are scanned for their **keys only** and never for their bytes. A key names the job
 * (`providerOperationJobIdFromRecordKey`), and that is the whole requirement: an operation an older build left
 * in flight must keep its job away from generic recovery across the upgrade. What the row means is not this
 * reader's to guess, and guessing is what a converting upcaster would be.
 *
 * Empty is a legitimate value. A generation belongs here only while a build that wrote it can still have left
 * rows behind; once that build is out of the field the entry is deleted, not kept for symmetry.
 *
 * These rows do not accumulate forever. `readSupersededProviderOperations` reads the one thing every
 * generation records the same way — the pids — and startup retires a row whose processes are all absent, so
 * the fence it holds is released and its job settles through ordinary recovery.
 */
const SUPERSEDED_PROVIDER_OPERATION_RECORD_VERSIONS: readonly number[] = [1];
const SUPERSEDED_PROVIDER_OPERATION_RECORD_PREFIXES: readonly string[] =
  SUPERSEDED_PROVIDER_OPERATION_RECORD_VERSIONS.map((version) => `${sagaPrefix(version)}record:`);

const PROVIDER_OPERATION_READ_PAGE_SIZE = 128;
const FIXED_WIDTH_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
const UUID_KEY_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDENTITY_KEY_SOURCE = `${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}`;
const PROVIDER_OPERATION_RECORD_KEY_PATTERN = new RegExp(
  `^${escapeKeyPrefix(PROVIDER_OPERATION_RECORD_PREFIX)}${IDENTITY_KEY_SOURCE}$`,
  'u',
);
/** Every generation's canonical record key, each capturing the job id it names. */
const RECORD_KEY_PATTERNS: readonly RegExp[] = [
  PROVIDER_OPERATION_RECORD_PREFIX,
  ...SUPERSEDED_PROVIDER_OPERATION_RECORD_PREFIXES,
].map(
  (prefix) =>
    new RegExp(
      `^${escapeKeyPrefix(prefix)}(${UUID_KEY_SOURCE}):${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}:${UUID_KEY_SOURCE}$`,
      'u',
    ),
);
const PROVIDER_OPERATION_DUE_KEY_PATTERN = new RegExp(
  `^${escapeKeyPrefix(PROVIDER_OPERATION_DUE_PREFIX)}[0-9]{${FIXED_WIDTH_INTEGER_DIGITS}}:` +
    `${IDENTITY_KEY_SOURCE}:[0-9]{${FIXED_WIDTH_INTEGER_DIGITS}}$`,
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

/** Whether this build can decode the value at a canonical key. Shared by both scans so "unreadable" means one
 *  thing: the row a record scan skips is exactly the row a due scan must not fault on. */
function canReadCanonicalValue(key: string, value: string): boolean {
  try {
    decodeCanonicalValue(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The job a canonical key names, without decoding the value — the only identity available for a row this
 *  build cannot read, and the one startup ownership needs to keep that job away from generic recovery. */
export function providerOperationJobIdFromRecordKey(key: string): string | null {
  // The *whole* canonical shape, not just the prefix and the first segment. A key like
  // `<prefix>:<real-job-uuid>:garbage` would otherwise hand back a real job id and fence that unrelated job
  // for as long as the row exists — a malformed row taking a healthy job down with it.
  const match = RECORD_KEY_PATTERNS.map((pattern) => pattern.exec(key)).find((result) => result !== null);
  return match?.[1] ?? null;
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
 * run. That distinction is not hypothetical \u2014 every scan caller sits on a path that ends at the
 * coordinator's own startup.
 *
 * The scan reaches superseded generations too, and only their keys. A row an older build left in flight names
 * its job in the key, which is exactly what startup ownership needs to keep that job away from generic
 * recovery; the bytes stay unread because converting them would be a guess about someone else's shape.
 *
 * Unreadable rows are reported as keys, never as bytes. They are also left in place. Nothing is lost by
 * skipping one \u2014 the row stays, and a build that understands it can still act on it.
 */
export type ProviderOperationScan = Readonly<{
  records: readonly ProviderOperationRecord[];
  unreadableKeys: readonly string[];
}>;

function forEachRowUnderPrefix(db: Database, prefix: string, visit: (row: MetaRow) => void): void {
  let cursor = prefix;
  for (;;) {
    const rows = db
      .prepare<[string, string, number], MetaRow>(
        `SELECT key, value FROM meta
         WHERE key > ? AND key < ?
         ORDER BY key
         LIMIT ?`,
      )
      .all(cursor, `${prefix}\uffff`, PROVIDER_OPERATION_READ_PAGE_SIZE);
    for (const row of rows) visit(row);
    if (rows.length < PROVIDER_OPERATION_READ_PAGE_SIZE) return;
    cursor = rows.at(-1)?.key ?? cursor;
  }
}

/**
 * The pids a superseded row names, and nothing else it says.
 *
 * A generation this build cannot decode is still not opaque: every generation of this record has carried the
 * same three process locators plus an optional provider root, and a **pid is readable without trusting
 * anything else in the row**. That is the whole observation this permissive shape exists to take. It reads no
 * start time, no incarnation and no phase — the fields whose meaning changed are exactly the fields it must
 * not interpret, and `.passthrough()` is what lets the rest of the row stay unread rather than rejected.
 *
 * `pids: null` means the row could not even be walked for pids. That is not absence and must never be treated
 * as it: an unwalkable row keeps its fence.
 */
const supersededProcessSchema = z.object({ pid: z.number().int().nonnegative().safe() }).passthrough();
const supersededRecordSchema = z
  .object({
    locator: z
      .object({
        proxy: supersededProcessSchema,
        guardian: supersededProcessSchema,
        reaper: supersededProcessSchema,
      })
      .passthrough(),
    providerRoot: supersededProcessSchema.optional(),
  })
  .passthrough();

export type SupersededProviderOperationRow = Readonly<{
  key: string;
  jobId: string;
  pids: readonly number[] | null;
}>;

export function readSupersededProviderOperations(db: Database): readonly SupersededProviderOperationRow[] {
  const rows: SupersededProviderOperationRow[] = [];
  for (const prefix of SUPERSEDED_PROVIDER_OPERATION_RECORD_PREFIXES) {
    forEachRowUnderPrefix(db, prefix, (row) => {
      const jobId = providerOperationJobIdFromRecordKey(row.key);
      if (jobId === null) return;
      rows.push({ key: row.key, jobId, pids: observableProcessIds(row.value) });
    });
  }
  return rows;
}

function observableProcessIds(value: string): readonly number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = supersededRecordSchema.safeParse(parsed);
  if (!result.success) return null;
  const { locator, providerRoot } = result.data;
  const pids: number[] = [locator.proxy.pid, locator.guardian.pid, locator.reaper.pid];
  if (providerRoot !== undefined) pids.push(providerRoot.pid);
  return [...new Set(pids)].filter((pid) => pid > 0);
}

/**
 * Removes one superseded row and every due entry pointing at it, in one transaction.
 *
 * Deleting the record is what *unfences* its job: startup ownership derives the fence from the rows present,
 * so once this row is gone the job reaches ordinary recovery and settles the way any interrupted job does.
 * That is the point — this build has no way to settle a provider operation it cannot read, and it does not
 * need one. It only needs to stop claiming ownership it cannot exercise.
 */
export function retireSupersededProviderOperation(db: Database, key: string): void {
  withImmediate(db, () => {
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(key);
    for (const prefix of SUPERSEDED_PROVIDER_OPERATION_RECORD_PREFIXES) {
      const duePrefix = `${prefix.slice(0, prefix.length - 'record:'.length)}due:`;
      db.prepare<[string, string, string]>('DELETE FROM meta WHERE key > ? AND key < ? AND value = ?').run(
        duePrefix,
        `${duePrefix}\uffff`,
        key,
      );
    }
  });
}

export function readProviderOperations(db: Database): ProviderOperationScan {
  const records: ProviderOperationRecord[] = [];
  const unreadableKeys: string[] = [];
  forEachRowUnderPrefix(db, PROVIDER_OPERATION_RECORD_PREFIX, (row) => {
    try {
      records.push(decodeCanonicalValue(row.key, row.value));
    } catch {
      unreadableKeys.push(row.key);
    }
  });
  for (const prefix of SUPERSEDED_PROVIDER_OPERATION_RECORD_PREFIXES) {
    forEachRowUnderPrefix(db, prefix, (row) => unreadableKeys.push(row.key));
  }
  return { records, unreadableKeys };
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
  const upperBound = `${PROVIDER_OPERATION_DUE_PREFIX}${encodedNow};`;
  const page = db.prepare<[string, string, number], MetaRow>(
    `SELECT key, value FROM meta
       WHERE key > ? AND key < ?
       ORDER BY key
       LIMIT ?`,
  );

  // Paged until `limit` *selectable* rows are found, not until `limit` rows are read. Due keys sort by retry
  // time, so rows this build cannot use sort to the front — an older build's are the oldest there are. Taking
  // one page and filtering afterwards would hand back nothing while readable work sat immediately behind them,
  // on every poll, forever: the reconciler reads an empty selection as "nothing due" and never advances.
  const selections: ProviderOperationDueSelection[] = [];
  let cursor = PROVIDER_OPERATION_DUE_PREFIX;
  while (selections.length < limit) {
    const rows = page.all(cursor, upperBound, limit - selections.length);
    if (rows.length === 0) break;
    cursor = rows.at(-1)?.key ?? cursor;
    for (const row of rows) {
      const due = decodeDueEntry(row);
      const value = readCanonicalValue(db, due.recordKey);
      if (value !== undefined && !canReadCanonicalValue(due.recordKey, value)) {
        // A pointer to a record this build cannot read. There is no work here for it to do, and throwing takes
        // the whole coordinator down — the reconciler classifies a due-scan failure as fatal — which is the
        // trade `readProviderOperations` already refused for the record itself. Quiet on purpose: this is the
        // same canonical row that scan skips, and it reports the key once at startup. Reporting again here
        // would name it twice for one condition.
        continue;
      }
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
      selections.push({ rawKey: row.key, rawValue: row.value, record });
    }
  }
  return selections;
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
