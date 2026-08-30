import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { errorNumber } from '../infra/error-number.js';
import { DirectoryLockOwnershipLostError } from '../infra/fs-lock.js';
import type { SqliteDatabasePort, StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { canonicalContractJson, type CanonicalContractValue } from '../infra/persisted-contract.js';

export const SQLITE_BUSY = 5;
export const SQLITE_FULL = 13;
export const SQLITE_NOTADB = 26;
export const SQLITE_CORRUPT = 11;
export const SQLITE_ERROR = 1;
const HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH = 10;
export const HANDOFF_ROUTING_STATUS_GENERATION_BAND = {
  minimum: 10 ** (HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH - 1),
  // `PRAGMA user_version` cannot store a value above the signed 32-bit maximum.
  maximum: Math.min(10 ** HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH - 1, 2 ** 31 - 1),
  decimalWidth: HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH,
} as const;
const HANDOFF_ROUTING_STATUS_QUARANTINE_DIRECTORY = 'handoff-routing-quarantine';
export const MAX_HANDOFF_ROUTING_STATUS_QUARANTINES = 16;
const MAX_HANDOFF_ROUTING_STATUS_QUARANTINE_FILES = MAX_HANDOFF_ROUTING_STATUS_QUARANTINES * 2 + 1;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HandoffRoutingStatusQuarantineArtifact = 'database' | 'wal';

export type HandoffRoutingStatusQuarantineEntry = Readonly<{
  id: string;
  quarantinePath: string;
  state: 'complete' | 'incomplete';
  artifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
}>;

export type HandoffRoutingStatusQuarantineList =
  | Readonly<{
      kind: 'listed';
      entries: readonly HandoffRoutingStatusQuarantineEntry[];
      overflow: boolean;
    }>
  | Readonly<{
      kind: 'undeterminable';
      cause: 'root-observation-failed' | 'directory-read-failed';
      errcode: number;
    }>;

export type HandoffRoutingStatusQuarantineAffectedArtifact = HandoffRoutingStatusQuarantineArtifact | 'shm';
export type HandoffRoutingStatusQuarantineSyncedDirectory = 'source' | 'quarantine';

type HandoffRoutingStatusQuarantineStorageEffects = Readonly<{
  quarantineId: string;
  quarantinePath: string;
  movedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
  observedMovedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
  removedArtifacts: readonly HandoffRoutingStatusQuarantineAffectedArtifact[];
  observedRemovedArtifacts: readonly HandoffRoutingStatusQuarantineAffectedArtifact[];
  syncedDirectories: readonly HandoffRoutingStatusQuarantineSyncedDirectory[];
}>;

type HandoffRoutingStatusQuarantineStorageFailureCause =
  | 'artifact-move-failed'
  | 'directory-sync-failed'
  | 'ownership-lost'
  | 'root-create-failed';

export type HandoffRoutingStatusQuarantineResult =
  | Readonly<{
      kind: 'quarantined';
      quarantineId: string;
      quarantinePath: string;
      retainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
    }>
  | Readonly<{
      kind: 'quarantined-incomplete';
      quarantineId: string;
      quarantinePath: string;
      retainedArtifacts: readonly ['wal'];
    }>
  | Readonly<{ kind: 'incomplete-quarantine'; quarantineId: string }>
  | Readonly<{
      kind: 'quarantine-coordinate-occupied';
      quarantineId: string;
      quarantinePath: string;
      artifact: HandoffRoutingStatusQuarantineArtifact;
    }>
  | Extract<HandoffRoutingStatusQuarantineList, { kind: 'undeterminable' }>
  | Readonly<{ kind: 'undeterminable'; cause: 'artifact-observation-failed'; errcode: number }>
  | (HandoffRoutingStatusQuarantineStorageEffects &
      Readonly<{
        kind: 'quarantine-storage-failed';
        retainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
        cause: HandoffRoutingStatusQuarantineStorageFailureCause;
      }>)
  | (HandoffRoutingStatusQuarantineStorageEffects &
      Readonly<{
        kind: 'quarantine-storage-failed';
        retainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
        cause: 'artifact-observation-failed';
        errcode: number;
      }>)
  | (HandoffRoutingStatusQuarantineStorageEffects &
      Readonly<{
        kind: 'quarantine-retention-undeterminable';
        observedRetainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
      }> &
      (
        | Readonly<{ cause: 'artifact-observation-failed'; errcode: number }>
        | Readonly<{ cause: 'directory-sync-failed' }>
        | Readonly<{ cause: 'ownership-lost' }>
      ));

export type HandoffRoutingStatusQuarantineClearStoreResult =
  | Readonly<{ kind: 'cleared'; entry: HandoffRoutingStatusQuarantineEntry }>
  | Readonly<{ kind: 'quarantine-not-found'; quarantineId: string }>
  | Readonly<{
      kind: 'quarantine-clear-undeterminable';
      quarantineId: string;
      quarantinePath: string;
      artifact: HandoffRoutingStatusQuarantineArtifact;
      errcode: number;
    }>
  | Readonly<{
      kind: 'quarantine-clear-storage-failed';
      quarantineId: string;
      quarantinePath: string;
      removedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
      observedRemovedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
      syncedDirectories: readonly HandoffRoutingStatusQuarantineSyncedDirectory[];
      cause: 'artifact-remove-failed' | 'directory-sync-failed' | 'ownership-lost';
    }>;

export class HandoffRoutingStatusQuarantineCapacityError extends Error {}

export type HandoffRoutingRecordKind = 'selection' | 'terminal' | 'retirement';

export type HandoffRoutingStatusBodyVocabulary = Readonly<{
  completedPairStability: Readonly<{
    selectionDispositionKind: string;
    selectionBasisKinds: readonly string[];
    terminalDispositionKind: string;
  }>;
}>;

export type HandoffRoutingStatusStoreDurableFormat = Readonly<{
  maximumIdentifierLength: number;
  maximumObservedAtLength: number;
  maximumRoutingSelectedBytes: number;
  maximumExecutionFailedBytes: number;
  maximumContinuationFinalizedBytes: number;
  maximumRetirementTombstoneBytes: number;
  closingRecordBytes: number;
  recordContracts: Readonly<Record<HandoffRoutingRecordKind, CanonicalContractValue>>;
  bodyVocabulary: HandoffRoutingStatusBodyVocabulary;
}>;

export type HandoffRoutingStatusStoreOperationalCapacity = Readonly<{
  // Capacity tuning must not move the address of data that remains decodable.
  maximumBytes: number;
}>;

export type HandoffRoutingStatusStoreSchema = Readonly<{
  durableFormat: HandoffRoutingStatusStoreDurableFormat;
  operational: HandoffRoutingStatusStoreOperationalCapacity;
  validateRecordBody: (record: HandoffRoutingRecordInput) => HandoffRoutingRecordValidationResult;
}>;

export type HandoffRoutingRecordValidationResult =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{ kind: 'malformed-json' }>
  | Readonly<{ kind: 'schema-violation' }>
  | Readonly<{ kind: 'envelope-body-disagreement' }>;

export type HandoffRoutingRecordValidationFailure = Exclude<
  HandoffRoutingRecordValidationResult,
  Readonly<{ kind: 'valid' }>
>;

export type HandoffRoutingRecordInput = Readonly<{
  generation: number;
  sequence: number;
  eventId: string;
  invocationId: string;
  observedAt: string;
  recordKind: HandoffRoutingRecordKind;
  eventKind: 'routing-selected' | 'execution-failed' | 'continuation-finalized' | 'retirement-tombstone';
  selectionSequence: number | null;
  retirementCause: 'selection-evicted-at-capacity' | 'completed-pair-compaction' | 'operator-resolved' | null;
  terminalExisted: boolean | null;
  bodyJson: string;
}>;

const DURABLE_VOCABULARY_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function sqlVocabularyLiteral(value: string): string {
  if (!DURABLE_VOCABULARY_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('Routing-status durable vocabulary contains an unsafe identifier.');
  }
  return `'${value}'`;
}

function completedPairStableSql(vocabulary: HandoffRoutingStatusBodyVocabulary): string {
  const stability = vocabulary.completedPairStability;
  const selectionDisposition = sqlVocabularyLiteral(stability.selectionDispositionKind);
  const selectionBases = stability.selectionBasisKinds.map(sqlVocabularyLiteral).join(', ');
  const terminalDisposition = sqlVocabularyLiteral(stability.terminalDispositionKind);
  return `(
    (
      json_extract(selection.body_json, '$.disposition.kind') = ${selectionDisposition} AND
      json_extract(selection.body_json, '$.disposition.basis.kind') IN (${selectionBases})
    ) OR json_extract(terminal.body_json, '$.disposition.kind') = ${terminalDisposition}
  )`;
}

export type HandoffRoutingRetirementHistoryRow = Readonly<{
  generation: number;
  expired_identity_count: number;
  capacity_eviction_count: number;
  completed_pair_compaction_count: number;
  operator_resolved_count: number;
  min_selection_sequence: number | null;
  max_selection_sequence: number | null;
  earliest_selected_at: string | null;
  latest_selected_at: string | null;
}>;

export type HandoffRoutingRetirementHistoryUpdate = Readonly<{
  expiredIdentityCount: number;
  capacityEvictionCount: number;
  completedPairCompactionCount: number;
  operatorResolvedCount: number;
  minSelectionSequence: number | null;
  maxSelectionSequence: number | null;
  earliestSelectedAt: string | null;
  latestSelectedAt: string | null;
}>;

export class HandoffRoutingStoreInvalidRecordError extends Error {
  readonly validation: HandoffRoutingRecordValidationFailure;

  constructor(validation: HandoffRoutingRecordValidationFailure) {
    super();
    this.validation = validation;
  }
}

export class HandoffRoutingStoreUnreadableError extends Error {
  readonly errcode: number;

  constructor(errcode = SQLITE_CORRUPT) {
    super();
    this.errcode = errcode;
  }
}

class HandoffRoutingStorePathObservationError extends Error {
  readonly cause: unknown;
  readonly errcode: number;

  constructor(cause: unknown) {
    super();
    this.cause = cause;
    this.errcode = errorNumber(cause, SQLITE_ERROR);
  }
}

export class HandoffRoutingStatusTransaction {
  readonly #database: SqliteDatabasePort;
  readonly #schema: HandoffRoutingStatusStoreSchema;

  constructor(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema) {
    this.#database = database;
    this.#schema = schema;
  }

  nextRecordSequence(): number {
    const row = this.#database
      .prepare(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'handoff_routing_records'), 0) + 1 AS next",
      )
      .get() as Readonly<{ next: number }>;
    return row.next;
  }

  insertRecord(record: HandoffRoutingRecordInput): number {
    const validation = this.#schema.validateRecordBody(record);
    if (validation.kind !== 'valid') throw new HandoffRoutingStoreInvalidRecordError(validation);
    const inserted = this.#database
      .prepare(
        `INSERT INTO handoff_routing_records (
          generation,
          event_id,
          invocation_id,
          observed_at,
          record_kind,
          event_kind,
          selection_sequence,
          retirement_cause,
          terminal_existed,
          body_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
      )
      .get(
        record.generation,
        record.eventId,
        record.invocationId,
        record.observedAt,
        record.recordKind,
        record.eventKind,
        record.selectionSequence,
        record.retirementCause,
        record.terminalExisted === null ? null : Number(record.terminalExisted),
        record.bodyJson,
      ) as Readonly<{ sequence: number }> | undefined;
    if (inserted?.sequence !== record.sequence) throw new HandoffRoutingStoreUnreadableError();
    return inserted.sequence;
  }

  recordBody(invocationId: string, recordKind: HandoffRoutingRecordKind): string | undefined {
    const row = this.#database
      .prepare('SELECT body_json FROM handoff_routing_records WHERE invocation_id = ? AND record_kind = ?')
      .get(invocationId, recordKind) as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  insertClosingReserve(invocationId: string, eventId: string, observedAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO handoff_routing_closing_reserve (invocation_id, event_id, observed_at, allocation)
        VALUES (?, ?, ?, zeroblob(?))`,
      )
      .run(invocationId, eventId, observedAt, this.#schema.durableFormat.closingRecordBytes);
  }

  releaseClosingReserve(invocationId: string): boolean {
    return (
      this.#database.prepare('DELETE FROM handoff_routing_closing_reserve WHERE invocation_id = ?').run(invocationId)
        .changes === 1
    );
  }

  readRetirementHistory(): HandoffRoutingRetirementHistoryRow | undefined {
    return readRetirementHistory(this.#database);
  }

  updateRetirementHistory(update: HandoffRoutingRetirementHistoryUpdate): void {
    this.#database
      .prepare(
        `UPDATE handoff_routing_metadata SET
          expired_identity_count = ?,
          capacity_eviction_count = ?,
          completed_pair_compaction_count = ?,
          operator_resolved_count = ?,
          min_selection_sequence = ?,
          max_selection_sequence = ?,
          earliest_selected_at = ?,
          latest_selected_at = ?
        WHERE singleton = 1`,
      )
      .run(
        update.expiredIdentityCount,
        update.capacityEvictionCount,
        update.completedPairCompactionCount,
        update.operatorResolvedCount,
        update.minSelectionSequence,
        update.maxSelectionSequence,
        update.earliestSelectedAt,
        update.latestSelectedAt,
      );
  }

  deleteRecord(sequence: number): void {
    this.#database.prepare('DELETE FROM handoff_routing_records WHERE sequence = ?').run(sequence);
  }

  deleteInvocationRecords(invocationId: string): void {
    this.#database.prepare('DELETE FROM handoff_routing_records WHERE invocation_id = ?').run(invocationId);
  }

  tombstoneBounds(): Readonly<{ count: number; bytes: number }> {
    return this.#database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(encoded_bytes), 0) AS bytes
        FROM handoff_routing_records WHERE record_kind = 'retirement'`,
      )
      .get() as Readonly<{ count: number; bytes: number }>;
  }

  oldestTombstoneBody(): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT body_json FROM handoff_routing_records
        WHERE record_kind = 'retirement'
        ORDER BY selection_sequence, invocation_id
        LIMIT 1`,
      )
      .get() as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  oldestCompletedSelectionBody(): string | undefined {
    const completedPairStable = completedPairStableSql(this.#schema.durableFormat.bodyVocabulary);
    const row = this.#database
      .prepare(
        `WITH latest_stable_pair AS (
          SELECT selection.sequence
          FROM handoff_routing_records AS selection
          JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
          WHERE selection.record_kind = 'selection'
            AND terminal.record_kind = 'terminal'
            AND ${completedPairStable}
          ORDER BY selection.sequence DESC
          LIMIT 1
        )
        SELECT selection.body_json
        FROM handoff_routing_records AS selection
        JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
        WHERE selection.record_kind = 'selection'
          AND terminal.record_kind = 'terminal'
          AND selection.sequence != COALESCE((SELECT sequence FROM latest_stable_pair), 0)
        ORDER BY selection.sequence
        LIMIT 1`,
      )
      .get() as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  hasAdmissionCapacity(recordBytes: number): boolean {
    const pageSize = this.#pragmaNumber('page_size');
    const pageCount = this.#pragmaNumber('page_count');
    const freeListCount = this.#database.prepare('PRAGMA freelist_count').get() as Readonly<{
      freelist_count: number;
    }>;
    const maxPageCount = this.#pragmaNumber('max_page_count');
    const availableBytes = (maxPageCount - pageCount + freeListCount.freelist_count) * pageSize;
    const maximumIdentifierBytes = Buffer.byteLength(
      '\u0800'.repeat(this.#schema.durableFormat.maximumIdentifierLength),
      'utf8',
    );
    const indexedEnvelopeBytes = maximumIdentifierBytes * 4 + this.#schema.durableFormat.maximumObservedAtLength * 2;
    const btreeAllocationMarginBytes = pageSize * 8;
    return availableBytes >= recordBytes + indexedEnvelopeBytes + btreeAllocationMarginBytes;
  }

  deleteOldestBoundedTerminal(): boolean {
    return (
      this.#database
        .prepare(
          `DELETE FROM handoff_routing_records
          WHERE sequence = (
            SELECT terminal.sequence
            FROM handoff_routing_records AS terminal
            WHERE terminal.record_kind = 'terminal'
              AND NOT EXISTS (
                SELECT 1 FROM handoff_routing_records AS selection
                WHERE selection.invocation_id = terminal.invocation_id AND selection.record_kind = 'selection'
              )
            ORDER BY terminal.sequence
            LIMIT 1
          )`,
        )
        .run().changes === 1
    );
  }

  boundedTerminalCount(): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
        FROM handoff_routing_records AS terminal
        WHERE terminal.record_kind = 'terminal'
          AND NOT EXISTS (
            SELECT 1 FROM handoff_routing_records AS selection
            WHERE selection.invocation_id = terminal.invocation_id AND selection.record_kind = 'selection'
          )`,
      )
      .get() as Readonly<{ count: number }>;
    return row.count;
  }

  completedSelectionBodiesForCompaction(limit: number, cutoff: string): readonly string[] {
    const completedPairStable = completedPairStableSql(this.#schema.durableFormat.bodyVocabulary);
    const rows = this.#database
      .prepare(
        `WITH completed_pairs AS MATERIALIZED (
          SELECT
            selection.sequence,
            selection.observed_at,
            selection.body_json,
            ${completedPairStable} AS stable
          FROM handoff_routing_records AS selection
          JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
          WHERE selection.record_kind = 'selection' AND terminal.record_kind = 'terminal'
        ),
        newest_pairs AS (
          SELECT sequence FROM completed_pairs
          ORDER BY sequence DESC
          LIMIT ?
        ),
        latest_stable_pair AS (
          SELECT sequence FROM completed_pairs
          WHERE stable
          ORDER BY sequence DESC
          LIMIT 1
        )
        SELECT body_json
        FROM completed_pairs
        WHERE sequence != COALESCE((SELECT sequence FROM latest_stable_pair), 0)
          AND (
            julianday(observed_at) < julianday(?) OR
            sequence NOT IN (SELECT sequence FROM newest_pairs)
          )
        ORDER BY sequence`,
      )
      .all(limit, cutoff) as ReadonlyArray<Readonly<{ body_json: string }>>;
    return rows.map((row) => row.body_json);
  }

  unresolvedCount(): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
        FROM handoff_routing_records AS selection
        WHERE selection.record_kind = 'selection'
          AND NOT EXISTS (
            SELECT 1 FROM handoff_routing_records AS terminal
            WHERE terminal.invocation_id = selection.invocation_id AND terminal.record_kind = 'terminal'
          )`,
      )
      .get() as Readonly<{ count: number }>;
    return row.count;
  }

  oldestOpeningBody(): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT selection.body_json
        FROM handoff_routing_records AS selection
        WHERE selection.record_kind = 'selection'
          AND NOT EXISTS (
            SELECT 1 FROM handoff_routing_records AS terminal
            WHERE terminal.invocation_id = selection.invocation_id AND terminal.record_kind = 'terminal'
          )
        ORDER BY selection.sequence
        LIMIT 1`,
      )
      .get() as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  eventExists(eventId: string): boolean {
    return (
      this.#database.prepare('SELECT 1 FROM handoff_routing_records WHERE event_id = ?').get(eventId) !== undefined
    );
  }

  #pragmaNumber(name: 'page_size' | 'page_count' | 'max_page_count'): number {
    const row = this.#database.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    const value = row[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new HandoffRoutingStoreUnreadableError();
    return value;
  }
}

export type HandoffRoutingStoreUnreadableReason = 'invalid-json' | 'invalid-shape' | 'too-large';

type HandoffRoutingStoreNonCurrentClassification =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'vacant' }>
  | Readonly<{ kind: 'uninitialized' }>
  | Readonly<{ kind: 'detached-wal' }>
  | Readonly<{ kind: 'generation-missing' }>
  | Readonly<{ kind: 'foreign-generation'; generation: number }>
  | Readonly<{ kind: 'format-mismatch' }>
  | Readonly<{ kind: 'schema-divergent' }>
  | Readonly<{ kind: 'unreadable'; reason: HandoffRoutingStoreUnreadableReason }>
  | Readonly<{ kind: 'undeterminable'; cause: 'io-failed'; errcode: number }>;

export type HandoffRoutingStoreClassification<T> =
  | HandoffRoutingStoreNonCurrentClassification
  | Readonly<{ kind: 'current'; snapshot: T }>;

export type HandoffRoutingStoreArtifactRefusal = Extract<
  HandoffRoutingStoreClassification<never>,
  {
    kind:
      | 'detached-wal'
      | 'generation-missing'
      | 'foreign-generation'
      | 'format-mismatch'
      | 'schema-divergent'
      | 'unreadable'
      | 'undeterminable';
  }
>;

export type HandoffRoutingStorePublication<T> =
  | Readonly<{ kind: 'committed'; value: T }>
  | Readonly<{ kind: 'artifact-refused'; classification: HandoffRoutingStoreArtifactRefusal }>
  | Readonly<{ kind: 'failed'; error: unknown; commitStarted: boolean }>;

export type HandoffRoutingStoreSnapshot = Readonly<{
  rows: readonly unknown[];
  reserves: readonly unknown[];
  retirement: HandoffRoutingRetirementHistoryRow | undefined;
}>;

export type HandoffRoutingStoreBodyAdmission<T> = (
  snapshot: HandoffRoutingStoreSnapshot,
) =>
  | Readonly<{ kind: 'admitted'; snapshot: T }>
  | Readonly<{ kind: 'unreadable'; reason: HandoffRoutingStoreUnreadableReason }>;

export type HandoffRoutingStorePublicationPolicy = (
  classification: HandoffRoutingStoreClassification<unknown>,
) => 'initialize' | 'mutate' | 'refuse';

type HandoffRoutingWalStatReceipt = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}>;

export type HandoffRoutingWalObservationReceipt =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'zero'; stat: HandoffRoutingWalStatReceipt }>
  | Readonly<{ kind: 'non-empty'; stat: HandoffRoutingWalStatReceipt }>;

type HandoffRoutingStorePathObservation =
  | Readonly<{
      kind: 'observed';
      disposition: 'absent' | 'vacant' | 'detached-wal' | 'sqlite';
      mainState: 'absent' | 'zero' | 'non-empty';
      walReceipt: HandoffRoutingWalObservationReceipt;
    }>
  | Readonly<{ kind: 'undeterminable'; error: unknown }>;

type HandoffRoutingPathObservation =
  | Readonly<{ kind: 'present'; stat: StorageBigIntStat }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'undeterminable'; error: HandoffRoutingStorePathObservationError }>;

function observeHandoffRoutingPath(storage: StoragePort, path: string): HandoffRoutingPathObservation {
  try {
    return { kind: 'present', stat: storage.statSync(path, { bigint: true }) };
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'undeterminable', error: new HandoffRoutingStorePathObservationError(error) };
  }
}

// Node 24 `node:sqlite` unlinked a frames-bearing wal beside a zero-byte main after a read-only open and
// `PRAGMA user_version`, so the main/wal product must be decided before any SQLite open.
function observeHandoffRoutingStorePath(storage: StoragePort, path: string): HandoffRoutingStorePathObservation {
  const mainObservation = observeHandoffRoutingPath(storage, path);
  if (mainObservation.kind === 'undeterminable') return mainObservation;
  const main = mainObservation.kind === 'absent' ? 'absent' : mainObservation.stat.size === 0n ? 'zero' : 'non-empty';

  let walReceipt: HandoffRoutingWalObservationReceipt;
  const walObservation = observeHandoffRoutingPath(storage, `${path}-wal`);
  if (walObservation.kind === 'undeterminable') return walObservation;
  if (walObservation.kind === 'absent') {
    walReceipt = { kind: 'absent' };
  } else {
    const wal = walObservation.stat;
    const stat = { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs };
    walReceipt = wal.size === 0n ? { kind: 'zero', stat } : { kind: 'non-empty', stat };
  }

  if (main !== 'non-empty' && walReceipt.kind === 'non-empty') {
    return { kind: 'observed', disposition: 'detached-wal', mainState: main, walReceipt };
  }
  if (main === 'absent') return { kind: 'observed', disposition: 'absent', mainState: main, walReceipt };
  if (main === 'zero') return { kind: 'observed', disposition: 'vacant', mainState: main, walReceipt };
  return { kind: 'observed', disposition: 'sqlite', mainState: main, walReceipt };
}

function undeterminableClassification(
  error: unknown,
): Extract<HandoffRoutingStoreClassification<never>, { kind: 'undeterminable' }> {
  return {
    kind: 'undeterminable',
    cause: 'io-failed',
    errcode:
      error instanceof HandoffRoutingStorePathObservationError ? error.errcode : errorNumber(error, SQLITE_ERROR),
  };
}

function unreadableOrUndeterminableClassification(
  error: unknown,
): Extract<HandoffRoutingStoreClassification<never>, { kind: 'unreadable' | 'undeterminable' }> {
  if (error instanceof HandoffRoutingStoreUnreadableError) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }
  const reportedError = error as { readonly errcode?: unknown; readonly errno?: unknown } | null;
  const reportedErrcode =
    typeof reportedError?.errcode === 'number' && Number.isInteger(reportedError.errcode)
      ? reportedError.errcode
      : typeof reportedError?.errno === 'number' && Number.isInteger(reportedError.errno)
        ? reportedError.errno
        : undefined;
  if (reportedErrcode === undefined) {
    const errcode = errorNumber(error, SQLITE_ERROR);
    return { kind: 'undeterminable', cause: 'io-failed', errcode };
  }
  const errcode = reportedErrcode;
  const primaryErrcode = errcode & 0xff;
  return primaryErrcode === SQLITE_ERROR || primaryErrcode === SQLITE_NOTADB || primaryErrcode === SQLITE_CORRUPT
    ? { kind: 'unreadable', reason: 'invalid-shape' }
    : { kind: 'undeterminable', cause: 'io-failed', errcode };
}

function preflightClassification(
  observation: HandoffRoutingStorePathObservation,
): Extract<
  HandoffRoutingStoreClassification<never>,
  { kind: 'absent' | 'vacant' | 'detached-wal' | 'undeterminable' }
> | null {
  if (observation.kind === 'undeterminable') return undeterminableClassification(observation.error);
  switch (observation.disposition) {
    case 'absent':
      return { kind: 'absent' };
    case 'vacant':
      return { kind: 'vacant' };
    case 'detached-wal':
      return { kind: 'detached-wal' };
    case 'sqlite':
      return null;
  }
}

function quarantineRoot(path: string): string {
  return join(dirname(path), HANDOFF_ROUTING_STATUS_QUARANTINE_DIRECTORY);
}

function quarantineArtifact(
  fileName: string,
  databaseName: string,
): Readonly<{ id: string; artifact: HandoffRoutingStatusQuarantineArtifact }> | null {
  const prefix = `${databaseName}.`;
  if (!fileName.startsWith(prefix)) return null;
  const remainder = fileName.slice(prefix.length);
  const suffix = remainder.endsWith('-wal') ? '-wal' : '';
  const id = suffix === '' ? remainder : remainder.slice(0, -suffix.length);
  if (!CANONICAL_UUID_PATTERN.test(id)) return null;
  return { id, artifact: suffix === '-wal' ? 'wal' : 'database' };
}

export function listHandoffRoutingStoreQuarantines(
  storage: StoragePort,
  path: string,
): HandoffRoutingStatusQuarantineList {
  const root = quarantineRoot(path);
  const rootObservation = observeHandoffRoutingPath(storage, root);
  if (rootObservation.kind === 'absent') return { kind: 'listed', entries: [], overflow: false };
  if (rootObservation.kind === 'undeterminable' || !rootObservation.stat.isDirectory()) {
    return {
      kind: 'undeterminable',
      cause: 'root-observation-failed',
      errcode: rootObservation.kind === 'undeterminable' ? rootObservation.error.errcode : SQLITE_ERROR,
    };
  }
  let bounded: ReturnType<StoragePort['readDirectoryBoundedSync']>;
  try {
    bounded = storage.readDirectoryBoundedSync(root, MAX_HANDOFF_ROUTING_STATUS_QUARANTINE_FILES);
  } catch (error: unknown) {
    const repeatedObservation = observeHandoffRoutingPath(storage, root);
    if (repeatedObservation.kind === 'absent') return { kind: 'listed', entries: [], overflow: false };
    return {
      kind: 'undeterminable',
      cause: 'directory-read-failed',
      errcode:
        repeatedObservation.kind === 'undeterminable'
          ? repeatedObservation.error.errcode
          : errorNumber(error, SQLITE_ERROR),
    };
  }
  const artifactsById = new Map<string, Set<HandoffRoutingStatusQuarantineArtifact>>();
  for (const fileName of bounded.entries) {
    const parsed = quarantineArtifact(fileName, basename(path));
    if (parsed === null) continue;
    const artifacts = artifactsById.get(parsed.id) ?? new Set<HandoffRoutingStatusQuarantineArtifact>();
    artifacts.add(parsed.artifact);
    artifactsById.set(parsed.id, artifacts);
  }
  const artifactOrder: readonly HandoffRoutingStatusQuarantineArtifact[] = ['database', 'wal'];
  const entries = [...artifactsById.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, artifacts]): HandoffRoutingStatusQuarantineEntry => ({
        id,
        quarantinePath: join(root, `${basename(path)}.${id}`),
        state: artifacts.has('database') ? 'complete' : 'incomplete',
        artifacts: artifactOrder.filter((artifact) => artifacts.has(artifact)),
      }),
    );
  return { kind: 'listed', entries, overflow: bounded.overflow };
}

type HandoffRoutingStatusQuarantineMoveObservation =
  | Readonly<{ kind: 'moved' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'occupied' }>
  | Readonly<{
      kind: 'failed';
      cause: 'artifact-move-failed' | 'directory-sync-failed' | 'ownership-lost';
      retention: 'retained' | 'not-retained';
    }>
  | Readonly<{
      kind: 'undeterminable';
      error: HandoffRoutingStorePathObservationError;
      retention: 'retained' | 'not-retained' | 'unknown';
    }>;

type HandoffRoutingStatusMaintenanceState = { mutationAttempted: boolean };

type HandoffRoutingStatusDurabilityBarrierResult<Cause> =
  | Readonly<{ kind: 'durable' }>
  | Readonly<{ kind: 'failed'; cause: Cause }>;

type HandoffRoutingStatusArtifactEffects<Artifact> = Readonly<{
  durableArtifacts: ReadonlySet<Artifact>;
  observedArtifacts: ReadonlySet<Artifact>;
  recordObserved: (artifact: Artifact) => void;
  recordAfterBarrier: <Cause>(
    artifact: Artifact,
    barrier: () => HandoffRoutingStatusDurabilityBarrierResult<Cause>,
  ) => HandoffRoutingStatusDurabilityBarrierResult<Cause>;
}>;

function createHandoffRoutingStatusArtifactEffects<Artifact>(): HandoffRoutingStatusArtifactEffects<Artifact> {
  const durableArtifacts = new Set<Artifact>();
  const observedArtifacts = new Set<Artifact>();
  return {
    durableArtifacts,
    observedArtifacts,
    recordObserved: (artifact) => {
      observedArtifacts.add(artifact);
    },
    recordAfterBarrier: (artifact, barrier) => {
      const result = barrier();
      if (result.kind === 'durable') {
        durableArtifacts.add(artifact);
      } else {
        observedArtifacts.add(artifact);
      }
      return result;
    },
  };
}

type HandoffRoutingIdentityObservation =
  | Readonly<{ kind: 'present'; identity: Readonly<{ dev: bigint; ino: bigint }> }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'undeterminable'; error: HandoffRoutingStorePathObservationError }>;

type HandoffRoutingUnlinkObservation =
  | Readonly<{ kind: 'removed' }>
  | Readonly<{ kind: 'candidate-absent' }>
  | Readonly<{ kind: 'expected-absent' }>
  | Readonly<{ kind: 'occupied' }>
  | Readonly<{ kind: 'undeterminable'; error: HandoffRoutingStorePathObservationError }>;

function attemptHandoffRoutingStatusMutation<T>(state: HandoffRoutingStatusMaintenanceState, mutate: () => T): T {
  state.mutationAttempted = true;
  return mutate();
}

function observeHandoffRoutingIdentity(storage: StoragePort, path: string): HandoffRoutingIdentityObservation {
  const observation = observeHandoffRoutingPath(storage, path);
  return observation.kind === 'present'
    ? { kind: 'present', identity: { dev: observation.stat.dev, ino: observation.stat.ino } }
    : observation;
}

function unlinkHandoffRoutingPathIfIdentityMatches(
  storage: StoragePort,
  path: string,
  expectedIdentity: () => HandoffRoutingIdentityObservation,
  assertOwned: () => void,
  state: HandoffRoutingStatusMaintenanceState,
): HandoffRoutingUnlinkObservation {
  assertOwned();
  const expectedObservation = expectedIdentity();
  const candidateObservation = observeHandoffRoutingIdentity(storage, path);
  if (expectedObservation.kind === 'undeterminable') return expectedObservation;
  if (candidateObservation.kind === 'undeterminable') return candidateObservation;
  if (candidateObservation.kind === 'absent') return { kind: 'candidate-absent' };
  if (expectedObservation.kind === 'absent') return { kind: 'expected-absent' };
  if (
    expectedObservation.identity.dev !== candidateObservation.identity.dev ||
    expectedObservation.identity.ino !== candidateObservation.identity.ino
  ) {
    return { kind: 'occupied' };
  }
  try {
    // Constraint: the maintenance lease makes this operation the sole Coral mutator authorized to replace
    // or delete source or quarantine pathnames. Observational SQLite opens outside the lease may still create
    // or rewrite sidecars, so identity must be re-observed immediately before deletion.
    attemptHandoffRoutingStatusMutation(state, () => storage.unlinkSync(path));
    return { kind: 'removed' };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'candidate-absent' };
    throw error;
  }
}

function moveQuarantineArtifact(
  storage: StoragePort,
  source: string,
  destination: string,
  artifact: HandoffRoutingStatusQuarantineArtifact,
  sourceDirectory: string,
  root: string,
  state: HandoffRoutingStatusMaintenanceState,
  movedArtifactEffects: HandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>,
  syncedDirectories: Set<HandoffRoutingStatusQuarantineSyncedDirectory>,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineMoveObservation {
  const sourceObservation = observeHandoffRoutingPath(storage, source);
  if (sourceObservation.kind === 'undeterminable') {
    return { ...sourceObservation, retention: 'not-retained' };
  }
  if (sourceObservation.kind === 'absent') return sourceObservation;
  try {
    // POSIX link(2) fails with EEXIST instead of replacing the destination, so it can claim a quarantine
    // coordinate atomically where rename(2) cannot.
    attemptHandoffRoutingStatusMutation(state, () => storage.linkSync(source, destination));
  } catch {
    // A reported link failure does not decide whether the destination entry was created.
  }

  const repeatedSourceObservation = observeHandoffRoutingPath(storage, source);
  const repeatedDestinationObservation = observeHandoffRoutingPath(storage, destination);
  if (repeatedDestinationObservation.kind === 'undeterminable') {
    return { ...repeatedDestinationObservation, retention: 'unknown' };
  }
  if (repeatedDestinationObservation.kind === 'absent') {
    if (repeatedSourceObservation.kind === 'undeterminable') {
      return { ...repeatedSourceObservation, retention: 'not-retained' };
    }
    return { kind: 'failed', cause: 'artifact-move-failed', retention: 'not-retained' };
  }
  if (repeatedSourceObservation.kind === 'undeterminable') {
    return { ...repeatedSourceObservation, retention: 'unknown' };
  }
  const sourceAlreadyRemoved = repeatedSourceObservation.kind === 'absent';
  if (
    repeatedSourceObservation.kind === 'present' &&
    (repeatedSourceObservation.stat.dev !== repeatedDestinationObservation.stat.dev ||
      repeatedSourceObservation.stat.ino !== repeatedDestinationObservation.stat.ino)
  ) {
    return { kind: 'occupied' };
  }

  // The quarantine name must be durable before source removal so every crash point retains at least one
  // durable name for the payload.
  if (!syncQuarantineMoveDirectory(storage, root, 'quarantine', state, syncedDirectories)) {
    if (sourceAlreadyRemoved) movedArtifactEffects.recordObserved(artifact);
    return { kind: 'failed', cause: 'directory-sync-failed', retention: 'retained' };
  }
  if (sourceAlreadyRemoved) {
    const durability = movedArtifactEffects.recordAfterBarrier(
      artifact,
      (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed'> =>
        syncQuarantineMoveDirectory(storage, sourceDirectory, 'source', state, syncedDirectories)
          ? { kind: 'durable' }
          : { kind: 'failed', cause: 'directory-sync-failed' },
    );
    if (durability.kind === 'failed') {
      return { kind: 'failed', cause: durability.cause, retention: 'retained' };
    }
    return { kind: 'moved' };
  }
  let unlinkObservation: HandoffRoutingUnlinkObservation;
  try {
    unlinkObservation = unlinkHandoffRoutingPathIfIdentityMatches(
      storage,
      source,
      () => observeHandoffRoutingIdentity(storage, destination),
      assertOwned,
      state,
    );
  } catch (error: unknown) {
    if (error instanceof DirectoryLockOwnershipLostError) {
      return { kind: 'failed', cause: 'ownership-lost', retention: 'retained' };
    }
    return { kind: 'failed', cause: 'artifact-move-failed', retention: 'retained' };
  }
  if (unlinkObservation.kind === 'undeterminable') {
    return { ...unlinkObservation, retention: 'unknown' };
  }
  if (unlinkObservation.kind === 'occupied') return unlinkObservation;
  if (unlinkObservation.kind === 'expected-absent') {
    return { kind: 'failed', cause: 'artifact-move-failed', retention: 'not-retained' };
  }
  const durability = movedArtifactEffects.recordAfterBarrier(
    artifact,
    (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed'> =>
      syncQuarantineMoveDirectory(storage, sourceDirectory, 'source', state, syncedDirectories)
        ? { kind: 'durable' }
        : { kind: 'failed', cause: 'directory-sync-failed' },
  );
  if (durability.kind === 'failed') {
    return { kind: 'failed', cause: durability.cause, retention: 'retained' };
  }
  return { kind: 'moved' };
}

function syncQuarantineMoveDirectory(
  storage: StoragePort,
  directory: string,
  label: HandoffRoutingStatusQuarantineSyncedDirectory,
  state: HandoffRoutingStatusMaintenanceState,
  syncedDirectories: Set<HandoffRoutingStatusQuarantineSyncedDirectory>,
): boolean {
  try {
    const synced = attemptHandoffRoutingStatusMutation(state, () => storage.syncDirectoryDurableSync(directory));
    if (synced) syncedDirectories.add(label);
    return synced;
  } catch {
    return false;
  }
}

function sameWalStat(left: HandoffRoutingWalStatReceipt, right: HandoffRoutingWalStatReceipt): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function movedWalStat(storage: StoragePort, path: string): HandoffRoutingWalStatReceipt {
  const fd = storage.openSync(path, 'r');
  try {
    const stat = storage.fstatSync(fd, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
  } finally {
    storage.closeSync(fd);
  }
}

export type HandoffRoutingStatusQuarantineObservations = Readonly<{
  firstMainState: 'absent' | 'zero' | 'non-empty';
  firstWalReceipt: HandoffRoutingWalObservationReceipt;
  guardedMainState: 'absent' | 'zero' | 'non-empty';
  guardedWalReceipt: HandoffRoutingWalObservationReceipt;
}>;

export function quarantineHandoffRoutingStoreArtifact(
  storage: StoragePort,
  path: string,
  quarantineId: string,
  observations: HandoffRoutingStatusQuarantineObservations,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineResult {
  const sourceDirectory = dirname(path);
  const root = quarantineRoot(path);
  assertOwned();
  const retained = listHandoffRoutingStoreQuarantines(storage, path);
  assertOwned();
  if (retained.kind === 'undeterminable') return retained;
  const retainedCoordinate = retained.entries.find((entry) => entry.id === quarantineId);
  const incomplete = retained.entries.filter((entry) => entry.state === 'incomplete' && entry.id !== quarantineId);
  if (incomplete.length > 1 || retained.overflow) throw new HandoffRoutingStatusQuarantineCapacityError();
  const incompleteEntry = incomplete[0];
  if (incompleteEntry !== undefined) {
    assertOwned();
    return { kind: 'incomplete-quarantine', quarantineId: incompleteEntry.id };
  }
  if (retained.entries.length >= MAX_HANDOFF_ROUTING_STATUS_QUARANTINES && retainedCoordinate === undefined) {
    throw new HandoffRoutingStatusQuarantineCapacityError();
  }
  if (!CANONICAL_UUID_PATTERN.test(quarantineId)) {
    throw new Error('Routing-status quarantine ID must be a canonical lowercase UUID.');
  }
  const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
  for (const [sourcePath, artifactPath, artifact] of [
    [path, quarantinePath, 'database'],
    [`${path}-wal`, `${quarantinePath}-wal`, 'wal'],
  ] as const) {
    const observation = observeHandoffRoutingPath(storage, artifactPath);
    assertOwned();
    if (observation.kind === 'undeterminable') {
      return { kind: 'undeterminable', cause: 'artifact-observation-failed', errcode: observation.error.errcode };
    }
    if (observation.kind === 'present') {
      const sourceObservation = observeHandoffRoutingPath(storage, sourcePath);
      assertOwned();
      if (sourceObservation.kind === 'undeterminable') {
        return {
          kind: 'undeterminable',
          cause: 'artifact-observation-failed',
          errcode: sourceObservation.error.errcode,
        };
      }
      if (
        sourceObservation.kind === 'present' &&
        sourceObservation.stat.dev === observation.stat.dev &&
        sourceObservation.stat.ino === observation.stat.ino
      ) {
        continue;
      }
      return { kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact };
    }
  }
  const state: HandoffRoutingStatusMaintenanceState = { mutationAttempted: false };
  const movedArtifactEffects = createHandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>();
  const removedArtifactEffects =
    createHandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineAffectedArtifact>();
  const retainedArtifacts = new Set<HandoffRoutingStatusQuarantineArtifact>();
  const syncedDirectories = new Set<HandoffRoutingStatusQuarantineSyncedDirectory>();
  const storageFailure = (
    cause: HandoffRoutingStatusQuarantineStorageFailureCause | 'artifact-observation-failed',
    errcode?: number,
  ): HandoffRoutingStatusQuarantineResult => {
    const effects = {
      quarantineId,
      quarantinePath,
      movedArtifacts: [...movedArtifactEffects.durableArtifacts],
      observedMovedArtifacts: [...movedArtifactEffects.observedArtifacts],
      removedArtifacts: [...removedArtifactEffects.durableArtifacts],
      observedRemovedArtifacts: [...removedArtifactEffects.observedArtifacts],
      syncedDirectories: [...syncedDirectories],
    };
    const retainedEffects = {
      ...effects,
      kind: 'quarantine-storage-failed' as const,
      retainedArtifacts: [...retainedArtifacts],
    };
    return cause === 'artifact-observation-failed'
      ? { ...retainedEffects, cause, errcode: errcode ?? SQLITE_ERROR }
      : { ...retainedEffects, cause };
  };
  const retentionUndeterminable = (
    cause:
      | Readonly<{ kind: 'artifact-observation-failed'; error: HandoffRoutingStorePathObservationError }>
      | Readonly<{ kind: 'directory-sync-failed' | 'ownership-lost' }>,
  ): Extract<HandoffRoutingStatusQuarantineResult, { kind: 'quarantine-retention-undeterminable' }> => {
    const effects = {
      kind: 'quarantine-retention-undeterminable' as const,
      quarantineId,
      quarantinePath,
      observedRetainedArtifacts: [...retainedArtifacts],
      movedArtifacts: [...movedArtifactEffects.durableArtifacts],
      observedMovedArtifacts: [...movedArtifactEffects.observedArtifacts],
      removedArtifacts: [...removedArtifactEffects.durableArtifacts],
      observedRemovedArtifacts: [...removedArtifactEffects.observedArtifacts],
      syncedDirectories: [...syncedDirectories],
    };
    return cause.kind === 'artifact-observation-failed'
      ? { ...effects, cause: cause.kind, errcode: cause.error.errcode }
      : { ...effects, cause: cause.kind };
  };
  const ownershipFailureCauseAfterMutation = (): 'ownership-lost' | null => {
    try {
      assertOwned();
      return null;
    } catch (error: unknown) {
      if (!state.mutationAttempted) throw error;
      if (error instanceof DirectoryLockOwnershipLostError) return 'ownership-lost';
      throw error;
    }
  };
  const assertOwnedAfterMutation = (): HandoffRoutingStatusQuarantineResult | null => {
    const cause = ownershipFailureCauseAfterMutation();
    return cause === null ? null : storageFailure(cause);
  };
  try {
    attemptHandoffRoutingStatusMutation(state, () => storage.mkdirSync(root, { recursive: true, mode: 0o700 }));
  } catch {
    return storageFailure('root-create-failed');
  }
  if (!syncQuarantineMoveDirectory(storage, sourceDirectory, 'source', state, syncedDirectories)) {
    return storageFailure('directory-sync-failed');
  }
  const ownershipFailureAfterRoot = assertOwnedAfterMutation();
  if (ownershipFailureAfterRoot !== null) return ownershipFailureAfterRoot;
  let walMove: HandoffRoutingStatusQuarantineMoveObservation;
  try {
    walMove = moveQuarantineArtifact(
      storage,
      `${path}-wal`,
      `${quarantinePath}-wal`,
      'wal',
      sourceDirectory,
      root,
      state,
      movedArtifactEffects,
      syncedDirectories,
      assertOwned,
    );
  } catch {
    return storageFailure('artifact-move-failed');
  }
  if (walMove.kind === 'undeterminable') {
    if (walMove.retention === 'retained') retainedArtifacts.add('wal');
    return walMove.retention === 'unknown'
      ? retentionUndeterminable({ kind: 'artifact-observation-failed', error: walMove.error })
      : storageFailure('artifact-observation-failed', walMove.error.errcode);
  }
  if (walMove.kind === 'occupied') {
    return { kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact: 'wal' };
  }
  if (walMove.kind === 'failed') {
    if (walMove.retention === 'retained') retainedArtifacts.add('wal');
    return storageFailure(walMove.cause);
  }
  const walMoved = walMove.kind === 'moved';
  if (walMoved) {
    retainedArtifacts.add('wal');
    const ownershipFailure = assertOwnedAfterMutation();
    if (ownershipFailure !== null) return ownershipFailure;
    try {
      const movedStat = movedWalStat(storage, `${quarantinePath}-wal`);
      const guardedReceipt = observations.guardedWalReceipt;
      if (
        observations.firstWalReceipt.kind === 'absent' &&
        guardedReceipt.kind === 'zero' &&
        movedStat.size === 0n &&
        sameWalStat(guardedReceipt.stat, movedStat)
      ) {
        const unlinkObservation = unlinkHandoffRoutingPathIfIdentityMatches(
          storage,
          `${quarantinePath}-wal`,
          () => ({ kind: 'present', identity: movedStat }),
          assertOwned,
          state,
        );
        if (unlinkObservation.kind === 'undeterminable') {
          return retentionUndeterminable({ kind: 'artifact-observation-failed', error: unlinkObservation.error });
        }
        if (unlinkObservation.kind === 'occupied' || unlinkObservation.kind === 'expected-absent') {
          return { kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact: 'wal' };
        }
        const removalDurability = removedArtifactEffects.recordAfterBarrier(
          'wal',
          (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed' | 'ownership-lost'> => {
            const ownershipFailure = ownershipFailureCauseAfterMutation();
            if (ownershipFailure !== null) return { kind: 'failed', cause: ownershipFailure };
            return syncQuarantineMoveDirectory(storage, root, 'quarantine', state, syncedDirectories)
              ? { kind: 'durable' }
              : { kind: 'failed', cause: 'directory-sync-failed' };
          },
        );
        if (removalDurability.kind === 'failed') {
          return retentionUndeterminable({ kind: removalDurability.cause });
        }
        retainedArtifacts.delete('wal');
      }
    } catch (error: unknown) {
      if (error instanceof DirectoryLockOwnershipLostError) return storageFailure('ownership-lost');
      return storageFailure('artifact-move-failed');
    }
  }

  const ownershipFailureBeforeShm = assertOwnedAfterMutation();
  if (ownershipFailureBeforeShm !== null) return ownershipFailureBeforeShm;
  let shmRemoved: boolean;
  try {
    // Node 24 `node:sqlite` rewrote `-shm` on a read-only open whenever `-wal` was present, so it cannot
    // preserve evidence from before classification.
    shmRemoved = attemptHandoffRoutingStatusMutation(state, () => unlinkIfPresent(storage, `${path}-shm`));
  } catch {
    return storageFailure('artifact-move-failed');
  }
  if (shmRemoved) {
    const removalDurability = removedArtifactEffects.recordAfterBarrier(
      'shm',
      (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed' | 'ownership-lost'> => {
        const ownershipFailure = ownershipFailureCauseAfterMutation();
        if (ownershipFailure !== null) return { kind: 'failed', cause: ownershipFailure };
        return syncQuarantineMoveDirectory(storage, sourceDirectory, 'source', state, syncedDirectories)
          ? { kind: 'durable' }
          : { kind: 'failed', cause: 'directory-sync-failed' };
      },
    );
    if (removalDurability.kind === 'failed') {
      return storageFailure(removalDurability.cause);
    }
  }
  const ownershipFailureBeforeDatabase = assertOwnedAfterMutation();
  if (ownershipFailureBeforeDatabase !== null) return ownershipFailureBeforeDatabase;

  const detachedWalHadNoMain =
    observations.firstMainState === 'absent' &&
    observations.firstWalReceipt.kind === 'non-empty' &&
    observations.guardedMainState === 'absent' &&
    observations.guardedWalReceipt.kind === 'non-empty';
  if (detachedWalHadNoMain) {
    if (!walMoved) return storageFailure('artifact-move-failed');
    return {
      kind: 'quarantined-incomplete',
      quarantineId,
      quarantinePath,
      retainedArtifacts: ['wal'],
    };
  }

  let databaseMove: HandoffRoutingStatusQuarantineMoveObservation;
  try {
    databaseMove = moveQuarantineArtifact(
      storage,
      path,
      quarantinePath,
      'database',
      sourceDirectory,
      root,
      state,
      movedArtifactEffects,
      syncedDirectories,
      assertOwned,
    );
  } catch {
    return storageFailure('artifact-move-failed');
  }
  if (databaseMove.kind === 'undeterminable') {
    if (databaseMove.retention === 'retained') retainedArtifacts.add('database');
    return databaseMove.retention === 'unknown'
      ? retentionUndeterminable({ kind: 'artifact-observation-failed', error: databaseMove.error })
      : storageFailure('artifact-observation-failed', databaseMove.error.errcode);
  }
  if (databaseMove.kind === 'occupied') {
    return { kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact: 'database' };
  }
  if (databaseMove.kind === 'failed') {
    if (databaseMove.retention === 'retained') retainedArtifacts.add('database');
    return storageFailure(databaseMove.cause);
  }
  if (databaseMove.kind === 'absent') return storageFailure('artifact-move-failed');
  retainedArtifacts.add('database');
  const ownershipFailure = assertOwnedAfterMutation();
  if (ownershipFailure !== null) return ownershipFailure;
  return { kind: 'quarantined', quarantineId, quarantinePath, retainedArtifacts: [...retainedArtifacts] };
}

function unlinkIfPresent(storage: StoragePort, path: string): boolean {
  try {
    storage.unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function syncQuarantineClear(
  storage: StoragePort,
  path: string,
  state: HandoffRoutingStatusMaintenanceState,
  syncedDirectories: Set<HandoffRoutingStatusQuarantineSyncedDirectory>,
): boolean {
  const synced = attemptHandoffRoutingStatusMutation(state, () =>
    storage.syncDirectoryDurableSync(quarantineRoot(path)),
  );
  if (synced) syncedDirectories.add('quarantine');
  return synced;
}

export function clearHandoffRoutingStoreQuarantine(
  storage: StoragePort,
  path: string,
  quarantineId: string,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineClearStoreResult {
  if (!CANONICAL_UUID_PATTERN.test(quarantineId)) return { kind: 'quarantine-not-found', quarantineId };
  const quarantinePath = join(quarantineRoot(path), `${basename(path)}.${quarantineId}`);
  assertOwned();
  const artifacts: HandoffRoutingStatusQuarantineArtifact[] = [];
  for (const [artifactPath, artifact] of [
    [quarantinePath, 'database'],
    [`${quarantinePath}-wal`, 'wal'],
  ] as const) {
    const observation = observeHandoffRoutingPath(storage, artifactPath);
    assertOwned();
    if (observation.kind === 'undeterminable') {
      return {
        kind: 'quarantine-clear-undeterminable',
        quarantineId,
        quarantinePath,
        artifact,
        errcode: observation.error.errcode,
      };
    }
    if (observation.kind === 'present') artifacts.push(artifact);
  }
  if (artifacts.length === 0) return { kind: 'quarantine-not-found', quarantineId };
  const entry: HandoffRoutingStatusQuarantineEntry = {
    id: quarantineId,
    quarantinePath,
    state: artifacts.includes('database') ? 'complete' : 'incomplete',
    artifacts,
  };
  const removedArtifactEffects = createHandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>();
  const syncedDirectories = new Set<HandoffRoutingStatusQuarantineSyncedDirectory>();
  const state: HandoffRoutingStatusMaintenanceState = { mutationAttempted: false };
  const storageFailure = (
    cause: Extract<
      HandoffRoutingStatusQuarantineClearStoreResult,
      { kind: 'quarantine-clear-storage-failed' }
    >['cause'],
  ): HandoffRoutingStatusQuarantineClearStoreResult => ({
    kind: 'quarantine-clear-storage-failed',
    quarantineId,
    quarantinePath,
    removedArtifacts: [...removedArtifactEffects.durableArtifacts],
    observedRemovedArtifacts: [...removedArtifactEffects.observedArtifacts],
    syncedDirectories: [...syncedDirectories],
    cause,
  });
  const ownershipFailureCauseAfterMutation = (): 'ownership-lost' | null => {
    try {
      assertOwned();
      return null;
    } catch (error: unknown) {
      if (!state.mutationAttempted) throw error;
      if (error instanceof DirectoryLockOwnershipLostError) return 'ownership-lost';
      throw error;
    }
  };
  const assertOwnedAfterMutation = (): HandoffRoutingStatusQuarantineClearStoreResult | null => {
    const cause = ownershipFailureCauseAfterMutation();
    return cause === null ? null : storageFailure(cause);
  };
  for (const [artifactPath, artifact] of [
    [`${entry.quarantinePath}-wal`, 'wal'],
    [entry.quarantinePath, 'database'],
  ] as const) {
    let removed: boolean;
    try {
      removed = attemptHandoffRoutingStatusMutation(state, () => unlinkIfPresent(storage, artifactPath));
    } catch {
      return storageFailure('artifact-remove-failed');
    }
    if (removed) {
      const removalDurability = removedArtifactEffects.recordAfterBarrier(
        artifact,
        (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed' | 'ownership-lost'> => {
          const ownershipFailure = ownershipFailureCauseAfterMutation();
          if (ownershipFailure !== null) return { kind: 'failed', cause: ownershipFailure };
          try {
            return syncQuarantineClear(storage, path, state, syncedDirectories)
              ? { kind: 'durable' }
              : { kind: 'failed', cause: 'directory-sync-failed' };
          } catch {
            return { kind: 'failed', cause: 'directory-sync-failed' };
          }
        },
      );
      if (removalDurability.kind === 'failed') {
        return storageFailure(removalDurability.cause);
      }
    }
    const ownershipFailure = assertOwnedAfterMutation();
    if (ownershipFailure !== null) return ownershipFailure;
  }
  return { kind: 'cleared', entry };
}

export function publishHandoffRoutingStoreTransaction<T>(
  storage: StoragePort,
  path: string,
  schema: HandoffRoutingStatusStoreSchema,
  publicationPolicy: HandoffRoutingStorePublicationPolicy,
  admitBody: HandoffRoutingStoreBodyAdmission<unknown>,
  mutate: (transaction: HandoffRoutingStatusTransaction) => T,
): HandoffRoutingStorePublication<T> {
  let database: SqliteDatabasePort | undefined;
  let transactionOpen = false;
  let commitStarted = false;
  try {
    const observation = observeHandoffRoutingStorePath(storage, path);
    const preflight = preflightClassification(observation);
    if (preflight !== null && publicationPolicy(preflight) === 'refuse') {
      return { kind: 'artifact-refused', classification: preflight as HandoffRoutingStoreArtifactRefusal };
    }
    storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      database = storage.openSqliteDatabaseSync(path);
    } catch (error: unknown) {
      return {
        kind: 'artifact-refused',
        classification: unreadableOrUndeterminableClassification(error),
      };
    }
    const advisory = classifyOpenHandoffRoutingStoreDatabase(database, schema, admitBody);
    if (publicationPolicy(advisory) === 'refuse') {
      return { kind: 'artifact-refused', classification: advisory as HandoffRoutingStoreArtifactRefusal };
    }
    storage.chmodSync(path, 0o600);
    configureDatabase(database, schema.operational);
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const admission = classifyOpenHandoffRoutingStoreDatabase(database, schema, admitBody);
    const admissionAction = publicationPolicy(admission);
    if (admissionAction === 'refuse') {
      rollback(database, transactionOpen, false);
      transactionOpen = false;
      return { kind: 'artifact-refused', classification: admission as HandoffRoutingStoreArtifactRefusal };
    }
    if (admissionAction === 'initialize') initializeDatabase(database, schema);
    const value = mutate(new HandoffRoutingStatusTransaction(database, schema));
    commitStarted = true;
    database.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'committed', value };
  } catch (error) {
    rollback(database, transactionOpen, commitStarted);
    return { kind: 'failed', error, commitStarted };
  } finally {
    close(database);
  }
}

export type HandoffRoutingStoreSnapshotObservation<T> =
  | Readonly<{
      kind: 'observed';
      classification: HandoffRoutingStoreClassification<T>;
      mainState: 'absent' | 'zero' | 'non-empty';
      walReceipt: HandoffRoutingWalObservationReceipt;
    }>
  | Readonly<{
      kind: 'undeterminable';
      classification: Extract<HandoffRoutingStoreClassification<never>, { kind: 'undeterminable' }>;
    }>;

export function readHandoffRoutingStoreSnapshotWithObservation<T>(
  storage: StoragePort,
  path: string,
  schema: HandoffRoutingStatusStoreSchema,
  admitBody: HandoffRoutingStoreBodyAdmission<T>,
): HandoffRoutingStoreSnapshotObservation<T> {
  const observation = observeHandoffRoutingStorePath(storage, path);
  if (observation.kind === 'undeterminable') {
    return { kind: 'undeterminable', classification: undeterminableClassification(observation.error) };
  }
  const preflight = preflightClassification(observation);
  if (preflight !== null) {
    return {
      kind: 'observed',
      classification: preflight,
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  }

  try {
    storage.assertReadableSync(path);
  } catch (error) {
    return {
      kind: 'observed',
      classification: undeterminableClassification(error),
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  }

  let database: SqliteDatabasePort | undefined;
  let transactionOpen = false;
  try {
    database = storage.openSqliteDatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA busy_timeout=0');
    database.exec('BEGIN');
    transactionOpen = true;
    const classification = classifyOpenHandoffRoutingStoreDatabase(database, schema, admitBody);
    database.exec('COMMIT');
    transactionOpen = false;
    return {
      kind: 'observed',
      classification,
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  } catch (error) {
    rollback(database, transactionOpen, false);
    return {
      kind: 'observed',
      classification: unreadableOrUndeterminableClassification(error),
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  } finally {
    close(database);
  }
}

function configureDatabase(
  database: SqliteDatabasePort,
  operational: HandoffRoutingStatusStoreOperationalCapacity,
): void {
  database.exec('PRAGMA busy_timeout=0');
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=FULL');
  database.exec('PRAGMA foreign_keys=ON');
  const pageSize = Number((database.prepare('PRAGMA page_size').get() as Readonly<{ page_size: number }>).page_size);
  const maximumBytes = operational.maximumBytes;
  const maximumPages = Math.max(1, Math.floor(maximumBytes / pageSize));
  database.exec(`PRAGMA max_page_count=${maximumPages}`);
  database.exec(`PRAGMA journal_size_limit=${maximumBytes}`);
  database.exec(`PRAGMA wal_autocheckpoint=${maximumPages}`);
}

function readRetirementHistory(database: SqliteDatabasePort): HandoffRoutingRetirementHistoryRow | undefined {
  return database
    .prepare(
      `SELECT
        generation,
        expired_identity_count,
        capacity_eviction_count,
        completed_pair_compaction_count,
        operator_resolved_count,
        min_selection_sequence,
        max_selection_sequence,
        earliest_selected_at,
        latest_selected_at
      FROM handoff_routing_metadata WHERE singleton = 1`,
    )
    .get() as HandoffRoutingRetirementHistoryRow | undefined;
}

function initializeDatabase(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): void {
  const expectedGeneration = handoffRoutingStatusGeneration(schema);
  const expectedFingerprint = handoffRoutingStatusFingerprint(schema);
  database.exec(schemaSql(schema));
  database
    .prepare(
      `INSERT INTO handoff_routing_metadata (
        singleton,
        generation,
        fingerprint,
        expired_identity_count,
        capacity_eviction_count,
        completed_pair_compaction_count,
        operator_resolved_count
      ) VALUES (1, ?, ?, 0, 0, 0, 0)`,
    )
    .run(expectedGeneration, expectedFingerprint);
  database.exec(`PRAGMA user_version=${expectedGeneration}`);
}

function metadataFingerprintMatches(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): boolean {
  const expectedGeneration = handoffRoutingStatusGeneration(schema);
  const expectedFingerprint = handoffRoutingStatusFingerprint(schema);
  const metadata = database
    .prepare('SELECT generation, fingerprint FROM handoff_routing_metadata WHERE singleton = 1')
    .get() as Readonly<{ generation: number; fingerprint: unknown }> | undefined;
  if (
    metadata?.generation !== expectedGeneration ||
    !(metadata.fingerprint instanceof Uint8Array) ||
    metadata.fingerprint.byteLength !== 32
  ) {
    throw new HandoffRoutingStoreUnreadableError();
  }
  return expectedFingerprint.equals(metadata.fingerprint);
}

function readOpenHandoffRoutingStoreSnapshot(database: SqliteDatabasePort): HandoffRoutingStoreSnapshot {
  const retirement = readRetirementHistory(database);
  const rows = database
    .prepare(
      `SELECT
        sequence,
        generation,
        event_id,
        invocation_id,
        observed_at,
        record_kind,
        event_kind,
        selection_sequence,
        retirement_cause,
        terminal_existed,
        body_json,
        encoded_bytes
      FROM handoff_routing_records ORDER BY sequence`,
    )
    .all();
  const reserves = database
    .prepare(
      `SELECT
        invocation_id,
        event_id,
        observed_at,
        length(allocation) AS allocation_bytes
      FROM handoff_routing_closing_reserve ORDER BY invocation_id`,
    )
    .all();
  return { rows, reserves, retirement };
}

export function classifyOpenHandoffRoutingStoreDatabase<T>(
  database: SqliteDatabasePort,
  schema: HandoffRoutingStatusStoreSchema,
  admitBody: HandoffRoutingStoreBodyAdmission<T>,
): HandoffRoutingStoreClassification<T> {
  try {
    const expectedGeneration = handoffRoutingStatusGeneration(schema);
    const storedGeneration = (database.prepare('PRAGMA user_version').get() as Readonly<{ user_version: number }>)
      .user_version;
    if (storedGeneration === 0) {
      const existing = database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .get() as Readonly<{ count: number }>;
      return existing.count === 0 ? { kind: 'uninitialized' } : { kind: 'generation-missing' };
    }
    if (storedGeneration !== expectedGeneration) {
      return { kind: 'foreign-generation', generation: storedGeneration };
    }
    if (!databaseSchemaMatches(database, schema)) return { kind: 'schema-divergent' };
    if (!metadataFingerprintMatches(database, schema)) return { kind: 'format-mismatch' };
    const admitted = admitBody(readOpenHandoffRoutingStoreSnapshot(database));
    return admitted.kind === 'admitted' ? { kind: 'current', snapshot: admitted.snapshot } : admitted;
  } catch (error: unknown) {
    return unreadableOrUndeterminableClassification(error);
  }
}

const HANDOFF_ROUTING_STATUS_SCHEMA_SQL = `
    CREATE TABLE handoff_routing_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation = __HANDOFF_ROUTING_STATUS_GENERATION__),
      fingerprint BLOB NOT NULL CHECK(typeof(fingerprint) = 'blob' AND length(fingerprint) = 32),
      expired_identity_count INTEGER NOT NULL CHECK (expired_identity_count >= 0),
      capacity_eviction_count INTEGER NOT NULL CHECK (capacity_eviction_count >= 0),
      completed_pair_compaction_count INTEGER NOT NULL CHECK (completed_pair_compaction_count >= 0),
      operator_resolved_count INTEGER NOT NULL CHECK (operator_resolved_count >= 0),
      min_selection_sequence INTEGER CHECK (min_selection_sequence > 0),
      max_selection_sequence INTEGER CHECK (max_selection_sequence > 0),
      earliest_selected_at TEXT,
      latest_selected_at TEXT,
      CHECK (
        capacity_eviction_count + completed_pair_compaction_count + operator_resolved_count =
          expired_identity_count
      ),
      CHECK (
        (expired_identity_count = 0 AND min_selection_sequence IS NULL AND max_selection_sequence IS NULL AND
          earliest_selected_at IS NULL AND latest_selected_at IS NULL) OR
        (expired_identity_count > 0 AND min_selection_sequence IS NOT NULL AND max_selection_sequence IS NOT NULL AND
          earliest_selected_at IS NOT NULL AND latest_selected_at IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE handoff_routing_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      generation INTEGER NOT NULL CHECK (generation = __HANDOFF_ROUTING_STATUS_GENERATION__),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND __MAXIMUM_OBSERVED_AT_LENGTH__),
      record_kind TEXT NOT NULL CHECK (record_kind IN ('selection', 'terminal', 'retirement')),
      event_kind TEXT NOT NULL CHECK (
        event_kind IN ('routing-selected', 'execution-failed', 'continuation-finalized', 'retirement-tombstone')
      ),
      selection_sequence INTEGER CHECK (selection_sequence > 0),
      retirement_cause TEXT CHECK (
        retirement_cause IN ('selection-evicted-at-capacity', 'completed-pair-compaction', 'operator-resolved')
      ),
      terminal_existed INTEGER CHECK (terminal_existed IN (0, 1)),
      body_json TEXT NOT NULL CHECK (json_valid(body_json)),
      encoded_bytes INTEGER GENERATED ALWAYS AS (length(CAST(body_json AS BLOB))) STORED,
      CHECK (
        (record_kind = 'selection' AND event_kind = 'routing-selected' AND selection_sequence IS NULL AND
          retirement_cause IS NULL AND terminal_existed IS NULL) OR
        (record_kind = 'terminal' AND event_kind IN ('execution-failed', 'continuation-finalized') AND
          retirement_cause IS NULL AND terminal_existed IS NULL) OR
        (record_kind = 'retirement' AND event_kind = 'retirement-tombstone' AND selection_sequence IS NOT NULL AND
          retirement_cause IS NOT NULL AND terminal_existed IS NOT NULL)
      ),
      CHECK (json_extract(body_json, '$.generation') = generation),
      CHECK (json_extract(body_json, '$.sequence') = sequence),
      CHECK (json_extract(body_json, '$.eventId') = event_id),
      CHECK (json_extract(body_json, '$.invocationId') = invocation_id),
      CHECK (json_extract(body_json, '$.observedAt') = observed_at),
      CHECK (json_extract(body_json, '$.eventKind') = event_kind),
      CHECK (
        (record_kind = 'selection' AND json_extract(body_json, '$.phase') = 'selection' AND
          encoded_bytes <= __MAXIMUM_ROUTING_SELECTED_BYTES__) OR
        (record_kind = 'terminal' AND json_extract(body_json, '$.phase') = 'terminal' AND
          ((event_kind = 'execution-failed' AND encoded_bytes <= __MAXIMUM_EXECUTION_FAILED_BYTES__) OR
           (event_kind = 'continuation-finalized' AND
            encoded_bytes <= __MAXIMUM_CONTINUATION_FINALIZED_BYTES__))) OR
        (record_kind = 'retirement' AND json_extract(body_json, '$.phase') = 'retirement' AND
          json_extract(body_json, '$.selectionSequence') = selection_sequence AND
          json_extract(body_json, '$.retirementCause') = retirement_cause AND
          json_extract(body_json, '$.terminalExisted') = terminal_existed AND
          encoded_bytes <= __MAXIMUM_RETIREMENT_TOMBSTONE_BYTES__)
      )
    ) STRICT;

    CREATE TABLE handoff_routing_closing_reserve (
      invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND __MAXIMUM_OBSERVED_AT_LENGTH__),
      allocation BLOB NOT NULL CHECK (length(allocation) = __CLOSING_RECORD_BYTES__)
    ) STRICT;

    CREATE UNIQUE INDEX handoff_routing_selection_or_retirement_per_invocation
      ON handoff_routing_records(invocation_id)
      WHERE record_kind IN ('selection', 'retirement');

    CREATE UNIQUE INDEX handoff_routing_terminal_or_retirement_per_invocation
      ON handoff_routing_records(invocation_id)
      WHERE record_kind IN ('terminal', 'retirement');

    CREATE UNIQUE INDEX handoff_routing_selection_or_unretained_terminal_per_invocation
      ON handoff_routing_records(invocation_id)
      WHERE record_kind = 'selection' OR (
        record_kind = 'terminal' AND (
          json_extract(body_json, '$.selection.kind') = 'without-selection' OR
          json_extract(body_json, '$.disposition.kind') IN (
            'terminal-without-retained-selection',
            'terminal-after-operator-resolution'
          )
        )
      );
  `;

function renderedSchemaSql(format: HandoffRoutingStatusStoreDurableFormat, generation: string): string {
  return HANDOFF_ROUTING_STATUS_SCHEMA_SQL.replaceAll('__HANDOFF_ROUTING_STATUS_GENERATION__', generation)
    .replaceAll('__MAXIMUM_IDENTIFIER_LENGTH__', String(format.maximumIdentifierLength))
    .replaceAll('__MAXIMUM_OBSERVED_AT_LENGTH__', String(format.maximumObservedAtLength))
    .replaceAll('__MAXIMUM_ROUTING_SELECTED_BYTES__', String(format.maximumRoutingSelectedBytes))
    .replaceAll('__MAXIMUM_EXECUTION_FAILED_BYTES__', String(format.maximumExecutionFailedBytes))
    .replaceAll('__MAXIMUM_CONTINUATION_FINALIZED_BYTES__', String(format.maximumContinuationFinalizedBytes))
    .replaceAll('__MAXIMUM_RETIREMENT_TOMBSTONE_BYTES__', String(format.maximumRetirementTombstoneBytes))
    .replaceAll('__CLOSING_RECORD_BYTES__', String(format.closingRecordBytes));
}

function assertCanonicalVocabulary(name: string, values: readonly string[]): void {
  for (const value of values) sqlVocabularyLiteral(value);
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index])) {
    throw new Error(`Routing-status ${name} vocabulary must be sorted and unique.`);
  }
}

type PersistedContractNode = Readonly<{ [key: string]: CanonicalContractValue }>;

function persistedContractNode(value: CanonicalContractValue): PersistedContractNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as PersistedContractNode) : null;
}

function indexPersistedContractNodes(
  value: CanonicalContractValue,
  nodesById: Map<number, PersistedContractNode>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) indexPersistedContractNodes(item, nodesById);
    return;
  }
  const node = persistedContractNode(value);
  if (node === null) return;
  if (typeof node.$id === 'number') nodesById.set(node.$id, node);
  for (const child of Object.values(node)) indexPersistedContractNodes(child, nodesById);
}

function resolvePersistedContractNode(
  value: CanonicalContractValue,
  nodesById: ReadonlyMap<number, PersistedContractNode>,
): PersistedContractNode | null {
  const node = persistedContractNode(value);
  if (node === null) return null;
  return typeof node.$ref === 'number' ? (nodesById.get(node.$ref) ?? null) : node;
}

function persistedContractValuesAtFieldPath(
  value: CanonicalContractValue,
  fieldPath: readonly string[],
  nodesById: ReadonlyMap<number, PersistedContractNode>,
): readonly CanonicalContractValue[] {
  const node = resolvePersistedContractNode(value, nodesById);
  if (node === null) return [];
  if (fieldPath.length === 0) return [node];
  const [field, ...remainingPath] = fieldPath;
  if (field === undefined) return [node];
  if (node.type === 'ZodObject') {
    const fields = persistedContractNode(node.fields);
    const child = fields?.[field];
    return child === undefined ? [] : persistedContractValuesAtFieldPath(child, remainingPath, nodesById);
  }
  if ((node.type === 'ZodUnion' || node.type === 'ZodDiscriminatedUnion') && Array.isArray(node.options)) {
    return node.options.flatMap((option) => persistedContractValuesAtFieldPath(option, fieldPath, nodesById));
  }
  const wrapped =
    node.type === 'ZodEffects' || node.type === 'ZodPipeline'
      ? node.input
      : node.type === 'ZodLazy'
        ? node.value
        : node.inner;
  return wrapped === undefined ? [] : persistedContractValuesAtFieldPath(wrapped, fieldPath, nodesById);
}

function persistedContractValueAcceptsStringLiteral(
  value: CanonicalContractValue,
  expected: string,
  nodesById: ReadonlyMap<number, PersistedContractNode>,
  visitedIds: ReadonlySet<number> = new Set<number>(),
): boolean {
  const node = resolvePersistedContractNode(value, nodesById);
  if (node === null) return false;
  const id = typeof node.$id === 'number' ? node.$id : undefined;
  if (id !== undefined && visitedIds.has(id)) return false;
  const nextVisited = id === undefined ? visitedIds : new Set([...visitedIds, id]);
  if (node.type === 'ZodLiteral') return node.value === expected;
  if (node.type === 'ZodEnum') return Array.isArray(node.values) && node.values.some((item) => item === expected);
  if ((node.type === 'ZodUnion' || node.type === 'ZodDiscriminatedUnion') && Array.isArray(node.options)) {
    return node.options.some((option) =>
      persistedContractValueAcceptsStringLiteral(option, expected, nodesById, nextVisited),
    );
  }
  const wrapped =
    node.type === 'ZodEffects' || node.type === 'ZodPipeline'
      ? node.input
      : node.type === 'ZodLazy'
        ? node.value
        : node.inner;
  return wrapped !== undefined && persistedContractValueAcceptsStringLiteral(wrapped, expected, nodesById, nextVisited);
}

function persistedContractFieldAcceptsStringLiteral(
  contract: CanonicalContractValue,
  fieldPath: readonly string[],
  expected: string,
): boolean {
  const nodesById = new Map<number, PersistedContractNode>();
  indexPersistedContractNodes(contract, nodesById);
  return persistedContractValuesAtFieldPath(contract, fieldPath, nodesById).some((value) =>
    persistedContractValueAcceptsStringLiteral(value, expected, nodesById),
  );
}

function assertDurableFormat(format: HandoffRoutingStatusStoreDurableFormat): void {
  const stability = format.bodyVocabulary.completedPairStability;
  sqlVocabularyLiteral(stability.selectionDispositionKind);
  sqlVocabularyLiteral(stability.terminalDispositionKind);
  assertCanonicalVocabulary('completed-pair routing-basis', stability.selectionBasisKinds);
  if (
    !persistedContractFieldAcceptsStringLiteral(
      format.recordContracts.selection,
      ['disposition', 'kind'],
      stability.selectionDispositionKind,
    )
  ) {
    throw new Error('Routing-status completed-pair selection disposition is outside the durable vocabulary.');
  }
  if (
    !persistedContractFieldAcceptsStringLiteral(
      format.recordContracts.terminal,
      ['disposition', 'kind'],
      stability.terminalDispositionKind,
    )
  ) {
    throw new Error('Routing-status completed-pair terminal disposition is outside the durable vocabulary.');
  }
  if (
    stability.selectionBasisKinds.some(
      (kind) =>
        !persistedContractFieldAcceptsStringLiteral(
          format.recordContracts.selection,
          ['disposition', 'basis', 'kind'],
          kind,
        ),
    )
  ) {
    throw new Error('Routing-status completed-pair basis is outside the durable vocabulary.');
  }
}

export function handoffRoutingStatusFingerprint(schema: HandoffRoutingStatusStoreSchema): Buffer {
  assertDurableFormat(schema.durableFormat);
  return createHash('sha256')
    .update(canonicalContractJson(schema.durableFormat), 'utf-8')
    .update('\0', 'utf-8')
    .update(renderedSchemaSql(schema.durableFormat, ''), 'utf-8')
    .update('\0', 'utf-8')
    .update(completedPairStableSql(schema.durableFormat.bodyVocabulary), 'utf-8')
    .digest();
}

export function handoffRoutingStatusGeneration(schema: HandoffRoutingStatusStoreSchema): number {
  const fingerprint = handoffRoutingStatusFingerprint(schema);
  const { minimum, maximum } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;
  const generationCount = maximum - minimum + 1;
  return (fingerprint.readUInt32BE(0) % generationCount) + minimum;
}

function schemaSql(schema: HandoffRoutingStatusStoreSchema): string {
  return renderedSchemaSql(schema.durableFormat, String(handoffRoutingStatusGeneration(schema)));
}

type HandoffRoutingSchemaObject = Readonly<{
  type: string;
  name: string;
  sql: string | null;
}>;

function canonicalSchemaSql(sql: string): string {
  return sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
}

function expectedSchemaObjects(schema: HandoffRoutingStatusStoreSchema): readonly HandoffRoutingSchemaObject[] {
  return schemaSql(schema)
    .split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0)
    .map((sql) => {
      const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX) ([a-z0-9_]+)/iu.exec(sql);
      const type = match?.[1]?.toLowerCase();
      const name = match?.[2];
      if ((type !== 'table' && type !== 'index') || name === undefined) {
        throw new Error('Handoff routing schema contains an unaddressed object.');
      }
      return { type, name, sql };
    });
}

function databaseSchemaMatches(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): boolean {
  const observed = database
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'`,
    )
    .all() as readonly HandoffRoutingSchemaObject[];
  const expected = expectedSchemaObjects(schema);
  if (observed.length !== expected.length) return false;
  const observedByName = new Map(observed.map((object) => [object.name, object]));
  return expected.every((object) => {
    const candidate = observedByName.get(object.name);
    return (
      candidate?.type === object.type &&
      candidate.sql !== null &&
      canonicalSchemaSql(candidate.sql) === canonicalSchemaSql(object.sql ?? '')
    );
  });
}

function rollback(database: SqliteDatabasePort | undefined, transactionOpen: boolean, commitStarted: boolean): void {
  if (database === undefined || !transactionOpen || commitStarted) return;
  try {
    database.exec('ROLLBACK');
  } catch (rollbackError) {
    void rollbackError;
  }
}

function close(database: SqliteDatabasePort | undefined): void {
  if (database === undefined) return;
  try {
    database.close();
  } catch (closeError) {
    void closeError;
  }
}
